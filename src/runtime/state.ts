import type { Tracer } from './trace.js'
import { BonsaiLimitError, BonsaiRuntimeError, type ErrorCode, type Span } from '../errors.js'

/** Runtime limits. Every limit is on by default; options only change the budget. */
export interface RuntimeLimits {
  /** Deterministic work budget per evaluation. Default 1,000,000. */
  readonly maxSteps: number
  /** Longest string an expression may produce. Default 100,000. */
  readonly maxStringLength: number
  /** Longest list an expression may produce. Default 100,000. */
  readonly maxListLength: number
  /** Deepest value nesting an expression may build, or equality and templates will walk. Default 64. */
  readonly maxValueDepth: number
  /** Longest regular expression pattern `matches` accepts. Default 4,096. */
  readonly maxPatternLength: number
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  maxSteps: 1_000_000,
  maxStringLength: 100_000,
  maxListLength: 100_000,
  maxValueDepth: 64,
  maxPatternLength: 4096,
})

const CLOCK_SAMPLE = 1024
const NO_CONTEXT: Record<string, unknown> = Object.freeze({})
/**
 * Building a runtime error (message, span, stack) costs about as much as
 * 50 ordinary steps; `try()` can catch errors in a loop, so each one is charged.
 */
const ERROR_COST = 64

/** A resource whose creation failed, remembered so a retry costs no work. */
class Failed {
  readonly error: unknown
  constructor(error: unknown) {
    this.error = error
  }
}

/** Mutable per-evaluation state. Created (or reset) once per run. */
export class State {
  ctx: Record<string, unknown> = NO_CONTEXT
  /**
   * The caller's context, as `context: true` host functions receive it. The
   * same object as `ctx`, except for a partial-evaluation residual, whose
   * `ctx` also holds the known values it refers to.
   */
  hostCtx: Record<string, unknown> = NO_CONTEXT
  source = ''
  locals: unknown[] = []
  steps = 0
  maxSteps: number
  deadline = 0
  signal: AbortSignal | undefined = undefined
  /** An error thrown while reading the signal (see `isAborted`). */
  signalError: unknown = undefined
  nextSample = CLOCK_SAMPLE
  nowValue: Date | undefined = undefined
  /** Shapes of containers this evaluation built (see `track`); created on demand. */
  shapes: WeakMap<object, number> | undefined = undefined
  /** Time zones this evaluation has read, and what it has paid for (see time.ts). */
  zones: Map<string, unknown> | undefined = undefined
  /** Costly resources (patterns, formatters) this evaluation has used; created on demand. */
  private resources: Map<string, unknown> | undefined = undefined
  /** Set only while explaining; traced programs record into it. */
  tracer: Tracer | undefined = undefined
  readonly limits: RuntimeLimits
  readonly clock: () => Date

  constructor(limits: RuntimeLimits, clock: () => Date) {
    this.limits = limits
    this.maxSteps = limits.maxSteps
    this.clock = clock
  }

  reset(
    ctx: Record<string, unknown>,
    source: string,
    localCount: number,
    maxSteps: number,
    timeout: number,
    signal: AbortSignal | undefined,
  ): void {
    this.ctx = ctx
    this.hostCtx = ctx
    this.source = source
    if (this.locals.length < localCount) this.locals = new Array<unknown>(localCount)
    this.steps = 0
    this.maxSteps = maxSteps
    this.deadline = timeout > 0 ? performance.now() + timeout : 0
    this.signal = signal
    this.signalError = undefined
    this.scheduleSample()
    this.nowValue = undefined
    this.resources = undefined
    this.shapes = undefined
    this.zones = undefined
    if (signal !== undefined && isAborted(this)) throw abortError(this)
  }

  /** Grows the locals array for a program with more slots (partial evaluation). */
  ensureLocals(count: number): void {
    if (this.locals.length < count) this.locals.length = count
  }

  release(): void {
    this.tracer = undefined
    this.ctx = NO_CONTEXT
    this.hostCtx = NO_CONTEXT
    this.resources = undefined
    this.shapes = undefined
    this.zones = undefined
    this.locals.fill(undefined)
    this.signal = undefined
  }

