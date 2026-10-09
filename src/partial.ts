import type { Analysis } from './check/checker.js'
import { BonsaiLimitError, BonsaiRuntimeError, type BonsaiError } from './errors.js'
import { forEachChild, type LambdaNode, type Node, type SpreadNode } from './syntax/ast.js'
import { parse, type ParseLimits } from './syntax/parser.js'
import { print } from './syntax/printer.js'
import { MAX_TRACE_TEXT, capTraceText } from './runtime/trace.js'
import { isMap, type Duration } from './runtime/values.js'
import type {
  AbortSignalLike,
  EvaluateOptions,
  ExplainOptions,
  Explanation,
} from './environment.js'

// === dependencies ===

/** What a subtree needs from outside itself to be evaluated. */
interface Deps {
  /** Context paths read: `user.age` for static member chains, `user` otherwise. */
  readonly paths: ReadonlySet<string>
  /** let bindings and lambda parameters referenced but bound outside the subtree. */
  readonly locals: ReadonlySet<string>
  /** Reads the implicit lambda parameter bound outside the subtree. */
  readonly it: boolean
  /** Calls now(). */
  readonly now: boolean
  /** Calls a host function (including one that replaces a built-in). */
  readonly host: boolean
  /** Calls an async host function (never evaluated during partial evaluation). */
  readonly asyncHost: boolean
  /** Calls a context host function, which reads the whole context. */
  readonly wholeContext: boolean
}

const NONE: Deps = {
  paths: new Set(),
  locals: new Set(),
  it: false,
  now: false,
  host: false,
  asyncHost: false,
  wholeContext: false,
}

/** How a host function behaves, for deciding what partial evaluation may call. */
export interface HostKind {
  readonly async: boolean
  /** Receives a HostCall, so it can read the whole context. */
  readonly call: boolean
}

/** The static context path a member chain reads (`user.address.city`), if any. */
function staticPath(node: Node): string | undefined {
  if (node.type === 'Variable') return node.name
  if (node.type === 'Member') {
    const base = staticPath(node.object)
    return base === undefined ? undefined : `${base}.${node.name}`
  }
  return undefined
}

function dependencies(hostKind: (name: string) => HostKind | undefined): (node: Node) => Deps {
  const memo = new Map<Node, Deps>()
  const merge = (all: readonly Deps[]): Deps => {
    if (all.length === 0) return NONE
    if (all.length === 1) return all[0]
    return {
      paths: new Set(all.flatMap((d) => [...d.paths])),
      locals: new Set(all.flatMap((d) => [...d.locals])),
      it: all.some((d) => d.it),
      now: all.some((d) => d.now),
      host: all.some((d) => d.host),
      asyncHost: all.some((d) => d.asyncHost),
      wholeContext: all.some((d) => d.wholeContext),
    }
  }
  const visit = (node: Node): Deps => {
    const cached = memo.get(node)
    if (cached !== undefined) return cached
    const children = (): Deps[] => {
      const out: Deps[] = []
      forEachChild(node, (child) => {
        out.push(visit(child))
      })
      return out
    }
    let deps: Deps
    switch (node.type) {
      case 'Variable':
        deps = { ...NONE, paths: new Set([node.name]) }
        break
      case 'Local':
        deps = { ...NONE, locals: new Set([node.name]) }
        break
      case 'It':
        deps = { ...NONE, it: true }
        break
      case 'Member': {
        const path = staticPath(node)
        deps = path === undefined ? merge(children()) : { ...NONE, paths: new Set([path]) }
        break
      }
      case 'Lambda': {
        const body = visit(node.body)
        const locals = new Set([...body.locals].filter((name) => !node.params.includes(name)))
        deps = { ...body, locals, it: node.implicit ? false : body.it }
        break
      }
      case 'Let': {
        const value = visit(node.value)
        const body = visit(node.body)
        deps = merge([
          value,
          { ...body, locals: new Set([...body.locals].filter((name) => name !== node.name)) },
        ])
        break
      }
      case 'Call': {
        const kind = hostKind(node.name)
        const own: Deps = {
          ...NONE,
          now: node.name === 'now' && kind === undefined,
          host: kind !== undefined,
          asyncHost: kind?.async === true,
          wholeContext: kind?.call === true,
        }
        deps = merge([own, ...children()])
        break
      }
      case 'Literal':
      case 'Template':
      case 'Index':
      case 'Unary':
      case 'Binary':
      case 'Conditional':
      case 'List':
      case 'Map':
      case 'Has':
      case 'Try':
      default:
        deps = merge(children())
    }
    memo.set(node, deps)
    return deps
  }
  return visit
}

