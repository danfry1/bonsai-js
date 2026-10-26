// Lays out a value over lines the way a person would write it: anything that
// fits in `width` characters stays on one line, anything bigger puts each
// entry on its own line. As coloured runs (for the result) or plain JSON text
// (for the examples' data).
import { Duration } from '../../../../../src/index.ts'

export interface Run {
  text: string
  /** The syntax class the editors use: tk-str, tk-lit, tk-prop, tk-punct, or none. */
  cls: string
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

interface Options {
  /** JSON quotes every key; otherwise keys that are names go unquoted, as Bonsai writes a map. */
  json: boolean
  width: number
}

function key(name: string, options: Options): Run {
  return { text: !options.json && IDENT.test(name) ? name : JSON.stringify(name), cls: 'tk-prop' }
}

function scalar(value: unknown): Run {
  if (value === null || value === undefined) return { text: 'null', cls: 'tk-lit' }
  if (typeof value === 'string') return { text: JSON.stringify(value), cls: 'tk-str' }
  if (typeof value === 'number') return { text: Object.is(value, -0) ? '0' : String(value), cls: 'tk-lit' }
  if (typeof value === 'boolean') return { text: String(value), cls: 'tk-lit' }
  if (value instanceof Date) return { text: value.toISOString(), cls: 'tk-str' }
  if (value instanceof Duration) return { text: value.toString(), cls: 'tk-str' }
  return { text: String(value), cls: '' }
}

const isNested = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Duration)

const length = (runs: readonly Run[]) => runs.reduce((n, r) => n + r.text.length, 0)

function inline(value: unknown, options: Options, seen: Set<object>): Run[] {
  if (!isNested(value)) return [scalar(value)]
  if (seen.has(value)) return [{ text: '…', cls: 'tk-punct' }]
  seen.add(value)
  const p = (text: string): Run => ({ text, cls: 'tk-punct' })
  let out: Run[]
  if (Array.isArray(value)) {
    out = [p('[')]
    value.forEach((item, i) => out.push(...(i ? [p(', ')] : []), ...inline(item, options, seen)))
    out.push(p(']'))
  } else {
    const entries = Object.entries(value)
    out = entries.length ? [p('{ ')] : [p('{}')]
    entries.forEach(([k, item], i) => out.push(...(i ? [p(', ')] : []), key(k, options), p(': '), ...inline(item, options, seen)))
    if (entries.length) out.push(p(' }'))
  }
  seen.delete(value)
  return out
}

/** `lead` is how far into its line the value starts (after its key); `indent` is that line's indent. */
function block(value: unknown, options: Options, indent: number, lead: number, seen: Set<object>): Run[] {
  const flat = inline(value, options, seen)
  if (!isNested(value) || lead + length(flat) <= options.width || seen.has(value)) return flat
  seen.add(value)
  const p = (text: string): Run => ({ text, cls: 'tk-punct' })
  const pad = ' '.repeat(indent + 2)
  const entries: [string | null, unknown][] = Array.isArray(value)
    ? value.map((item) => [null, item])
    : Object.entries(value)
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  const out: Run[] = [p(open)]
  entries.forEach(([k, item], i) => {
    out.push({ text: `\n${pad}`, cls: '' })
    const head = k === null ? [] : [key(k, options), p(': ')]
    out.push(...head, ...block(item, options, indent + 2, indent + 2 + length(head), seen))
    if (i < entries.length - 1) out.push(p(','))
  })
  out.push({ text: `\n${' '.repeat(indent)}`, cls: '' }, p(close))
  seen.delete(value)
  return out
}

/** A value as coloured runs, in Bonsai's notation (or JSON), broken over lines where it doesn't fit. */
export function runs(value: unknown, { json = false, width = 56 } = {}): Run[] {
  return block(value, { json, width }, 0, 0, new Set())
}

/** A value as JSON text, one top-level entry per line, the rest broken over lines where it doesn't fit. */
export function prettyJSON(value: unknown, width = 56): string {
  return block(value, { json: true, width }, 0, Infinity, new Set())
    .map((r) => r.text)
    .join('')
}

/** A value on one line, for a row of the explanation. */
export function oneLine(value: unknown): Run[] {
  return inline(value, { json: false, width: Infinity }, new Set())
}
