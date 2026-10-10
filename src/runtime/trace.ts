import { BonsaiError, type BonsaiErrorJSON, type ErrorCode } from '../errors.js'
import { forEachChild, type BinaryOperator, type Node, type UnaryOperator } from '../syntax/ast.js'
import { durationText, isMap, isValidDuration } from './values.js'

/** One evaluated (or skipped) sub-expression. */
export interface Trace {
  /** Stable id of the syntax node (pre-order index), shared by every run of it. */
  readonly id: number
  /** Syntax node type, e.g. `Binary`, `Member`, `Call`. */
  readonly kind: Node['type']
  /** The operator of a `Binary` or `Unary` node. */
  readonly operator?: BinaryOperator | UnaryOperator
  readonly start: number
  readonly end: number
  /** The source text of this sub-expression. */
  readonly text: string
  /** False when short-circuiting skipped it (`false && x`, the untaken branch of `?:`). */
  readonly evaluated: boolean
  /**
   * True when it was evaluated only because the explanation asked for every
   * reason (`exhaustive`); ordinary evaluation would have skipped it.
   */
  readonly extra?: boolean
  /** The value it produced (a live reference into your data; see Explanation.toJSON). */
  readonly value?: unknown
  /** Why it failed, when it did. */
  readonly error?: { readonly code: ErrorCode; readonly message: string }
  readonly children: readonly Trace[]
  /** For calls with a lambda: one entry per run of the lambda (up to the cap). */
  readonly iterations?: readonly Iteration[]
  /** Lambda runs beyond the cap, counted but not recorded. */
  readonly omittedIterations?: number
}

/** A trace while it is being recorded; published as the read-only {@link Trace}. */
export interface TraceRecord extends Trace {
  evaluated: boolean
  extra?: boolean
  value?: unknown
  error?: { readonly code: ErrorCode; readonly message: string }
  children: TraceRecord[]
  iterations?: IterationRecord[]
  omittedIterations?: number
}

interface IterationRecord extends Iteration {
  readonly trace: TraceRecord
}

export interface Iteration {
  readonly index: number
  /** The list item the lambda ran on. */
  readonly item: unknown
  /** For reduce: the accumulated value passed in. */
  readonly accumulator?: unknown
  /** The lambda's result for this item. */
  readonly result?: unknown
  /** Why the lambda failed for this item, when it did. */
  readonly error?: { readonly code: ErrorCode; readonly message: string }
  /** The lambda body's trace for this item. */
  readonly trace: Trace
}

/** A {@link Trace} as JSON: values are bounded, JSON-safe copies. */
export interface TraceJSON extends Omit<Trace, 'children' | 'iterations'> {
  readonly children: readonly TraceJSON[]
  readonly iterations?: readonly IterationJSON[]
}

/** An {@link Iteration} as JSON, inside a {@link TraceJSON}. */
export interface IterationJSON extends Omit<Iteration, 'trace'> {
  readonly trace: TraceJSON
}

/** The JSON form of an explanation (`explanation.toJSON()`, used by `JSON.stringify`). */
export type ExplanationJSON = (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: BonsaiErrorJSON }
) & {
  readonly truncated: boolean
  readonly trace: TraceJSON
}

export const DEFAULT_MAX_ITERATIONS = 20

/**
 * Longest text a trace record keeps (a longer one ends with `...`), so an
 * explanation and its JSON stay bounded however long the source is. The
 * record's offsets still let a UI slice the full source.
 */
export const MAX_TRACE_TEXT = 120

const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff

/** `text` cut to `max` code units and marked with `...`, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  const splitsPair = code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST
  return `${text.slice(0, splitsPair ? max - 1 : max)}...`
}

/** `text` cut to {@link MAX_TRACE_TEXT} code units, never inside a surrogate pair. */
export function capTraceText(text: string): string {
  return cut(text, MAX_TRACE_TEXT)
}
export const DEFAULT_MAX_TRACE_NODES = 10_000

/**
 * Every recorded trace inherits a non-enumerable `toJSON`, so
 * `JSON.stringify(trace)` writes the bounded {@link TraceJSON} form instead of
 * the live values; the trace's own keys are unchanged.
 */
const TRACE_PROTOTYPE: object = Object.defineProperty({}, 'toJSON', {
  value(this: Trace): TraceJSON {
    return snapshotTrace(this)
  },
})

