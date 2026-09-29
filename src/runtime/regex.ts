/**
 * A small linear-time regular expression engine (Thompson NFA simulation).
 *
 * Patterns come from expression authors, so JavaScript's backtracking RegExp
 * would allow catastrophic backtracking that no step budget can interrupt.
 * This engine matches in O(pattern x text) time over code points and supports
 * JavaScript regular expression syntax (as with the `u` flag) except the parts
 * that cannot run in linear time: literals, `.`, classes (`[a-z]`, `[^...]`, `\d \w \s` and negations),
 * anchors `^ $ \b \B`, groups `(...)` and `(?:...)`, alternation `|`, and
 * quantifiers `* + ? {n} {n,} {n,m}` (greedy and lazy forms behave the same for
 * a yes/no match). A leading `(?i)` makes the match case-insensitive (ASCII
 * letters only).
 * Backreferences and lookaround are not supported (they cannot be linear).
 */

type CharTest = (code: number) => boolean

type Inst =
  | { op: 'char'; test: CharTest }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'assert'; kind: '^' | '$' | 'b' | 'B' }
  | { op: 'match' }

type Ast =
  | { kind: 'empty' }
  /** `lit`: the one code point this matches, when it is a plain literal (used by the prefilter). */
  | { kind: 'char'; test: CharTest; lit?: number }
  | { kind: 'assert'; assert: '^' | '$' | 'b' | 'B' }
  | { kind: 'concat'; items: Ast[] }
  | { kind: 'alt'; items: Ast[] }
  | { kind: 'repeat'; item: Ast; min: number; max: number }

export class RegexSyntaxError extends Error {}

const MAX_PROGRAM = 5000
const MAX_REPEAT = 1000

export interface Program {
  readonly insts: readonly Inst[]
  /** Every match must start at position 0 (the pattern begins with ^ on all branches). */
  readonly anchored: boolean
  /** Instructions plus class ranges: what the compiled program costs to keep. */
  readonly size: number
  /** Every match contains at least one of these strings (absent: unknown). */
  readonly required?: readonly string[]
  /** Every match begins with this text (after zero-width assertions), when known. */
  readonly prefix?: string
  /** Scratch space reused across searches (one search runs at a time). */
  scratch?: Scratch
}

interface Scratch {
  current: Int32Array
  next: Int32Array
  seen: Int32Array
  generation: number
}

// Character codes the engine compares against.
const CH_BACKSPACE = 8
const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_0 = 48
const CH_9 = 57
const CH_UPPER_A = 65
const CH_UPPER_Z = 90
const CH_UNDERSCORE = 95
const CH_LOWER_A = 97
const CH_LOWER_Z = 122
const CH_LINE_SEPARATOR = 0x2028
const CH_PARAGRAPH_SEPARATOR = 0x2029
/** Distance between an ASCII upper-case letter and its lower-case form. */
const ASCII_CASE_OFFSET = 32
/** Generation counters restart before they could overflow an Int32Array slot. */
const MAX_GENERATION = 0x3fffffff

const isDigit = (c: number): boolean => c >= CH_0 && c <= CH_9
const isWord = (c: number): boolean =>
  isDigit(c) ||
  (c >= CH_UPPER_A && c <= CH_UPPER_Z) ||
  (c >= CH_LOWER_A && c <= CH_LOWER_Z) ||
  c === CH_UNDERSCORE
/**
 * What JavaScript's \s matches, as sorted [low, high] pairs: TAB..CR, and the
 * rest of the ECMAScript WhiteSpace and LineTerminator sets.
 */
const SPACE_RANGES: readonly number[] = Array.from(
  '\t\r  \u00a0\u00a0\u1680\u1680\u2000\u200a\u2028\u2029\u202f\u202f\u205f\u205f\u3000\u3000\ufeff\ufeff',
  (c) => c.charCodeAt(0),
)

