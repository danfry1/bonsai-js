import { acceptsArgument, analyze, signatureText, type Analysis } from '../check/checker.js'
import { internalsOf, type Environment } from '../environment.js'
import { BonsaiError, locate, type Diagnostic } from '../errors.js'
import { assertType, type FunctionDef } from '../functions/define.js'
import { forEachChild, type Node } from '../syntax/ast.js'
import { parse } from '../syntax/parser.js'
import {
  fieldOf,
  formatType,
  isExact,
  nonNull,
  t,
  unionMembers,
  unionOf,
  widen,
  type MapType,
  type Type,
} from '../types.js'

export type CompletionKind =
  | 'value'
  | 'variable'
  | 'local'
  | 'property'
  | 'function'
  | 'method'
  | 'keyword'

export interface Completion {
  readonly label: string
  readonly kind: CompletionKind
  /** Type or signature text. */
  readonly detail: string
  readonly documentation?: string
  /** Text to insert (e.g. `trim()` for a method). */
  readonly insertText: string
  /**
   * The range this item replaces, when it differs from the result's range: a
   * field that is not a plain name is inserted as `["first-name"]` in place of
   * the `.` before it.
   */
  readonly range?: { readonly start: number; readonly end: number }
}

export interface CompletionResult {
  /** The range the completion replaces (the partially typed name). */
  readonly start: number
  readonly end: number
  readonly items: readonly Completion[]
}

export interface HoverResult {
  readonly start: number
  readonly end: number
  /** Type of the expression under the cursor, or the function signature. */
  readonly detail: string
  readonly documentation?: string
}

export interface LanguageService {
  /** Completions at a UTF-16 offset in `source`. */
  complete: (source: string, offset: number) => CompletionResult
  /** Type information for the expression at `offset`. */
  hover: (source: string, offset: number) => HoverResult | undefined
  /** Every syntax and check diagnostic, never throwing. */
  diagnostics: (source: string) => readonly Diagnostic[]
}

const PROBE = '__bonsai_probe__'

const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '${': '}' }
const KEYWORDS = ['true', 'false', 'null', 'let', 'has', 'try', 'not in', 'in']
const IDENT_CHAR = /[A-Za-z0-9_$]/u
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

/**
 * A UTF-16 offset inside `source`: one past the end, or a non-numeric offset,
 * means the end. A negative or fractional offset is a caller bug: RangeError.
 */
function clampOffset(source: string, offset: number): number {
  if (!Number.isFinite(offset)) return source.length
  if (offset < 0 || !Number.isInteger(offset)) {
    throw new RangeError(`An offset must be a whole number of at least 0, not ${offset}`)
  }
  return Math.min(offset, source.length)
}

export interface LanguageServiceOptions {
  /**
   * The type every expression must have, as `check(source, { expect })` takes
   * it: diagnostics then include EXPECTED_TYPE (a filter editor passes
   * `t.boolean()`).
   */
  readonly expect?: Type | undefined
}

/** Reads the service options once: only `expect`, which must be a type built with t. */
function serviceExpect(options: unknown): Type | undefined {
  if (options === undefined) return undefined
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Language service options must be an object')
  for (const key of Object.keys(options)) {
    if (key !== 'expect')
      throw new TypeError(`Unknown language service option key "${key}" (expected one of: expect)`)
  }
  const expect = (options as { expect?: unknown }).expect
  if (expect !== undefined) assertType(expect, 'Language service option "expect"')
  return expect
}

/**
 * Editor features over an environment. Nothing here evaluates an expression or
 * calls a host function: completions and hovers come from the static checker.
 */