/** Records traces during one explained evaluation. */
export class Tracer {
  readonly root: TraceRecord
  /** Set when the node cap stopped recording; the result is still exact. */
  truncated = false
  private readonly stack: TraceRecord[] = []
  private readonly nodes = new WeakMap<TraceRecord, Node>()
  private readonly ids = new WeakMap<Node, number>()
  private suspended = 0
  private recorded = 0
  /** Above zero while evaluating a side that only exhaustive explanations run. */
  extraDepth = 0

  private readonly source: string
  /** The text of a node, when it is not the source between its offsets (a residual's). */
  private readonly textOf: ((node: Node) => string) | undefined
  private readonly maxIterations: number
  private readonly maxNodes: number
  /** Evaluate both sides of && and || so every deciding condition is recorded. */
  readonly exhaustive: boolean

  constructor(
    source: string,
    rootNode: Node,
    maxIterations: number,
    maxNodes: number,
    exhaustive: boolean,
    textOf?: (node: Node) => string,
  ) {
    this.source = source
    this.textOf = textOf
    this.maxIterations = maxIterations
    this.maxNodes = maxNodes
    this.exhaustive = exhaustive
    let next = 0
    const number = (node: Node): void => {
      this.ids.set(node, next++)
      forEachChild(node, number)
    }
    number(rootNode)
    this.root = this.create(rootNode)
    this.root.evaluated = false
  }

  private create(node: Node): TraceRecord {
    const trace = Object.create(TRACE_PROTOTYPE) as TraceRecord
    Object.assign(trace, {
      id: this.ids.get(node) ?? -1,
      kind: node.type,
      start: node.start,
      end: node.end,
      text: capTraceText(
        this.textOf === undefined
          ? this.source.slice(node.start, Math.min(node.end, node.start + MAX_TRACE_TEXT + 1))
          : this.textOf(node),
      ),
      evaluated: true,
      children: [],
      ...(node.type === 'Binary' || node.type === 'Unary' ? { operator: node.operator } : {}),
    })
    this.nodes.set(trace, node)
    return trace
  }

  private full(): boolean {
    if (this.recorded < this.maxNodes) return false
    this.truncated = true
    return true
  }

  /** Starts a node; returns undefined when recording is suspended or full. */
  enter(node: Node, extra = false): TraceRecord | undefined {
    if (this.suspended > 0) return undefined
    const parent = this.stack[this.stack.length - 1]
    let trace: TraceRecord
    if (parent === undefined) {
      trace = this.root
      trace.evaluated = true
    } else {
      if (this.full()) return undefined
      trace = this.create(node)
      if (extra || this.extraDepth > 0) trace.extra = true
      parent.children.push(trace)
    }
    this.recorded++
    this.stack.push(trace)
    return trace
  }

  exit(): void {
    this.stack.pop()
  }

  /**
   * Starts one lambda run. Returns the trace to record into, or undefined when
   * the run is not recorded (cap reached, or recording already suspended); in
   * that case recording stays suspended until the matching exitIteration.
   */
  enterIteration(
    lambda: Node,
    index: number,
    item: unknown,
    accumulator?: unknown,
  ): TraceRecord | undefined {
    const call = this.stack[this.stack.length - 1]
    if (this.suspended > 0 || call === undefined) {
      this.suspended++
      return undefined
    }
    call.iterations ??= []
    if (call.iterations.length >= this.maxIterations || this.full()) {
      call.omittedIterations = (call.omittedIterations ?? 0) + 1
      this.suspended++
      return undefined
    }
    const trace = this.create(lambda)
    this.recorded++
    call.iterations.push(
      accumulator === undefined ? { index, item, trace } : { index, item, accumulator, trace },
    )
    this.stack.push(trace)
    return trace
  }

  exitIteration(recorded: TraceRecord | undefined): void {
    if (recorded === undefined) this.suspended--
    else this.stack.pop()
  }

