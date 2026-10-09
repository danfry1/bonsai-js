import type { Analysis } from './check/checker.js'
import { BonsaiError, BonsaiLimitError, BonsaiRuntimeError } from './errors.js'
import {
  forEachChild,
  mapChildren as mapEachChild,
  type IndexNode,
  type LambdaNode,
  type MemberNode,
  type Node,
} from './syntax/ast.js'
import { parse, type ParseLimits } from './syntax/parser.js'
import { print } from './syntax/printer.js'
import { MAX_TRACE_TEXT, capTraceText } from './runtime/trace.js'
import { dateTime, isMap, isTimestamp, type Duration } from './runtime/values.js'
import type { Type } from './types.js'
import type {
  AbortSignalLike,
  EvaluateOptions,
  ExplainOptions,
  Explanation,
} from './environment.js'

// === dependencies ===

const NO_NAMES: ReadonlySet<string> = new Set()

/** How a host function behaves, for deciding what partial evaluation may call. */
export interface HostKind {
  readonly async: boolean
  /** Receives a HostCall, so it can read the whole context. */
  readonly call: boolean
}

/**
 * The key a read takes from its object as a path segment: a member name, or a
 * literal string index (`user["age"]` reads the same data as `user.age`). A key
 * with a dot cannot be a segment of a dotted path, so it is not one.
 */
function segmentOf(node: Node): string | undefined {
  if (node.type === 'Member') return node.name
  if (
    node.type === 'Index' &&
    node.index.type === 'Literal' &&
    typeof node.index.value === 'string' &&
    node.index.value !== '' &&
    !node.index.value.includes('.')
  ) {
    return node.index.value
  }
  return undefined
}

/** Characters of a path built or tested per step charged for it. */
const PATH_CHARS_PER_STEP = 64
/** Nodes of a subtree compiled for partial evaluation per step charged for it. */
const COMPILE_NODES_PER_STEP = 4
/** Nodes indexed per step charged for it. */
const INDEX_NODES_PER_STEP = 4

/** Subtree flags: calls now(), a host function, an async one, a `call: true` one. */
const NOW = 1
const HOST = 2
const ASYNC_HOST = 4
const WHOLE_CONTEXT = 8

/**
 * What a subtree needs from outside itself. Positions are pre-order, so the
 * subtree spans `pos` up to `end`, and a `.` or local read refers to a binder
 * outside it exactly when the binder's position is below `pos`. Nothing is
 * copied per node, so an index costs O(nodes + path text) however deep the
 * tree nests.
 */
interface NodeInfo {
  readonly pos: number
  end: number
  /** The calls in the subtree, as NOW | HOST | ASYNC_HOST | WHOLE_CONTEXT bits. */
  flags: number
  /** Lowest position of the binder of a `.` read in the subtree (-1: unbound). */
  it: number
  /** Lowest position of the binder of a local read in the subtree (-1: unbound). */
  local: number
  /** The subtree's local reads are `locals` from `first` up to `last`. */
  readonly first: number
  last: number
}

interface TreeIndex {
  readonly info: ReadonlyMap<Node, NodeInfo>
  /** Local reads in pre-order: name, and the position of its binder. */
  readonly locals: readonly (readonly [string, number])[]
  /** The context paths the tree reads (`user.age` for a static chain of reads), with their segments. */
  readonly paths: ReadonlyMap<string, readonly string[]>
  /** The path each outermost static read names. */
  readonly readPath: ReadonlyMap<Node, string>
  /** The steps building the index charged, charged again on each reuse. */
  readonly steps: number
}

/** Per program: its tree and its environment's host functions never change. */
const ROOT_INDEX = new WeakMap<Analysis, TreeIndex>()

/** The segments of a static chain of reads (`user.address.city`), outermost last. */
function chainSegments(node: Node): string[] | undefined {
  const segments: string[] = []
  let at = node
  for (;;) {
    if (at.type === 'Variable') {
      segments.push(at.name)
      return segments.reverse()
    }
    const segment = segmentOf(at)
    if (segment === undefined || (at.type !== 'Member' && at.type !== 'Index')) return undefined
    segments.push(segment)
    at = at.object
  }
}

