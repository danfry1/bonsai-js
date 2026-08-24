import type { BonsaiOptions, EvaluationOptions } from './types.js'
import { BonsaiSecurityError } from './errors.js'

/**
 * Discriminates how a property name is being accessed so security checks can
 * apply different rules (e.g. root identifiers bypass allow/deny lists).
 */
export type AccessKind = 'identifier' | 'member' | 'method' | 'object-key'

export const BLOCKED_PROPERTIES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

const MAX_INDEX_DIGITS = 10

/** Whether `key` is a canonical non-negative integer index (`"0"`, `"12"`, not `"01"`). */
export function isCanonicalIndex(key: string): boolean {
  if (key.length === 0 || key.length > MAX_INDEX_DIGITS) return false
  const n = Number(key)
  return Number.isInteger(n) && n >= 0 && String(n) === key
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<AbortSignal>
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  )
}

const TIMEOUT_CHECK_INTERVAL = 1000

/**
 * Shared sentinel for "no per-run overrides". Callers pass it instead of a
 * fresh `{}` so the synchronous hot path neither allocates nor re-validates
 * options on every evaluation.
 */
export const NO_EVALUATION_OPTIONS: EvaluationOptions = Object.freeze({})

// Deadlines use a monotonic clock where the host provides one: Date.now can
// jump backwards or forwards under NTP adjustment, which would silently widen
// or shrink the timeout window.
// Stryker disable all: host feature detection is selected once at module load and both branches implement the same clock contract
const monotonicNow: () => number =
  typeof performance === 'object' && typeof performance.now === 'function'
    ? () => performance.now()
    : Date.now
// Stryker restore all
const DEFAULT_MAX_DEPTH = 100
const DEFAULT_MAX_SOURCE_LENGTH = 100_000
const DEFAULT_MAX_TOKENS = 25_000
const DEFAULT_MAX_AST_NODES = 10_000
const DEFAULT_MAX_ARRAY_LENGTH = 100_000
const DEFAULT_MAX_STRING_LENGTH = 100_000
const DEFAULT_MAX_OBJECT_PROPERTIES = 10_000
const DEFAULT_MAX_CALL_ARGUMENTS = 1_000
const DEFAULT_MAX_STEPS = 1_000_000

/** Immutable per-instance security configuration derived from BonsaiOptions. */
export class SecurityPolicy {
  readonly maxSourceLength: number
  readonly maxTokens: number
  readonly maxAstNodes: number
  readonly maxDepth: number
  readonly maxArrayLength: number
  readonly maxStringLength: number
  readonly maxObjectProperties: number
  readonly maxCallArguments: number
  /** Maximum accounted evaluator steps per evaluation; 0 disables the bound. */
  readonly maxSteps: number
  readonly timeout: number
  readonly allowedProperties?: ReadonlySet<string>
  readonly deniedProperties?: ReadonlySet<string>

  constructor(options: BonsaiOptions = {}) {
    this.maxSourceLength = options.maxSourceLength ?? DEFAULT_MAX_SOURCE_LENGTH
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.maxAstNodes = options.maxAstNodes ?? DEFAULT_MAX_AST_NODES
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    this.maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH
    this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
    this.maxObjectProperties = options.maxObjectProperties ?? DEFAULT_MAX_OBJECT_PROPERTIES
    this.maxCallArguments = options.maxCallArguments ?? DEFAULT_MAX_CALL_ARGUMENTS
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.timeout = options.timeout ?? 0
    this.allowedProperties = options.allowedProperties
      ? new Set(options.allowedProperties)
      : undefined
    this.deniedProperties = options.deniedProperties ? new Set(options.deniedProperties) : undefined
  }
}

/** Mutable per-evaluation state: tracks depth, step count, and deadline for a single evaluation. */
export class ExecutionContext {
  private stepCount = 0
  private nextCheck = TIMEOUT_CHECK_INTERVAL
  private depth = 0
  private deadline: number
  private maxSteps: number
  private timeout: number
  private signal?: AbortSignal
  // True only while an evaluation is walking this context. Step accounting is
  // gated on it so that closures created during evaluation (lambda accessors,
  // identity/expression lambdas) that a host retains and invokes *after* the
  // evaluation returns cannot mutate this (possibly pooled and reused) context's
  // step state or trip a stale deadline. Outside a run those closures behave as
  // the pure getters they were before per-element accounting existed.
  private running = false
  // Accounting runs when either a step budget or a wall-clock timeout is
  // configured. Constant per instance since both come from the (immutable)
  // policy, so the hot no-limits path can skip step tracking entirely.
  private accounting!: boolean
  readonly policy: SecurityPolicy
  private readonly now: () => number