/** A counted repeat: {n}, {n,}, or {n,m}. */
const REPEAT = /^\{(?<min>\d+)(?<range>,(?<max>\d*))?\}/u

function lower(c: number): number {
  return c >= CH_UPPER_A && c <= CH_UPPER_Z ? c + ASCII_CASE_OFFSET : c
}

const isCaseless = (c: number): boolean => lower(c) === c && !(c >= CH_LOWER_A && c <= CH_LOWER_Z)

type Atom =
  | { readonly code: number }
  | { readonly ranges: readonly number[] }
  | { readonly assert: 'b' | 'B' }

// === code point range sets: flat [lo0, hi0, lo1, hi1, ...], sorted and merged ===

/** Sorts and merges overlapping or adjacent ranges. */
function normalize(ranges: readonly number[]): number[] {
  const pairs: [number, number][] = []
  for (let k = 0; k < ranges.length; k += 2) pairs.push([ranges[k], ranges[k + 1]])
  pairs.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  for (const [lo, hi] of pairs) {
    const last = out.length - 1
    if (last > 0 && lo <= out[last] + 1) out[last] = Math.max(out[last], hi)
    else out.push(lo, hi)
  }
  return out
}

function complement(ranges: readonly number[]): number[] {
  const set = normalize(ranges)
  const out: number[] = []
  let next = 0
  for (let k = 0; k < set.length; k += 2) {
    if (set[k] > next) out.push(next, set[k] - 1)
    next = set[k + 1] + 1
  }
  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT)
  return out
}

/** Adds the other ASCII case of every letter in the set. */
function foldCase(ranges: readonly number[]): number[] {
  const out = [...ranges]
  for (let k = 0; k < ranges.length; k += 2) {
    const upperLo = Math.max(ranges[k], CH_UPPER_A)
    const upperHi = Math.min(ranges[k + 1], CH_UPPER_Z)
    if (upperLo <= upperHi) out.push(upperLo + ASCII_CASE_OFFSET, upperHi + ASCII_CASE_OFFSET)
    const lowerLo = Math.max(ranges[k], CH_LOWER_A)
    const lowerHi = Math.min(ranges[k + 1], CH_LOWER_Z)
    if (lowerLo <= lowerHi) out.push(lowerLo - ASCII_CASE_OFFSET, lowerHi - ASCII_CASE_OFFSET)
  }
  return out
}

/** A membership test over a normalized set: binary search, O(log ranges). */
function rangeTest(ranges: readonly number[]): CharTest {
  const set = Int32Array.from(ranges)
  const pairs = set.length >>> 1
  if (pairs === 1) {
    const [lo, hi] = [set[0], set[1]]
    return (c) => c >= lo && c <= hi
  }
  return (c) => {
    let low = 0
    let high = pairs - 1
    while (low <= high) {
      const mid = (low + high) >>> 1
      if (c < set[mid * 2]) high = mid - 1
      else if (c > set[mid * 2 + 1]) low = mid + 1
      else return true
    }
    return false
  }
}

const DIGIT_RANGES: readonly number[] = [CH_0, CH_9]
const WORD_RANGES: readonly number[] = normalize([
  CH_0,
  CH_9,
  CH_UPPER_A,
  CH_UPPER_Z,
  CH_UNDERSCORE,
  CH_UNDERSCORE,
  CH_LOWER_A,
  CH_LOWER_Z,
])

const MAX_GROUP_DEPTH = 100
const BMP_LIMIT = 0xffff
const HIGH_SURROGATE = 0xd800
const LOW_SURROGATE = 0xdc00
/** Code points per high surrogate. */
const SURROGATE_BLOCK = 0x400
const MAX_CODE_POINT = 0x10ffff
const CH_FORM_FEED = 12
const CH_VERTICAL_TAB = 11
const HEX = 16
const QUANTIFIER = /^(?:[*+?]|\{\d+(?:,\d*)?\})/u

