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
  | 'VALUE_DEPTH_LIMIT'
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
  // query translation
  | 'UNTRANSLATABLE'

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
  /** UTF-16 offset where the finding starts (the same as `span.start`). */
  readonly start: number
  /** UTF-16 offset where the finding ends (the same as `span.end`). */
  readonly end: number
  /** The offsets as a span, as on a {@link BonsaiError}. */
  readonly span: Span
  /** 1-based line and column of `start`, as on a {@link BonsaiError}. */
  readonly position: { readonly line: number; readonly column: number }
  /**
   * The message followed by a code frame, as on a {@link BonsaiError}.
   * Computed when read, and not part of the JSON form.
   */
  readonly formatted: string
  /**
   * For an unknown variable, property, or function: the declared name the
   * checker suggests instead (the "did you mean" in the message).
   */
  readonly suggestion?: string
}

/** A finding as the checker records it, before it is tied to a source. */
export interface Finding {
  readonly code: DiagnosticCode
  readonly message: string
  readonly severity: 'error' | 'warning'
  readonly start: number
  readonly end: number
  readonly suggestion?: string
}

class SourceDiagnostic implements Diagnostic {
  readonly code: DiagnosticCode
  readonly message: string
  readonly severity: 'error' | 'warning'
  readonly start: number
  readonly end: number
  readonly span: Span
  readonly position: { readonly line: number; readonly column: number }
  declare readonly suggestion?: string
  readonly #source: string

  constructor(source: string, finding: Finding, position: { line: number; column: number }) {
    this.code = finding.code
    this.message = finding.message
    this.severity = finding.severity
    this.start = finding.start
    this.end = finding.end
    this.span = { start: finding.start, end: finding.end }
    this.position = position
    if (finding.suggestion !== undefined) {
      Object.defineProperty(this, 'suggestion', { value: finding.suggestion, enumerable: true })
    }
    this.#source = source
  }

  get formatted(): string {
    return `${this.message}\n${codeFrame(this.#source, this.span)}`
  }
}

/**
 * Ties findings to their source: spans, 1-based positions (one pass over the
 * source, however many findings), and a code frame computed when read.
 */
export function locate(source: string, findings: readonly Finding[]): Diagnostic[] {
  const lineStarts = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1)
  }
  return findings.map((finding) => {
    const offset = Math.min(Math.max(finding.start, 0), source.length)
    // The last line starting at or before the offset.
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return new SourceDiagnostic(source, finding, {
      line: low + 1,
      column: offset - lineStarts[low] + 1,
    })
  })
}

export type DiagnosticCode =
  // warnings
  | 'ALWAYS_FALSE'
  | 'ALWAYS_TRUE'
  | 'NEVER_NULL'
  | 'MAYBE_NULL'
  | 'UNSAFE_INTEGER'
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

  constructor(source: string, diagnostics: readonly Diagnostic[] | readonly Finding[]) {
    const first = diagnostics[0]
    const more = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : ''
    super('CHECK', `${first?.message ?? 'Check failed'}${more}`, {
      source,
      span: first === undefined ? undefined : { start: first.start, end: first.end },
    })
    this.diagnostics = locate(source, diagnostics)
  }
}

export function isBonsaiError(value: unknown): value is BonsaiError {
  return value instanceof BonsaiError
}