function indexTree(
  root: Node,
  hostKind: (name: string) => HostKind | undefined,
  charge: (steps: number) => void,
): TreeIndex {
  let steps = 0
  const spend = (n: number): void => {
    steps += n
    charge(n)
  }
  const info = new Map<Node, NodeInfo>()
  const locals: [string, number][] = []
  const paths = new Map<string, readonly string[]>()
  const readPath = new Map<Node, string>()
  // The binders in scope: per local name, and for `.` (implicit lambdas).
  const scopes = new Map<string, number[]>()
  const implicit: number[] = []
  const scope = (name: string): number[] => {
    let stack = scopes.get(name)
    if (stack === undefined) scopes.set(name, (stack = []))
    return stack
  }
  const read = (node: Node, parts: readonly string[]): void => {
    const path = parts.join('.')
    spend(1 + Math.floor(path.length / PATH_CHARS_PER_STEP))
    if (!paths.has(path)) paths.set(path, parts)
    readPath.set(node, path)
  }
  let count = 0
  // `inChain`: inside a static chain of reads, whose outermost node is the read.
  const visit = (node: Node, inChain: boolean): NodeInfo => {
    const pos = count++
    // Indexing a node is cheap work, charged a step per few nodes as it goes.
    if (pos % INDEX_NODES_PER_STEP === 0) spend(1)
    const me: NodeInfo = {
      pos,
      end: 0,
      flags: 0,
      it: Infinity,
      local: Infinity,
      first: locals.length,
      last: 0,
    }
    info.set(node, me)
    let chain = inChain
    if (node.type === 'Variable') {
      if (!inChain) read(node, [node.name])
    } else if (node.type === 'Local') {
      me.local = scope(node.name).at(-1) ?? -1
      locals.push([node.name, me.local])
    } else if (node.type === 'It') {
      me.it = implicit.at(-1) ?? -1
    } else if ((node.type === 'Member' || node.type === 'Index') && !inChain) {
      const parts = chainSegments(node)
      if (parts !== undefined) read(node, parts)
      chain = parts !== undefined
    } else if (node.type === 'Call') {
      const kind = hostKind(node.name)
      if (node.name === 'now' && kind === undefined) me.flags |= NOW
      if (kind !== undefined) me.flags |= HOST
      if (kind?.async === true) me.flags |= ASYNC_HOST
      if (kind?.call === true) me.flags |= WHOLE_CONTEXT
    } else if (node.type === 'Lambda') {
      for (const param of node.params) scope(param).push(pos)
      if (node.implicit) implicit.push(pos)
    }
    forEachChild(node, (child) => {
      // A let's name is bound in its body, not its value.
      if (node.type === 'Let' && child === node.body) scope(node.name).push(pos)
      const inner = visit(child, chain)
      me.flags |= inner.flags
      me.it = Math.min(me.it, inner.it)
      me.local = Math.min(me.local, inner.local)
    })
    if (node.type === 'Let') scope(node.name).pop()
    if (node.type === 'Lambda') {
      for (const param of node.params) scope(param).pop()
      if (node.implicit) implicit.pop()
    }
    me.end = count
    me.last = locals.length
    return me
  }
  visit(root, false)
  return { info, locals, paths, readPath, steps }
}

interface PathTrie {
  /** An unknown path ends here, so everything under it is unknown too. */
  under: boolean
  readonly next: Map<string, PathTrie>
}

/**
 * Whether a read of a path could observe data that is not given: the path is
 * `unknown` or `missing`, lies above one (reading it reads that one), or lies
 * under an `unknown` path. Under a missing path is not covered: a missing path
 * is a value the expression reads, and a path under it that the expression
 * reads is tested in its own right. The paths are kept as a tree of segments,
 * so building it and each test walk the segments once: no prefix strings are
 * built, and checking costs nothing like paths x unknowns. The tree is
 * returned too: copies of the known data leave out what it marks `under`.
 */
function unknownIndex(
  unknown: Iterable<string>,
  missing: Iterable<string>,
  charge: (steps: number) => void,
  segmentsOf: (path: string) => readonly string[],
): [(path: string) => boolean, PathTrie] {
  const root: PathTrie = { under: false, next: new Map() }
  const add = (path: string): PathTrie => {
    charge(1 + Math.floor(path.length / PATH_CHARS_PER_STEP))
    let node = root
    for (const segment of segmentsOf(path)) {
      let child = node.next.get(segment)
      if (child === undefined) node.next.set(segment, (child = { under: false, next: new Map() }))
      node = child
    }
    return node
  }
  for (const path of unknown) add(path).under = true
  for (const path of missing) add(path)
  const touches = (path: string): boolean => {
    let node = root
    for (const segment of segmentsOf(path)) {
      const child = node.next.get(segment)
      if (child === undefined) return false
      if (child.under) return true
      node = child
    }
    // The path is a missing one, or one lies under it.
    return true
  }
  return [touches, root]
}

// === public types ===

/**
 * Any part of a context, at any depth: the known data for partial(), and the
 * context a residual is evaluated with.
 */
export type PartialData<T> = T extends
  | readonly unknown[]
  | Date
  | Duration
  | ((...args: never) => unknown)
  ? T
  : T extends object
    ? { [K in keyof T]?: PartialData<T[K]> | undefined }
    : T

export type PartialResult<R = unknown, Ctx = object> =
  | { readonly status: 'value'; readonly value: R }
  /** Evaluation fails whatever the unknown data turns out to be. */
  | { readonly status: 'error'; readonly error: BonsaiError }
  | ResidualResult<R, Ctx>