export function compileRegex(source: string): Program {
  let pattern = source
  let offset = 0
  let ignoreCase = false
  if (pattern.startsWith('(?i)')) {
    ignoreCase = true
    offset = '(?i)'.length
    pattern = pattern.slice(offset)
  }
  let i = 0
  let depth = 0
  /** Class ranges kept by the program, counted toward its size. */
  let rangeCount = 0
  const fail = (message: string): never => {
    throw new RegexSyntaxError(`${message} at position ${i + offset} in /${source}/`)
  }

  const literal = (code: number): CharTest =>
    ignoreCase ? (c) => c === code || lower(c) === lower(code) : (c) => c === code
  /** A literal char node; under (?i) only a character without case stays a plain literal. */
  const literalNode = (code: number): Ast => ({
    kind: 'char',
    test: literal(code),
    ...(!ignoreCase || isCaseless(code) ? { lit: code } : {}),
  })

  /** Reads one code point of the pattern. */
  const readCodePoint = (): number => {
    const code = pattern.codePointAt(i) as number
    i += code > BMP_LIMIT ? 2 : 1
    return code
  }

  function parseAlt(): Ast {
    const items = [parseConcat()]
    while (pattern[i] === '|') {
      i++
      items.push(parseConcat())
    }
    return items.length === 1 ? items[0] : { kind: 'alt', items }
  }

  function parseConcat(): Ast {
    const items: Ast[] = []
    while (i < pattern.length && pattern[i] !== '|' && pattern[i] !== ')') items.push(parseRepeat())
    if (items.length === 0) return { kind: 'empty' }
    return items.length === 1 ? items[0] : { kind: 'concat', items }
  }

  function parseRepeat(): Ast {
    const atom = parseAtom()
    const ch = pattern[i]
    let min: number
    let max: number
    let match: RegExpExecArray | null = null
    if (ch === '*') [min, max] = [0, Infinity]
    else if (ch === '+') [min, max] = [1, Infinity]
    else if (ch === '?') [min, max] = [0, 1]
    else if (ch === '{' && (match = REPEAT.exec(pattern.slice(i))) !== null) {
      const groups = match.groups ?? {}
      min = Number(groups.min)
      if (groups.range === undefined) max = min
      else max = groups.max === '' ? Infinity : Number(groups.max)
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT))
        fail(`Repeat count above ${MAX_REPEAT}`)
      if (max < min) fail('Invalid repeat range')
      i += match[0].length - 1
    } else return atom
    i++
    if (pattern[i] === '?') i++ // lazy: same result for a yes/no match
    if (atom.kind === 'assert') fail('Nothing to repeat')
    // A quantifier directly after another (a{2}{3}, a**) is an error, as in JavaScript.
    if (QUANTIFIER.test(pattern.slice(i))) fail('Nothing to repeat')
    return { kind: 'repeat', item: atom, min, max }
  }

  function parseAtom(): Ast {
    const ch = pattern[i]
    switch (ch) {
      case '(': {
        i++
        if (pattern.startsWith('?:', i)) i += 2
        else if (pattern[i] === '?') {
          if (/^\?[a-z]+\)/u.test(pattern.slice(i)))
            fail('Flags such as (?i) are only supported at the start of the pattern')
          fail('Lookaround and named groups are not supported')
        }
        if (++depth > MAX_GROUP_DEPTH) fail(`Groups nest deeper than ${MAX_GROUP_DEPTH}`)
        const inner = parseAlt()
        depth--
        if (pattern[i] !== ')') fail('Missing )')
        i++
        return inner
      }
      case '.':
        i++
        return {
          kind: 'char',
          test: (c) =>
            c !== CH_LF && c !== CH_CR && c !== CH_LINE_SEPARATOR && c !== CH_PARAGRAPH_SEPARATOR,
        }
      case '^':
        i++
        return { kind: 'assert', assert: '^' }
      case '$':
        i++
        return { kind: 'assert', assert: '$' }
      case '[':
        return { kind: 'char', test: parseClass() }
      case '\\': {
        const atom = parseEscape(false)
        if ('assert' in atom) return { kind: 'assert', assert: atom.assert }
        return 'code' in atom
          ? literalNode(atom.code)
          : { kind: 'char', test: rangeTest(atom.ranges) }
      }
      case '*':
      case '+':
      case '?':
        return fail('Nothing to repeat')
      case ')':
        return fail('Unmatched )')
      case ']':
      case '{':
      case '}':
        return fail(`Escape "${ch}" to match it literally (\\${ch})`)
      default:
        return literalNode(readCodePoint())
    }
  }

  function hexEscape(length: number, what: string): number {
    const hex = pattern.slice(i, i + length)
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`, 'u').test(hex)) fail(`Invalid ${what} escape`)
    i += length
    return parseInt(hex, HEX)
  }

  function parseEscape(inClass: boolean): Atom {
    i++ // backslash
    const e = pattern[i]
    if (e === undefined) fail('Trailing backslash')
    i++
    switch (e) {
      case 'd':
        return { ranges: DIGIT_RANGES }
      case 'D':
        return { ranges: complement(DIGIT_RANGES) }
      case 'w':
        return { ranges: WORD_RANGES }
      case 'W':
        return { ranges: complement(WORD_RANGES) }
      case 's':
        return { ranges: SPACE_RANGES }
      case 'S':
        return { ranges: complement(SPACE_RANGES) }
      case 'b':
        return inClass ? { code: CH_BACKSPACE } : { assert: 'b' }
      case 'B':
        if (inClass) fail('\\B in a class')
        return { assert: 'B' }
      case 'n':
        return { code: CH_LF }
      case 't':
        return { code: CH_TAB }
      case 'r':
        return { code: CH_CR }
      case 'f':
        return { code: CH_FORM_FEED }
      case 'v':
        return { code: CH_VERTICAL_TAB }
      case '0':
        if (/[0-9]/u.test(pattern[i] ?? '')) fail('Backreferences are not supported')
        return { code: 0 }
      case 'u': {
        if (pattern[i] === '{') {
          const close = pattern.indexOf('}', i)
          const hex = close === -1 ? '' : pattern.slice(i + 1, close)
          const code = /^[0-9a-fA-F]{1,6}$/u.test(hex) ? parseInt(hex, HEX) : -1
          if (code < 0 || code > MAX_CODE_POINT) fail('Invalid \\u{...} escape')
          i = close + 1
          return { code }
        }
        const code = hexEscape(4, '\\u')
        // As with the u flag, an escaped surrogate pair is one code point.
        if (
          code >= HIGH_SURROGATE &&
          code < LOW_SURROGATE &&
          /^\\u[dD][c-fC-F][0-9a-fA-F]{2}/u.test(pattern.slice(i))
        ) {
          i += 2
          const low = hexEscape(4, '\\u')
          return {
            code: (code - HIGH_SURROGATE) * SURROGATE_BLOCK + (low - LOW_SURROGATE) + BMP_LIMIT + 1,
          }
        }
        return { code }
      }
      case 'x':
        return { code: hexEscape(2, '\\x') }
      default:
        if (/[1-9]/u.test(e)) fail('Backreferences are not supported')
        // Only ASCII punctuation may be escaped to stand for itself (\. \- \/ ...).
        if (!/^[!-/:-@[-`{-~]$/u.test(e)) fail(`Unknown escape \\${e}`)
        i--
        return { code: readCodePoint() }
    }
  }

  function classAtom(): Atom {
    return pattern[i] === '\\' ? parseEscape(true) : { code: readCodePoint() }
  }

  function parseClass(): CharTest {
    i++ // [
    let negated = false
    if (pattern[i] === '^') {
      negated = true
      i++
    }
    // Literal characters and ranges (case-folded under (?i)), and class escapes (not folded).
    const chars: number[] = []
    const escapes: number[] = []
    while (i < pattern.length && pattern[i] !== ']') {
      const low = classAtom()
      if (pattern[i] === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
        i++
        const high = classAtom()
        if (!('code' in low) || !('code' in high) || high.code < low.code)
          fail('Invalid class range')
        chars.push((low as { code: number }).code, (high as { code: number }).code)
      } else if ('code' in low) chars.push(low.code, low.code)
      else if ('ranges' in low) escapes.push(...low.ranges)
    }
    if (pattern[i] !== ']') fail('Missing ]')
    i++
    const members = normalize([...(ignoreCase ? foldCase(chars) : chars), ...escapes])
    // As in JavaScript, [] matches nothing and [^] matches any character.
    const set = negated ? complement(members) : members
    rangeCount += set.length >>> 1
    if (set.length === 0) return () => false
    return rangeTest(set)
  }

  const ast = parseAlt()
  if (i < pattern.length) fail('Unmatched )')
  if (sizeOf(ast) > MAX_PROGRAM) throw new RegexSyntaxError(`Pattern is too complex: /${source}/`)

  const insts: Inst[] = []
  const emit = (inst: Inst): number => {
    insts.push(inst)
    return insts.length - 1
  }

  function gen(node: Ast): void {
    switch (node.kind) {
      case 'empty':
        return
      case 'char':
        emit({ op: 'char', test: node.test })
        return
      case 'assert':
        emit({ op: 'assert', kind: node.assert })
        return
      case 'concat':
        for (const item of node.items) gen(item)
        return
      case 'alt': {
        const jumps: number[] = []
        for (let k = 0; k < node.items.length - 1; k++) {
          const split = emit({ op: 'split', x: 0, y: 0 })
          ;(insts[split] as { x: number }).x = insts.length
          gen(node.items[k])
          jumps.push(emit({ op: 'jmp', x: 0 }))
          ;(insts[split] as { y: number }).y = insts.length
        }
        gen(node.items[node.items.length - 1])
        for (const jump of jumps) (insts[jump] as { x: number }).x = insts.length
        return
      }
      case 'repeat': {
        for (let k = 0; k < node.min; k++) gen(node.item)
        if (node.max === Infinity) {
          const split = emit({ op: 'split', x: 0, y: 0 })
          ;(insts[split] as { x: number }).x = insts.length
          gen(node.item)
          emit({ op: 'jmp', x: split })
          ;(insts[split] as { y: number }).y = insts.length
          return
        }
        const splits: number[] = []
        for (let k = node.min; k < node.max; k++) {
          const split = emit({ op: 'split', x: 0, y: 0 })
          ;(insts[split] as { x: number }).x = insts.length
          splits.push(split)
          gen(node.item)
        }
        for (const split of splits) (insts[split] as { y: number }).y = insts.length
        break
      }
    }
  }

  gen(ast)
  emit({ op: 'match' })
  const required = requiredLiterals(ast)
  const prefix = literalPrefix(ast)
  return {
    insts,
    anchored: anchoredAtStart(ast),
    size: insts.length + rangeCount,
    ...(required === undefined ? {} : { required }),
    ...(prefix === '' ? {} : { prefix }),
  }
}

