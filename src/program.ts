import type { Analysis } from './check/checker.js'
import { compileProgram, type CompiledProgram } from './compile/compiler.js'
import type { EvaluateOptions, ResidualOf, Settings } from './environment.js'
import { BonsaiLimitError, BonsaiRuntimeError, type BonsaiError } from './errors.js'
import {
  conforms,
  describeMismatch,
  isRecord,
  type Out,
  type ValidationBudget,
} from './functions/define.js'
import { escaping, isOwn, raised } from './runtime/attribution.js'
import { isStackOverflow, tooDeep } from './runtime/overflow.js'
import { State } from './runtime/state.js'
import { errorText, isMap } from './runtime/values.js'
import { formatType, type Type } from './types.js'

/** What running a program needs from its analysis. */
export type ProgramAnalysis = Pick<Analysis, 'root' | 'calls' | 'async'>

const EMPTY_CONTEXT: Record<string, unknown> = Object.freeze({})

/** A number option: TypeError when it is not a number, RangeError when out of range. */
export function numberOption(
  name: string,
  value: unknown,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`)
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      minimum === 0
        ? `${name} must be a non-negative integer (0 disables it)`
        : `${name} must be a positive integer`,
    )
  }
  return value
}

/**
 * A timeout in milliseconds: 0 turns it off; any other non-negative number,
 * fractions included, is a limit, so a budget computed down to its last
 * fraction of a millisecond stays a limit rather than becoming 0.
 */
export function timeoutOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`)
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number of milliseconds (0 disables it)`)
  }
  return value
}

export function assertKeys(value: unknown, allowed: ReadonlySet<string>, what: string): void {
  if (!isRecord(value)) throw new TypeError(`${what} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(
        `Unknown ${what.toLowerCase()} key "${key}" (expected one of: ${[...allowed].join(', ')})`,
      )
    }
  }
}

export const EVALUATE_OPTION_KEYS = new Set([
  'timeout',
  'maxSteps',
  'signal',
  'now',
  'validateContext',
])

export interface EvaluationLimits {
  readonly maxSteps: number
  readonly timeout: number
  readonly signal: AbortSignal | undefined
  /** The time now() returns, when the caller fixed it. */
  readonly now: Date | undefined
  /** Whether to validate the context, when the caller overrides the environment. */
  readonly validateContext: boolean | undefined
}

/** Whether a value is a valid Date (an object that only inherits from Date.prototype is not). */
export function isValidDate(value: unknown): value is Date {
  try {
    return value instanceof Date && !Number.isNaN(Date.prototype.getTime.call(value))
  } catch {
    return false
  }
}

/** Whether a value has an AbortSignal's members; a signal whose getters throw does not. */
function looksLikeSignal(signal: object): boolean {
  try {
    const s = signal as Record<string, unknown>
    return (
      typeof s.aborted === 'boolean' &&
      typeof s.addEventListener === 'function' &&
      typeof s.removeEventListener === 'function'
    )
  } catch {
    return false
  }
}