export function createLanguageService(
  env: Environment,
  options?: LanguageServiceOptions,
): LanguageService {
  const { checkEnv, parseLimits } = internalsOf(env)
  const expect = serviceExpect(options)
  const checkOptions = expect === undefined ? undefined : { expect }

  function tryAnalyze(source: string, probe?: string): Analysis | undefined {
    try {
      return analyze(parse(source, parseLimits), checkEnv, { probe, expected: expect })
    } catch (error) {
      if (error instanceof BonsaiError) return undefined
      throw error
    }
  }

  function complete(source: string, offset: number): CompletionResult {
    const cursor = clampOffset(source, offset)
    let from = cursor
    while (from > 0 && IDENT_CHAR.test(source[from - 1])) from--
    let to = cursor
    while (to < source.length && IDENT_CHAR.test(source[to])) to++
    const typed = source.slice(from, cursor)
    const empty: CompletionResult = { start: from, end: to, items: [] }

    const prefix = source.slice(0, from)
    const scan = scanOpen(prefix)
    // Inside a string after == or != (user.plan == "p|), in a list after `in`
    // (user.plan in ["pro", "f|), or as a call argument (roles.includes("a|),
    // xs.sortBy(.k, "d|)): offer the values the other side allows.
    const quoted =
      /(?:==|!=|[(,]|\bin\s*\[(?:\s*(?:"[^"\\]*"|'[^'\\]*')\s*,)*)\s*(?<quote>["'])(?<typed>[^"'\\]*)$/u.exec(
        source.slice(0, cursor),
      )
    if (quoted !== null && scan.inString) {
      const enumPrefix = quoted.groups?.typed ?? ''
      const quoteAt = cursor - enumPrefix.length
      const outer = source.slice(0, quoteAt - 1)
      const outerScan = scanOpen(outer)
      const analysis = tryAnalyze(`${outer}${PROBE}${outerScan.closers}`, PROBE)
      const values =
        analysis === undefined ? [] : literalValues(analysis).filter((v) => typeof v === 'string')
      const items = values.map((v) => ({
        label: v,
        kind: 'value' as const,
        detail: 'value',
        insertText: v,
      }))
      let end = cursor
      while (end < source.length && source[end] !== quoted.groups?.quote) end++
      return { start: quoteAt, end, items: rank(items, enumPrefix) }
    }
    if (scan.inString || scan.inComment) return empty
    if (from > 0 && /[0-9]/u.test(source[from - 1])) return empty

    // Whitespace and comments may sit between a `.` and the cursor.
    const before = withoutTrailingTrivia(prefix)
    const afterDot = before.endsWith('?.') || (before.endsWith('.') && !before.endsWith('...'))
    const probeText = afterDot ? `${before}${PROBE}` : `${prefix}${PROBE}`

    let analysis: Analysis | undefined
    for (const suffix of [
      scan.closers,
      ` : null${scan.closers}`,
      `; null${scan.closers}`,
      ` 0${scan.closers}`,
      // try(x, fallback) and a computed key [k]: v need their second half.
      `, null${scan.closers}`,
      `${scan.closers.slice(0, 1)}: null${scan.closers.slice(1)}`,
    ]) {
      analysis = tryAnalyze(probeText + suffix, PROBE)
      if (analysis !== undefined) break
    }
    if (analysis === undefined) return empty

    const dotAt = afterDot && !before.endsWith('?.') ? before.length - 1 : undefined
    const items = afterDot
      ? memberCompletions(analysis, dotAt === undefined ? undefined : { start: dotAt, end: to })
      : nameCompletions(analysis)
    if (!afterDot && /(?:==|!=)\s*$/u.test(prefix)) {
      for (const value of literalValues(analysis)) {
        items.unshift({
          label: JSON.stringify(value),
          kind: 'value',
          detail: 'value',
          insertText: JSON.stringify(value),
        })
      }
    }
    return { start: from, end: to, items: rank(items, typed) }
  }

  /** Literal members of the type on the other side of `== probe` or `in [..., probe]`. */
  function literalValues(analysis: Analysis): (string | number | boolean)[] {
    let other: Type | undefined
    const isProbe = (node: Node): boolean => node.type === 'Variable' && node.name === PROBE
    const find = (node: Node): void => {
      if (other !== undefined) return
      if (node.type === 'Binary' && (node.operator === '==' || node.operator === '!=')) {
        if (isProbe(node.right)) other = analysis.types.get(node.left)
        else if (isProbe(node.left)) other = analysis.types.get(node.right)
        if (other !== undefined) return
      }
      if (
        node.type === 'Binary' &&
        (node.operator === 'in' || node.operator === 'not in') &&
        node.right.type === 'List' &&
        node.right.items.some((item) => item.type !== 'Spread' && isProbe(item))
      ) {
        other = analysis.types.get(node.left)
        if (other !== undefined) return
      }
      if (node.type === 'Call') {
        const index = node.args.findIndex((arg) => arg.type !== 'Spread' && isProbe(arg))
        if (index > 0) {
          const receiver = node.args[0]
          if (node.name === 'includes' && index === 1 && receiver.type !== 'Spread') {
            // roles.includes("a"): the list's element type.
            const list = analysis.types.get(receiver)
            const listType = list === undefined ? undefined : nonNull(list)
            if (listType?.kind === 'list') other = listType.element
          } else {
            // A parameter declared as literals (sortBy's "asc" | "desc").
            const plan = analysis.calls.get(node)
            const overload = plan?.def.overloads[plan.candidates[0] ?? 0]
            const param = overload?.params[index] ?? overload?.rest
            if (param !== undefined && unionMembers(param).every((m) => m.kind === 'literal'))
              other = param
          }
          if (other !== undefined) return
        }
      }
      forEachChild(node, find)
    }
    find(analysis.root)
    if (other === undefined) return []
    return unionMembers(other).flatMap((member) =>
      member.kind === 'literal' ? [member.value] : [],
    )
  }

  /** Completions after `receiver.`; `dot` is the range of the `.` and the typed name. */
  function memberCompletions(
    analysis: Analysis,
    dot: { start: number; end: number } | undefined,
  ): Completion[] {
    let receiver: Type | undefined
    // `.name` directly after an implicit-lambda `.` (xs.map(.name)).
    let onItem = false
    const find = (node: Node): void => {
      if (receiver !== undefined) return
      if (node.type === 'Member' && node.name === PROBE) {
        receiver = analysis.types.get(node.object)
        onItem = node.object.type === 'It'
        return
      }
      forEachChild(node, find)
    }
    find(analysis.root)
    if (receiver === undefined) return []
    const target = nonNull(receiver)
    const items: Completion[] = []
    const members = unionMembers(target)
    // Fields of every map member (a union of records offers each one's keys).
    const maps = members.filter((member): member is MapType => member.kind === 'map')
    const names = new Set(maps.flatMap((member) => Object.keys(member.fields)))
    // The type a read has, as check() and hover report it: a member without
    // the field reads its `rest` (or null), and a declared object may hold any key.
    const readOf = (member: MapType, name: string): Type => {
      const field = fieldOf(member, name)
      if (field !== undefined) return field
      if (member.rest !== undefined) return t.optional(member.rest)
      return isExact(member) ? t.null() : t.any()
    }
    for (const name of names) {
      const detail = formatType(unionOf(maps.map((member) => readOf(member, name))))
      if (IDENTIFIER.test(name)) {
        items.push({ label: name, kind: 'property', detail, insertText: name })
      } else {
        // `user.first-name` would subtract: index it instead. The item's own
        // `.` stays: xs.map(.["first-name"]).
        items.push({
          label: name,
          kind: 'property',
          detail,
          insertText: `${onItem ? '.' : ''}[${JSON.stringify(name)}]`,
          ...(dot === undefined ? {} : { range: dot }),
        })
      }
    }
    if (
      members.some(
        (member) =>
          member.kind === 'list' ||
          member.kind === 'string' ||
          (member.kind === 'literal' && typeof member.value === 'string'),
      )
    ) {
      items.push({ label: 'length', kind: 'property', detail: 'number', insertText: 'length' })
    }
    // Functions whose first parameter accepts the receiver can be called as
    // methods; for a union, every member must be accepted by some signature.
    const receivers = unionMembers(widen(target))
    for (const name of checkEnv.functionNames()) {
      const def = checkEnv.lookup(name) as FunctionDef
      const firstOf = (o: (typeof def.overloads)[number]): Type | undefined => {
        const first = o.params[0] ?? o.rest
        return first === undefined || first.kind === 'function' ? undefined : first
      }
      const accepts = (o: (typeof def.overloads)[number], member: Type): boolean => {
        const first = firstOf(o)
        return first !== undefined && (member.kind === 'any' || acceptsArgument(first, member))
      }
      const applicable = def.overloads.filter((o) => receivers.some((member) => accepts(o, member)))
      if (
        applicable.length === 0 ||
        !receivers.every((member) => applicable.some((o) => accepts(o, member)))
      )
        continue
      items.push({
        label: name,
        kind: 'method',
        detail: applicable.map((o) => signatureText(name, o)).join('\n'),
        documentation: def.description,
        insertText: `${name}(${takesMore(def) ? '' : ')'}`,
      })
    }
    return items
  }

  function nameCompletions(analysis: Analysis): Completion[] {
    const items: Completion[] = []
    const scope = analysis.probeScope
    if (scope?.it !== undefined) {
      items.push({
        label: '.',
        kind: 'local',
        detail: formatType(scope.it),
        documentation: 'The current item',
        insertText: '.',
      })
    }
    for (const [name, type] of scope?.locals ?? []) {
      items.push({ label: name, kind: 'local', detail: formatType(type), insertText: name })
    }
    for (const [name, type] of Object.entries(checkEnv.variables ?? {})) {
      items.push({ label: name, kind: 'variable', detail: formatType(type), insertText: name })
    }
    for (const name of checkEnv.functionNames()) {
      const def = checkEnv.lookup(name) as FunctionDef
      items.push({
        label: name,
        kind: 'function',
        detail: def.overloads.map((o) => signatureText(name, o)).join('\n'),
        documentation: def.description,
        insertText: `${name}(`,
      })
    }
    for (const keyword of KEYWORDS) {
      items.push({
        label: keyword,
        kind: 'keyword',
        detail: 'keyword',
        insertText: keyword === 'has' || keyword === 'try' ? `${keyword}(` : keyword,
      })
    }
    return items
  }

  function hover(source: string, rawOffset: number): HoverResult | undefined {
    if (!Number.isFinite(rawOffset)) return undefined
    const offset = clampOffset(source, rawOffset)
    const analysis = tryAnalyze(source)
    if (analysis === undefined) return undefined
    let best: Node | undefined
    const visit = (node: Node): void => {
      if (offset < node.start || offset > node.end) return
      // The implicit item's `.` ends where the name after it starts (`.cat`):
      // an offset on that name belongs to the member, not the item.
      if (node.type === 'It' && offset === node.end && best?.type === 'Member') return
      best = node
      forEachChild(node, visit)
    }
    visit(analysis.root)
    if (best === undefined) return undefined
    const node: Node = best
    if (node.type === 'Call' && offset >= node.nameStart && offset <= node.nameEnd) {
      const def = checkEnv.lookup(node.name)
      if (def !== undefined) {
        return {
          start: node.nameStart,
          end: node.nameEnd,
          detail: def.overloads.map((o) => signatureText(def.name, o)).join('\n'),
          documentation: def.description,
        }
      }
    }
    const type = analysis.types.get(node)
    if (type === undefined) return undefined
    return {
      start: node.start,
      end: node.end,
      detail: formatType(type.kind === 'literal' ? widen(type) : type),
    }
  }

  function diagnostics(source: string): readonly Diagnostic[] {
    // Spans stay inside the source (an error at the end is zero-width there).
    const found = env.check(source, checkOptions).diagnostics
    if (found.every((d) => d.start >= 0 && d.end >= d.start && d.end <= source.length)) return found
    return locate(
      source,
      found.map((d) => {
        const start = Math.min(Math.max(d.start, 0), source.length)
        return { ...d, start, end: Math.min(Math.max(d.end, start), source.length) }
      }),
    )
  }

  return Object.freeze({ complete, hover, diagnostics })
}

function takesMore(def: FunctionDef): boolean {
  return def.overloads.some((o) => o.params.length > 1 || o.rest !== undefined)
}

function rank(items: readonly Completion[], typed: string): Completion[] {
  const needle = typed.toLowerCase()
  const scored = items
    .map((item) => {
      const label = item.label.toLowerCase()
      let score = 0
      if (needle === '') score = 1
      else if (label.startsWith(needle)) score = 2
      else if (label.includes(needle)) score = 1
      return { item, score }
    })
    .filter((entry) => entry.score > 0)
  const order: Record<CompletionKind, number> = {
    value: -1,
    local: 0,
    property: 1,
    variable: 2,
    method: 3,
    function: 4,
    keyword: 5,
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      order[a.item.kind] - order[b.item.kind] ||
      a.item.label.localeCompare(b.item.label),
  )
  const seen = new Set<string>()
  return scored
    .map((entry) => entry.item)
    .filter((item) => !seen.has(item.label) && (seen.add(item.label), true))
}

/** `text` without the whitespace and comments at its end. */
function withoutTrailingTrivia(text: string): string {
  const startOf = new Map(commentSpans(text).map((span) => [span.end, span.start]))
  let end = text.length
  for (;;) {
    while (end > 0 && /\s/u.test(text[end - 1])) end--
    const start = startOf.get(end)
    if (start === undefined) break
    end = start
  }
  return text.slice(0, end)
}

/** The comments in `text` (outside strings and templates), as [start, end) spans. */
function commentSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let i = 0
  let template = 0
  while (i < text.length) {
    const ch = text[i]
    if (template > 0 && ch === '`') {
      template--
      i++
    } else if (template > 0) {
      i += ch === '\\' ? 2 : 1
    } else if (ch === '`') {
      template++
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i)
      if (end === -1) end = text.length
      spans.push({ start: i, end })
      i = end
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? text.length : close + 2
      spans.push({ start: i, end })
      i = end
    } else if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1
      i = j + 1
    } else i++
  }
  return spans
}

/** Tracks open brackets, strings, and templates in a prefix to synthesize closers. */
function scanOpen(text: string): { closers: string; inString: boolean; inComment: boolean } {
  const stack: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const top = stack[stack.length - 1]
    if (top === '`') {
      if (ch === '\\') i += 2
      else if (ch === '`') {
        stack.pop()
        i++
      } else if (ch === '$' && text[i + 1] === '{') {
        stack.push('${')
        i += 2
      } else i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      if (end === -1) return { closers: '', inString: false, inComment: true }
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return { closers: '', inString: false, inComment: true }
      i = end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) return { closers: '', inString: true, inComment: false }
      i = j + 1
      continue
    }
    if (ch === '`') stack.push('`')
    else if (ch === '(' || ch === '[' || ch === '{') stack.push(ch)
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (top === '${' && ch === '}') stack.pop()
      else if (top === '(' || top === '[' || top === '{') stack.pop()
    }
    i++
  }
  if (stack[stack.length - 1] === '`') return { closers: '', inString: true, inComment: false }
  const closers = stack
    .reverse()
    .map((open) => CLOSER[open] ?? '`')
    .join('')
  return { closers, inString: false, inComment: false }
}