/** Most alternatives the prefilter checks for. */
const MAX_REQUIRED = 8

/** Strings of which every match contains at least one (undefined: none known). */
function requiredLiterals(node: Ast): string[] | undefined {
  switch (node.kind) {
    case 'char':
      return node.lit === undefined ? undefined : [String.fromCodePoint(node.lit)]
    case 'repeat':
      return node.min > 0 ? requiredLiterals(node.item) : undefined
    case 'alt': {
      const all = new Set<string>()
      for (const item of node.items) {
        const found = requiredLiterals(item)
        if (found === undefined) return undefined
        for (const text of found) all.add(text)
      }
      return all.size <= MAX_REQUIRED ? [...all] : undefined
    }
    case 'concat': {
      // Runs of literals (across nested groups) and each other item's set are
      // candidates; the best has the longest shortest string.
      let best: string[] | undefined
      const consider = (set: string[] | undefined): void => {
        if (set !== undefined && (best === undefined || score(set) > score(best))) best = set
      }
      let run = ''
      const walk = (items: readonly Ast[]): void => {
        for (const item of items) {
          if (item.kind === 'concat') walk(item.items)
          else if (item.kind === 'char' && item.lit !== undefined)
            run += String.fromCodePoint(item.lit)
          else {
            if (run !== '') consider([run])
            run = ''
            consider(requiredLiterals(item))
          }
        }
      }
      walk(node.items)
      if (run !== '') consider([run])
      return best
    }
    case 'assert':
    case 'empty':
    default:
      return undefined
  }
}