/**
 * Whether a read of a path could observe an unknown path: the path itself, a
 * prefix of it, or a path under it is unknown. Built once, each test walks only
 * the path's own segments, so checking costs nothing like paths x unknowns.
 */
function unknownIndex(unknown: readonly string[]): (path: string) => boolean {
  const exact = new Set(unknown)
  const parents = new Set<string>()
  for (const path of unknown) {
    for (let dot = path.indexOf('.'); dot !== -1; dot = path.indexOf('.', dot + 1))
      parents.add(path.slice(0, dot))
  }
  return (path) => {
    if (exact.has(path) || parents.has(path)) return true
    for (let dot = path.indexOf('.'); dot !== -1; dot = path.indexOf('.', dot + 1))
      if (exact.has(path.slice(0, dot))) return true
    return false
  }
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

export type PartialResult<R, Ctx = object> =
  | { readonly status: 'value'; readonly value: R }
  /** Evaluation fails whatever the unknown data turns out to be. */
  | { readonly status: 'error'; readonly error: BonsaiError }
  | ResidualResult<R, Ctx>

export interface ResidualResult<R, Ctx = object> {
  readonly status: 'residual'
  /**
   * The simplified expression that still needs the unknown data. Known values
   * that are not short primitives are referenced as variables named in
   * `bindings` rather than copied into the tree.
   */
  readonly residual: Node
  /** The residual as source, for display and storage alongside `bindings`. */
  readonly source: string
  /** Known values the residual refers to by name. */
  readonly bindings: Readonly<Record<string, unknown>>
  /** Context paths the residual still reads (besides `bindings`). */
  readonly dependsOn: readonly string[]
  /** Host functions the residual still calls (they may replace a built-in of the same name). */
  readonly hostFunctions: readonly string[]
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
   * known yet. Unknown wins over a value present in `known`. Default: every
   * variable the expression reads that `known` does not have.
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
  /** Wall-clock budget for the whole partial evaluation in milliseconds (0 = none). */
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
   * Whether a known value read whole is incomplete for its declared type (an
   * object missing declared fields), so it cannot be read as given. Open
   * environments declare nothing, so a value they read whole is taken as given.
   */
  readonly incomplete: (path: string, value: unknown) => boolean
  /**
   * Evaluates a subtree against the known context with the given free locals,
   * sharing one step budget and deadline across the whole partial evaluation.
   * Throws BonsaiRuntimeError for evaluation errors and BonsaiLimitError when
   * a limit is reached.
   */
  readonly evaluate: (node: Node, locals: readonly (readonly [string, unknown])[]) => unknown
  /**
   * Compiles a residual for later evaluation, with `bindings` as fixed values
   * of the variables they name; everything else is read from the caller's
   * context. `source` is the residual printed; `known` (when the residual calls
   * `call: true` host functions) is the known data they see under the caller's.
   */
  readonly compileResidual: (
    residual: Node,
    bindings: Readonly<Record<string, unknown>>,
    source: string,
    known: Readonly<Record<string, unknown>> | undefined,
  ) => {
    runSync: (ctx: unknown, options: unknown) => unknown
    runAsync: (ctx: unknown, options: unknown) => Promise<unknown>
    explainSync: (ctx: unknown, options: unknown) => Explanation<unknown>
    explainAsync: (ctx: unknown, options: unknown) => Promise<Explanation<unknown>>
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
const NO_PATHS: ReadonlySet<string> = new Set()
/**
 * Longest string written into a residual as a literal. A longer one is bound
 * once and referenced by name, so a value used many times is not copied into
 * the residual at every use.
 */
const MAX_INLINE_STRING = 16
/** Steps charged per character of residual printed or compiled. */
export const RESIDUAL_CHARS_PER_STEP = 16
/** Known keys copied per step for a residual's call: true functions. */
export const KNOWN_KEYS_PER_STEP = 8
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
  const depsOf = dependencies(engine.hostKind)
  const rootDeps = depsOf(root)
  const unknown =
    options.unknown ??
    [...new Set([...rootDeps.paths].map((path) => path.split('.')[0]))].filter(
      // A known value of undefined is absent, as a host key holding undefined is.
      (name) => !Object.hasOwn(known, name) || known[name] === undefined,
    )
  const touchesUnknown = unknownIndex(unknown)
  const callHost = options.callHostFunctions === true
  const nowKnown = options.now !== undefined
  // Without an explicit unknown list, anything not given is unknown, including
  // a property a known object leaves out (or a declared object given in part):
  // reading it as null could decide the result wrongly.
  const missing = options.unknown === undefined ? missingPaths(rootDeps.paths) : NO_PATHS

  const bindings: Record<string, unknown> = {}
  // Binding names must not shadow a variable the expression reads or a name it
  // binds; known data the expression never reads is irrelevant.
  const taken = new Set([...rootDeps.paths].map((path) => path.split('.')[0]))
  for (const name of boundNames(root)) taken.add(name)
  let bindingCount = 0
  const freshName = (base: string): string => {
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`
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
   * every path above such a path (reading that object whole would see it
   * incomplete), and a whole read of a declared object given in part.
   */
  function missingPaths(paths: ReadonlySet<string>): ReadonlySet<string> {
    const out = new Set<string>()
    // The path and every path above it (reading those whole would see the gap).
    const markMissing = (segments: readonly string[]): void => {
      for (let i = 1; i <= segments.length; i++) out.add(segments.slice(0, i).join('.'))
    }
    for (const path of paths) {
      engine.charge()
      const segments = path.split('.')
      let value: unknown = known[segments[0]]
      // A variable known does not give is unknown already.
      if (value === undefined) continue
      // Whether the path reached its own value (rather than stopping at a gap,
      // or at null, a list, or another value, where evaluation decides).
      let reached = true
      for (let i = 1; i < segments.length; i++) {
        if (value === null || !isMap(value)) {
          reached = false
          break
        }
        const segment = segments[i]
        const next = Object.hasOwn(value, segment) ? value[segment] : undefined
        if (next === undefined) {
          markMissing(segments)
          reached = false
          break
        }
        value = next
      }
      if (reached && engine.incomplete(path, value)) markMissing(segments)
    }
    return out
  }

  type Env = ReadonlyMap<string, Outcome>

  const closed = (node: Node, env: Env): boolean => {
    const deps = depsOf(node)
    if (deps.it || (deps.now && !nowKnown) || (deps.host && !callHost) || deps.asyncHost)
      return false
    // A context function can read variables the expression never names, so it
    // runs only when the caller says nothing is unknown.
    if (deps.wholeContext && (options.unknown === undefined || unknown.length > 0)) return false
    for (const path of deps.paths) if (touchesUnknown(path) || missing.has(path)) return false
    for (const name of deps.locals) if (env.get(name)?.known !== true) return false
    return true
  }

  const evaluateClosed = (node: Node, env: Env): unknown => {
    const locals = [...depsOf(node).locals].map(
      (name) => [name, (env.get(name) as { value: unknown }).value] as const,
    )
    return engine.evaluate(node, locals)
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
      case 'Literal':
      case 'Template':
      case 'Variable':
      case 'Local':
      case 'It':
      case 'Member':
      case 'Index':
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
        if (lambda.implicit && !depsOf(body).it) {
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
  const residualDeps = dependencies(engine.hostKind)(outcome.node)
  const frozenBindings = Object.freeze({ ...bindings })
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
  const hostFunctions = hostCalls(outcome.node, engine.hostKind)
  const readsContext = hostFunctions.some((name) => engine.hostKind(name)?.call === true)
  // The bindings are compiled in as constants, so evaluating reads the caller's
  // context as it is: no per-call copy, and getters see their own object.
  const knownCopy = readsContext ? Object.freeze({ ...known }) : undefined
  if (knownCopy !== undefined)
    engine.charge(1 + Math.ceil(Object.keys(knownCopy).length / KNOWN_KEYS_PER_STEP))
  const compiled = engine.compileResidual(outcome.node, frozenBindings, source, knownCopy)
  engine.checkTime()
  return Object.freeze({
    status: 'residual',
    residual: outcome.node,
    source,
    bindings: frozenBindings,
    dependsOn: [...residualDeps.paths]
      .filter((path) => !Object.hasOwn(frozenBindings, path.split('.')[0]))
      .sort(),
    hostFunctions,
    evaluateSync: (context?: object, evaluateOptions?: EvaluateOptions) =>
      compiled.runSync(context, evaluateOptions) as R,
    evaluate: async (context?: object, evaluateOptions?: EvaluateOptions) =>
      (await compiled.runAsync(context, evaluateOptions)) as R,
    explainSync: (context?: object, explainOptions?: ExplainOptions) =>
      compiled.explainSync(context, explainOptions) as Explanation<R>,
    explain: (context?: object, explainOptions?: ExplainOptions) =>
      compiled.explainAsync(context, explainOptions) as Promise<Explanation<R>>,
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
  const spreadable = (item: Node | SpreadNode): Node | SpreadNode =>
    item.type === 'Spread' ? { ...item, argument: one(item.argument) } : one(item)
  switch (node.type) {
    case 'Template':
      return {
        ...node,
        parts: node.parts.map((part) => (typeof part === 'string' ? part : one(part))),
      }
    case 'Member':
      return { ...node, object: one(node.object) }
    case 'Index':
      return { ...node, object: one(node.object), index: one(node.index) }
    case 'Call':
      return { ...node, args: node.args.map(spreadable) }
    case 'Unary':
      return { ...node, operand: one(node.operand) }
    case 'Binary':
      return { ...node, left: one(node.left), right: one(node.right) }
    case 'Conditional':
      return { ...node, test: one(node.test), then: one(node.then), otherwise: one(node.otherwise) }
    case 'List':
      return { ...node, items: node.items.map(spreadable) }
    case 'Map':
      return {
        ...node,
        entries: node.entries.map((entry) =>
          entry.type === 'Spread'
            ? { ...entry, argument: one(entry.argument) }
            : {
                ...entry,
                key: typeof entry.key === 'string' ? entry.key : one(entry.key),
                value: one(entry.value),
              },
        ),
      }
    case 'Lambda':
      return f(node, node)
    case 'Let':
      return { ...node, value: one(node.value), body: one(node.body) }
    case 'Has': {
      // has() tests a path without reading it: keep the path's shape, but
      // rewrite what the path is built from.
      const target = node.target
      return target.type === 'Member'
        ? { ...node, target: { ...target, object: one(target.object) } }
        : { ...node, target: { ...target, object: one(target.object), index: one(target.index) } }
    }
    case 'Try':
      return { ...node, body: one(node.body), fallback: one(node.fallback) }
    case 'Literal':
    case 'Variable':
    case 'Local':
    case 'It':
    default:
      return node
  }
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
