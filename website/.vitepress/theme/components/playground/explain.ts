// The rows of the playground's Explain view: every step of an evaluation
// worth reading, outermost first, each with the value it produced. Literals,
// the item of a lambda, and the parts of a field chain (`order` in
// `order.total`) are left out; a lambda's runs are listed under its call,
// one row per item, each opening into that run's own steps.
import type { Trace } from '../../../../../src/index.ts'

export interface Step {
  /** Unique within one explanation: the path of child indexes and iterations to this row. */
  key: string
  depth: number
  start: number
  end: number
  text: string
  state: 'value' | 'skipped' | 'extra' | 'error'
  value?: unknown
  error?: string
  /** A run of a lambda: the item it ran on, and whether its own steps are listed. */
  item?: { index: number; value: unknown; open: boolean; steps: number }
  /** Runs past the recorded ones, counted on the row after the last. */
  more?: number
}

/** A plain read of data: a name, or fields and fixed indexes on one (`orders[0].total`), but not `xs[ys.length - 1]`. */
const isRead = (node: Trace): boolean => {
  if (node.kind === 'Variable' || node.kind === 'It' || node.kind === 'Local') return true
  const [object, index] = node.children
  if (object === undefined || !isRead(object)) return false
  if (node.kind === 'Member') return true
  return node.kind === 'Index' && index !== undefined && (index.kind === 'Literal' || isRead(index))
}

/** A list or map written out in full (`["admin", "editor"]`): its value is its text. */
const constant = (node: Trace): boolean =>
  (node.kind === 'List' || node.kind === 'Map' || node.kind === 'Entry') &&
  node.children.every((child) => child.kind === 'Literal' || constant(child))

function state(node: Trace): Step['state'] {
  if (node.error) return 'error'
  if (!node.evaluated) return 'skipped'
  return node.extra ? 'extra' : 'value'
}

function visit(node: Trace, depth: number, key: string, open: ReadonlySet<string>, out: Step[]): void {
  // A lambda is its body; a literal or a lambda's item says nothing its parent doesn't.
  if (node.kind === 'Lambda' && node.children.length > 0) {
    node.children.forEach((child, i) => visit(child, depth, `${key}.${i}`, open, out))
    return
  }
  if (node.kind === 'Literal' || node.kind === 'It' || node.kind === 'Lambda' || constant(node)) return
  out.push({
    key,
    depth,
    start: node.start,
    end: node.end,
    text: node.text,
    state: state(node),
    value: node.value,
    error: node.error?.message,
  })
  if (!isRead(node)) node.children.forEach((child, i) => visit(child, depth + 1, `${key}.${i}`, open, out))
  for (const run of node.iterations ?? []) {
    const runKey = `${key}@${run.index}`
    const inner: Step[] = []
    visit(run.trace, depth + 2, runKey, open, inner)
    out.push({
      key: runKey,
      depth: depth + 1,
      start: run.trace.start,
      end: run.trace.end,
      text: '',
      state: run.error ? 'error' : 'value',
      value: run.result,
      error: run.error?.message,
      item: { index: run.index, value: run.item, open: open.has(runKey), steps: inner.length },
    })
    if (open.has(runKey)) out.push(...inner)
  }
  if (node.omittedIterations) {
    out.push({ key: `${key}+`, depth: depth + 1, start: node.start, end: node.end, text: '', state: 'value', more: node.omittedIterations })
  }
}

/** The rows for an explanation's trace; `open` holds the keys of the lambda runs whose steps are shown. */
export function steps(trace: Trace, open: ReadonlySet<string> = new Set()): Step[] {
  const out: Step[] = []
  visit(trace, 0, '0', open, out)
  return out
}

/** The innermost row whose source range holds `offset`: what the pointer is over in the editor. */
export function stepAt(rows: readonly Step[], offset: number): Step | undefined {
  let best: Step | undefined
  for (const row of rows) {
    if (row.item || row.more !== undefined) continue
    if (row.start <= offset && offset < row.end && (!best || row.end - row.start <= best.end - best.start)) best = row
  }
  return best
}