/** How selective a required set is: its shortest string, fewer alternatives breaking ties. */
function score(set: readonly string[]): number {
  return Math.min(...set.map((text) => text.length)) * MAX_REQUIRED * 2 - set.length
}

/** The literal text every match begins with, after any leading assertions. */
function literalPrefix(node: Ast): string {
  let text = ''
  const walk = (item: Ast): boolean => {
    if (item.kind === 'concat') return item.items.every(walk)
    if (item.kind === 'assert' && text === '') return true
    if (item.kind === 'char' && item.lit !== undefined) {
      text += String.fromCodePoint(item.lit)
      return true
    }
    return false
  }
  walk(node)
  return text
}

/** Whether every match of `node` must begin at the start of the text. */
function anchoredAtStart(node: Ast): boolean {
  switch (node.kind) {
    case 'assert':
      return node.assert === '^'
    case 'concat':
      return node.items.length > 0 && anchoredAtStart(node.items[0])
    case 'alt':
      return node.items.every(anchoredAtStart)
    case 'repeat':
      return node.min > 0 && anchoredAtStart(node.item)
    case 'char':
    case 'empty':
    default:
      return false
  }
}

/**
 * Upper bound on the instructions a node compiles to (saturating), computed
 * before generation so repeats of repeats cannot run away. Zero-width bodies
 * count as one instruction per copy, so their repetition is bounded too.
 */