export interface ResidualResult<R = unknown, Ctx = object> {
  readonly status: 'residual'
  /**
   * The simplified expression that still needs the unknown data. Known values
   * that are not short primitives are referenced as variables named in
   * `bindings` rather than copied into the tree.
   */
  readonly residual: Node
  /** The residual as source, for display and storage alongside `bindings`. */
  readonly source: string
  /**
   * Known values the residual refers to by name: frozen copies taken during
   * partial(), so later changes to the known objects do not reach the residual.
   */
  readonly bindings: Readonly<Record<string, unknown>>
  /** Context paths the residual still reads (besides `bindings`). */
  readonly dependsOn: readonly string[]
  /** Host functions the residual still calls (they may replace a built-in of the same name). */
  readonly hostFunctions: readonly string[]
  /**
   * Whether the residual calls a `call: true` host function. Such a function
   * reads the whole context, not only the paths in `dependsOn`: a copy of the
   * known data given to partial() (without the paths listed in `unknown`)
   * overlaid (deeply, your values winning) with the context the residual is
   * evaluated with.
   */
  readonly readsContext: boolean
  /** Whether the residual calls an async host function (evaluateSync rejects it). */
  readonly async: boolean
  /** The program's statically inferred result type, which the residual's result also has. */
  readonly type: Type
  /**
   * Evaluates the residual with the (full) context, taking the same options as
   * Program.evaluateSync; bindings are supplied for you.
   */
  readonly evaluateSync: (context?: PartialData<Ctx>, options?: EvaluateOptions) => R
  readonly evaluate: (context?: PartialData<Ctx>, options?: EvaluateOptions) => Promise<R>
  /**
   * Explains the residual with the (full) context, like Program.explain;
   * bindings are supplied for you. Each trace node's text is the residual's
   * own (printed) text; its offsets refer to the original expression, and are
   * 0 for values filled in from the known data.
   */
  readonly explain: (
    context?: PartialData<Ctx>,
    options?: ExplainOptions,
  ) => Promise<Explanation<R>>
  readonly explainSync: (context?: PartialData<Ctx>, options?: ExplainOptions) => Explanation<R>
}

export interface PartialOptions {
  /**
   * Variables or dotted paths (`order`, `user.riskScore`) whose values are not
   * known yet. Unknown wins over a value present in `known`, and everything
   * else in `known` is taken as complete; an object above a listed path that
   * `known` leaves out is unknown as a whole. Default: everything `known` does not
   * give: variables and fields it leaves out, and any object it gives that the
   * expression reads whole (a spread, `keys()`, `==`, a `let` holding it).
   */
  readonly unknown?: readonly string[] | undefined
  /**
   * Evaluate host function calls whose inputs are known. Default false: they
   * stay in the residual. Only sync host functions can be called.
   */
  readonly callHostFunctions?: boolean | undefined
  /** The time now() returns. Default: now() stays in the residual. */
  readonly now?: Date | undefined
  /** Step budget for the whole partial evaluation (0 = none), as in evaluation. */
  readonly maxSteps?: number | undefined
  /** Wall-clock budget for the whole partial evaluation in milliseconds (0 = none; fractions allowed). */
  readonly timeout?: number | undefined
  /** Cancels the partial evaluation. */
  readonly signal?: AbortSignalLike | undefined
}

/** How the partial evaluator reaches the engine. */
export interface PartialEngine {
  readonly analysis: Analysis
  readonly hostKind: (name: string) => HostKind | undefined
  /** Charges partial-evaluation work (one step by default) against the shared budget. */
  readonly charge: (steps?: number) => void
  /** Checks the shared deadline and signal now. */
  readonly checkTime: () => void
  /** The longest residual source allowed: the environment's maxSourceLength. */
  readonly maxSourceLength: number
  /**
   * Runs a read of the known data, which is host data: a throwing getter or
   * Proxy trap becomes a HOST_ERROR.
   */
  readonly readKnown: <T>(read: () => T) => T
  /**
   * The variables evaluation validates against their declared types, when the
   * environment validates contexts: a residual validates the context it runs
   * on, so it keeps the known values of these.
   */
  readonly validated: ReadonlySet<string> | undefined
  /**
   * Evaluates a subtree of `size` nodes (of a program of `total`) against the
   * known context with the given free locals, sharing one step budget and
   * deadline across the whole partial evaluation. Throws BonsaiRuntimeError
   * for evaluation errors and BonsaiLimitError when a limit is reached.
   */
  readonly evaluate: (
    node: Node,
    locals: readonly (readonly [string, unknown])[],
    size: number,
    total: number,
  ) => unknown
  /**
   * Compiles a residual for later evaluation, with `bindings` as fixed values
   * of the variables they name; everything else is read from the caller's
   * context. `source` is the residual printed; `known` is a frozen copy of the
   * known data, without the paths listed as unknown, kept when the residual
   * calls `call: true` host functions (`readsContext`: they see it under the
   * caller's context) or validates its context (then of the validated
   * variables only).
   */
  readonly compileResidual: (
    residual: Node,
    bindings: Readonly<Record<string, unknown>>,
    source: string,
    known: Readonly<Record<string, unknown>> | undefined,
    readsContext: boolean,
  ) => {
    readonly async: boolean
    runSync: (ctx: unknown, options: unknown) => unknown
    runAsync: (ctx: unknown, options: unknown) => Promise<unknown>
    explainSync: (ctx: unknown, options: unknown) => Explanation
    explainAsync: (ctx: unknown, options: unknown) => Promise<Explanation>
  }
}

// === the partial evaluator ===

/**
 * A known value, or a residual node. `fails` marks a residual that always
 * raises that error when evaluation reaches it, whatever the unknowns are.
 */
type Outcome =
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false; readonly node: Node; readonly fails?: BonsaiRuntimeError }

const at = { start: 0, end: 0 }
/**
 * Longest string written into a residual as a literal. A longer one is bound
 * once and referenced by name, so a value used many times is not copied into
 * the residual at every use.
 */
const MAX_INLINE_STRING = 16
/** Steps charged per character of residual printed or compiled. */
export const RESIDUAL_CHARS_PER_STEP = 16
const BOOLEAN_OPERATORS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', '&&', '||'])

function literalFor(value: unknown): Node | undefined {
  if (value === null || value === undefined) return { type: 'Literal', value: null, ...at }
  if (typeof value === 'boolean') return { type: 'Literal', value, ...at }
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'Literal', value, ...at }
  if (typeof value === 'string' && value.length <= MAX_INLINE_STRING)
    return { type: 'Literal', value, ...at }
  return undefined
}

