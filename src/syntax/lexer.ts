import { BonsaiLimitError, BonsaiSyntaxError } from '../errors.js'

export type TokenKind = 'number' | 'string' | 'template' | 'name' | 'keyword' | 'punct' | 'eof'

export interface Token {
  readonly kind: TokenKind
  /** Punctuation/keyword text, the identifier name, or the decoded string value. */
  readonly value: string
  /** Numeric value for `number` tokens. */
  readonly number?: number
  /** Decoded chunks and raw interpolation sources for `template` tokens. */
  readonly template?: TemplatePart[]
  readonly start: number
  readonly end: number
}

export type TemplatePart =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'expr'; readonly start: number; readonly end: number }

// Nested templates are scanned recursively; bound the recursion well below any
// engine stack limit.
const MAX_TEMPLATE_NESTING = 32

/** Words the lexer reads as keywords, never as names. */
const KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'let', 'in', 'not'])
/** Names the language never lets an expression read, bind, or use as a key. */
export const BLOCKED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

/** Whether `name` can be written as a name: an identifier that is neither a keyword nor blocked. */
export function isName(name: string): boolean {
  return IDENTIFIER.test(name) && !KEYWORDS.has(name) && !BLOCKED_NAMES.has(name)
}

// Character codes the scanner compares against.
const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_SPACE = 32
const CH_DOUBLE_QUOTE = 34
const CH_HASH = 35
const CH_DOLLAR = 36
const CH_AMPERSAND = 38
const CH_SINGLE_QUOTE = 39
const CH_STAR = 42
const CH_SLASH = 47
const CH_0 = 48
const CH_9 = 57
const CH_UPPER_A = 65
const CH_UPPER_Z = 90
const CH_UNDERSCORE = 95
const CH_BACKTICK = 96
const CH_LOWER_A = 97
const CH_LOWER_Z = 122
const CH_PIPE = 124
const CH_CARET = 94
const CH_BOM = 0xfeff
const HEX_WIDTH = 4
/** Characters that cannot be seen in an error message; they are shown as code points. */
const INVISIBLE = /[\p{Z}\p{Cc}\p{Cf}]/u

const HEX_RADIX = 16
const OCTAL_RADIX = 8
const MAX_CODE_POINT = 0x10ffff
/** Hex digits in the longest `\\u{...}` escape. */
const MAX_CODE_POINT_DIGITS = 6
/** Length of a `uXXXX` escape body, counted from the `u`. */
const UNICODE_ESCAPE_END = 5

const SINGLE = new Set(['(', ')', '[', ']', '{', '}', ',', ':', ';', '+', '-', '/', '%'])

/** The punctuation token starting at `i`, longest match first. */
function punctuationAt(source: string, i: number): string | undefined {
  const c = source[i]
  const d = source[i + 1]
  switch (c) {
    case '.':
      return d === '.' && source[i + 2] === '.' ? '...' : '.'
    case '?':
      if (d === '.') return '?.'
      return d === '?' ? '??' : '?'
    case '|':
      if (d === '>') return '|>'
      return d === '|' ? '||' : undefined
    case '=':
      if (d === '>') return '=>'
      return d === '=' ? '==' : '='
    case '&':
      return d === '&' ? '&&' : undefined
    case '!':
      return d === '=' ? '!=' : '!'
    case '<':
      return d === '=' ? '<=' : '<'
    case '>':
      return d === '=' ? '>=' : '>'
    case '*':
      return d === '*' ? '**' : '*'
    default:
      return SINGLE.has(c) ? c : undefined
  }
}

function isDigit(c: number): boolean {
  return c >= CH_0 && c <= CH_9
}

function isIdentStart(c: number): boolean {
  return (
    (c >= CH_UPPER_A && c <= CH_UPPER_Z) ||
    (c >= CH_LOWER_A && c <= CH_LOWER_Z) ||
    c === CH_UNDERSCORE ||
    c === CH_DOLLAR
  )
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c)
}

export interface LexOptions {
  readonly maxSourceLength: number
  readonly maxTokens: number
}