/** Validates per-evaluation options the way `limits` are validated; nothing fails open. */
export function evaluationLimits(options: unknown, settings: Settings): EvaluationLimits {
  if (options === undefined) {
    return {
      maxSteps: settings.runtimeLimits.maxSteps,
      timeout: settings.timeout,
      signal: undefined,
      now: undefined,
      validateContext: undefined,
    }
  }
  // Options are the caller's own object; one whose getters or Proxy traps throw
  // is invalid options (a TypeError), never an error from inside evaluation.
  let o: Record<string, unknown>
  try {
    assertKeys(options, EVALUATE_OPTION_KEYS, 'Evaluate option')
    const read = options as Record<string, unknown>
    o = {
      maxSteps: read.maxSteps,
      timeout: read.timeout,
      signal: read.signal,
      now: read.now,
      validateContext: read.validateContext,
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error
    throw new TypeError(`Evaluate options could not be read: ${errorText(error)}`, { cause: error })
  }
  const signal = o.signal
  if (
    signal !== undefined &&
    (typeof signal !== 'object' || signal === null || !looksLikeSignal(signal))
  ) {
    throw new TypeError('signal must be an AbortSignal')
  }
  if (o.now !== undefined && !isValidDate(o.now)) throw new TypeError('now must be a valid Date')
  if (o.validateContext !== undefined && typeof o.validateContext !== 'boolean')
    throw new TypeError('validateContext must be a boolean')
  return {
    maxSteps: numberOption('maxSteps', o.maxSteps, settings.runtimeLimits.maxSteps, 0),
    timeout: timeoutOption('timeout', o.timeout, settings.timeout),
    // A structurally checked AbortSignalLike; evaluation only reads the members checked above.
    signal: signal as AbortSignal | undefined,
    now: o.now,
    validateContext: o.validateContext,
  }
}

export interface ValidationLimits {
  readonly maxDepth: number
  readonly maxSteps: number
  readonly timeout: number
}

export function validationBudget(source: string, limits: ValidationLimits): ValidationBudget {
  return {
    maxDepth: limits.maxDepth,
    remaining: limits.maxSteps > 0 ? limits.maxSteps : Number.POSITIVE_INFINITY,
    deadline: limits.timeout > 0 ? performance.now() + limits.timeout : 0,
    onExhausted: (reason) => {
      if (reason === 'depth') {
        throw raised(
          new BonsaiLimitError(
            'VALUE_DEPTH_LIMIT',
            `Context nests deeper than ${limits.maxDepth}`,
            {
              source,
            },
          ),
        )
      }
      if (reason === 'time')
        throw raised(new BonsaiLimitError('TIMEOUT', 'Context validation timed out', { source }))
      throw raised(
        new BonsaiLimitError('STEP_LIMIT', 'Context validation exceeded the step limit', {
          source,
        }),
      )
    },
  }
}

export function invalidContext(problem: string | undefined, source: string): void {
  if (problem !== undefined) {
    throw raised(
      new BonsaiRuntimeError('INVALID_CONTEXT', `Invalid context: ${problem}`, { source }),
    )
  }
}

export function validateContext(
  ctx: Record<string, unknown>,
  variables: Readonly<Record<string, Type>>,
  source: string,
  limits: ValidationLimits,
): void {
  const budget = validationBudget(source, limits)
  for (const [name, type] of Object.entries(variables)) {
    const value = Object.hasOwn(ctx, name) ? ctx[name] : undefined
    invalidContext(describeMismatch(value, type, name, budget), source)
  }
}

/** The budget validating a context gets: the evaluation's steps and time, and the value depth limit. */
export function validationLimits(settings: Settings, limits: EvaluationLimits): ValidationLimits {
  return {
    maxDepth: settings.runtimeLimits.maxValueDepth,
    maxSteps: limits.maxSteps,
    timeout: limits.timeout,
  }
}

/**
 * Reading host data (a getter, a Proxy trap, a `then` hook) can throw. Such a
 * failure is a HOST_ERROR, never a raw JavaScript error. Only the errors this
 * evaluation raised pass through: any other Bonsai error (from another
 * evaluation, from parsing, checking, or translating, or built by the host)
 * that host data threw is the host data's failure too.
 */
export function hostDataFailure(error: unknown, source: string): BonsaiError {
  if (isOwn(error)) return error
  if (isStackOverflow(error)) return raised(tooDeep(source, error))
  return raised(
    new BonsaiRuntimeError('HOST_ERROR', `Reading host data failed: ${errorText(error)}`, {
      source,
      cause: error,
    }),
  )
}

/** The most zones one program warms when it is compiled. */
const WARMED_ZONES = 16

/**
 * Loads the time zone data a program's calls need, so its first evaluation
 * does not pay for it inside its deadline. Only built-in functions that take a
 * zone count: a zone written as text is loaded itself, and any other zone
 * argument loads the data every zone shares. Each zone is warmed once, and at
 * most WARMED_ZONES of them, so a source full of zone names compiles quickly.
 */
export function warmZones(analysis: Pick<Analysis, 'calls'>): void {
  const seen = new Set<string | undefined>()
  for (const [call, plan] of analysis.calls) {
    const zone = plan.def.zone
    const arg = zone === undefined ? undefined : call.args[zone.at]
    if (arg === undefined) continue
    const name = arg.type === 'Literal' ? arg.value : undefined
    if ((name !== undefined && typeof name !== 'string') || seen.has(name)) continue
    seen.add(name)
    zone?.warm(name)
    if (seen.size >= WARMED_ZONES) return
  }
}

export function contextOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return EMPTY_CONTEXT
  let map: boolean
  try {
    // A Proxy (even a revoked one) answers these through its traps.
    map = typeof value === 'object' && isMap(value)
  } catch (error) {
    throw new BonsaiRuntimeError('HOST_ERROR', 'Reading the evaluation context failed', {
      cause: error,
    })
  }
  // A caller's mistake, like invalid options, not an error in the expression's data.
  if (!map) throw new TypeError('The evaluation context must be a plain object or class instance')
  return value as Record<string, unknown>
}