  /** Fills in skipped sub-expressions (in source order) and iteration results. */
  finish(): TraceRecord {
    const visit = (trace: TraceRecord): void => {
      const node = this.nodes.get(trace)
      if (node !== undefined && trace.evaluated && node.type !== 'Lambda') {
        const byNode = new Map<Node, TraceRecord>()
        for (const child of trace.children) {
          const childNode = this.nodes.get(child)
          if (childNode !== undefined && !byNode.has(childNode)) byNode.set(childNode, child)
        }
        const ordered: TraceRecord[] = []
        const placed = new Set<TraceRecord>()
        forEachChild(node, (child) => {
          const recorded = byNode.get(child)
          if (recorded !== undefined) {
            ordered.push(recorded)
            placed.add(recorded)
          } else if (
            !(child.type === 'Lambda' && trace.iterations !== undefined) &&
            // has() tests its path without evaluating it; a truncated trace
            // cannot tell skipped from unrecorded.
            node.type !== 'Has' &&
            !this.truncated
          ) {
            const skipped = this.create(child)
            skipped.evaluated = false
            ordered.push(skipped)
          }
        })
        for (const child of trace.children) if (!placed.has(child)) ordered.push(child)
        trace.children = ordered
      }
      for (const child of trace.children) visit(child)
      if (trace.iterations !== undefined) {
        trace.iterations = trace.iterations.map((iteration) => {
          visit(iteration.trace)
          const body = iteration.trace.children[0]
          if (body === undefined) return iteration
          iteration.trace.value = body.value
          if (body.error !== undefined) {
            iteration.trace.error = body.error
            return { ...iteration, error: body.error }
          }
          return { ...iteration, result: body.value }
        })
      }
    }
    visit(this.root)
    return this.root
  }
}

export function errorInfo(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof BonsaiError) return { code: error.code, message: error.message }
  return { code: 'HOST_ERROR', message: error instanceof Error ? error.message : String(error) }
}

// === reasons ===

/**
 * The conditions that decided a result: follows `&&`, `||`, and `!` down to
 * the comparisons and values that made the expression true or false (and to
 * any error). With `exhaustive`, a false `&&` lists every false condition, not
 * just the first.
 */
export function reasonsOf(root: Trace): Trace[] {
  const out: Trace[] = []
  const visit = (trace: Trace): void => {
    if (!trace.evaluated) return
    if (trace.error !== undefined) {
      const failed = trace.children.filter((child) => child.error !== undefined)
      if (failed.length === 0) out.push(trace)
      else failed.forEach(visit)
      return
    }
    if (trace.operator === '&&' || trace.operator === '||') {
      // A false && (or true ||) is decided by the children with that value;
      // otherwise every evaluated child contributed.
      const evaluated = trace.children.filter((child) => child.evaluated)
      const deciding = evaluated.filter((child) => child.value === trace.value)
      const decisive = (trace.operator === '&&') === (trace.value !== true)
      for (const child of decisive && deciding.length > 0 ? deciding : evaluated) visit(child)
      return
    }
    if (trace.operator === '!' && trace.children[0] !== undefined) {
      visit(trace.children[0])
      return
    }
    out.push(trace)
  }
  visit(root)
  // Serialized together under one budget, so logging the reasons stays bounded.
  return Object.defineProperty(out, 'toJSON', {
    value: (): TraceJSON[] => {
      const budget: SnapshotBudget = { left: SNAPSHOT_ENTRIES }
      return out.map((trace) => snapshotTrace(trace, budget))
    },
  })
}

// === snapshots (safe to serialize) ===

const SNAPSHOT_DEPTH = 4
const SNAPSHOT_ITEMS = 50
const SNAPSHOT_TEXT = 1000

/** A bounded, cycle-safe, JSON-ready copy of a value. Never runs getters. */
/**
 * How many values one snapshot may describe in total. Shared across a whole
 * toJSON() call, so a value referenced from many trace nodes cannot multiply
 * its cost.
 */
export const SNAPSHOT_ENTRIES = 10_000

export interface SnapshotBudget {
  left: number
  /**
   * The keys of each map listed so far (null when listing failed), so a map
   * recurring in the trace is listed once per snapshot, not once per node.
   */
  keys?: Map<object, readonly string[] | null>
}

/**
 * The own enumerable keys of a map, listed once per budget. Listing is
 * charged one entry per {@link SNAPSHOT_ITEMS} keys, so many large maps run
 * the budget down instead of each being listed in full.
 */
function keysOf(value: object, budget: SnapshotBudget): readonly string[] | null {
  budget.keys ??= new Map()
  const known = budget.keys.get(value)
  if (known !== undefined) return known
  let keys: readonly string[] | null = null
  try {
    keys = Object.keys(value)
    budget.left -= Math.floor(keys.length / SNAPSHOT_ITEMS)
  } finally {
    budget.keys.set(value, keys)
  }
  return keys
}

