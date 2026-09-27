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
  | { kind: 'char'; test: CharTest }
  | { kind: 'assert'; assert: '^' | '$' | 'b' | 'B' }
  | { kind: 'concat'; items: Ast[] }
  | { kind: 'alt'; items: Ast[] }
  | { kind: 'repeat'; item: Ast; min: number; max: number }

export class RegexSyntaxError extends Error {}

const MAX_PROGRAM = 5000
const MAX_REPEAT = 1000

export interface Program {
  readonly insts: readonly Inst[]
}

// Character codes the engine compares against.
const CH_BACKSPACE = 8
const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_SPACE = 32
const CH_0 = 48
const CH_9 = 57
const CH_UPPER_A = 65
const CH_UPPER_Z = 90
const CH_UNDERSCORE = 95
const CH_LOWER_A = 97
const CH_LOWER_Z = 122
const CH_NBSP = 0xa0
const CH_LINE_SEPARATOR = 0x2028
const CH_PARAGRAPH_SEPARATOR = 0x2029
const CH_BOM = 0xfeff
/** Distance between an ASCII upper-case letter and its lower-case form. */
const ASCII_CASE_OFFSET = 32
/** One extra step is charged per 2^3 = 8 live NFA threads. */
const THREAD_COST_SHIFT = 3

const isDigit = (c: number): boolean => c >= CH_0 && c <= CH_9
const isWord = (c: number): boolean =>
  isDigit(c) ||
  (c >= CH_UPPER_A && c <= CH_UPPER_Z) ||
  (c >= CH_LOWER_A && c <= CH_LOWER_Z) ||
  c === CH_UNDERSCORE
/** The characters JavaScript's \s matches besides TAB..CR, from the ECMAScript WhiteSpace and LineTerminator sets. */
const SPACES = new Set(
  [
    CH_SPACE,
    CH_NBSP,
    '\u1680',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u202f',
    '\u205f',
    '\u3000',
  ]
    .map((c) => (typeof c === 'number' ? c : c.charCodeAt(0)))
    .concat([CH_LINE_SEPARATOR, CH_PARAGRAPH_SEPARATOR, CH_BOM]),
)
const isSpace = (c: number): boolean => (c >= CH_TAB && c <= CH_CR) || SPACES.has(c)

function lower(c: number): number {
  return c >= CH_UPPER_A && c <= CH_UPPER_Z ? c + ASCII_CASE_OFFSET : c
}
function upper(c: number): number {
  return c >= CH_LOWER_A && c <= CH_LOWER_Z ? c - ASCII_CASE_OFFSET : c
}

type Atom = { readonly code: number } | { readonly test: CharTest } | { readonly assert: 'b' | 'B' }

const MAX_GROUP_DEPTH = 100
const BMP_LIMIT = 0xffff
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
  const fail = (message: string): never => {
    throw new RegexSyntaxError(`${message} at position ${i + offset} in /${source}/`)
  }

  const literal = (code: number): CharTest =>
    ignoreCase ? (c) => c === code || lower(c) === lower(code) : (c) => c === code

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
    if (ch === '*') [min, max] = [0, Infinity]
    else if (ch === '+') [min, max] = [1, Infinity]
    else if (ch === '?') [min, max] = [0, 1]
    else if (ch === '{' && /^\{\d+(?:,\d*)?\}/u.test(pattern.slice(i))) {
      const match = /^\{(?<min>\d+)(?<range>,(?<max>\d*))?\}/u.exec(
        pattern.slice(i),
      ) as RegExpExecArray
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
        return { kind: 'char', test: 'code' in atom ? literal(atom.code) : atom.test }
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
        return { kind: 'char', test: literal(readCodePoint()) }
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
        return { test: isDigit }
      case 'D':
        return { test: (c) => !isDigit(c) }
      case 'w':
        return { test: isWord }
      case 'W':
        return { test: (c) => !isWord(c) }
      case 's':
        return { test: isSpace }
      case 'S':
        return { test: (c) => !isSpace(c) }
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
        return { code: hexEscape(4, '\\u') }
      }
      case 'x':
        return { code: hexEscape(2, '\\x') }
      default:
        if (/[1-9]/u.test(e)) fail('Backreferences are not supported')
        if (/[A-Za-z]/u.test(e)) fail(`Unknown escape \\${e}`)
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
    const tests: CharTest[] = []
    while (i < pattern.length && pattern[i] !== ']') {
      const low = classAtom()
      if (pattern[i] === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
        i++
        const high = classAtom()
        if (!('code' in low) || !('code' in high) || high.code < low.code)
          fail('Invalid class range')
        const a = (low as { code: number }).code
        const b = (high as { code: number }).code
        tests.push(
          ignoreCase
            ? (c) =>
                (c >= a && c <= b) ||
                (lower(c) >= a && lower(c) <= b) ||
                (upper(c) >= a && upper(c) <= b)
            : (c) => c >= a && c <= b,
        )
      } else if ('code' in low) tests.push(literal(low.code))
      else if ('test' in low) tests.push(low.test)
    }
    if (pattern[i] !== ']') fail('Missing ]')
    i++
    // As in JavaScript, [] matches nothing and [^] matches any character.
    return negated ? (c) => !tests.some((test) => test(c)) : (c) => tests.some((test) => test(c))
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
  return { insts }
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
 * Whether `program` matches anywhere in `text`. `charge(n)` is called with the
 * number of NFA threads advanced per character, so cost is accounted.
 */
export function searchRegex(program: Program, text: string, charge: (n: number) => void): boolean {
  const { insts } = program
  const n = insts.length
  let current = new Int32Array(n)
  let next = new Int32Array(n)
  let currentCount = 0
  let nextCount = 0
  const seen = new Int32Array(n).fill(-1)
  let generation = 0

  // Adds a thread at `pc`, following jumps, splits, and assertions at position `at`.
  const add = (list: Int32Array, count: number, pc: number, at: number): number => {
    const stack: number[] = [pc]
    let size = count
    while (stack.length > 0) {
      const p = stack.pop() as number
      if (seen[p] === generation) continue
      seen[p] = generation
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

  // Matching steps over code points, so a character outside the BMP is one
  // character (as in JavaScript's `u` mode and RE2).
  for (let at = 0; ;) {
    // Restart the search at every position (unanchored match). `seen` still
    // holds this generation's marks from building `current`, so the start
    // thread is not added twice.
    currentCount = add(current, currentCount, 0, at)
    charge(1 + (currentCount >>> THREAD_COST_SHIFT))
    if (at >= text.length) {
      for (let k = 0; k < currentCount; k++) if (insts[current[k]].op === 'match') return true
      return false
    }
    const code = text.codePointAt(at) as number
    const width = code > BMP_LIMIT ? 2 : 1
    generation++
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
