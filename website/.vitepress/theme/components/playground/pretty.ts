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

const p = (text: string): Run => ({ text, cls: 'tk-punct' })

/** Lists longer than this show their first items and a count of the rest, so a huge result stays responsive. */
const MAX_ITEMS = 200

/** A value's entries (list items have no key), the shown ones only, and how many more there are. */
function entriesOf(value: object): { entries: [string | null, unknown][]; more: number } {
  const all: [string | null, unknown][] = Array.isArray(value)
    ? value.slice(0, MAX_ITEMS).map((item: unknown) => [null, item])
    : Object.entries(value)
  return { entries: all, more: Array.isArray(value) ? Math.max(0, value.length - MAX_ITEMS) : 0 }
}

/** Appends without spreading, which overflows the stack for long lists. */
function append(out: Run[], runs: readonly Run[]): void {
  for (const run of runs) out.push(run)
}

function inline(value: unknown, options: Options, seen: Set<object>): Run[] {
  if (!isNested(value)) return [scalar(value)]
  if (seen.has(value)) return [p('…')]
  seen.add(value)
  const { entries, more } = entriesOf(value)
  const list = Array.isArray(value)
  const out: Run[] = []
  if (entries.length === 0) out.push(p(list ? '[]' : '{}'))
  else {
    out.push(p(list ? '[' : '{ '))
    entries.forEach(([k, item], i) => {
      if (i) out.push(p(', '))
      if (k !== null) out.push(key(k, options), p(': '))
      append(out, inline(item, options, seen))
    })
    if (more) out.push(p(`, … ${more} more`))
    out.push(p(list ? ']' : ' }'))
  }
  seen.delete(value)
  return out
}

/**
 * `lead` is how far into its line the value starts (after its key); `indent`
 * is that line's indent; `tail` is what follows it on the line (a comma).
 */
function block(value: unknown, options: Options, indent: number, lead: number, tail: number, seen: Set<object>): Run[] {
  const flat = inline(value, options, seen)
  if (!isNested(value) || lead + length(flat) + tail <= options.width || seen.has(value)) return flat
  const { entries, more } = entriesOf(value)
  if (entries.length === 0) return flat
  seen.add(value)
  const pad = ' '.repeat(indent + 2)
  const out: Run[] = [p(Array.isArray(value) ? '[' : '{')]
  entries.forEach(([k, item], i) => {
    out.push({ text: `\n${pad}`, cls: '' })
    const head = k === null ? [] : [key(k, options), p(': ')]
    const last = i === entries.length - 1 && !more
    append(out, head)
    append(out, block(item, options, indent + 2, indent + 2 + length(head), last ? 0 : 1, seen))
    if (!last) out.push(p(','))
  })
  if (more) out.push({ text: `\n${pad}`, cls: '' }, p(`… ${more} more`))
  out.push({ text: `\n${' '.repeat(indent)}`, cls: '' }, p(Array.isArray(value) ? ']' : '}'))
  seen.delete(value)
  return out
}

/** A value as coloured runs, in Bonsai's notation (or JSON), broken over lines where it doesn't fit. */
export function runs(value: unknown, { json = false, width = 56 } = {}): Run[] {
  return block(value, { json, width }, 0, 0, 0, new Set())
}

/** A value as JSON text, one top-level entry per line, the rest broken over lines where it doesn't fit. */
export function prettyJSON(value: unknown, width = 56): string {
  return block(value, { json: true, width }, 0, Infinity, 0, new Set())
    .map((r) => r.text)
    .join('')
}

/** A value on one line, for a row of the explanation. */
export function oneLine(value: unknown): Run[] {
  return inline(value, { json: false, width: Infinity }, new Set())
}
