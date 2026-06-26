import type { BonsaiOptions } from './types.js'
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

function isCanonicalIndex(key: string): boolean {
  if (key.length === 0 || key.length > MAX_INDEX_DIGITS) return false
  const n = Number(key)
  return Number.isInteger(n) && n >= 0 && String(n) === key
}

const TIMEOUT_CHECK_INTERVAL = 1000
const DEFAULT_MAX_DEPTH = 100
const DEFAULT_MAX_ARRAY_LENGTH = 100_000
const DEFAULT_MAX_STRING_LENGTH = 100_000

/** Immutable per-instance security configuration derived from BonsaiOptions. */
export class SecurityPolicy {
  readonly maxDepth: number
  readonly maxArrayLength: number
  readonly maxStringLength: number
  readonly timeout: number
  readonly allowedProperties?: ReadonlySet<string>
  readonly deniedProperties?: ReadonlySet<string>

  constructor(options: BonsaiOptions = {}) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    this.maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH
    this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
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
  private depth = 0
  private deadline: number
  readonly policy: SecurityPolicy
  private readonly now: () => number

  constructor(policy: SecurityPolicy, now: () => number = Date.now) {
    this.policy = policy
    this.now = now
    this.deadline = policy.timeout ? now() + policy.timeout : 0
  }

  /** Reset mutable state for reuse. Avoids allocating a new instance per evaluation. */
  reset(): void {
    this.stepCount = 0
    this.depth = 0
    this.deadline = this.policy.timeout ? this.now() + this.policy.timeout : 0
  }

  step(): void {
    if (this.deadline) {
      this.stepCount++
      if (this.stepCount % TIMEOUT_CHECK_INTERVAL === 0) {
        this.checkTimeout()
      }
    }
  }

  checkTimeout(): void {
    if (this.deadline && this.now() >= this.deadline) {
      throw new BonsaiSecurityError(
        'TIMEOUT',
        `Expression timeout: exceeded ${this.policy.timeout}ms`,
      )
    }
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

  withDepth<T>(fn: () => T): T {
    this.enterDepth()
    try {
      return fn()
    } finally {
      this.exitDepth()
    }
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
}