/**
 * A bounded, JSON-safe copy of a value. Getters are described, never run, and
 * host collections (typed arrays, Map, Set, and other opaque values) are
 * summarized by type. Host data that throws when read (a Proxy trap) becomes
 * `[unreadable]`.
 */
export function snapshot(
  value: unknown,
  budget: SnapshotBudget = { left: SNAPSHOT_ENTRIES },
  depth = 0,
  seen = new Set<object>(),
): unknown {
  if (budget.left <= 0) return '...'
  budget.left--
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return cut(value, SNAPSHOT_TEXT)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return `${value}n`
    case 'object':
      break
    case 'symbol':
    case 'function':
    case 'undefined':
    default:
      return `[${typeof value}]`
  }
  try {
    if (isValidDuration(value)) return durationText(value)
    const time = dateTime(value)
    if (time !== undefined)
      return Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString()
    const list = Array.isArray(value)
    if (!list && !isMap(value)) return `[${opaqueName(value)}]`
    if (seen.has(value)) return '[Circular]'
    const length = list ? (ownData(value, 'length') as number) : 0
    if (depth >= SNAPSHOT_DEPTH) return list ? `[${length} items]` : '{...}'
    seen.add(value)
    try {
      if (list) {
        const items: unknown[] = []
        for (let i = 0; i < Math.min(length, SNAPSHOT_ITEMS); i++)
          items.push(snapshot(ownData(value, String(i)), budget, depth + 1, seen))
        if (length > SNAPSHOT_ITEMS) items.push(`... ${length - SNAPSHOT_ITEMS} more`)
        return items
      }
      const keys = keysOf(value, budget)
      if (keys === null) return '[unreadable]'
      const out: Record<string, unknown> = {}
      for (const key of keys.slice(0, SNAPSHOT_ITEMS))
        out[key] = snapshot(ownData(value, key), budget, depth + 1, seen)
      if (keys.length > SNAPSHOT_ITEMS) out['...'] = `${keys.length - SNAPSHOT_ITEMS} more keys`
      return out
    } finally {
      seen.delete(value)
    }
  } catch {
    return '[unreadable]'
  }
}

/** The milliseconds of a real Date (not one that only inherits from Date.prototype). */
function dateTime(value: object): number | undefined {
  if (!(value instanceof Date)) return undefined
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return undefined
  }
}

/** A short name for a value expressions cannot read into (its built-in type tag). */
function opaqueName(value: object): string {
  return Object.prototype.toString.call(value).slice('[object '.length, -1)
}

/** An own data property's value; accessors are described, never invoked. */
function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor === undefined) return undefined
  return 'value' in descriptor ? descriptor.value : '[getter]'
}

/** The trace with every value replaced by its snapshot. */
export function snapshotTrace(
  trace: Trace,
  budget: SnapshotBudget = { left: SNAPSHOT_ENTRIES },
): TraceJSON {
  return {
    id: trace.id,
    kind: trace.kind,
    ...(trace.operator === undefined ? {} : { operator: trace.operator }),
    start: trace.start,
    end: trace.end,
    text: trace.text,
    evaluated: trace.evaluated,
    ...(trace.extra === true ? { extra: true } : {}),
    ...(trace.evaluated && trace.error === undefined
      ? { value: snapshot(trace.value, budget) }
      : {}),
    ...(trace.error === undefined ? {} : { error: trace.error }),
    children: trace.children.map((child) => snapshotTrace(child, budget)),
    ...(trace.iterations === undefined
      ? {}
      : {
          iterations: trace.iterations.map((iteration) => ({
            index: iteration.index,
            item: snapshot(iteration.item, budget),
            ...(iteration.accumulator === undefined
              ? {}
              : { accumulator: snapshot(iteration.accumulator, budget) }),
            ...(iteration.error === undefined
              ? { result: snapshot(iteration.result, budget) }
              : { error: iteration.error }),
            trace: snapshotTrace(iteration.trace, budget),
          })),
        }),
    ...(trace.omittedIterations === undefined
      ? {}
      : { omittedIterations: trace.omittedIterations }),
  }
}

// === rendering ===

const MAX_PREVIEW = 60
const PREVIEW_DEPTH = 2
/** Values one preview may describe. */
const PREVIEW_ENTRIES = 200