export interface RunnerInput {
  readonly source: string
  readonly analysis: ProgramAnalysis
  /** The type the result is checked against at run time, when the checker could not prove it. */
  readonly guard: Type | undefined
  readonly settings: Settings
  readonly residualOf?: ResidualOf | undefined
}

/**
 * How a compiled program runs: per-evaluation limits, context validation, the
 * pooled synchronous State, the result guard, and settling async results.
 * Shared by environments and by anything else that builds programs, so every
 * program evaluates the same way.
 */
export function programRunner<R>({ source, analysis, guard, settings, residualOf }: RunnerInput) {
  const checked = (result: unknown, state: State): void => {
    if (guard !== undefined && !conforms(result, guard, state)) {
      throw raised(
        new BonsaiRuntimeError(
          'TYPE_ERROR',
          `The result does not match the expected type ${formatType(guard)}`,
          { source },
        ),
      )
    }
  }
  // The limits of an evaluation without options: built once, not per run.
  const defaultLimits = evaluationLimits(undefined, settings)
  const limitsOf = (options: EvaluateOptions | undefined): EvaluationLimits =>
    options === undefined ? defaultLimits : evaluationLimits(options, settings)
  let syncCode: CompiledProgram | undefined
  let asyncCode: CompiledProgram | undefined
  let pooled: State | undefined
  let pooledInUse = false

  const compileOptions = residualOf === undefined ? {} : { constant: residualOf.constant }
  const syncProgram = (): CompiledProgram =>
    (syncCode ??= compileProgram(analysis, 'sync', compileOptions))
  const asyncProgram = (): CompiledProgram =>
    (asyncCode ??= analysis.async
      ? compileProgram(analysis, 'async', compileOptions)
      : syncProgram())

  // Options and the context's shape are the caller's own mistakes (TypeError,
  // RangeError, INVALID_ARGUMENT), so they are checked before anything reads
  // host data and are never reported as host failures.
  function prepare(
    state: State,
    ctx: Record<string, unknown>,
    limits: EvaluationLimits,
    locals: number,
  ): void {
    state.reset(ctx, source, locals, limits.maxSteps, limits.timeout, limits.signal)
    if (limits.now !== undefined) state.nowValue = limits.now
    const validation =
      (limits.validateContext ?? settings.validateContext) ? settings.variables : undefined
    if (residualOf !== undefined) residualOf.prepare(state, ctx, validation, limits)
    else if (validation !== undefined)
      validateContext(ctx, validation, source, validationLimits(settings, limits))
  }

  function runSync(context: unknown, options: EvaluateOptions | undefined): R {
    if (analysis.async) {
      throw escaping(
        new BonsaiRuntimeError(
          'ASYNC_IN_SYNC',
          'This expression calls an async function; use evaluate() instead of evaluateSync()',
          { source },
        ),
      )
    }
    const code = syncProgram()
    const limits = limitsOf(options)
    const ctx = contextOf(context)
    let state: State
    const reuse = !pooledInUse
    if (reuse) {
      pooled ??= new State(settings.runtimeLimits, settings.clock)
      state = pooled
      pooledInUse = true
    } else {
      state = new State(settings.runtimeLimits, settings.clock)
    }
    try {
      prepare(state, ctx, limits, code.localCount)
      const result = code.run(state)
      checked(result, state)
      state.checkTime()
      return result as R
    } catch (error) {
      throw escaping(hostDataFailure(error, source))
    } finally {
      state.release()
      if (reuse) pooledInUse = false
    }
  }

  async function runAsync(context: unknown, options: EvaluateOptions | undefined): Promise<R> {
    if (!analysis.async) {
      const result = runSync(context, options)
      try {
        return settle(result)
      } catch (error) {
        throw escaping(hostDataFailure(error, source))
      }
    }
    const code = asyncProgram()
    const limits = limitsOf(options)
    const ctx = contextOf(context)
    const state = new State(settings.runtimeLimits, settings.clock)
    try {
      prepare(state, ctx, limits, code.localCount)
      const result = ((await code.run(state)) as Out).v
      checked(result, state)
      state.checkTime()
      return settle(result as R)
    } catch (error) {
      throw escaping(hostDataFailure(error, source))
    } finally {
      state.release()
    }
  }

  // Returning a thenable from an async function would call its `then`
  // (an ORM query object would execute), so it is an error instead.
  function settle(result: R): R {
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      throw raised(
        new BonsaiRuntimeError(
          'TYPE_ERROR',
          'evaluate() cannot return a promise-like value; use evaluateSync()',
          { source },
        ),
      )
    }
    return result
  }
  return { prepare, checked, settle, runSync, runAsync, compileOptions }
}