export function tokenize(source: string, options: LexOptions): Token[] {
  if (source.length > options.maxSourceLength) {
    throw new BonsaiLimitError(
      'SOURCE_TOO_LONG',
      `Expression length ${source.length} exceeds the limit of ${options.maxSourceLength}`,
    )
  }
  const tokens: Token[] = []
  // A leading byte order mark (from a file) is not part of the expression.
  let i = source.charCodeAt(0) === CH_BOM ? 1 : 0
  const n = source.length

  const fail = (message: string, start: number, end = start + 1): never => {
    const to = Math.min(end, n)
    throw new BonsaiSyntaxError(message, { source, span: { start: Math.min(start, to), end: to } })
  }

  const push = (token: Token): void => {
    if (tokens.length >= options.maxTokens) {
      throw new BonsaiLimitError(
        'TOO_MANY_NODES',
        `Expression has more than ${options.maxTokens} tokens`,
        { source, span: { start: token.start, end: token.end } },
      )
    }
    tokens.push(token)
  }

  while (i < n) {
    const c = source.charCodeAt(i)

    // whitespace
    if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) {
      i++
      continue
    }

    // comments
    if (c === CH_SLASH && source.charCodeAt(i + 1) === CH_SLASH) {
      while (i < n && source.charCodeAt(i) !== CH_LF) i++
      continue
    }
    if (c === CH_SLASH && source.charCodeAt(i + 1) === CH_STAR) {
      const close = source.indexOf('*/', i + 2)
      if (close === -1) fail('Unterminated block comment', i, i + 2)
      i = close + 2
      continue
    }

    const start = i

    if (isDigit(c)) {
      const { value, end } = readNumber(source, i, fail)
      if (!Number.isFinite(value)) fail('Number is too large', start, end)
      push({ kind: 'number', value: source.slice(start, end), number: value, start, end })
      i = end
      continue
    }

    if (isIdentStart(c)) {
      while (i < n && isIdentPart(source.charCodeAt(i))) i++
      const word = source.slice(start, i)
      push({ kind: KEYWORDS.has(word) ? 'keyword' : 'name', value: word, start, end: i })
      continue
    }

    if (c === CH_DOUBLE_QUOTE || c === CH_SINGLE_QUOTE) {
      const { value, end } = readString(source, i, fail)
      push({ kind: 'string', value, start, end })
      i = end
      continue
    }

    if (c === CH_BACKTICK) {
      const { parts, end } = readTemplate(source, i, fail, 0)
      push({ kind: 'template', value: '', template: parts, start, end })
      i = end
      continue
    }

    const punct = punctuationAt(source, i)
    if (punct === undefined) {
      const previous = tokens[tokens.length - 1]
      let hint = ''
      if (c === CH_AMPERSAND) hint = '; use && for "and"'
      else if (c === CH_PIPE) hint = '; use || for "or"'
      else if (c === CH_HASH) hint = '; comments start with //'
      else if (previous?.kind === 'punct' && previous.value === '/')
        hint = '; patterns are strings, e.g. matches(text, "^a.*z$")'
      else if (c === CH_CARET) hint = '; use ** for powers'
      const code = source.codePointAt(i) as number
      const ch = String.fromCodePoint(code)
      const shown = INVISIBLE.test(ch)
        ? `U+${code.toString(HEX_RADIX).toUpperCase().padStart(HEX_WIDTH, '0')}`
        : JSON.stringify(ch)
      fail(`Unexpected character ${shown}${hint}`, i, i + ch.length)
    }
    push({ kind: 'punct', value: punct as string, start, end: i + (punct as string).length })
    i += (punct as string).length
  }

  push({ kind: 'eof', value: '', start: n, end: n })
  return tokens
}

type Fail = (message: string, start: number, end?: number) => never

function readNumber(source: string, start: number, fail: Fail): { value: number; end: number } {
  let i = start
  const n = source.length
  const c1 = source[i + 1]
  if (
    source[i] === '0' &&
    (c1 === 'x' || c1 === 'X' || c1 === 'b' || c1 === 'B' || c1 === 'o' || c1 === 'O')
  ) {
    let radix = OCTAL_RADIX
    if (c1 === 'x' || c1 === 'X') radix = HEX_RADIX
    else if (c1 === 'b' || c1 === 'B') radix = 2
    i += 2
    const digitsStart = i
    while (i < n && /[0-9a-fA-F_]/u.test(source[i])) i++
    const raw = source.slice(digitsStart, i)
    // Only digit adjacency applies: `e` is a hex digit, not an exponent.
    if (/(?:^_|_$|__)/u.test(raw)) fail('Invalid numeric separator', start, i)
    const digits = raw.replaceAll('_', '')
    let valid = /^[0-7]+$/u
    if (radix === HEX_RADIX) valid = /^[0-9a-f]+$/iu
    else if (radix === 2) valid = /^[01]+$/u
    if (!valid.test(digits)) fail(`Invalid base-${radix} number`, start, i)
    return { value: parseInt(digits, radix), end: i }
  }
  while (i < n && /[0-9_]/u.test(source[i])) i++
  if (source[i] === '.' && isDigit(source.charCodeAt(i + 1))) {
    i++
    while (i < n && /[0-9_]/u.test(source[i])) i++
  }
  if (source[i] === 'e' || source[i] === 'E') {
    let j = i + 1
    if (source[j] === '+' || source[j] === '-') j++
    if (!isDigit(source.charCodeAt(j))) fail('Exponent requires digits', start, j)
    i = j
    while (i < n && /[0-9_]/u.test(source[i])) i++
  }
  if (i < n && isIdentStart(source.charCodeAt(i))) fail('Invalid number', start, i + 1)
  const raw = source.slice(start, i)
  checkSeparators(raw, start, fail)
  return { value: Number(raw.replaceAll('_', '')), end: i }
}