  constructor(
    policy: SecurityPolicy,
    now: () => number = monotonicNow,
    options: EvaluationOptions = NO_EVALUATION_OPTIONS,
  ) {
    this.policy = policy
    this.now = now
    this.maxSteps = policy.maxSteps
    this.timeout = policy.timeout
    this.deadline = 0
    this.applyOptions(options)
    this.nextCheck = this.computeNextCheck(0)
  }

  /** Reset mutable state for reuse. Avoids allocating a new instance per evaluation. */
  reset(options: EvaluationOptions = NO_EVALUATION_OPTIONS): void {
    this.stepCount = 0
    this.depth = 0
    this.applyOptions(options)
    this.nextCheck = this.computeNextCheck(0)
  }

  private applyOptions(options: EvaluationOptions): void {
    // Stryker disable all: this allocation-free fast path is intentionally semantically identical to resolving the empty override object below
    if (options === NO_EVALUATION_OPTIONS) {
      // Hot path: no per-run overrides, so skip validation and take the
      // instance defaults directly.
      this.maxSteps = this.policy.maxSteps
      this.timeout = this.policy.timeout
      this.signal = undefined
      this.accounting = this.maxSteps !== 0 || this.timeout !== 0
      this.deadline = this.timeout ? this.now() + this.timeout : 0
      return
    }
    // Stryker restore all
    const maxSteps = options.maxSteps ?? this.policy.maxSteps
    const timeout = options.timeout ?? this.policy.timeout
    if (!Number.isInteger(maxSteps) || maxSteps < 0) {
      throw new RangeError(
        `bonsai: "maxSteps" must be a non-negative integer, received ${String(maxSteps)}`,
      )
    }
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new RangeError(
        `bonsai: "timeout" must be a non-negative, finite number of milliseconds, received ${String(timeout)}`,
      )
    }
    if (options.signal !== undefined && !isAbortSignal(options.signal)) {
      throw new TypeError('bonsai: "signal" must be an AbortSignal')
    }
    this.maxSteps = maxSteps
    this.timeout = timeout
    this.signal = options.signal
    this.accounting = maxSteps !== 0 || timeout !== 0 || this.signal !== undefined
    this.deadline = timeout ? this.now() + timeout : 0
  }

  // The next stepCount at which checkpoint() must run: the maxSteps hard cap
  // (checked exactly once, at cap + 1) and, when a timeout is armed, the next
  // periodic clock sample. Whichever comes first.
  private computeNextCheck(from: number): number {
    // Stryker disable next-line all: changing the early checkpoint only changes sampling overhead; checkpoint enforces the exact bound
    const stepsBound = this.maxSteps ? this.maxSteps + 1 : Infinity
    // Stryker disable next-line all: an unarmed interrupt checkpoint is result-equivalent and only slower
    const interruptBound = this.deadline || this.signal ? from + TIMEOUT_CHECK_INTERVAL : Infinity
    return Math.min(stepsBound, interruptBound)
  }

  /** Mark the start of an evaluation walk. Paired with a `finally { endRun() }`. */
  beginRun(): void {
    this.running = true
  }

  /** Mark the end of an evaluation walk, disarming step accounting on this context. */
  endRun(): void {
    this.running = false
  }

  step(): void {
    if (this.accounting && this.running) {
      if (++this.stepCount >= this.nextCheck) {
        this.checkpoint()
      }
    }
  }

  /**
   * Charge `n` units of work at once (bulk operations such as spreading an
   * already-materialized array), so a bulk charge spends the same budget as `n`
   * individual step() calls without per-unit checks.
   */
  addSteps(n: number): void {
    if (this.accounting && this.running) {
      this.stepCount += n
      if (this.stepCount >= this.nextCheck) {
        this.checkpoint()
      }
    }
  }

  // Runs when stepCount crosses nextCheck: enforce the step budget, sample the
  // timeout clock, and schedule the next checkpoint.
  private checkpoint(): void {
    if (this.maxSteps && this.stepCount > this.maxSteps) {
      throw new BonsaiSecurityError(
        'MAX_STEPS',
        `Expression exceeded the maximum step budget (${this.maxSteps})`,
      )
    }
    if (this.deadline || this.signal) this.checkTimeout()
    this.nextCheck = this.computeNextCheck(this.stepCount)
  }

  checkTimeout(): void {
    if (this.signal?.aborted === true) {
      throw new BonsaiSecurityError('ABORTED', 'Evaluation aborted')
    }
    if (this.deadline && this.now() >= this.deadline) {
      throw new BonsaiSecurityError('TIMEOUT', `Expression timeout: exceeded ${this.timeout}ms`)
    }
  }

  /** Enforce cancellation while awaiting an evaluator walk or opaque host Promise. */
  async waitFor<T>(value: PromiseLike<T> | T): Promise<T> {
    if (!this.deadline && this.signal === undefined) return value
    this.checkTimeout()

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const signal = this.signal
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const rejectWith = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        rejectWith(new BonsaiSecurityError('ABORTED', 'Evaluation aborted'))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      if (this.deadline) {
        const remaining = Math.max(0, this.deadline - this.now())
        timer = setTimeout(() => {
          rejectWith(
            new BonsaiSecurityError('TIMEOUT', `Expression timeout: exceeded ${this.timeout}ms`),
          )
        }, remaining)
      }

      Promise.resolve(value).then(
        (result) => {
          cleanup()
          resolve(result)
        },
        (error: unknown) => {
          cleanup()
          // Promise rejection values are host API behavior and must propagate unchanged.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      )
    })
  }

  /**
   * Units of work charged so far this run (0 when no step budget or timeout is
   * configured, since accounting is skipped then). Exposed for diagnostics and
   * tests that assert bulk operations like spreads are charged proportionally.
   */
  get stepsTaken(): number {
    return this.stepCount
  }

  /**
   * Whether this run does step accounting (a step budget or a timeout is set).
   * Evaluator entry points use it to skip run-tracking and per-element charging
   * entirely on the no-limits hot path.
   */
  get needsAccounting(): boolean {
    return this.accounting
  }

  /**
   * Whether a wall-clock deadline is armed for this run. Distinct from
   * {@link needsAccounting}: a step budget alone accounts without a deadline.
   */
  get hasDeadline(): boolean {
    return this.deadline !== 0
  }

  enterDepth(): void {
    if (++this.depth > this.policy.maxDepth) {
      throw new BonsaiSecurityError(
        'MAX_DEPTH',
        `Maximum expression depth (${this.policy.maxDepth}) exceeded`,
      )
    }
  }

  exitDepth(): void {
    this.depth--
  }

  checkNameAccess(key: string, kind: AccessKind): void {
    if (BLOCKED_PROPERTIES.has(key)) {
      throw new BonsaiSecurityError(
        'BLOCKED_PROPERTY',
        `Blocked: access to "${key}" is not allowed`,
      )
    }

    if (kind === 'identifier' || kind === 'object-key') return

    const { allowedProperties, deniedProperties } = this.policy
    // Fast path for the default configuration: with no allow/deny lists there is
    // nothing left to check, so skip the canonical-index test (which coerces the
    // key through Number()/String()) entirely. The index check only exists to let
    // numeric indices bypass those lists, so it is pure overhead without them.
    if (allowedProperties === undefined && deniedProperties === undefined) return

    if (isCanonicalIndex(key)) return

    if (allowedProperties) {
      if (!allowedProperties.has(key)) {
        throw new BonsaiSecurityError(
          'PROPERTY_NOT_ALLOWED',
          `Blocked: "${key}" is not in allowed properties`,
        )
      }
    }

    if (deniedProperties) {
      if (deniedProperties.has(key)) {
        throw new BonsaiSecurityError(
          'PROPERTY_DENIED',
          `Blocked: "${key}" is in denied properties`,
        )
      }
    }
  }

  checkArrayLength(length: number): void {
    if (length > this.policy.maxArrayLength) {
      throw new BonsaiSecurityError(
        'MAX_ARRAY_LENGTH',
        `Array length (${length}) exceeds maximum (${this.policy.maxArrayLength})`,
      )
    }
  }

  checkStringLength(length: number): void {
    if (length > this.policy.maxStringLength) {
      throw new BonsaiSecurityError(
        'MAX_STRING_LENGTH',
        `String length (${length}) exceeds maximum (${this.policy.maxStringLength})`,
      )
    }
  }

  checkObjectProperties(count: number): void {
    if (count > this.policy.maxObjectProperties) {
      throw new BonsaiSecurityError(
        'MAX_OBJECT_PROPERTIES',
        `Object property count (${count}) exceeds maximum (${this.policy.maxObjectProperties})`,
      )
    }
  }

  checkCallArguments(count: number): void {
    if (count > this.policy.maxCallArguments) {
      throw new BonsaiSecurityError(
        'MAX_CALL_ARGUMENTS',
        `Call argument count (${count}) exceeds maximum (${this.policy.maxCallArguments})`,
      )
    }
  }
}