function sizeOf(node: Ast): number {
  const cap = (n: number): number => Math.min(n, MAX_PROGRAM + 1)
  switch (node.kind) {
    case 'empty':
      return 0
    case 'char':
    case 'assert':
      return 1
    case 'concat':
      return cap(node.items.reduce((total, item) => total + sizeOf(item), 0))
    case 'alt':
      return cap(
        node.items.reduce((total, item) => total + sizeOf(item), 0) + 2 * (node.items.length - 1),
      )
    case 'repeat':
    default: {
      const body = Math.max(1, sizeOf(node.item))
      const copies = node.max === Infinity ? node.min + 1 : node.max
      return cap(body * copies + (node.max === Infinity ? 2 : node.max - node.min))
    }
  }
}

/**
 * Whether `program` matches anywhere in `text`. `charge(n)` is called once
 * per character position with the number of NFA states visited there, so the
 * work of a search is accounted as it happens.
 */
export function searchRegex(program: Program, text: string, charge: (n: number) => void): boolean {
  const { insts, anchored, required, prefix } = program
  // A text containing none of the required strings cannot match (an anchored
  // search stops within a few characters anyway, so it skips this).
  if (required !== undefined && !anchored && text.length >= PREFILTER_MIN_TEXT) {
    let found = false
    for (const needle of required) {
      const index = text.indexOf(needle)
      charge(searchCost(index < 0 ? text.length : index + needle.length, needle.length))
      if (index >= 0) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  const n = insts.length
  program.scratch ??= {
    current: new Int32Array(n),
    next: new Int32Array(n),
    seen: new Int32Array(n).fill(-1),
    generation: 0,
  }
  const scratch = program.scratch
  if (scratch.generation > MAX_GENERATION) {
    scratch.seen.fill(-1)
    scratch.generation = 0
  }
  let { current, next } = scratch
  const { seen } = scratch
  let currentCount = 0
  let nextCount = 0
  let generation = ++scratch.generation
  let visited = 0

  // Adds a thread at `pc`, following jumps, splits, and assertions at position `at`.
  // A fresh stack each call keeps `add` small enough for the engine to inline.
  const add = (list: Int32Array, count: number, pc: number, at: number): number => {
    const stack = [pc]
    let size = count
    while (stack.length > 0) {
      const p = stack.pop() as number
      if (seen[p] === generation) continue
      seen[p] = generation
      visited++
      const inst = insts[p]
      switch (inst.op) {
        case 'jmp':
          stack.push(inst.x)
          break
        case 'split':
          stack.push(inst.y, inst.x)
          break
        case 'assert':
          if (assertion(inst.kind, text, at)) stack.push(p + 1)
          break
        case 'char':
        case 'match':
        default:
          list[size++] = p
      }
    }
    return size
  }

  try {
    // Matching steps over code points, so a character outside the BMP is one
    // character (as in JavaScript's `u` mode).
    for (let at = 0; ;) {
      // With no thread under way and every match beginning with `prefix`, the
      // next match can only start where `prefix` next occurs: jump there.
      if (currentCount === 0 && prefix !== undefined && !anchored && at > 0) {
        const index = text.indexOf(prefix, at)
        charge(searchCost((index < 0 ? text.length : index + prefix.length) - at, prefix.length))
        if (index < 0) return false
        if (index > at) {
          // Marks from the old position must not hide states at the new one.
          at = index
          generation = ++scratch.generation
        }
      }
      // Restart the search at every position (unanchored match). `seen` still
      // holds this generation's marks from building `current`, so the start
      // thread is not added twice. An anchored pattern starts only at 0.
      if (at === 0 || !anchored) currentCount = add(current, currentCount, 0, at)
      charge(1 + visited)
      visited = 0
      if (currentCount === 0 && anchored) return false
      if (at >= text.length) {
        for (let k = 0; k < currentCount; k++) if (insts[current[k]].op === 'match') return true
        return false
      }
      const code = text.codePointAt(at) as number
      const width = code > BMP_LIMIT ? 2 : 1
      generation = ++scratch.generation
      nextCount = 0
      for (let k = 0; k < currentCount; k++) {
        const pc = current[k]
        const inst = insts[pc]
        if (inst.op === 'match') return true
        if (inst.op === 'char' && inst.test(code))
          nextCount = add(next, nextCount, pc + 1, at + width)
      }
      ;[current, next] = [next, current]
      currentCount = nextCount
      at += width
    }
  } finally {
    scratch.current = current
    scratch.next = next
  }
}

/** Texts shorter than this skip the prefilter (it would not pay off). */
const PREFILTER_MIN_TEXT = 32

/** Steps for scanning `scanned` characters for a `length`-character string, as for the text built-ins. */
function searchCost(scanned: number, length: number): number {
  // oxlint-disable-next-line no-magic-numbers -- n/64 + n*m/512, the text built-ins' rate
  return 1 + (scanned >>> 6) + ((scanned * length) >>> 9)
}

function assertion(kind: '^' | '$' | 'b' | 'B', text: string, at: number): boolean {
  switch (kind) {
    case '^':
      return at === 0
    case '$':
      return at === text.length
    case 'b':
    case 'B':
    default: {
      const before = at > 0 && isWord(text.charCodeAt(at - 1))
      const after = at < text.length && isWord(text.charCodeAt(at))
      return (before !== after) === (kind === 'b')
    }
  }
}
