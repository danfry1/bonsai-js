/** Stable machine-readable error codes. Adding a code is a minor change; renaming one is major. */
export type ErrorCode =
  // syntax
  | 'SYNTAX'
  // static checking (the individual diagnostics carry their own codes)
  | 'CHECK'
  // resource limits
  | 'SOURCE_TOO_LONG'
  | 'TOO_DEEP'
  | 'TOO_MANY_NODES'
  | 'TOO_COMPLEX'
  | 'STEP_LIMIT'
  | 'STRING_LIMIT'
  | 'PATTERN_LIMIT'
  | 'LIST_LIMIT'
  | 'PATTERN_LIMIT'
  | 'TIMEOUT'
  | 'ABORTED'
  // evaluation
  | 'TYPE_ERROR'
  | 'NO_OVERLOAD'
  | 'NULL_RECEIVER'
  | 'DIVISION_BY_ZERO'
  | 'NON_FINITE'
  | 'BLOCKED_PROPERTY'
  | 'INVALID_ARGUMENT'
  | 'ASYNC_IN_SYNC'
  | 'HOST_ERROR'
  | 'HOST_CONTRACT'
  | 'INVALID_CONTEXT'

export interface Span {
  readonly start: number
  readonly end: number
}

const LINE_FEED = 10

/** 1-based line and column of an offset in `source`. */
function positionOf(source: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  const end = Math.min(Math.max(offset, 0), source.length)
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === LINE_FEED) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: end - lineStart + 1 }
}

/** A source excerpt with a caret line under `span`, e.g. for terminal output. */
function codeFrame(source: string, span: Span): string {
  const { line, column } = positionOf(source, span.start)
  const lines = source.split('\n')
  const text = lines[line - 1] ?? ''
  const width = Math.max(1, Math.min(span.end, span.start + text.length - column + 1) - span.start)
  const gutter = String(line)
  return `${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${' '.repeat(column - 1)}${'^'.repeat(width)}`
}

/** Options for constructing a {@link BonsaiError}. */
export interface ErrorInit {
  readonly source?: string | undefined
  readonly span?: Span | undefined
  readonly cause?: unknown
}

/** Base class of every error Bonsai throws. */
export class BonsaiError extends Error {
  readonly code: ErrorCode
  readonly source: string | undefined
  readonly span: Span | undefined

  constructor(code: ErrorCode, message: string, init: ErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = new.target.name
    this.code = code
    this.source = init.source
    this.span = init.span
  }

  /** 1-based position of the error, when it is tied to a source span. */
  get position(): { line: number; column: number } | undefined {
    if (this.source === undefined || this.span === undefined) return undefined
    return positionOf(this.source, this.span.start)
  }

  /** The message followed by a code frame, when a span is known. */
  get formatted(): string {
    if (this.source === undefined || this.span === undefined) return this.message
    return `${this.message}\n${codeFrame(this.source, this.span)}`
  }
}

/** The expression text is not valid Bonsai syntax. */
export class BonsaiSyntaxError extends BonsaiError {
  constructor(message: string, init: ErrorInit = {}) {
    super('SYNTAX', message, init)
  }
}

/** A resource limit, timeout, or cancellation stopped parsing or evaluation. */
export class BonsaiLimitError extends BonsaiError {}

/** Evaluation failed: a type mismatch, invalid argument, or host failure. */
export class BonsaiRuntimeError extends BonsaiError {}

/** One static-checking finding. */
export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly message: string
  readonly severity: 'error' | 'warning'
  readonly start: number
  readonly end: number
}

export type DiagnosticCode =
  // warnings
  | 'ALWAYS_FALSE'
  | 'NEVER_NULL'
  | 'MAYBE_NULL'
  // errors
  | 'SYNTAX'
  | 'LIMIT'
  | 'UNKNOWN_VARIABLE'
  | 'UNKNOWN_PROPERTY'
  | 'UNKNOWN_FUNCTION'
  | 'NO_OVERLOAD'
  | 'TYPE_ERROR'
  | 'NULLABLE_RECEIVER'
  | 'INVALID_LAMBDA'
  | 'BLOCKED_PROPERTY'
  | 'EXPECTED_TYPE'
  | 'INVALID_ARGUMENT'

/** Static checking rejected the expression; `diagnostics` lists every finding. */
export class BonsaiCheckError extends BonsaiError {
  readonly diagnostics: readonly Diagnostic[]

  constructor(source: string, diagnostics: readonly Diagnostic[]) {
    const first = diagnostics[0]
    const more = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : ''
    super('CHECK', `${first?.message ?? 'Check failed'}${more}`, {
      source,
      span: first === undefined ? undefined : { start: first.start, end: first.end },
    })
    this.diagnostics = diagnostics
  }
}

export function isBonsaiError(value: unknown): value is BonsaiError {
  return value instanceof BonsaiError
}
