/**
 * Explaining and partial evaluation: the program features the main entry
 * point adds to every environment. `bonsai-js/lite` leaves them out, so a
 * bundle that only checks and evaluates does not carry them.
 */
import { analyze, type Analysis, type CallPlan } from './check/checker.js'
import { compileProgram, type CompiledProgram } from './compile/compiler.js'
import { escaping, isOwn, raised } from './runtime/attribution.js'
import { BonsaiRuntimeError, type BonsaiError } from './errors.js'
import { describeMismatch, type Out, type ValidationBudget } from './functions/define.js'
import {
  EVALUATE_OPTION_KEYS,
  contextOf,
  evaluationLimits,
  hostDataFailure,
  invalidContext,
  isValidDate,
  validationBudget,
} from './program.js'
import {
  type EvaluateOptions,
  type ExplainOptions,
  type Explanation,
  type Features,
  type ProgramCore,
  type ProgramFeatures,
} from './environment.js'
import {
  forTranslation,
  partiallyEvaluate,
  residualTexts,
  type PartialOptions,
  type PartialResult,
} from './partial.js'
import { isStackOverflow, tooDeep } from './runtime/overflow.js'
import { State } from './runtime/state.js'
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TRACE_NODES,
  SNAPSHOT_ENTRIES,
  Tracer,
  freezeAll,
  reasonsOf,
  renderTrace,
  snapshot,
  snapshotTrace,
  type ExplanationJSON,
  type Parts,
} from './runtime/trace.js'
import { isMap, keyListCost } from './runtime/values.js'
import { forEachChild, type CallNode, type Node } from './syntax/ast.js'
import { BLOCKED_NAMES, isName } from './syntax/lexer.js'
import type { Type } from './types.js'

/** Subtrees compiled for partial evaluation, in nodes, kept per program: this times its own. */
const SUBTREE_CACHE_FACTOR = 2

const EXPLAIN_OPTION_KEYS: ReadonlySet<string> = new Set([
  ...EVALUATE_OPTION_KEYS,
  'maxIterations',
  'maxTraceNodes',
  'exhaustive',
])

interface ExplainSettings {
  readonly maxIterations: number
  readonly maxNodes: number
  readonly exhaustive: boolean
  /** The evaluation options among them, validated by evaluationLimits. */
  readonly evaluate: EvaluateOptions | undefined
}

/** Reads explain options once, with the same TypeError/RangeError rules as evaluate's. */
function explainSettings(options: unknown): ExplainSettings {
  if (options === undefined) {
    return {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxNodes: DEFAULT_MAX_TRACE_NODES,
      exhaustive: false,
      evaluate: undefined,
    }
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Explain options must be an object')
  let copy: Record<string, unknown>
  try {
    copy = { ...(options as Record<string, unknown>) }
  } catch {
    throw new TypeError('Explain options could not be read')
  }
  for (const key of Object.keys(copy)) {
    if (!EXPLAIN_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `Unknown explain option key "${key}" (expected one of: ${[...EXPLAIN_OPTION_KEYS].join(', ')})`,
      )
    }
  }
  const count = (name: string, fallback: number): number => {
    const value = copy[name]
    if (value === undefined) return fallback
    if (typeof value !== 'number') throw new TypeError(`Explain option "${name}" must be a number`)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`Explain option "${name}" must be a non-negative integer`)
    return value
  }
  if (copy.exhaustive !== undefined && typeof copy.exhaustive !== 'boolean')
    throw new TypeError('Explain option "exhaustive" must be a boolean')
  const {
    maxIterations: _iterations,
    maxTraceNodes: _nodes,
    exhaustive: _exhaustive,
    ...evaluate
  } = copy
  return {
    maxIterations: count('maxIterations', DEFAULT_MAX_ITERATIONS),
    maxNodes: count('maxTraceNodes', DEFAULT_MAX_TRACE_NODES),
    exhaustive: copy.exhaustive === true,
    evaluate,
  }
}

const PARTIAL_OPTION_KEYS: ReadonlySet<string> = new Set([
  'unknown',
  'callHostFunctions',
  'now',
  'maxSteps',
  'timeout',
  'signal',
])
/** A variable name, then field names as reads spell them: none empty or blocked. */
const isPath = (path: unknown): boolean => {
  if (typeof path !== 'string') return false
  const [name, ...fields] = path.split('.')
  return isName(name) && fields.every((field) => field !== '' && !BLOCKED_NAMES.has(field))
}