function checkSeparators(raw: string, start: number, fail: Fail): void {
  // `_` may only sit between two digits.
  if (/(?:^_|_$|__|_[.eE]|[.eE+-]_)/u.test(raw))
    fail('Invalid numeric separator', start, start + raw.length)
}

function readEscape(source: string, i: number, fail: Fail): { text: string; end: number } {
  // `i` points at the character after the backslash.
  const e = source[i]
  switch (e) {
    case 'n':
      return { text: '\n', end: i + 1 }
    case 't':
      return { text: '\t', end: i + 1 }
    case 'r':
      return { text: '\r', end: i + 1 }
    case '0':
      return { text: '\0', end: i + 1 }
    case '\\':
    case '"':
    case "'":
    case '`':
    case '$':
      return { text: e, end: i + 1 }
    case 'x': {
      const hex = source.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/u.test(hex)) fail('Invalid \\x escape', i - 1, i + 3)
      return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 3 }
    }
    case 'u': {
      if (source[i + 1] === '{') {
        let close = i + 2
        while (close < source.length && /[0-9a-fA-F]/u.test(source[close])) close++
        const hex = source.slice(i + 2, close)
        const code =
          hex.length >= 1 && hex.length <= MAX_CODE_POINT_DIGITS ? parseInt(hex, HEX_RADIX) : -1
        if (source[close] !== '}' || code < 0 || code > MAX_CODE_POINT) {
          fail('Invalid \\u{...} escape', i - 1, Math.min(close + 1, source.length))
        }
        return { text: String.fromCodePoint(code), end: close + 1 }
      }
      const hex = source.slice(i + 1, i + UNICODE_ESCAPE_END)
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail('Invalid \\u escape', i - 1, i + UNICODE_ESCAPE_END)
      return { text: String.fromCharCode(parseInt(hex, 16)), end: i + UNICODE_ESCAPE_END }
    }
    default:
      return fail(
        `Unknown escape sequence \\${e ?? ''}${e !== undefined && /[dDwWsSbB.]/u.test(e) ? `; in a pattern string write \\\\${e}, e.g. matches(text, "\\\\d+")` : ''}`,
        i - 1,
        i + 1,
      )
  }
}

function readString(source: string, start: number, fail: Fail): { value: string; end: number } {
  const quote = source[start]
  let i = start + 1
  let value = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === quote) return { value, end: i + 1 }
    if (ch === '\n') break
    if (ch === '\\') {
      const esc = readEscape(source, i + 1, fail)
      value += esc.text
      i = esc.end
      continue
    }
    value += ch
    i++
  }
  return fail('Unterminated string', start, i)
}

/**
 * Scans a template literal. Interpolations are recorded as source ranges and
 * parsed later by the parser, so nested templates and strings inside `${}`
 * only need to be skipped correctly here.
 */
function readTemplate(
  source: string,
  start: number,
  fail: Fail,
  depth: number,
): { parts: TemplatePart[]; end: number } {
  if (depth > MAX_TEMPLATE_NESTING) {
    throw new BonsaiLimitError('TOO_DEEP', `Templates nest deeper than ${MAX_TEMPLATE_NESTING}`, {
      source,
      span: { start, end: start + 1 },
      // A fixed bound, not maxDepth.
      limit: null,
    })
  }
  const parts: TemplatePart[] = []
  let i = start + 1
  let text = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '`') {
      if (text !== '' || parts.length === 0) parts.push({ kind: 'text', value: text })
      return { parts, end: i + 1 }
    }
    if (ch === '\\') {
      const esc = readEscape(source, i + 1, fail)
      text += esc.text
      i = esc.end
      continue
    }
    if (ch === '$' && source[i + 1] === '{') {
      if (text !== '') parts.push({ kind: 'text', value: text })
      text = ''
      const exprStart = i + 2
      const exprEnd = skipInterpolation(source, exprStart, fail, depth)
      parts.push({ kind: 'expr', start: exprStart, end: exprEnd })
      i = exprEnd + 1
      continue
    }
    text += ch
    i++
  }
  return fail('Unterminated template', start, i)
}

/** Returns the index of the `}` closing an interpolation that starts at `i`. */
function skipInterpolation(source: string, i: number, fail: Fail, nesting: number): number {
  const open = i - 2
  let depth = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      i = readString(source, i, fail).end
      continue
    }
    if (ch === '`') {
      i = readTemplate(source, i, fail, nesting + 1).end
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      if (close === -1) fail('Unterminated block comment', i, i + 2)
      i = close + 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      if (depth === 0) return i
      depth--
    }
    i++
  }
  return fail('Unterminated template interpolation', open, i)
}
