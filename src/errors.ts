import type { SourcePosition } from './types.js'

const NEWLINE_CODE = 10

export interface ErrorLocation {
  source: string
  start: number
  end: number
}

/** Syntax error thrown during parsing. Contains source location and formatted caret display. */
export class ExpressionError extends Error {
  /** Literal discriminant: narrow a caught error with `switch (err.name)`. */
  readonly name = 'ExpressionError'
  readonly rawMessage: string
  readonly start: number
  readonly end: number
  readonly source: string
  readonly suggestion?: string

  constructor(message: string, location: ErrorLocation, suggestion?: string) {
    const formatted = formatError(message, location, suggestion)
    super(formatted)
    this.rawMessage = message
    this.start = location.start
    this.end = location.end
    this.source = location.source
    this.suggestion = suggestion
  }
}

/** Runtime type error when a transform, function, or method receives an unexpected value type. */
export class BonsaiTypeError extends Error {
  /** Literal discriminant: narrow a caught error with `switch (err.name)`. */
  readonly name = 'BonsaiTypeError'
  readonly transform: string
  readonly expected: string
  readonly received: string
  location?: ErrorLocation
  formatted?: string

  constructor(transform: string, expected: string, value: unknown, receivedText?: string) {
    let received: string
    if (receivedText !== undefined) received = receivedText
    else if (value === null) received = 'null'
    else if (value instanceof Promise) received = 'Promise'
    else if (Array.isArray(value)) received = 'array'
    else received = typeof value
    super(`"${transform}" expects ${expected}, got ${received}`)
    this.transform = transform
    this.expected = expected
    this.received = received
  }
}

/**
 * Why a {@link BonsaiSecurityError} was raised. A closed set so consumers can
 * branch on it exhaustively (e.g. surface a `TIMEOUT` differently from a
 * `BLOCKED_PROPERTY`).
 */
export type BonsaiSecurityCode =
  | 'BLOCKED_PROPERTY'
  | 'PROPERTY_NOT_ALLOWED'
  | 'PROPERTY_DENIED'
  | 'METHOD_NOT_ALLOWED'
  | 'MAX_SOURCE_LENGTH'
  | 'MAX_TOKENS'
  | 'MAX_AST_NODES'
  | 'MAX_DEPTH'
  | 'MAX_ARRAY_LENGTH'
  | 'MAX_STRING_LENGTH'
  | 'MAX_OBJECT_PROPERTIES'
  | 'MAX_CALL_ARGUMENTS'
  | 'MAX_STEPS'
  | 'TIMEOUT'
  | 'ABORTED'

/** Security violation: blocked property access, timeout, depth limit, or array size limit. */
export class BonsaiSecurityError extends Error {
  /** Literal discriminant: narrow a caught error with `switch (err.name)`. */
  readonly name = 'BonsaiSecurityError'
  /** Which guard fired. See {@link BonsaiSecurityCode}. */
  readonly code: BonsaiSecurityCode
  location?: ErrorLocation
  formatted?: string

