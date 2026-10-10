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

/** The widest excerpt of a line a code frame shows. */
const FRAME_WIDTH = 120
/** Columns shown before the span when a long line is cut on the left. */
const FRAME_LEAD = 40

/**
 * A source excerpt with a caret line under `span`, e.g. for terminal output.
 * A long line is cut to a window around the span (marked `...`), so a frame
 * costs the same however long the source is.
 */
function codeFrame(
  source: string,
  span: Span,
  { line, column }: { line: number; column: number },
): string {
  const start = Math.min(Math.max(span.start, 0), source.length)
  const lineStart = start - (column - 1)
  let from = start - lineStart > FRAME_WIDTH - FRAME_LEAD ? start - FRAME_LEAD : lineStart
  // Never start or end the window between the halves of a surrogate pair.
  if (from > lineStart && LOW_SURROGATE.test(source[from] ?? '')) from++
  const window = source.slice(from, from + FRAME_WIDTH + 1)
  const newline = window.indexOf('\n')
  let to = from + (newline === -1 ? Math.min(window.length, FRAME_WIDTH) : newline)
  const cutRight = newline === -1 && window.length > FRAME_WIDTH ? '...' : ''
  if (cutRight !== '' && LOW_SURROGATE.test(source[to] ?? '')) to--
  // A CRLF line ends at its \n; the \r before it is not shown.
  if (newline !== -1 && to > from && source[to - 1] === '\r') to--
  const cutLeft = from > lineStart ? '...' : ''
  const text = `${cutLeft}${source.slice(from, to)}${cutRight}`
  // The caret lines up by characters, not UTF-16 units, and a tab stays a tab.
  const lead = source.slice(from, Math.min(start, to)).replace(/[^\t]/gu, ' ')
  const width = Math.max(1, Array.from(source.slice(start, Math.min(span.end, to))).length)
  const gutter = String(line)
  return `${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${' '.repeat(cutLeft.length)}${lead}${'^'.repeat(width)}`
}

/** One UTF-16 unit that is the second half of a surrogate pair (with u, only a lone one matches). */
const LOW_SURROGATE = /^[\uDC00-\uDFFF]$/u

/**
 * The JSON form of a {@link BonsaiError} (`JSON.stringify(error)`), the same
 * wherever an error is serialized: thrown, in an explanation, or in a partial
 * result. The source text and the `cause` are left out; keep the source with
 * the error if you store it.
 */
export interface BonsaiErrorJSON {
  readonly name: string
  readonly code: ErrorCode
  readonly message: string
  readonly span?: Span
  readonly position?: { readonly line: number; readonly column: number }
  /** For a limit error: the option that bounds it, when there is one. */
  readonly limit?: LimitName
  /** For a check error: every finding, without the `formatted` code frame. */
  readonly diagnostics?: readonly DiagnosticJSON[]
}

/**
 * Marks Bonsai errors across copies of the package (two installed versions,
 * or a bundle beside node_modules), so isBonsaiError recognizes them all.
 */
const BRAND = Symbol.for('bonsai-js.error')

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
    Object.defineProperty(this, BRAND, { value: true })
  }

  /** 1-based position of the error, when it is tied to a source span. */
  get position(): { line: number; column: number } | undefined {
    if (this.source === undefined || this.span === undefined) return undefined
    return positionOf(this.source, this.span.start)
  }

  /** The message followed by a code frame, when a span is known. */
  get formatted(): string {
    if (this.source === undefined || this.span === undefined) return this.message
    return `${this.message}\n${codeFrame(this.source, this.span, positionOf(this.source, this.span.start))}`
  }

  /** The stable JSON form; see {@link BonsaiErrorJSON}. */
  toJSON(): BonsaiErrorJSON {
    const position = this.position
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.span === undefined ? {} : { span: { start: this.span.start, end: this.span.end } }),
      ...(position === undefined ? {} : { position }),
    }
  }
}

