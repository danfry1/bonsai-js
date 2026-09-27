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
  /** Deepest value nesting that equality and templates will walk. Default 64. */
  readonly maxValueDepth: number
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  maxSteps: 1_000_000,
  maxStringLength: 100_000,
  maxListLength: 100_000,
  maxValueDepth: 64,
})

const CLOCK_SAMPLE = 1024
const NO_CONTEXT: Record<string, unknown> = Object.freeze({})

/** Mutable per-evaluation state. Created (or reset) once per run. */
export class State {
  ctx: Record<string, unknown> = NO_CONTEXT
  source = ''
  locals: unknown[] = []
  steps = 0
  maxSteps: number
  deadline = 0
  signal: AbortSignal | undefined = undefined
  nextSample = CLOCK_SAMPLE
  nowValue: Date | undefined = undefined
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
    this.source = source
    if (this.locals.length < localCount) this.locals = new Array<unknown>(localCount)
    this.steps = 0
    this.maxSteps = maxSteps
    this.deadline = timeout > 0 ? performance.now() + timeout : 0
    this.signal = signal
    this.scheduleSample()
    this.nowValue = undefined
    if (signal?.aborted === true) throw abortError(this)
  }

  /** Grows the locals array for a program with more slots (partial evaluation). */
  ensureLocals(count: number): void {
    if (this.locals.length < count) this.locals.length = count
  }

  release(): void {
    this.tracer = undefined
    this.ctx = NO_CONTEXT
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
      throw new BonsaiLimitError(
        'STEP_LIMIT',
        `Evaluation exceeded the step limit of ${this.maxSteps}`,
        {
          source: this.source,
        },
      )
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
      throw new BonsaiLimitError('TIMEOUT', 'Evaluation timed out', { source: this.source })
    }
    if (this.signal?.aborted === true) throw abortError(this)
  }

  now(): Date {
    this.nowValue ??= this.clock()
    return this.nowValue
  }

  stringLimit(length: number, at?: Span): void {
    if (length > this.limits.maxStringLength) {
      throw new BonsaiLimitError(
        'STRING_LIMIT',
        `String of length ${length} exceeds the limit of ${this.limits.maxStringLength}`,
        { source: this.source, span: spanOf(at) },
      )
    }
  }

  listLimit(length: number, at?: Span): void {
    if (length > this.limits.maxListLength) {
      throw new BonsaiLimitError(
        'LIST_LIMIT',
        `List of length ${length} exceeds the limit of ${this.limits.maxListLength}`,
        { source: this.source, span: spanOf(at) },
      )
    }
  }

  error(code: ErrorCode, message: string, at?: Span, cause?: unknown): BonsaiRuntimeError {
    return new BonsaiRuntimeError(code, message, { source: this.source, span: spanOf(at), cause })
  }
}

/** Copies just the offsets, so errors never hold (or serialize) syntax nodes. */
function spanOf(at: Span | undefined): Span | undefined {
  return at === undefined ? undefined : { start: at.start, end: at.end }
}

function abortError(state: State): BonsaiLimitError {
  return new BonsaiLimitError('ABORTED', 'Evaluation was aborted', {
    source: state.source,
    cause: state.signal?.reason,
  })
}
