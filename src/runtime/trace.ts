import { BonsaiError } from '../errors.js'
import { forEachChild, type Node } from '../syntax/ast.js'
import { Duration } from './values.js'

/** One evaluated (or skipped) sub-expression. */
export interface Trace {
  /** Stable id of the syntax node (pre-order index), shared by every run of it. */
  readonly id: number
  /** Syntax node type, e.g. `Binary`, `Member`, `Call`. */
  readonly kind: Node['type']
  /** The operator of a `Binary` or `Unary` node. */
  readonly operator?: string
  readonly start: number
  readonly end: number
  /** The source text of this sub-expression. */
  readonly text: string
  /** False when short-circuiting skipped it (`false && x`, the untaken branch of `?:`). */
  evaluated: boolean
  /**
   * True when it was evaluated only because the explanation asked for every
   * reason (`exhaustive`); ordinary evaluation would have skipped it.
   */
  extra?: boolean
  /** The value it produced (a live reference into your data; see Explanation.toJSON). */
  value?: unknown
  /** Why it failed, when it did. */
  error?: { readonly code: string; readonly message: string }
  children: Trace[]
  /** For calls with a lambda: one entry per run of the lambda (up to the cap). */
  iterations?: Iteration[]
  /** Lambda runs beyond the cap, counted but not recorded. */
  omittedIterations?: number
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
  readonly error?: { readonly code: string; readonly message: string }
  /** The lambda body's trace for this item. */
  readonly trace: Trace
}

export const DEFAULT_MAX_ITERATIONS = 20
export const DEFAULT_MAX_TRACE_NODES = 10_000

/** Records traces during one explained evaluation. */
export class Tracer {
  readonly root: Trace
  /** Set when the node cap stopped recording; the result is still exact. */
  truncated = false
  private readonly stack: Trace[] = []
  private readonly nodes = new WeakMap<Trace, Node>()
  private readonly ids = new WeakMap<Node, number>()
  private suspended = 0
  private recorded = 0
  /** Above zero while evaluating a side that only exhaustive explanations run. */
  extraDepth = 0

  private readonly source: string
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
  ) {
    this.source = source
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

  private create(node: Node): Trace {
    const base = {
      id: this.ids.get(node) ?? -1,
      kind: node.type,
      start: node.start,
      end: node.end,
      text: this.source.slice(node.start, node.end),
      evaluated: true,
      children: [],
    }
    const trace: Trace =
      node.type === 'Binary' || node.type === 'Unary' ? { ...base, operator: node.operator } : base
    this.nodes.set(trace, node)
    return trace
  }

  private full(): boolean {
    if (this.recorded < this.maxNodes) return false
    this.truncated = true
    return true
  }

  /** Starts a node; returns undefined when recording is suspended or full. */
  enter(node: Node, extra = false): Trace | undefined {
    if (this.suspended > 0) return undefined
    const parent = this.stack[this.stack.length - 1]
    let trace: Trace
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
  ): Trace | undefined {
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

  exitIteration(recorded: Trace | undefined): void {
    if (recorded === undefined) this.suspended--
    else this.stack.pop()
  }

  /** Fills in skipped sub-expressions (in source order) and iteration results. */
  finish(): Trace {
    const visit = (trace: Trace): void => {
      const node = this.nodes.get(trace)
      if (node !== undefined && trace.evaluated && node.type !== 'Lambda') {
        const byNode = new Map<Node, Trace>()
        for (const child of trace.children) {
          const childNode = this.nodes.get(child)
          if (childNode !== undefined && !byNode.has(childNode)) byNode.set(childNode, child)
        }
        const ordered: Trace[] = []
        const placed = new Set<Trace>()
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

export function errorInfo(error: unknown): { code: string; message: string } {
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
  return out
}

// === snapshots (safe to serialize) ===

const SNAPSHOT_DEPTH = 4
const SNAPSHOT_ITEMS = 50
const SNAPSHOT_TEXT = 1000

/** A bounded, cycle-safe, JSON-ready copy of a value. Never runs getters. */
export function snapshot(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return value.length > SNAPSHOT_TEXT ? `${value.slice(0, SNAPSHOT_TEXT)}...` : value
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
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof Duration) return value.toString()
  if (seen.has(value)) return '[Circular]'
  if (depth >= SNAPSHOT_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '{...}'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, SNAPSHOT_ITEMS).map((item) => snapshot(item, depth + 1, seen))
      if (value.length > SNAPSHOT_ITEMS) items.push(`... ${value.length - SNAPSHOT_ITEMS} more`)
      return items
    }
    const out: Record<string, unknown> = {}
    const keys = Object.keys(value)
    for (const key of keys.slice(0, SNAPSHOT_ITEMS))
      out[key] = snapshot(ownData(value, key), depth + 1, seen)
    if (keys.length > SNAPSHOT_ITEMS) out['...'] = `${keys.length - SNAPSHOT_ITEMS} more keys`
    return out
  } finally {
    seen.delete(value)
  }
}

/** An own data property's value; accessors are described, never invoked. */
function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor === undefined) return undefined
  return 'value' in descriptor ? descriptor.value : '[getter]'
}

/** The trace with every value replaced by its snapshot. */
export function snapshotTrace(trace: Trace): unknown {
  return {
    id: trace.id,
    kind: trace.kind,
    ...(trace.operator === undefined ? {} : { operator: trace.operator }),
    start: trace.start,
    end: trace.end,
    text: trace.text,
    evaluated: trace.evaluated,
    ...(trace.extra === true ? { extra: true } : {}),
    ...(trace.evaluated && trace.error === undefined ? { value: snapshot(trace.value) } : {}),
    ...(trace.error === undefined ? {} : { error: trace.error }),
    children: trace.children.map(snapshotTrace),
    ...(trace.iterations === undefined
      ? {}
      : {
          iterations: trace.iterations.map((iteration) => ({
            index: iteration.index,
            item: snapshot(iteration.item),
            ...(iteration.accumulator === undefined
              ? {}
              : { accumulator: snapshot(iteration.accumulator) }),
            ...(iteration.error === undefined
              ? { result: snapshot(iteration.result) }
              : { error: iteration.error }),
            trace: snapshotTrace(iteration.trace),
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

/** A short, readable rendering of a value. Never runs getters. */
function preview(value: unknown): string {
  const text = JSON.stringify(snapshot(value, SNAPSHOT_DEPTH - PREVIEW_DEPTH)) ?? 'null'
  return text.length > MAX_PREVIEW * 2 ? `${text.slice(0, MAX_PREVIEW * 2)}...` : text
}

function outcome(trace: Trace): string {
  if (!trace.evaluated) return '(not evaluated)'
  if (trace.error !== undefined) return `error ${trace.error.code}: ${trace.error.message}`
  return `${preview(trace.value)}${trace.extra === true ? '  (checked for the explanation)' : ''}`
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
  const visit = (trace: Trace, lead: string, rest: string): void => {
    lines.push(`${lead}${oneLine(trace.text)}  → ${outcome(trace)}`)
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
          ? preview(iteration.result)
          : `error ${iteration.error.code}: ${iteration.error.message}`
      const accumulator =
        iteration.accumulator === undefined ? '' : ` (acc ${preview(iteration.accumulator)})`
      lines.push(
        `${iterationLead}item ${iteration.index} ${preview(iteration.item)}${accumulator}  → ${result}`,
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
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW)}...` : flat
}