/** The expression text is not valid Bonsai syntax. */
export class BonsaiSyntaxError extends BonsaiError {
  constructor(message: string, init: ErrorInit = {}) {
    super('SYNTAX', message, init)
  }
}

/**
 * The option that bounds a limit error: a key of `limits` (or the
 * per-evaluation `timeout`), or `signal` for a cancellation.
 */
export type LimitName =
  | 'maxSourceLength'
  | 'maxDepth'
  | 'maxNodes'
  | 'maxSteps'
  | 'maxStringLength'
  | 'maxListLength'
  | 'maxValueDepth'
  | 'maxPatternLength'
  | 'timeout'
  | 'signal'

const LIMIT_OF: Partial<Record<ErrorCode, LimitName>> = {
  SOURCE_TOO_LONG: 'maxSourceLength',
  TOO_DEEP: 'maxDepth',
  TOO_MANY_NODES: 'maxNodes',
  STEP_LIMIT: 'maxSteps',
  STRING_LIMIT: 'maxStringLength',
  LIST_LIMIT: 'maxListLength',
  VALUE_DEPTH_LIMIT: 'maxValueDepth',
  PATTERN_LIMIT: 'maxPatternLength',
  TIMEOUT: 'timeout',
  ABORTED: 'signal',
}

/** A resource limit, timeout, or cancellation stopped parsing or evaluation. */
export class BonsaiLimitError extends BonsaiError {
  /**
   * The option that bounds this limit, so a caller can tell which to raise:
   * undefined for a fixed internal bound (TOO_COMPLEX, template nesting).
   */
  readonly limit: LimitName | undefined

  constructor(
    code: ErrorCode,
    message: string,
    init: ErrorInit & { readonly limit?: LimitName | null } = {},
  ) {
    super(code, message, init)
    // `null` marks a bound that is not configurable even though the code usually is.
    this.limit = init.limit === null ? undefined : (init.limit ?? LIMIT_OF[code])
  }

  override toJSON(): BonsaiErrorJSON {
    return this.limit === undefined ? super.toJSON() : { ...super.toJSON(), limit: this.limit }
  }
}

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
   * The message followed by a code frame, as on a {@link BonsaiError}. An
   * accessor computed when read: not part of the JSON form, and not copied by
   * spreading the diagnostic.
   */
  readonly formatted: string
  /**
   * For an unknown variable, property, or function: the declared name the
   * checker suggests instead (the "did you mean" in the message).
   */
  readonly suggestion?: string
}

/** A {@link Diagnostic} as JSON: every field except the `formatted` accessor. */
export type DiagnosticJSON = Omit<Diagnostic, 'formatted'>

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
    return `${this.message}\n${codeFrame(this.#source, this.span, this.position)}`
  }
}

/**
 * Ties findings to their source: spans, 1-based positions (one pass over the
 * source, however many findings), and a code frame computed when read.
 */
export function locate(source: string, findings: readonly Finding[]): readonly Diagnostic[] {
  const lineStarts = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1)
  }
  const located = findings.map((finding) => {
    const offset = Math.min(Math.max(finding.start, 0), source.length)
    // The last line starting at or before the offset.
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return Object.freeze(
      new SourceDiagnostic(source, finding, {
        line: low + 1,
        column: offset - lineStarts[low] + 1,
      }),
    )
  })
  return Object.freeze(located)
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

  override toJSON(): BonsaiErrorJSON {
    return { ...super.toJSON(), diagnostics: this.diagnostics }
  }
}

/**
 * Whether `value` is a Bonsai error, including one thrown by another copy of
 * the package (where `instanceof` fails).
 */
export function isBonsaiError(value: unknown): value is BonsaiError {
  if (value instanceof BonsaiError) return true
  if (typeof value !== 'object' || value === null) return false
  try {
    return (value as Record<symbol, unknown>)[BRAND] === true
  } catch {
    // A hostile Proxy is not a Bonsai error.
    return false
  }
}