  /**
   * Charges `n` units of work. `nextSample` is the next step count at which
   * anything needs checking (the step limit or a clock/abort sample), so the
   * common case is one addition and one comparison.
   */
  charge(n: number): void {
    this.steps += n
    if (this.steps >= this.nextSample) this.sample()
  }

  /** Slow path of {@link charge}: enforce the step limit, then sample the clock. */
  sample(): void {
    if (this.maxSteps > 0 && this.steps > this.maxSteps) {
      throw this.limit('STEP_LIMIT', `Evaluation exceeded the step limit of ${this.maxSteps}`)
    }
    this.checkTime()
    this.scheduleSample()
  }

  private scheduleSample(): void {
    const next = this.steps + CLOCK_SAMPLE
    this.nextSample = this.maxSteps > 0 ? Math.min(next, this.maxSteps + 1) : next
  }

  /** Checks the deadline and abort signal now. */
  checkTime(): void {
    if (this.deadline !== 0 && performance.now() > this.deadline) {
      throw this.limit('TIMEOUT', 'Evaluation timed out')
    }
    if (this.signal !== undefined && isAborted(this)) throw abortError(this)
  }

  /**
   * A costly resource (a compiled pattern, a formatter) for this evaluation.
   * Its first use in an evaluation is charged `before` (then `after(resource)`)
   * as if nothing were cached, and the evaluation keeps it, so step counts never
   * depend on what shared caches hold, and a cache eviction never causes
   * uncharged work. The charge comes before creating it, so a creation that
   * fails (inside `try()`) is paid for too, and the failure is remembered.
   */
  resource<R>(key: string, before: number, create: () => R, after?: (resource: R) => number): R {
    const resources = (this.resources ??= new Map())
    const known = resources.get(key)
    if (known !== undefined) {
      if (known instanceof Failed) {
        // Failing again costs what failing costs, even without building the error anew.
        this.charge(ERROR_COST)
        throw known.error
      }
      return known as R
    }
    this.charge(before)
    let value: R
    try {
      value = create()
    } catch (error) {
      resources.set(key, new Failed(error))
      throw error
    }
    resources.set(key, value)
    if (after !== undefined) this.charge(after(value))
    return value
  }

  now(): Date {
    this.nowValue ??= this.clock()
    return this.nowValue
  }

  stringLimit(length: number, at?: Span): void {
    if (length > this.limits.maxStringLength) {
      throw this.limit(
        'STRING_LIMIT',
        `String of length ${length} exceeds the limit of ${this.limits.maxStringLength}`,
        at,
      )
    }
  }

  listLimit(length: number, at?: Span): void {
    if (length > this.limits.maxListLength) {
      throw this.limit(
        'LIST_LIMIT',
        `List of length ${length} exceeds the limit of ${this.limits.maxListLength}`,
        at,
      )
    }
  }

  /** A limit error at `at`. Unlike {@link error}, it is not charged: the evaluation is over. */
  limit(code: ErrorCode, message: string, at?: Span): BonsaiLimitError {
    return new BonsaiLimitError(code, message, { source: this.source, span: spanOf(at) })
  }

  error(code: ErrorCode, message: string, at?: Span, cause?: unknown): BonsaiRuntimeError {
    this.charge(ERROR_COST)
    return new BonsaiRuntimeError(code, message, { source: this.source, span: spanOf(at), cause })
  }
}

/** Copies just the offsets, so errors never hold (or serialize) syntax nodes. */
function spanOf(at: Span | undefined): Span | undefined {
  return at === undefined ? undefined : { start: at.start, end: at.end }
}

/**
 * Reads the signal, which is host code: a getter that throws counts as an
 * abort (failing closed, with the error as the cause), never as a raw error.
 */
function isAborted(state: State): boolean {
  try {
    return state.signal?.aborted === true
  } catch (error) {
    state.signalError = error
    return true
  }
}

function abortError(state: State): BonsaiLimitError {
  let cause: unknown = state.signalError
  if (cause === undefined) {
    try {
      cause = state.signal?.reason
    } catch (error) {
      cause = error
    }
  }
  return new BonsaiLimitError('ABORTED', 'Evaluation was aborted', { source: state.source, cause })
}