/** Nodes that always produce true or false (or fail), never null. */
function alwaysBoolean(node: Node): boolean {
  if (node.type === 'Binary') return BOOLEAN_OPERATORS.has(node.operator)
  if (node.type === 'Unary') return node.operator === '!'
  if (node.type === 'Has') return true
  return node.type === 'Literal' && typeof node.value === 'boolean'
}

export function partiallyEvaluate<R>(
  engine: PartialEngine,
  known: Record<string, unknown>,
  options: PartialOptions,
): PartialResult<R> {
  const root = engine.analysis.root
  // The tree's dependencies are the same on every call: found once per program,
  // and charged on each call as if found again, so budgets behave the same.
  let rootIndex = ROOT_INDEX.get(engine.analysis)
  if (rootIndex === undefined) {
    rootIndex = indexTree(root, engine.hostKind, engine.charge)
    ROOT_INDEX.set(engine.analysis, rootIndex)
  } else {
    engine.charge(rootIndex.steps)
  }
  const rootPaths = rootIndex.paths
  // The program's nodes: subtrees compiled for it are kept up to a few times this.
  const total = (rootIndex.info.get(root) as NodeInfo).end
  const segmentsOf = (path: string): readonly string[] => rootPaths.get(path) ?? path.split('.')

  // Nodes made during this call (a computed key written in) are indexed on
  // their own when first asked about, charged like the tree's.
  const ownIndex = new Map<Node, TreeIndex>()
  const locate = (node: Node): { readonly index: TreeIndex; readonly info: NodeInfo } => {
    let index: TreeIndex | undefined = rootIndex
    let info = index.info.get(node)
    if (info === undefined) {
      index = ownIndex.get(node)
      if (index === undefined)
        ownIndex.set(node, (index = indexTree(node, engine.hostKind, engine.charge)))
      info = index.info.get(node) as NodeInfo
    }
    return { index, info }
  }
  /** The free locals a subtree reads (bound outside it), each name once. */
  const freeLocals = (index: TreeIndex, info: NodeInfo): string[] => {
    const names = new Set<string>()
    if (info.local >= info.pos) return []
    engine.charge(1 + info.last - info.first)
    for (let i = info.first; i < info.last; i++) {
      const [name, binder] = index.locals[i]
      if (binder < info.pos) names.add(name)
    }
    return [...names]
  }
  // The static context path a chain of reads names (`user.address.city`), if
  // any; memoized per node, so a long chain builds each prefix once.
  const pathMemo = new Map<Node, string | undefined>()
  const staticPath = (node: Node): string | undefined => {
    if (node.type === 'Variable') return node.name
    const read = rootIndex.readPath.get(node)
    if (read !== undefined) return read
    if (pathMemo.has(node)) return pathMemo.get(node)
    const segment = segmentOf(node)
    let path: string | undefined
    if (segment !== undefined && (node.type === 'Member' || node.type === 'Index')) {
      const base = staticPath(node.object)
      if (base !== undefined) {
        path = `${base}.${segment}`
        engine.charge(Math.ceil(path.length / PATH_CHARS_PER_STEP))
      }
    }
    pathMemo.set(node, path)
    return path
  }

  const unknown = engine.readKnown(() =>
    options.unknown === undefined
      ? [...new Set([...rootPaths.keys()].map((path) => segmentsOf(path)[0]))].filter(
          // A known value of undefined is absent, as a host key holding undefined is.
          (name) => !Object.hasOwn(known, name) || known[name] === undefined,
        )
      : withAbsentParents(options.unknown),
  )
  const callHost = options.callHostFunctions === true
  const nowKnown = options.now !== undefined
  // Without an explicit unknown list, anything not given is unknown: a property
  // a known object leaves out, and any known object read whole (its keys, a
  // spread, ==, a let alias), since the caller may not have given all of it.
  const missing = options.unknown === undefined ? missingPaths(rootPaths.keys()) : NO_NAMES
  const [touchesUnknown, unknownTree] = unknownIndex(unknown, missing, engine.charge, segmentsOf)

  const bindings: Record<string, unknown> = {}
  // Binding names must not shadow a variable the expression reads or a name it
  // binds; known data the expression never reads is irrelevant.
  const taken = new Set([...rootPaths.keys()].map((path) => segmentsOf(path)[0]))
  for (const name of boundNames(root)) taken.add(name)
  let bindingCount = 0
  const freshName = (base: string): string => {
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`
    // Taken from now on: a lambda made explicit inside another must not reuse it.
    taken.add(name)
    return name
  }
  // One binding per value, however often it is used.
  const bound = new Map<unknown, string>()
  const bind = (value: unknown): Node => {
    let name = bound.get(value)
    if (name === undefined) {
      do name = `__known${++bindingCount}`
      while (taken.has(name))
      bindings[name] = value
      bound.set(value, name)
    }
    return { type: 'Variable', name, ...at }
  }

  /**
   * The paths the expression reads that the known data does not give: a path
   * through a known object that lacks the next property (or holds undefined),
   * and a path whose known value is an object, which the expression reads whole
   * (a static path names only the value it reads: `user.age` reads `user.age`,
   * `{...user}` reads `user`). Every path the expression reads is listed, so a
   * path above a gap is decided by its own value, not by the gap.
   */
  function missingPaths(paths: Iterable<string>): ReadonlySet<string> {
    const out = new Set<string>()
    for (const path of paths) if (missingAt(path)) out.add(path)
    return out
  }

  function missingAt(path: string): boolean {
    engine.charge(1 + Math.floor(path.length / PATH_CHARS_PER_STEP))
    const segments = segmentsOf(path)
    return engine.readKnown(() => {
      let value: unknown = known[segments[0]]
      // A variable known does not give is unknown already.
      if (value === undefined) return false
      for (let i = 1; i < segments.length; i++) {
        // At null, a list, or another value, evaluation decides.
        if (value === null || !isMap(value)) return false
        const segment = segments[i]
        value = Object.hasOwn(value, segment) ? value[segment] : undefined
        if (value === undefined) return true
      }
      return isMap(value)
    })
  }

  /**
   * The unknown list, plus each variable or object the known data leaves out
   * on the way to a listed path: listing `cart.items` says `cart` exists, so
   * when `known` does not give `cart`, its other fields are unknown, not null.
   */
  function withAbsentParents(listed: readonly string[]): readonly string[] {
    const out = [...listed]
    for (const path of listed) {
      engine.charge(1 + Math.floor(path.length / PATH_CHARS_PER_STEP))
      const segments = path.split('.')
      let value: Record<string, unknown> = known
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i]
        const next = Object.hasOwn(value, segment) ? value[segment] : undefined
        if (next === undefined) {
          out.push(segments.slice(0, i + 1).join('.'))
          break
        }
        // At null, a list, or another value, the known data decides.
        if (next === null || !isMap(next)) break
        value = next
      }
    }
    return out
  }

  // Whether a node's context reads are all given, once per node and each
  // path's test once: a node with a static path reads that path, any other
  // reads what its children read. The answers are kept for this call only.
  const pathOpen = new Map<string, boolean>()
  const readsGiven = new Map<Node, boolean>()
  const given = (node: Node): boolean => {
    let result = readsGiven.get(node)
    if (result !== undefined) return result
    const path = staticPath(node)
    if (path === undefined) {
      result = true
      forEachChild(node, (child) => {
        if (result === true && !given(child)) result = false
      })
    } else {
      let open = pathOpen.get(path)
      if (open === undefined) {
        engine.charge(1 + Math.floor(path.length / PATH_CHARS_PER_STEP))
        // A path the expression does not name is a computed key's (`tiers[level]`).
        open =
          touchesUnknown(path) ||
          (options.unknown === undefined && !rootPaths.has(path) && missingAt(path))
        pathOpen.set(path, open)
      }
      result = !open
    }
    readsGiven.set(node, result)
    return result
  }

  type Env = ReadonlyMap<string, Outcome>

  const closed = (node: Node, env: Env): boolean => {
    const { index, info } = locate(node)
    const flags = info.flags
    if (
      info.it < info.pos ||
      ((flags & NOW) !== 0 && !nowKnown) ||
      ((flags & HOST) !== 0 && !callHost) ||
      (flags & ASYNC_HOST) !== 0
    ) {
      return false
    }
    // A context function can read variables the expression never names, so it
    // runs only when the caller says nothing is unknown.
    if ((flags & WHOLE_CONTEXT) !== 0 && (options.unknown === undefined || unknown.length > 0))
      return false
    if (!given(node)) return false
    for (const name of freeLocals(index, info)) if (env.get(name)?.known !== true) return false
    return true
  }

  const evaluateClosed = (node: Node, env: Env): unknown => {
    const { index, info } = locate(node)
    const locals = freeLocals(index, info).map(
      (name) => [name, (env.get(name) as { value: unknown }).value] as const,
    )
    // Compiling the subtree is work in proportion to its size, charged on
    // every call (compiled or reused), so a budget fits every call alike.
    const size = info.end - info.pos
    engine.charge(Math.ceil(size / COMPILE_NODES_PER_STEP))
    return engine.evaluate(node, locals, size, total)
  }

  /** A known value as syntax: an inline literal, or a reference to a binding. */
  const asNode = (outcome: Outcome): Node =>
    outcome.known ? (literalFor(outcome.value) ?? bind(outcome.value)) : outcome.node
  const residual = (node: Node, fails?: BonsaiRuntimeError): Outcome =>
    fails === undefined ? { known: false, node } : { known: false, node, fails }

  const peval = (node: Node, env: Env): Outcome => {
    engine.charge()
    if (closed(node, env)) {
      try {
        return { known: true, value: evaluateClosed(node, env) }
      } catch (error) {
        // Evaluation errors happen only if evaluation reaches this point, so
        // the expression stays; limit errors end the whole partial evaluation.
        if (error instanceof BonsaiRuntimeError)
          return { known: false, node: withKnownLocals(node, env), fails: error }
        throw error
      }
    }
    switch (node.type) {
      case 'Binary':
        if (node.operator === '&&' || node.operator === '||') return logic(node, env)
        if (node.operator === '??') {
          const left = peval(node.left, env)
          if (left.known)
            return left.value === null || left.value === undefined ? peval(node.right, env) : left
          return residual(
            { ...node, left: left.node, right: asNode(peval(node.right, env)) },
            left.fails,
          )
        }
        return rebuild(node, env)
      case 'Conditional': {
        const test = peval(node.test, env)
        if (
          test.known &&
          (typeof test.value === 'boolean' || test.value === null || test.value === undefined)
        ) {
          return peval(test.value === true ? node.then : node.otherwise, env)
        }
        // Branches run only if chosen, so their failures do not propagate.
        const then = asNode(peval(node.then, env))
        const otherwise = asNode(peval(node.otherwise, env))
        return residual(
          { ...node, test: asNode(test), then, otherwise },
          test.known ? undefined : test.fails,
        )
      }
      case 'Try': {
        const body = peval(node.body, env)
        // try() recovers from evaluation errors: a body that always fails with one is the
        // fallback. A host contract violation is never recovered, so it propagates.
        if (!body.known && body.fails !== undefined) {
          return body.fails.code === 'HOST_CONTRACT' ? body : peval(node.fallback, env)
        }
        if (body.known) return body
        return residual({ ...node, body: body.node, fallback: asNode(peval(node.fallback, env)) })
      }
      case 'Let': {
        const value = peval(node.value, env)
        const inner = new Map(env)
        if (value.known) {
          inner.set(node.name, value)
          return peval(node.body, inner)
        }
        inner.delete(node.name)
        return residual(
          { ...node, value: value.node, body: asNode(peval(node.body, inner)) },
          value.fails,
        )
      }
      case 'Has':
        // has() tests a path without reading it; only known locals are written in.
        return residual(withKnownLocals(node, env))
      case 'Call': {
        if (!node.optional) return rebuild(node, env)
        // x?.f(...): a null receiver skips the call and its arguments.
        const receiver = node.args[0]
        if (receiver === undefined || receiver.type === 'Spread') return rebuild(node, env)
        const outcome = peval(receiver, env)
        if (outcome.known && (outcome.value === null || outcome.value === undefined)) {
          return { known: true, value: null }
        }
        return rebuild(node, env, new Map([[receiver, outcome]]), !outcome.known)
      }
      case 'Index': {
        // A known key into a context object reads one path (`tiers[level]`
        // with level "gold" reads `tiers.gold`), so only that path must be given.
        if (staticPath(node.object) === undefined || segmentOf(node) !== undefined)
          return rebuild(node, env)
        const key = peval(node.index, env)
        if (!key.known || typeof key.value !== 'string') {
          return rebuild(node, env, new Map([[node.index, key]]))
        }
        const { start, end } = node.index
        const keyed: Node = { ...node, index: { type: 'Literal', value: key.value, start, end } }
        return segmentOf(keyed) === undefined
          ? rebuild(node, env, new Map([[node.index, key]]))
          : peval(keyed, env)
      }
      case 'Literal':
      case 'Template':
      case 'Variable':
      case 'Local':
      case 'It':
      case 'Member':
      case 'Unary':
      case 'List':
      case 'Map':
      case 'Lambda':
      default:
        return rebuild(node, env)
    }
  }

  const logic = (node: Extract<Node, { type: 'Binary' }>, env: Env): Outcome => {
    const isAnd = node.operator === '&&'
    const left = peval(node.left, env)
    if (!left.known && left.fails !== undefined) {
      return residual(
        { ...node, left: left.node, right: withKnownLocals(node.right, env) },
        left.fails,
      )
    }
    if (left.known) {
      const value = left.value
      if (value !== true && value !== false && value !== null && value !== undefined) {
        return residual(withKnownLocals(node, env)) // a non-boolean fails; keep it so the error reproduces
      }
      const leftTrue = value === true
      if (leftTrue !== isAnd) return { known: true, value: leftTrue } // false && x, true || x
      const right = peval(node.right, env)
      if (right.known) {
        // true && y and false || y are truth(y): a boolean, false for null, or a failure.
        if (right.value === true || right.value === false)
          return { known: true, value: right.value }
        if (right.value === null || right.value === undefined) return { known: true, value: false }
        return residual(withKnownLocals(node, env))
      }
      // true && x and false || x are x only when x always yields a boolean.
      return residual(
        alwaysBoolean(right.node) ? right.node : { ...node, left: asNode(left), right: right.node },
      )
    }
    const right = peval(node.right, env)
    if (right.known && (right.value === true || right.value === false)) {
      const rightTrue = right.value
      // x && true and x || false are x when x always yields a boolean. (x && false
      // is not folded: evaluating x may fail, and that must still happen.)
      if (rightTrue === isAnd && alwaysBoolean(left.node)) return residual(left.node)
    }
    return residual({ ...node, left: left.node, right: asNode(right) })
  }

  const rebuild = (
    node: Node,
    env: Env,
    precomputed?: ReadonlyMap<Node, Outcome>,
    /** For x?.f(...) with a receiver that may be null: the arguments may not run. */
    onlyFirstMayFail = false,
  ): Outcome => {
    let first = true
    // Children evaluate in order; if one always fails and every child before it
    // is known, the node always fails with that error.
    let prefixKnown = true
    let fails: BonsaiRuntimeError | undefined
    const rebuilt = mapChildren(node, (child, lambda) => {
      if (lambda !== undefined) {
        const inner = new Map(env)
        for (const param of lambda.params) inner.delete(param)
        const body = asNode(peval(lambda.body, inner))
        // An implicit lambda whose body no longer uses `.` would print as a
        // plain value; make the parameter explicit instead.
        const info = lambda.implicit ? locate(body).info : undefined
        if (info !== undefined && info.it >= info.pos) {
          return { ...lambda, implicit: false, params: [freshName('__item')], body }
        }
        return { ...lambda, body }
      }
      const outcome = precomputed?.get(child) ?? peval(child, env)
      const mayPropagate = !onlyFirstMayFail || first
      first = false
      if (!outcome.known) {
        if (prefixKnown && mayPropagate && fails === undefined && outcome.fails !== undefined) {
          fails = outcome.fails
        }
        prefixKnown = false
      }
      return asNode(outcome)
    })
    return residual(rebuilt, node.type === 'Conditional' ? undefined : fails)
  }

  /** The node with known locals written in (as literals or bindings). */
  const withKnownLocals = (node: Node, env: Env): Node =>
    substituteLocals(node, (name) => {
      const local = env.get(name)
      return local?.known === true ? asNode(local) : undefined
    })

  let outcome: Outcome
  try {
    outcome = peval(root, new Map())
  } catch (error) {
    if (error instanceof BonsaiRuntimeError) return { status: 'error', error }
    throw error
  }
  if (outcome.known) return { status: 'value', value: outcome.value as R }
  if (outcome.fails !== undefined) return { status: 'error', error: outcome.fails }

  // An expression that is known except for an error it always raises.
  const residualPaths = indexTree(outcome.node, engine.hostKind, engine.charge).paths
  // Printing and compiling the residual are work proportional to its size:
  // charged, checked against the deadline, and bounded like any source.
  const source = print(outcome.node)
  engine.charge(1 + Math.ceil(source.length / RESIDUAL_CHARS_PER_STEP))
  engine.checkTime()
  if (source.length > engine.maxSourceLength) {
    throw new BonsaiLimitError(
      'SOURCE_TOO_LONG',
      `The residual is ${source.length} characters long, more than maxSourceLength (${engine.maxSourceLength})`,
    )
  }
  // A call: true host function reads the whole context, which includes the
  // known data: the residual's calls see it under the context they are given.
  const hostFunctions = Object.freeze(hostCalls(outcome.node, engine.hostKind))
  const readsContext = hostFunctions.some((name) => engine.hostKind(name)?.call === true)
  // The residual keeps the known data as partial() read it: the bindings (and
  // the known data it keeps) are copies, so later changes to the caller's
  // objects never reach it. The bindings are compiled in as constants, so
  // evaluating reads the caller's context as it is: no per-call copy.
  const copy = snapshotter(engine.charge)
  const frozenBindings = engine.readKnown(() => {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(bindings)) out[name] = copy(value)
    return Object.freeze(out)
  })
  // Kept for call: true functions (all of it) or for validating the context a
  // residual runs on (the validated variables), without the paths the caller
  // listed as unknown: those come from the caller's context alone.
  let residualKnown: Readonly<Record<string, unknown>> | undefined
  const keep = readsContext ? undefined : engine.validated
  if (readsContext || keep !== undefined) {
    residualKnown = engine.readKnown(() => {
      const kept = {}
      for (const name of Object.keys(known))
        if (keep?.has(name) !== false) definePut(kept, name, known[name])
      return copy(kept, unknownTree) as Record<string, unknown>
    })
  }
  // `x.length` reads a list's or a string's length when x is one, so the data
  // the caller supplies is the path above the first `length`.
  const dependsOn = new Set<string>()
  for (const [path, segments] of residualPaths) {
    if (Object.hasOwn(frozenBindings, segments[0])) continue
    const cut = segments.indexOf('length', 1)
    dependsOn.add(cut === -1 ? path : segments.slice(0, cut).join('.'))
  }
  const compiled = engine.compileResidual(
    outcome.node,
    frozenBindings,
    source,
    residualKnown,
    readsContext,
  )
  engine.checkTime()
  type Residual = ResidualResult<R>
  // The runners take (context, options) and always return a promise when async.
  return Object.freeze({
    status: 'residual',
    residual: outcome.node,
    source,
    bindings: frozenBindings,
    dependsOn: Object.freeze([...dependsOn].sort()),
    hostFunctions,
    readsContext,
    async: compiled.async,
    type: engine.analysis.type,
    evaluateSync: compiled.runSync as Residual['evaluateSync'],
    evaluate: compiled.runAsync as Residual['evaluate'],
    explainSync: compiled.explainSync as Residual['explainSync'],
    explain: compiled.explainAsync as Residual['explain'],
  })
}

/**
 * The text of each node of a residual tree, for explanations: slices of the
 * residual's printed `source`, found by parsing it once and walking the parsed
 * tree alongside the residual (an implicit lambda is its body in the parsed
 * tree). Each text is capped, so the whole costs time and memory in proportion
 * to the source, never to its size times the number of nodes. A node the walk
 * cannot pair (or a source the parser rejects) has empty text.
 */
export function residualTexts(
  root: Node,
  source: string,
  limits: ParseLimits,
): ReadonlyMap<Node, string> {
  const texts = new Map<Node, string>()
  let parsed: Node
  try {
    parsed = parse(source, limits)
  } catch {
    return texts
  }
  const children = (node: Node): Node[] => {
    const out: Node[] = []
    forEachChild(node, (child) => {
      out.push(child)
    })
    return out
  }
  const walk = (node: Node, twin: Node): void => {
    texts.set(
      node,
      capTraceText(source.slice(twin.start, Math.min(twin.end, twin.start + MAX_TRACE_TEXT + 1))),
    )
    if (node.type === 'Lambda' && node.implicit && twin.type !== 'Lambda') {
      walk(node.body, twin)
      return
    }
    const mine = children(node)
    const theirs = children(twin)
    if (mine.length !== theirs.length) return
    mine.forEach((child, i) => {
      walk(child, theirs[i])
    })
  }
  walk(root, parsed)
  return texts
}

// === copies of known data ===

/** Sets an own enumerable key; defined, not assigned, so a key named __proto__ stays a key. */
export function definePut(out: object, name: string, value: unknown, enumerable = true): void {
  Object.defineProperty(out, name, { value, enumerable, writable: true, configurable: true })
}

/**
 * Copies known data as the language reads it, so a residual keeps it as
 * partial() saw it: lists and maps (plain objects and class instances, read
 * through their own keys) are copied, a timestamp becomes a new Date, and
 * durations and opaque host values (a Map, a RegExp, a function) are kept as
 * they are, since the language never reads into them. Shared and cyclic
 * values stay shared, except along the paths of `leave` (a tree of unknown
 * paths), where each map is copied on its own and a key marked `under` is
 * left out (another path to the same map keeps it). It runs on an explicit
 * stack, so deep data costs no call stack, and every entry copied costs a
 * step. Reads run getters and Proxy traps, so the caller runs it as a read of
 * host data. `freeze()` freezes every copy once all are made.
 */
function snapshotter(
  charge: (steps: number) => void,
): (value: unknown, leave?: PathTrie) => unknown {
  const copies = new Map<object, unknown>()
  const pending: [object, object, PathTrie | undefined][] = []
  const shallow = (value: unknown, leave?: PathTrie): unknown => {
    if (typeof value !== 'object' || value === null) return value
    let out = leave === undefined ? copies.get(value) : undefined
    if (out !== undefined) return out
    out = value
    if (Array.isArray(value)) out = []
    else if (value instanceof Date) out = isTimestamp(value) ? new Date(dateTime(value)) : value
    else if (isMap(value)) out = {}
    if (leave === undefined) copies.set(value, out)
    if (out !== value && !(out instanceof Date)) pending.push([value, out as object, leave])
    return out
  }
  return (value, leave) => {
    try {
      const out = shallow(value, leave)
      for (let job = pending.pop(); job !== undefined; job = pending.pop()) {
        const [from, to, tree] = job
        if (Array.isArray(from)) {
          charge(1 + from.length)
          // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
          for (let i = 0; i < from.length; i++) (to as unknown[]).push(shallow(from[i]))
        } else {
          const names = Object.getOwnPropertyNames(from)
          charge(1 + names.length)
          for (const name of names) {
            const under = tree?.next.get(name)
            // A getter is read as evaluation reads it.
            if (under?.under !== true)
              definePut(
                to,
                name,
                shallow((from as Record<string, unknown>)[name], under),
                Object.prototype.propertyIsEnumerable.call(from, name),
              )
          }
        }
        // Filled: nothing changes it again.
        Object.freeze(to)
      }
      return out
    } catch (error) {
      if (error instanceof BonsaiError) throw error
      // Data that throws when read (a getter, a Proxy trap) cannot be copied;
      // it is kept as it is, and fails where evaluation reads it. Copies left
      // half made are never handed out again.
      pending.length = 0
      copies.clear()
      return value
    }
  }
}

// === tree helpers ===

function hostCalls(root: Node, hostKind: PartialEngine['hostKind']): string[] {
  const names = new Set<string>()
  const visit = (node: Node): void => {
    if (node.type === 'Call' && hostKind(node.name) !== undefined) names.add(node.name)
    forEachChild(node, visit)
  }
  visit(root)
  return [...names].sort()
}

/** Rebuilds `node` with each child replaced; lambda arguments are passed with their node. */
function mapChildren(node: Node, f: (child: Node, lambda?: LambdaNode) => Node): Node {
  const one = (child: Node): Node => (child.type === 'Lambda' ? f(child, child) : f(child))
  if (node.type === 'Lambda') return f(node, node)
  // has() tests a path without reading it: keep the path's shape, but rewrite
  // what the path is built from.
  if (node.type === 'Has')
    return { ...node, target: mapEachChild(node.target, one) as MemberNode | IndexNode }
  return mapEachChild(node, one)
}

/** Every let name and lambda parameter in the tree. */
function boundNames(root: Node): Set<string> {
  const names = new Set<string>()
  const visit = (node: Node): void => {
    if (node.type === 'Let') names.add(node.name)
    if (node.type === 'Lambda') for (const param of node.params) names.add(param)
    if (node.type === 'Local') names.add(node.name)
    forEachChild(node, visit)
  }
  visit(root)
  return names
}

/** Replaces free references to locals (not rebound inside) using `replace`. */
function substituteLocals(root: Node, replace: (name: string) => Node | undefined): Node {
  const walk = (node: Node, bound: ReadonlySet<string>): Node => {
    if (node.type === 'Local') return bound.has(node.name) ? node : (replace(node.name) ?? node)
    if (node.type === 'Lambda')
      return { ...node, body: walk(node.body, new Set([...bound, ...node.params])) }
    if (node.type === 'Let') {
      return {
        ...node,
        value: walk(node.value, bound),
        body: walk(node.body, new Set([...bound, node.name])),
      }
    }
    return mapChildren(node, (child) => walk(child, bound))
  }
  return walk(root, new Set())
}