  constructor(code: BonsaiSecurityCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Unknown transform, function, or method name. Includes a "did you mean?" suggestion when possible. */
export class BonsaiReferenceError extends Error {
  /** Literal discriminant: narrow a caught error with `switch (err.name)`. */
  readonly name = 'BonsaiReferenceError'
  readonly identifier: string
  readonly kind: 'transform' | 'function' | 'method'
  readonly suggestion?: string
  location?: ErrorLocation
  formatted?: string

  constructor(kind: 'transform' | 'function' | 'method', identifier: string, suggestion?: string) {
    const msg =
      suggestion !== undefined && suggestion !== ''
        ? `Unknown ${kind} "${identifier}". Did you mean "${suggestion}"?`
        : `Unknown ${kind} "${identifier}"`
    super(msg)
    this.identifier = identifier
    this.kind = kind
    this.suggestion = suggestion
  }
}

export type BonsaiRuntimeError = BonsaiTypeError | BonsaiSecurityError | BonsaiReferenceError
export type BonsaiError = ExpressionError | BonsaiRuntimeError

/**
 * Type guard for any error Bonsai throws (parse or runtime). Use it in a `catch`
 * to narrow `unknown` to {@link BonsaiError}, then switch on `error.name` or read
 * the per-error fields.
 */
export function isBonsaiError(error: unknown): error is BonsaiError {
  return (
    error instanceof ExpressionError ||
    error instanceof BonsaiTypeError ||
    error instanceof BonsaiSecurityError ||
    error instanceof BonsaiReferenceError
  )
}

/** Type guard for the runtime subset (everything except parse-time {@link ExpressionError}). */
export function isBonsaiRuntimeError(error: unknown): error is BonsaiRuntimeError {
  return (
    error instanceof BonsaiTypeError ||
    error instanceof BonsaiSecurityError ||
    error instanceof BonsaiReferenceError
  )
}

function clampOffset(source: string, offset: number): number {
  return Math.max(0, Math.min(offset, source.length))
}

function getLineStart(source: string, offset: number): number {
  let index = clampOffset(source, offset)
  while (index > 0 && source.charCodeAt(index - 1) !== NEWLINE_CODE) index--
  return index
}

function getLineEnd(source: string, offset: number): number {
  let index = clampOffset(source, offset)
  while (index < source.length && source.charCodeAt(index) !== NEWLINE_CODE) index++
  return index
}

export function offsetToPosition(source: string, offset: number): SourcePosition {
  const safeOffset = clampOffset(source, offset)
  let line = 1
  let column = 1

  for (let index = 0; index < safeOffset; index++) {
    if (source.charCodeAt(index) === NEWLINE_CODE) {
      line++
      column = 1
    } else {
      column++
    }
  }

  return { line, column, offset: safeOffset }
}

function hasErrorLocation(
  error: unknown,
): error is BonsaiRuntimeError & { location: ErrorLocation } {
  return (
    (error instanceof BonsaiTypeError ||
      error instanceof BonsaiSecurityError ||
      error instanceof BonsaiReferenceError) &&
    error.location !== undefined
  )
}

export function attachLocation(error: unknown, source: string, start: number, end: number): void {
  if (
    error instanceof BonsaiTypeError ||
    error instanceof BonsaiSecurityError ||
    error instanceof BonsaiReferenceError
  ) {
    if (!error.location) {
      error.location = { source, start, end }
      error.formatted = formatError(error.message, error.location)
    }
  }
}

/** Format an error message with source context, caret display, and position info. */
export function formatError(message: string, location: ErrorLocation, suggestion?: string): string {
  const { source } = location
  const start = clampOffset(source, location.start)
  const rawEnd = clampOffset(source, location.end)
  const end = Math.max(start + 1, rawEnd)
  const startPos = offsetToPosition(source, start)
  const lineStart = getLineStart(source, start)
  const lineEnd = getLineEnd(source, start)
  const lineText = source.slice(lineStart, lineEnd)
  const caretStart = start - lineStart
  const caretEnd = Math.min(end, lineEnd)
  const caretLength = Math.max(1, caretEnd - start)
  const gutter = `${startPos.line} | `
  const padding = ' '.repeat(gutter.length + caretStart)
  const carets = '^'.repeat(caretLength)

  let result = `${message}\n\n${gutter}${lineText}\n${padding}${carets}`

  if (suggestion !== undefined && suggestion !== '') {
    result += ` Did you mean "${suggestion}"?`
  }

  result += `\n\nat line ${startPos.line}, column ${startPos.column} (offset ${start}-${end})`

  return result
}

/** Format any Bonsai error into a human-readable string with source context when available. */
export function formatBonsaiError(error: unknown): string {
  if (error instanceof ExpressionError) return error.message
  if (hasErrorLocation(error)) {
    return error.formatted ?? formatError(error.message, error.location)
  }
  if (error instanceof Error) return error.message
  return String(error)
}

const MAX_SUGGEST_LENGTH = 64

export function suggest(input: string, known: string[], maxDistance = 2): string | undefined {
  if (input.length > MAX_SUGGEST_LENGTH) return undefined
  let best: string | undefined
  let bestDistance = maxDistance + 1

  for (const candidate of known) {
    const distance = levenshtein(input, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }

  return best
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }

  return dp[m][n]
}