/**
 * One rendering's shared state: a value budget for the whole render, the keys
 * of the maps listed so far, and the preview of each object already shown, so
 * a value recurring at many nodes costs one preview.
 */
interface RenderBudget extends SnapshotBudget {
  keys: Map<object, readonly string[] | null>
  readonly previews: Map<object, string>
}

/** A short, readable rendering of a value. Never runs getters. */
function preview(value: unknown, render: RenderBudget): string {
  const shared = typeof value === 'object' && value !== null
  const known = shared ? render.previews.get(value) : undefined
  if (known !== undefined) return known
  const budget: SnapshotBudget = { left: Math.min(PREVIEW_ENTRIES, render.left), keys: render.keys }
  const before = budget.left
  const text = cut(
    JSON.stringify(snapshot(value, budget, SNAPSHOT_DEPTH - PREVIEW_DEPTH)) ?? 'null',
    MAX_PREVIEW * 2,
  )
  render.left -= before - budget.left
  if (shared) render.previews.set(value, text)
  return text
}

function outcome(trace: Trace, render: RenderBudget): string {
  if (!trace.evaluated) return '(not evaluated)'
  if (trace.error !== undefined) return `error ${trace.error.code}: ${trace.error.message}`
  return `${preview(trace.value, render)}${trace.extra === true ? '  (checked for the explanation)' : ''}`
}

/**
 * Literals and the item itself add nothing to a rendered explanation, and
 * neither does the variable under a property read (`user` under `user.age`).
 * They stay in the trace data.
 */
function shownUnder(parent: Trace): (trace: Trace) => boolean {
  const readsPath = parent.kind === 'Member' || parent.kind === 'Index'
  return (trace) =>
    trace.kind !== 'Literal' &&
    trace.kind !== 'It' &&
    !(
      readsPath &&
      (trace.kind === 'Variable' || trace.kind === 'Local') &&
      trace.evaluated &&
      trace.error === undefined
    )
}

/** Renders a trace as an indented tree. */
export function renderTrace(root: Trace, truncated = false): string {
  const lines: string[] = []
  // One budget for the whole rendering, however often a value recurs.
  const render: RenderBudget = { left: SNAPSHOT_ENTRIES, keys: new Map(), previews: new Map() }
  const visit = (trace: Trace, lead: string, rest: string): void => {
    lines.push(`${lead}${oneLine(trace.text)}  → ${outcome(trace, render)}`)
    const children = trace.children.filter(shownUnder(trace))
    const iterations = trace.iterations ?? []
    const total =
      children.length + iterations.length + (trace.omittedIterations === undefined ? 0 : 1)
    let n = 0
    const next = (): [string, string] => {
      n++
      const last = n === total
      return [`${rest}${last ? '└─ ' : '├─ '}`, `${rest}${last ? '   ' : '│  '}`]
    }
    for (const child of children) {
      const [childLead, childRest] = next()
      visit(child, childLead, childRest)
    }
    for (const iteration of iterations) {
      const [iterationLead, iterationRest] = next()
      const result =
        iteration.error === undefined
          ? preview(iteration.result, render)
          : `error ${iteration.error.code}: ${iteration.error.message}`
      const accumulator =
        iteration.accumulator === undefined
          ? ''
          : ` (acc ${preview(iteration.accumulator, render)})`
      lines.push(
        `${iterationLead}item ${iteration.index} ${preview(iteration.item, render)}${accumulator}  → ${result}`,
      )
      const body = iteration.trace.children[0]
      if (body !== undefined) {
        const inner = body.children.filter(shownUnder(body))
        inner.forEach((child, i) => {
          const last = i === inner.length - 1
          visit(
            child,
            `${iterationRest}${last ? '└─ ' : '├─ '}`,
            `${iterationRest}${last ? '   ' : '│  '}`,
          )
        })
      }
    }
    if (trace.omittedIterations !== undefined) {
      const [omittedLead] = next()
      lines.push(`${omittedLead}... ${trace.omittedIterations} more items`)
    }
  }
  visit(root, '', '')
  if (truncated) lines.push('(trace truncated: raise maxTraceNodes to record more)')
  return lines.join('\n')
}

function oneLine(text: string): string {
  return cut(text.replace(/\s+/gu, ' ').trim(), MAX_PREVIEW)
}
