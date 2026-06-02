import type { Token, PunctuationValue } from './types.js'
import { ExpressionError } from './errors.js'

const KEYWORDS = new Map<string, { type: Token['type']; value: string }>([
  ['true', { type: 'Boolean', value: 'true' }],
  ['false', { type: 'Boolean', value: 'false' }],
  ['null', { type: 'Null', value: 'null' }],
  ['undefined', { type: 'Undefined', value: 'undefined' }],
  ['in', { type: 'Operator', value: 'in' }],
  ['not', { type: 'Operator', value: 'not' }],
])

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isAlpha(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$'
}

function isAlphaNumeric(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch)
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
}

// A numeric separator `_` is only legal between two digits of the same radix.
// The digit-consuming loops below accept `_` freely, so validate the produced
// literal here to reject leading, trailing, or doubled separators (`1_`,
// `1__0`, `0xff_`), which JS rejects and which Number() would otherwise coerce
// silently (e.g. Number('0xff_') === 255, Number('1_') === NaN).
const NUMERIC_SEPARATOR_PATTERNS = {
  hex: /^0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*$/u,
  bin: /^0[bB][01]+(?:_[01]+)*$/u,
  oct: /^0[oO][0-7]+(?:_[0-7]+)*$/u,
  dec: /^\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?$/u,
} as const

