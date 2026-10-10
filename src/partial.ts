import type { Analysis } from './check/checker.js'
import { BonsaiLimitError, BonsaiRuntimeError, type BonsaiError } from './errors.js'
import {
  forEachChild,
  mapChildren as mapEachChild,
  type IndexNode,
  type LambdaNode,
  type MemberNode,
  type Node,
} from './syntax/ast.js'
import { BLOCKED_NAMES } from './syntax/lexer.js'
import { parse, type ParseLimits } from './syntax/parser.js'
import { print } from './syntax/printer.js'
import { MAX_TRACE_TEXT, capTraceText } from './runtime/trace.js'
import { isMap, type Duration } from './runtime/values.js'
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
 * built, and checking costs nothing like paths x unknowns.
 */
function unknownIndex(
  unknown: Iterable<string>,
  missing: Iterable<string>,
  charge: (steps: number) => void,
  segmentsOf: (path: string) => readonly string[],
): (path: string) => boolean {
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
  return touches
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

// oxlint-disable-next-line typescript/no-explicit-any -- the erased context type, as Program's
export type PartialResult<Ctx = any, R = unknown> =
  | { readonly status: 'value'; readonly value: R }
  /** Evaluation fails whatever the unknown data turns out to be. */
  | { readonly status: 'error'; readonly error: BonsaiError }
  | ResidualResult<Ctx, R>

// oxlint-disable-next-line typescript/no-explicit-any -- the erased context type, as Program's
export interface ResidualResult<Ctx = any, R = unknown> {
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
   * Known values the residual refers to by name: the values partial() read,
   * shared with `known` (not copied). Do not change the known data afterwards;
   * run partial() again when it changes.
   */
  readonly bindings: Readonly<Record<string, unknown>>
  /** Context paths the residual still reads (besides `bindings`). */
  readonly dependsOn: readonly string[]
  /** Host functions the residual still calls (they may replace a built-in of the same name). */
  readonly hostFunctions: readonly string[]
  /**
   * Whether the residual calls a `call: true` host function. Such a function
   * reads `call.context`, which is exactly the context the residual is
   * evaluated with, so pass the full context (known values included), as for
   * the program: a variable known to partial() missing from it is an
   * INVALID_CONTEXT error.
   */
  readonly readsContext: boolean
  /** Whether the residual calls an async host function (evaluateSync rejects it). */
  readonly async: boolean
  /** The program's statically inferred result type, which the residual's result also has. */
  readonly type: Type
  /**
   * Evaluates the residual, taking the same options as Program.evaluateSync;
   * bindings are supplied for you. The context needs the paths in `dependsOn`,
   * or the full context when `readsContext` is true.
   */
  readonly evaluateSync: (context?: PartialData<Ctx>, options?: EvaluateOptions) => R
  readonly evaluate: (context?: PartialData<Ctx>, options?: EvaluateOptions) => Promise<R>
  /**
   * Explains the residual with the same context as evaluateSync, like Program.explain;
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
  /** Throws the LIST_LIMIT evaluation raises for a list literal of `length` items at `at`, if over. */
  readonly listLimit: (length: number, at: Node) => void
  /** The longest residual source allowed: the environment's maxSourceLength. */
  readonly maxSourceLength: number
  /**
   * Runs a read of the known data, which is host data: a throwing getter or
   * Proxy trap becomes a HOST_ERROR.
   */
  readonly readKnown: <T>(read: () => T) => T
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
   * Evaluates `node`, a copy of the program's node `origin` whose children are
   * all locals with the given values, running a call with the overload the
   * program chose for `origin`. Not cached: such a node is built once.
   */
  readonly evaluateFolded: (
    node: Node,
    origin: Node,
    locals: readonly (readonly [string, unknown])[],
  ) => unknown
  /**
   * Compiles a residual for later evaluation, with `bindings` as fixed values
   * of the variables they name (shared with the known data, not copied);
   * everything else is read from the caller's context, which `call: true` host
   * functions also see as it is. `source` is the residual printed. When
   * `readsContext`, the caller's context must hold every variable in
   * `knownRoots` (the ones known to partial()) and is validated whole;
   * otherwise only the paths in `dependsOn` are validated.
   */
  readonly compileResidual: (
    residual: Node,
    bindings: Readonly<Record<string, unknown>>,
    source: string,
    readsContext: boolean,
    knownRoots: readonly string[],
    dependsOn: readonly string[],
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
 * An error a subtree raises only if evaluation reaches it: an evaluation
 * error, or a limit on the size of a value it builds. Budget limits (steps,
 * time, cancellation) bound partial evaluation's own work, so they end it.
 */
type Failure = BonsaiRuntimeError | BonsaiLimitError

const VALUE_LIMITS: ReadonlySet<string> = new Set([
  'STRING_LIMIT',
  'LIST_LIMIT',
  'VALUE_DEPTH_LIMIT',
  'PATTERN_LIMIT',
])

function failureOf(error: unknown): Failure | undefined {
  if (error instanceof BonsaiRuntimeError) return error
  if (error instanceof BonsaiLimitError && VALUE_LIMITS.has(error.code)) return error
  return undefined
}

/** Whether `try()` lets the failure through: limits and host contract violations. */
function uncatchable(failure: Failure): boolean {
  return failure instanceof BonsaiLimitError || failure.code === 'HOST_CONTRACT'
}

/**
 * A known value, or a residual node. `fails` marks a residual that always
 * raises that error when evaluation reaches it, whatever the unknowns are.
 */
type Outcome =
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false; readonly node: Node; readonly fails?: Failure }

const at = { start: 0, end: 0 }
/**
 * Longest string written into a residual as a literal. A longer one is bound
 * once and referenced by name, so a value used many times is not copied into
 * the residual at every use.
 */
const MAX_INLINE_STRING = 16
/** Steps charged per character of residual printed or compiled. */
const RESIDUAL_CHARS_PER_STEP = 16
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
): PartialResult<object, R> {
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
  const touchesUnknown = unknownIndex(unknown, missing, engine.charge, segmentsOf)

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
  const residual = (node: Node, fails?: Failure): Outcome =>
    fails === undefined ? { known: false, node } : { known: false, node, fails }

  const peval = (node: Node, env: Env): Outcome => {
    engine.charge()
    if (closed(node, env)) {
      try {
        return { known: true, value: evaluateClosed(node, env) }
      } catch (error) {
        // Evaluation errors and value-size limits happen only if evaluation
        // reaches this point, so the expression stays; budget limits end the
        // whole partial evaluation.
        const failure = failureOf(error)
        if (failure !== undefined) return residual(withKnownLocals(node, env), failure)
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
        // fallback. A limit or host contract violation is never recovered, so it propagates.
        if (!body.known && body.fails !== undefined) {
          return uncatchable(body.fails) ? body : peval(node.fallback, env)
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

  /** Whether a node is decided by its children's values alone: no context read, host call, or clock. */
  const foldsWhenKnown = (node: Node): boolean => {
    switch (node.type) {
      case 'Binary':
      case 'Unary':
      case 'Member':
      case 'Index':
      case 'List':
      case 'Map':
      case 'Template':
        return true
      case 'Call':
        return engine.hostKind(node.name) === undefined && node.name !== 'now'
      case 'Literal':
      case 'Variable':
      case 'Local':
      case 'It':
      case 'Has':
      case 'Lambda':
      case 'Let':
      case 'Try':
      case 'Conditional':
      default:
        return false
    }
  }

  const rebuild = (
    node: Node,
    env: Env,
    precomputed?: ReadonlyMap<Node, Outcome>,
    /** For x?.f(...) with a receiver that may be null: the arguments may not run. */
    onlyFirstMayFail = false,
  ): Outcome => {
    // A list literal without spreads is checked against maxListLength before its
    // items run (unless an item awaits a host function), so that limit comes first.
    if (
      node.type === 'List' &&
      !node.items.some((item) => item.type === 'Spread') &&
      (locate(node).info.flags & ASYNC_HOST) === 0
    ) {
      try {
        engine.listLimit(node.items.length, node)
      } catch (error) {
        const failure = failureOf(error)
        if (failure !== undefined) return residual(withKnownLocals(node, env), failure)
        throw error
      }
    }
    let first = true
    // Children evaluate in order; if one always fails and every child before it
    // is known, the node always fails with that error.
    let prefixKnown = true
    let fails: Failure | undefined
    // A node whose children all turned out known (`(2 ?? row.total) >= 1`,
    // where `??` skips the read) is folded below.
    const values: (readonly [string, unknown])[] = []
    let foldable = foldsWhenKnown(node)
    const rebuilt = mapChildren(node, (child, lambda) => {
      if (lambda !== undefined) {
        foldable = false
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
        foldable = false
      } else if (foldable) values.push([`#${values.length}`, outcome.value])
      return asNode(outcome)
    })
    if (foldable && values.length > 0) {
      // The node with each child read from a local: it reads no context.
      let slot = 0
      const local = mapChildren(node, (child) => {
        const name = `#${slot++}`
        return { type: 'Local', name, start: child.start, end: child.end }
      })
      engine.charge(1 + values.length)
      try {
        return { known: true, value: engine.evaluateFolded(local, node, values) }
      } catch (error) {
        const failure = failureOf(error)
        if (failure !== undefined) return residual(rebuilt, failure)
        throw error
      }
    }
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
  if (outcome.fails !== undefined) {
    // A limit reached whatever the unknowns are is thrown, as evaluation throws it.
    if (outcome.fails instanceof BonsaiLimitError) throw outcome.fails
    return { status: 'error', error: outcome.fails }
  }

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
  // A call: true host function reads the whole context the residual is given,
  // which therefore has to hold the known data too.
  const hostFunctions = Object.freeze(hostCalls(outcome.node, engine.hostKind))
  const readsContext = hostFunctions.some((name) => engine.hostKind(name)?.call === true)
  // The bindings are the values partial() read, shared with `known` (copying
  // host data would change it: class instances, holes, prototypes). They are
  // compiled in as constants, so evaluating reads the caller's context as it is.
  const frozenBindings = Object.freeze(bindings)
  // The variables known to partial() (not listed whole as unknown), which the
  // context of a residual whose call: true functions read it must hold.
  const knownRoots: string[] = []
  if (readsContext) {
    const whole = new Set(options.unknown)
    engine.readKnown(() => {
      // Own keys, non-enumerable ones included: the language reads those too.
      // A blocked name is never a variable, so a context need not hold it.
      const names = Object.getOwnPropertyNames(known)
      engine.charge(names.length)
      for (const name of names)
        if (!whole.has(name) && !BLOCKED_NAMES.has(name) && known[name] !== undefined)
          knownRoots.push(name)
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
  const sortedDependsOn = Object.freeze([...dependsOn].sort())
  const compiled = engine.compileResidual(
    outcome.node,
    frozenBindings,
    source,
    readsContext,
    knownRoots,
    sortedDependsOn,
  )
  engine.checkTime()
  type Residual = ResidualResult<object, R>
  // The runners take (context, options) and always return a promise when async.
  return Object.freeze({
    status: 'residual',
    residual: outcome.node,
    source,
    bindings: frozenBindings,
    dependsOn: sortedDependsOn,
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
