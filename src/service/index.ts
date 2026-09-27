import { analyze, signatureText, type Analysis } from '../check/checker.js'
import { internalsOf, type Environment } from '../environment.js'
import { BonsaiError, type Diagnostic } from '../errors.js'
import type { FunctionDef } from '../functions/define.js'
import { forEachChild, type Node } from '../syntax/ast.js'
import { parse } from '../syntax/parser.js'
import { formatType, isAssignable, nonNull, widen, type Type } from '../types.js'

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
}

export interface CompletionResult {
  /** The range the completion replaces (the partially typed name). */
  readonly from: number
  readonly to: number
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

/**
 * Editor features over an environment. Nothing here evaluates an expression or
 * calls a host function: completions and hovers come from the static checker.
 */
export function createLanguageService(env: Environment<never>): LanguageService {
  const { checkEnv, parseLimits } = internalsOf(env)

  function tryAnalyze(source: string, probe?: string): Analysis | undefined {
    try {
      return analyze(parse(source, parseLimits), checkEnv, { probe })
    } catch (error) {
      if (error instanceof BonsaiError) return undefined
      throw error
    }
  }

  function complete(source: string, offset: number): CompletionResult {
    const cursor = Math.max(0, Math.min(offset, source.length))
    let from = cursor
    while (from > 0 && IDENT_CHAR.test(source[from - 1])) from--
    let to = cursor
    while (to < source.length && IDENT_CHAR.test(source[to])) to++
    const typed = source.slice(from, cursor)
    const empty: CompletionResult = { from, to, items: [] }

    const prefix = source.slice(0, from)
    const scan = scanOpen(prefix)
    // Inside a string after == or != (user.plan == "p|): offer the enum values.
    const quoted = /(?:==|!=)\s*(?<quote>["'])(?<typed>[^"'\\]*)$/u.exec(source.slice(0, cursor))
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
      return { from: quoteAt, to: end, items: rank(items, enumPrefix) }
    }
    if (scan.inString || scan.inComment) return empty
    if (from > 0 && /[0-9]/u.test(source[from - 1])) return empty

    const before = prefix.trimEnd()
    const afterDot = before.endsWith('?.') || (before.endsWith('.') && !before.endsWith('...'))
    const probeText = afterDot ? `${prefix.trimEnd()}${PROBE}` : `${prefix}${PROBE}`

    let analysis: Analysis | undefined
    for (const suffix of [
      scan.closers,
      ` : null${scan.closers}`,
      `; null${scan.closers}`,
      ` 0${scan.closers}`,
    ]) {
      analysis = tryAnalyze(probeText + suffix, PROBE)
      if (analysis !== undefined) break
    }
    if (analysis === undefined) return empty

    const items = afterDot ? memberCompletions(analysis) : nameCompletions(analysis)
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
    return { from, to, items: rank(items, typed) }
  }

  /** Literal members of the type on the other side of `== probe`. */
  function literalValues(analysis: Analysis): (string | number | boolean)[] {
    let other: Type | undefined
    const find = (node: Node): void => {
      if (other !== undefined) return
      if (node.type === 'Binary' && (node.operator === '==' || node.operator === '!=')) {
        if (node.right.type === 'Variable' && node.right.name === PROBE)
          other = analysis.types.get(node.left)
        else if (node.left.type === 'Variable' && node.left.name === PROBE)
          other = analysis.types.get(node.right)
        if (other !== undefined) return
      }
      forEachChild(node, find)
    }
    find(analysis.root)
    if (other === undefined) return []
    const members = other.kind === 'union' ? other.types : [other]
    return members.flatMap((member) => (member.kind === 'literal' ? [member.value] : []))
  }

  function memberCompletions(analysis: Analysis): Completion[] {
    let receiver: Type | undefined
    const find = (node: Node): void => {
      if (receiver !== undefined) return
      if (node.type === 'Member' && node.name === PROBE) {
        receiver = analysis.types.get(node.object)
        return
      }
      forEachChild(node, find)
    }
    find(analysis.root)
    if (receiver === undefined) return []
    const target = nonNull(receiver)
    const items: Completion[] = []
    if (target.kind === 'map') {
      for (const [name, type] of Object.entries(target.fields)) {
        items.push({ label: name, kind: 'property', detail: formatType(type), insertText: name })
      }
    }
    if (
      target.kind === 'list' ||
      target.kind === 'string' ||
      (target.kind === 'literal' && typeof target.value === 'string')
    ) {
      items.push({ label: 'length', kind: 'property', detail: 'number', insertText: 'length' })
    }
    // Functions whose first parameter accepts the receiver can be called as methods.
    for (const name of checkEnv.functionNames()) {
      const def = checkEnv.lookup(name) as FunctionDef
      const applicable = def.overloads.filter((o) => {
        const first = o.params[0] ?? o.rest
        return (
          first !== undefined &&
          first.kind !== 'function' &&
          (target.kind === 'any' || isAssignable(widen(target), first))
        )
      })
      if (applicable.length === 0) continue
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

  function hover(source: string, offset: number): HoverResult | undefined {
    const analysis = tryAnalyze(source)
    if (analysis === undefined) return undefined
    let best: Node | undefined
    const visit = (node: Node): void => {
      if (offset < node.start || offset > node.end) return
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
    return env.check(source).diagnostics
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