function checkNumericSeparators(
  value: string,
  kind: keyof typeof NUMERIC_SEPARATOR_PATTERNS,
  source: string,
  start: number,
  end: number,
): void {
  if (!NUMERIC_SEPARATOR_PATTERNS[kind].test(value)) {
    throw new ExpressionError(
      `Invalid numeric literal "${value}": "_" separators must sit between digits`,
      { source, start, end },
    )
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < source.length) {
    const ch = source[i]

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // Numbers: decimal, hex, binary, octal, scientific, underscores
    if (isDigit(ch)) {
      const start = i

      // Hex: 0x...
      if (ch === '0' && i + 1 < source.length && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        i += 2
        if (i >= source.length || !isHexDigit(source[i])) {
          throw new ExpressionError('Invalid hexadecimal literal: expected at least one digit after "0x"', { source, start, end: i })
        }
        while (i < source.length && (isHexDigit(source[i]) || source[i] === '_')) i++
        {
          const value = source.slice(start, i)
          checkNumericSeparators(value, 'hex', source, start, i)
          tokens.push({ type: 'Number', value, start, end: i })
        }
        continue
      }

      // Binary: 0b...
      if (ch === '0' && i + 1 < source.length && (source[i + 1] === 'b' || source[i + 1] === 'B')) {
        i += 2
        if (i >= source.length || (source[i] !== '0' && source[i] !== '1')) {
          throw new ExpressionError('Invalid binary literal: expected at least one digit after "0b"', { source, start, end: i })
        }
        while (i < source.length && (source[i] === '0' || source[i] === '1' || source[i] === '_')) i++
        {
          const value = source.slice(start, i)
          checkNumericSeparators(value, 'bin', source, start, i)
          tokens.push({ type: 'Number', value, start, end: i })
        }
        continue
      }

      // Octal: 0o...
      if (ch === '0' && i + 1 < source.length && (source[i + 1] === 'o' || source[i + 1] === 'O')) {
        i += 2
        if (i >= source.length || source[i] < '0' || source[i] > '7') {
          throw new ExpressionError('Invalid octal literal: expected at least one digit after "0o"', { source, start, end: i })
        }
        while (i < source.length && ((source[i] >= '0' && source[i] <= '7') || source[i] === '_')) i++
        {
          const value = source.slice(start, i)
          checkNumericSeparators(value, 'oct', source, start, i)
          tokens.push({ type: 'Number', value, start, end: i })
        }
        continue
      }

      // Decimal (with optional underscore separators)
      while (i < source.length && (isDigit(source[i]) || source[i] === '_')) i++
      if (i < source.length && source[i] === '.' && i + 1 < source.length && isDigit(source[i + 1])) {
        i++ // skip '.'
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) i++
      }

      // Scientific notation: e/E followed by optional +/- and at least one digit
      if (i < source.length && (source[i] === 'e' || source[i] === 'E')) {
        i++
        if (i < source.length && (source[i] === '+' || source[i] === '-')) i++
        if (i >= source.length || !isDigit(source[i])) {
          throw new ExpressionError('Invalid number: exponent has no digits', { source, start, end: i })
        }
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) i++
      }

      const value = source.slice(start, i)
      checkNumericSeparators(value, 'dec', source, start, i)
      tokens.push({ type: 'Number', value, start, end: i })
      continue
    }

    // Strings
    if (ch === '"' || ch === "'") {
      const quote = ch
      const start = i
      i++ // skip opening quote
      let value = ''
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i++
          const escaped = source[i]
          switch (escaped) {
            case 'n': value += '\n'; break
            case 't': value += '\t'; break
            case 'r': value += '\r'; break
            case '\\': value += '\\'; break
            case '0': value += '\0'; break
            case 'x': {
              const hex = source.slice(i + 1, i + 3)
              if (hex.length < 2 || !isHexDigit(hex[0]) || !isHexDigit(hex[1])) {
                throw new ExpressionError('Invalid \\x escape: expected 2 hex digits', { source, start, end: i + 3 })
              }
              value += String.fromCharCode(parseInt(hex, 16))
              i += 2
              break
            }
            case 'u': {
              if (i + 1 < source.length && source[i + 1] === '{') {
                const closeBrace = source.indexOf('}', i + 2)
                if (closeBrace === -1) {
                  throw new ExpressionError('Invalid \\u{} escape: missing closing brace', { source, start, end: source.length })
                }
                const hex = source.slice(i + 2, closeBrace)
                if (hex.length === 0) {
                  throw new ExpressionError('Invalid \\u{} escape: empty code point', { source, start, end: closeBrace + 1 })
                }
                for (const c of hex) {
                  if (!isHexDigit(c)) {
                    throw new ExpressionError(`Invalid \\u{} escape: non-hex digit "${c}"`, { source, start, end: closeBrace + 1 })
                  }
                }
                const MAX_UNICODE_CODE_POINT = 0x10FFFF
                const codePoint = parseInt(hex, 16)
                if (codePoint > MAX_UNICODE_CODE_POINT) {
                  throw new ExpressionError('Invalid \\u{} escape: code point out of range', { source, start, end: closeBrace + 1 })
                }
                value += String.fromCodePoint(codePoint)
                i = closeBrace
              } else {
                const UNICODE_ESCAPE_LEN = 4
                const hex = source.slice(i + 1, i + 1 + UNICODE_ESCAPE_LEN)
                if (hex.length < UNICODE_ESCAPE_LEN) {
                  throw new ExpressionError('Invalid \\u escape: expected 4 hex digits', { source, start, end: i + 1 + UNICODE_ESCAPE_LEN })
                }
                for (const c of hex) {
                  if (!isHexDigit(c)) {
                    throw new ExpressionError('Invalid \\u escape: expected 4 hex digits', { source, start, end: i + 1 + UNICODE_ESCAPE_LEN })
                  }
                }
                value += String.fromCharCode(parseInt(hex, 16))
                i += UNICODE_ESCAPE_LEN
              }
              break
            }
            default: value += escaped; break
          }
        } else {
          value += source[i]
        }
        i++
      }
      if (i >= source.length) {
        throw new ExpressionError('Unterminated string', { source, start, end: i })
      }
      i++ // skip closing quote
      tokens.push({ type: 'String', value, start, end: i })
      continue
    }

    // Template literals
    if (ch === '`') {
      const start = i
      i++ // skip opening backtick
      let raw = '`'
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '$' && i + 1 < source.length && source[i + 1] === '{') {
          raw += '${'
          i += 2
          let depth = 1
          while (i < source.length && depth > 0) {
            const ic = source[i]
            // Skip string literals inside interpolations
            if (ic === '"' || ic === "'") {
              raw += ic
              i++
              while (i < source.length && source[i] !== ic) {
                if (source[i] === '\\' && i + 1 < source.length) {
                  raw += source[i] + source[i + 1]
                  i += 2
                  continue
                }
                raw += source[i]
                i++
              }
              if (i < source.length) {
                raw += source[i] // closing quote
                i++
              }
              continue
            }
            // Skip nested template literals so their raw braces (and the braces
            // of their own interpolations) do not throw off this brace count.
            // The nested template is preserved verbatim and re-parsed later.
            if (ic === '`') {
              raw += ic
              i++
              while (i < source.length && source[i] !== '`') {
                if (source[i] === '\\' && i + 1 < source.length) {
                  raw += source[i] + source[i + 1]
                  i += 2
                  continue
                }
                raw += source[i]
                i++
              }
              if (i < source.length) {
                raw += source[i] // closing backtick
                i++
              }
              continue
            }
            if (ic === '{') depth++
            else if (ic === '}') depth--
            if (depth > 0) raw += ic
            i++
          }
          raw += '}'
        } else {
          raw += source[i]
          i++
        }
      }
      if (i >= source.length) {
        throw new ExpressionError('Unterminated template literal', { source, start, end: i })
      }
      raw += '`'
      i++ // skip closing backtick
      tokens.push({ type: 'TemplateLiteral', value: raw, start, end: i })
      continue
    }

    // Identifiers and keywords
    if (isAlpha(ch)) {
      const start = i
      while (i < source.length && isAlphaNumeric(source[i])) i++
      const value = source.slice(start, i)
      const kw = KEYWORDS.get(value)
      if (kw) {
        tokens.push({ type: kw.type, value: kw.value, start, end: i } as Token)
      } else {
        tokens.push({ type: 'Identifier', value, start, end: i })
      }
      continue
    }

    // Multi-character operators and punctuation
    const start = i

    // Spread operator ...
    if (ch === '.' && i + 2 < source.length && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ type: 'Spread', value: '...', start, end: i + 3 })
      i += 3
      continue
    }

    // Dot (punctuation)
    if (ch === '.') {
      tokens.push({ type: 'Punctuation', value: '.', start, end: i + 1 })
      i++
      continue
    }

    // Pipe |> or logical ||
    if (ch === '|') {
      if (i + 1 < source.length && source[i + 1] === '>') {
        tokens.push({ type: 'Pipe', value: '|>', start, end: i + 2 })
        i += 2
        continue
      }
      if (i + 1 < source.length && source[i + 1] === '|') {
        tokens.push({ type: 'Operator', value: '||', start, end: i + 2 })
        i += 2
        continue
      }
    }

    // &&
    if (ch === '&' && i + 1 < source.length && source[i + 1] === '&') {
      tokens.push({ type: 'Operator', value: '&&', start, end: i + 2 })
      i += 2
      continue
    }

    // == !=
    if (ch === '=' && i + 1 < source.length && source[i + 1] === '=') {
      tokens.push({ type: 'Operator', value: '==', start, end: i + 2 })
      i += 2
      continue
    }
    if (ch === '!' && i + 1 < source.length && source[i + 1] === '=') {
      tokens.push({ type: 'Operator', value: '!=', start, end: i + 2 })
      i += 2
      continue
    }

    // ! (logical not) - must come after != check
    if (ch === '!') {
      tokens.push({ type: 'Operator', value: '!', start, end: i + 1 })
      i++
      continue
    }

    // <= >= < >
    if (ch === '<') {
      if (i + 1 < source.length && source[i + 1] === '=') {
        tokens.push({ type: 'Operator', value: '<=', start, end: i + 2 })
        i += 2
        continue
      }
      tokens.push({ type: 'Operator', value: '<', start, end: i + 1 })
      i++
      continue
    }
    if (ch === '>') {
      if (i + 1 < source.length && source[i + 1] === '=') {
        tokens.push({ type: 'Operator', value: '>=', start, end: i + 2 })
        i += 2
        continue
      }
      tokens.push({ type: 'Operator', value: '>', start, end: i + 1 })
      i++
      continue
    }

    // ** (exponentiation) — must come before single *
    if (ch === '*' && i + 1 < source.length && source[i + 1] === '*') {
      tokens.push({ type: 'Operator', value: '**', start, end: i + 2 })
      i += 2
      continue
    }

    // ?. (optional chaining) or ?? (nullish coalescing) or ? (ternary)
    if (ch === '?') {
      if (i + 1 < source.length && source[i + 1] === '.') {
        tokens.push({ type: 'OptionalChain', value: '?.', start, end: i + 2 })
        i += 2
        continue
      }
      if (i + 1 < source.length && source[i + 1] === '?') {
        tokens.push({ type: 'NullishCoalescing', value: '??', start, end: i + 2 })
        i += 2
        continue
      }
      tokens.push({ type: 'Punctuation', value: '?', start, end: i + 1 })
      i++
      continue
    }

    // Single-character operators
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'Operator', value: ch, start, end: i + 1 })
      i++
      continue
    }

    // Punctuation
    if ('()[]{},:'.includes(ch)) {
      tokens.push({ type: 'Punctuation', value: ch as PunctuationValue, start, end: i + 1 })
      i++
      continue
    }

    throw new ExpressionError(`Unexpected character "${ch}"`, { source, start, end: i + 1 })
  }

  tokens.push({ type: 'EOF', value: '', start: i, end: i })
  return tokens
}