/** Reads partial() options once, with the same TypeError rules as the other options. */
function partialOptions(options: unknown): PartialOptions {
  if (options === undefined) return {}
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Partial options must be an object')
  let copy: Record<string, unknown>
  try {
    copy = { ...(options as Record<string, unknown>) }
    if (Array.isArray(copy.unknown)) copy.unknown = [...(copy.unknown as unknown[])]
  } catch {
    throw new TypeError('Partial options could not be read')
  }
  for (const key of Object.keys(copy)) {
    if (!PARTIAL_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `Unknown partial option key "${key}" (expected one of: ${[...PARTIAL_OPTION_KEYS].join(', ')})`,
      )
    }
  }
  const unknown = copy.unknown
  if (unknown !== undefined && (!Array.isArray(unknown) || !unknown.every(isPath)))
    throw new TypeError('Partial option "unknown" must be a list of variable names or dotted paths')
  if (copy.callHostFunctions !== undefined && typeof copy.callHostFunctions !== 'boolean')
    throw new TypeError('Partial option "callHostFunctions" must be a boolean')
  if (copy.now !== undefined && !isValidDate(copy.now))
    throw new TypeError('Partial option "now" must be a valid Date')
  return copy
}

/** Paths listed as unknown, as a tree of segments: `whole` marks a listed path. */
interface UnknownTree {
  whole: boolean
  readonly next: Map<string, UnknownTree>
}

function unknownTree(paths: readonly string[]): UnknownTree {
  const root: UnknownTree = { whole: false, next: new Map() }
  for (const path of paths) {
    let node = root
    for (const segment of path.split('.')) {
      let child = node.next.get(segment)
      if (child === undefined) node.next.set(segment, (child = { whole: false, next: new Map() }))
      node = child
    }
    node.whole = true
  }
  return root
}

/**
 * Why `value` does not conform to `type`, leaving out the parts of it under
 * listed unknown paths (`skip`): those are incomplete by design. Everything
 * else is checked as evaluation checks a context.
 */
function describeKnown(
  value: unknown,
  type: Type,
  path: string,
  skip: UnknownTree | undefined,
  budget: ValidationBudget,
): string | undefined {
  if (skip === undefined) return describeMismatch(value, type, path, budget)
  if (skip.whole) return undefined
  if (type.kind === 'union') {
    let first: string | undefined
    for (const member of type.types) {
      const problem = describeKnown(value, member, path, skip, budget)
      if (problem === undefined) return undefined
      first ??= problem
    }
    return first
  }
  const actual = value === undefined ? null : value
  if (type.kind !== 'map' || !isMap(actual)) return describeMismatch(value, type, path, budget)
  if (--budget.remaining < 0) budget.onExhausted('steps')
  for (const [key, fieldType] of Object.entries(type.fields)) {
    const field = Object.hasOwn(actual, key) ? actual[key] : null
    const problem = describeKnown(field, fieldType, `${path}.${key}`, skip.next.get(key), budget)
    if (problem !== undefined) return problem
  }
  if (type.rest === undefined) return undefined
  const keys = Object.keys(actual)
  budget.remaining -= keyListCost(keys.length)
  if (budget.remaining < 0) budget.onExhausted('steps')
  for (const key of keys) {
    // As evaluation's validation: keys the language never reads, or that hold undefined, are not data.
    if (Object.hasOwn(type.fields, key) || BLOCKED_NAMES.has(key) || actual[key] === undefined)
      continue
    const problem = describeKnown(
      actual[key],
      type.rest,
      `${path}.${key}`,
      skip.next.get(key),
      budget,
    )
    if (problem !== undefined) return problem
  }
  return undefined
}

function programFeatures<Ctx, R>(core: ProgramCore<R>): ProgramFeatures<Ctx, R> {
  const {
    source,
    analysis,
    expect,
    settings,
    checkEnv,
    compileOptions,
    residualOf,
    prepare,
    checked,
    settle,
  } = core

  let traceSync: CompiledProgram | undefined
  let traceAsync: CompiledProgram | undefined

  function explanation(
    tracer: Tracer,
    outcome: { ok: true; value: R } | { ok: false; error: BonsaiError },
  ): Explanation<R> {
    const trace = tracer.finish()
    // A result refused after the run (a promise-like value, a failed `expect`
    // check) is the whole expression's failure: marked on the root.
    if (!outcome.ok && trace.evaluated && trace.error === undefined) {
      trace.error = { code: outcome.error.code, message: outcome.error.message }
      delete trace.value
    }
    const truncated = tracer.truncated
    // Every rendering of this explanation lists a map's keys once, however it is sliced.
    const { listings } = tracer
    // Taken once, the first time any part is serialized: one budget for the
    // whole snapshot, however often a value recurs or the traces are sliced.
    let json: ExplanationJSON | undefined
    const parts: Parts = new WeakMap()
    const toJSON = (): ExplanationJSON => {
      if (json !== undefined) return json
      const budget = { left: SNAPSHOT_ENTRIES, keys: listings }
      const result = outcome.ok
        ? { ok: true as const, value: snapshot(outcome.value, budget) }
        : { ok: false as const, error: outcome.error.toJSON() }
      // Frozen: every serialization (and every part of it) is this same snapshot.
      return (json = freezeAll({
        ...result,
        truncated,
        trace: snapshotTrace(trace, budget, parts),
      }))
    }
    tracer.parts = () => (toJSON(), parts)
    return Object.freeze({
      ...outcome,
      trace,
      truncated,
      reasons: () => reasonsOf(trace, listings),
      toString: () => renderTrace(trace, truncated, listings),
      toJSON,
    })
  }

  function failure(error: unknown): { ok: false; error: BonsaiError } {
    return { ok: false, error: escaping(hostDataFailure(error, source)) }
  }

  // A residual's nodes keep the original's offsets (or none, for known
  // values), so their text comes from the printed residual instead: mapped
  // once, the first time the residual is explained.
  let residualText: ReadonlyMap<Node, string> | undefined
  const residualTextMap = (printed: string): ReadonlyMap<Node, string> =>
    (residualText ??= residualTexts(analysis.root, printed, {
      maxSourceLength: Math.max(settings.parseLimits.maxSourceLength, printed.length),
      // Printing adds parentheses (and unary minus for negative literals).
      maxDepth: settings.parseLimits.maxDepth * 4,
      maxNodes: settings.parseLimits.maxNodes * 4,
    }))
  const textOfResidual =
    residualOf === undefined
      ? undefined
      : (node: Node): string => residualTextMap(residualOf.source).get(node) ?? ''

  function tracerFor(explain: ExplainSettings): Tracer {
    return new Tracer(
      source,
      analysis.root,
      explain.maxIterations,
      explain.maxNodes,
      explain.exhaustive,
      textOfResidual,
    )
  }

  /** With `promised`, a thenable result fails as evaluate() fails it (see settle). */
  function explainSync(
    context: unknown,
    options: ExplainOptions | undefined,
    promised = false,
  ): Explanation<R> {
    const explain = explainSettings(options)
    if (analysis.async) {
      return explanation(
        tracerFor(explain),
        failure(
          raised(
            new BonsaiRuntimeError(
              'ASYNC_IN_SYNC',
              'This expression calls an async function; use explain() instead of explainSync()',
              { source },
            ),
          ),
        ),
      )
    }
    const code = (traceSync ??= compileProgram(analysis, 'sync', {
      ...compileOptions,
      trace: true,
    }))
    const limits = evaluationLimits(explain.evaluate, settings)
    const ctx = contextOf(context)
    const state = new State(settings.runtimeLimits, settings.clock)
    // A residual's text is mapped once per residual, work its partial()
    // already charged, so explaining costs the steps evaluating does.
    let tracer: Tracer | undefined
    try {
      prepare(state, ctx, limits, code.localCount)
      tracer = tracerFor(explain)
      state.tracer = tracer
      const value = code.run(state) as R
      checked(value, state)
      state.checkTime()
      if (promised) settle(value)
      return explanation(tracer, { ok: true, value })
    } catch (error) {
      return explanation(tracer ?? tracerFor(explain), failure(error))
    } finally {
      state.release()
    }
  }

  async function explainAsync(
    context: unknown,
    options: ExplainOptions | undefined,
  ): Promise<Explanation<R>> {
    if (!analysis.async) return explainSync(context, options, true)
    const explain = explainSettings(options)
    const code = (traceAsync ??= compileProgram(analysis, 'async', {
      ...compileOptions,
      trace: true,
    }))
    const limits = evaluationLimits(explain.evaluate, settings)
    const ctx = contextOf(context)
    const state = new State(settings.runtimeLimits, settings.clock)
    let tracer: Tracer | undefined
    try {
      prepare(state, ctx, limits, code.localCount)
      tracer = tracerFor(explain)
      state.tracer = tracer
      const value = ((await code.run(state)) as Out).v as R
      // In evaluate()'s order: the expected type, the deadline, then a promise-like value.
      checked(value, state)
      state.checkTime()
      settle(value)
      return explanation(tracer, { ok: true, value })
    } catch (error) {
      return explanation(tracer ?? tracerFor(explain), failure(error))
    } finally {
      state.release()
    }
  }

  // Each call the original program checked, by its source span and name. A
  // residual keeps the spans of the calls it copies, so it can run each one
  // with the overloads the original chose from the declared types: checking
  // the residual again would see other types (a known branch removed, an
  // open environment) and could pick another overload.
  let callsBySpan: Map<string, CallPlan | null> | undefined
  const callKey = (call: CallNode): string => `${call.start}:${call.end}:${call.name}`

  function originalPlans(
    compiled: Node,
    checkedCalls: ReadonlyMap<CallNode, CallPlan>,
  ): ReadonlyMap<CallNode, CallPlan> {
    if (callsBySpan === undefined) {
      callsBySpan = new Map()
      for (const [call, plan] of analysis.calls) {
        const key = callKey(call)
        // Two calls with one span cannot be told apart; neither is reused.
        callsBySpan.set(key, callsBySpan.has(key) ? null : plan)
      }
    }
    const bySpan = callsBySpan
    const plans = new Map(checkedCalls)
    const visit = (node: Node): void => {
      if (node.type === 'Call') {
        const plan = bySpan.get(callKey(node))
        if (plan !== undefined && plan !== null) plans.set(node, plan)
      }
      forEachChild(node, visit)
    }
    visit(compiled)
    return plans
  }

  // Sub-trees compiled on their own for partial evaluation, by free locals.
  // Which subtrees are closed depends on the data, so the cache holds at most
  // a few times the program's own nodes, and starts over when full.
  let subtrees = new Map<Node, Map<string, CompiledProgram>>()
  let subtreeNodes = 0

  function partial(
    known: Record<string, unknown>,
    rawOptions: unknown,
    translation = false,
  ): PartialResult<Ctx, R> {
    const options = partialOptions(rawOptions)
    // One budget for the whole partial evaluation, validated as evaluation's is.
    const limits = evaluationLimits(
      { maxSteps: options.maxSteps, timeout: options.timeout, signal: options.signal },
      settings,
    )
    const context = contextOf(known)
    const now = options.now
    const state = new State(settings.runtimeLimits, now === undefined ? settings.clock : () => now)
    state.reset(context, source, 0, limits.maxSteps, limits.timeout, limits.signal)
    try {
      // Known variables are validated as evaluation validates them, all but
      // the parts under listed unknown paths (incomplete by design): all the
      // data a residual has folded in is checked here, once.
      if (settings.validateContext && settings.variables !== undefined) {
        const variables = settings.variables
        const skip = unknownTree(options.unknown ?? [])
        try {
          const budget = validationBudget(source, {
            maxDepth: settings.runtimeLimits.maxValueDepth,
            maxSteps: limits.maxSteps,
            timeout: limits.timeout,
          })
          for (const [name, type] of Object.entries(variables)) {
            if (!Object.hasOwn(context, name)) continue
            const problem = describeKnown(context[name], type, name, skip.next.get(name), budget)
            invalidContext(problem, source)
          }
        } catch (error) {
          // Validation only reads the known data, so any other failure is the host's.
          if (!isOwn(error)) throw hostDataFailure(error, source)
          if (error instanceof BonsaiRuntimeError) return { status: 'error', error }
          throw error
        }
      }
      const result = partiallyEvaluate<R>(
        {
          analysis,
          hostKind: (name) => {
            const def = settings.host.get(name)
            return def === undefined
              ? undefined
              : { async: def.async === true, call: def.call === true }
          },
          charge: (steps = 1) => {
            state.charge(steps)
          },
          checkTime: () => {
            state.checkTime()
          },
          listLimit: (length, at) => {
            state.listLimit(length, at)
          },
          // Translation reads the residual tree, never its printed source.
          maxSourceLength: translation ? Infinity : settings.parseLimits.maxSourceLength,
          readKnown: (read) => {
            try {
              return read()
            } catch (error) {
              throw hostDataFailure(error, source)
            }
          },
          evaluate: (node, locals, size, total) => {
            const key = locals.map(([name]) => name).join('\u0000')
            let code = subtrees.get(node)?.get(key)
            if (code === undefined) {
              if (subtreeNodes + size > SUBTREE_CACHE_FACTOR * total) {
                subtrees = new Map()
                subtreeNodes = 0
              }
              code = compileProgram({ ...analysis, root: node }, 'sync', {
                locals: locals.map(([name]) => name),
              })
              let byLocals = subtrees.get(node)
              if (byLocals === undefined) subtrees.set(node, (byLocals = new Map()))
              byLocals.set(key, code)
              subtreeNodes += size
            }
            state.ensureLocals(code.localCount)
            locals.forEach(([, value], slot) => {
              state.locals[slot] = value
            })
            try {
              return code.run(state)
            } catch (error) {
              throw hostDataFailure(error, source)
            }
          },
          evaluateFolded: (node, origin, locals) => {
            const plan = origin.type === 'Call' ? analysis.calls.get(origin) : undefined
            const code = compileProgram(
              {
                ...analysis,
                root: node,
                calls: plan === undefined ? new Map() : new Map([[node as CallNode, plan]]),
              },
              'sync',
              { locals: locals.map(([name]) => name) },
            )
            state.ensureLocals(code.localCount)
            locals.forEach(([, value], slot) => {
              state.locals[slot] = value
            })
            try {
              return code.run(state)
            } catch (error) {
              throw hostDataFailure(error, source)
            }
          },
          compileResidual: (
            residual,
            bindings,
            residualSource,
            readsContext,
            knownRoots,
            dependsOn,
          ) => {
            // The original expression passed the checker; inlining known
            // values can make a failing branch statically visible, and that
            // failure must happen at run time, as it would have, so findings
            // here do not stop compilation. Analyzed as a tree (not
            // re-parsed), so the printer's parentheses cannot push it past
            // the parse depth limit.
            const reanalyzed: Analysis = analyze(
              residual,
              { ...checkEnv, variables: undefined, strict: false },
              { expected: expect },
            )
            return core.residual(
              // The plans go on the calls of the tree that is compiled: the
              // analysis root, where implicit lambdas are explicit nodes.
              { ...reanalyzed, calls: originalPlans(reanalyzed.root, reanalyzed.calls) },
              new Map(Object.entries(bindings)),
              {
                source: residualSource,
                readsContext,
                knownRoots,
                dependsOn,
                shapes: state.shapes,
              },
            )
          },
        },
        context,
        options,
      )
      // A decided result still has to match `expect`, as evaluation would check it.
      if (result.status === 'value') {
        try {
          checked(result.value, state)
        } catch (error) {
          // Checking reads the value, which can be host data.
          if (!isOwn(error)) throw hostDataFailure(error, source)
          if (error instanceof BonsaiRuntimeError) return { status: 'error', error }
          throw error
        }
      }
      // The residual accepts any object at run time; its parameter is typed by this program's context.
      return result as PartialResult<Ctx, R>
    } catch (error) {
      // Host data is read through readKnown, evaluate, and the checks above,
      // which report its failures as HOST_ERROR; anything else is a failure
      // of the engine itself, not of the caller's data, so it is not relabeled.
      if (isStackOverflow(error)) throw tooDeep(source, error)
      throw error
    } finally {
      state.release()
    }
  }

  return {
    explainSync,
    explainAsync,
    partial(program, known, options) {
      const translation = forTranslation(program)
      let result: PartialResult<Ctx, R>
      try {
        result = partial(known as Record<string, unknown>, options, translation)
      } catch (error) {
        throw escaping(error)
      }
      if (result.status === 'error') escaping(result.error)
      return Object.freeze(result)
    },
  }
}

/** Explaining and partial evaluation, for the main entry point's environments. */
export const explainAndPartial: Features = { program: programFeatures }
