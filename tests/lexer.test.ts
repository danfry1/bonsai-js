import { describe, it, expect } from 'vitest'
import { tokenize } from '../src/lexer.js'

describe('lexer', () => {
  it('should tokenize numbers', () => {
    const tokens = tokenize('42')
    expect(tokens[0]).toMatchObject({ type: 'Number', value: '42' })
  })

  it('should tokenize decimals', () => {
    const tokens = tokenize('3.14')
    expect(tokens[0]).toMatchObject({ type: 'Number', value: '3.14' })
  })

  it('should tokenize strings with double quotes', () => {
    const tokens = tokenize('"hello"')
    expect(tokens[0]).toMatchObject({ type: 'String', value: 'hello' })
  })

  it('should tokenize strings with single quotes', () => {
    const tokens = tokenize("'world'")
    expect(tokens[0]).toMatchObject({ type: 'String', value: 'world' })
  })

  it('should tokenize booleans', () => {
    const tokens = tokenize('true false')
    expect(tokens[0]).toMatchObject({ type: 'Boolean', value: 'true' })
    expect(tokens[1]).toMatchObject({ type: 'Boolean', value: 'false' })
  })

  it('should tokenize null and undefined', () => {
    const tokens = tokenize('null undefined')
    expect(tokens[0]).toMatchObject({ type: 'Null', value: 'null' })
    expect(tokens[1]).toMatchObject({ type: 'Undefined', value: 'undefined' })
  })

  it('should tokenize identifiers', () => {
    const tokens = tokenize('foo bar_baz')
    expect(tokens[0]).toMatchObject({ type: 'Identifier', value: 'foo' })
    expect(tokens[1]).toMatchObject({ type: 'Identifier', value: 'bar_baz' })
  })

  it('should tokenize arithmetic operators', () => {
    const tokens = tokenize('+ - * / % **')
    expect(tokens.filter((t) => t.type === 'Operator').map((t) => t.value)).toEqual([
      '+',
      '-',
      '*',
      '/',
      '%',
      '**',
    ])
  })

  it('should tokenize comparison operators', () => {
    const tokens = tokenize('== != < > <= >=')
    expect(tokens.filter((t) => t.type === 'Operator').map((t) => t.value)).toEqual([
      '==',
      '!=',
      '<',
      '>',
      '<=',
      '>=',
    ])
  })

  it('should tokenize logical operators', () => {
    const tokens = tokenize('&& || !')
    expect(tokens.filter((t) => t.type === 'Operator').map((t) => t.value)).toEqual([
      '&&',
      '||',
      '!',
    ])
  })

  it('should tokenize pipe operator |>', () => {
    const tokens = tokenize('x |> upper')
    expect(tokens[1]).toMatchObject({ type: 'Pipe', value: '|>' })
  })

  it('should tokenize optional chaining ?.', () => {
    const tokens = tokenize('a?.b')
    expect(tokens[1]).toMatchObject({ type: 'OptionalChain', value: '?.' })
  })

  it('should tokenize nullish coalescing ??', () => {
    const tokens = tokenize('a ?? b')
    expect(tokens[1]).toMatchObject({ type: 'NullishCoalescing', value: '??' })
  })

  it('should tokenize spread operator', () => {
    const tokens = tokenize('...arr')
    expect(tokens[0]).toMatchObject({ type: 'Spread', value: '...' })
  })

  it('should tokenize punctuation', () => {
    const tokens = tokenize('( ) [ ] { } , : .')
    expect(tokens.filter((t) => t.type === 'Punctuation').map((t) => t.value)).toEqual([
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      ',',
      ':',
      '.',
    ])
  })

  it('should tokenize a complex expression', () => {
    const tokens = tokenize('user.age >= 18 && user.verified')
    const types = tokens.filter((t) => t.type !== 'EOF').map((t) => t.type)
    expect(types).toEqual([
      'Identifier',
      'Punctuation',
      'Identifier',
      'Operator',
      'Number',
      'Operator',
      'Identifier',
      'Punctuation',
      'Identifier',
    ])
  })

  it('should tokenize template literals', () => {
    const tokens = tokenize('`Hello ${name}`')
    expect(tokens[0]).toMatchObject({ type: 'TemplateLiteral' })
  })

  it('should handle } inside strings in template interpolations', () => {
    const tokens = tokenize('`${obj["}"]}`')
    expect(tokens[0]).toMatchObject({ type: 'TemplateLiteral' })
    expect(tokens[0].value).toContain('obj["}"]')
  })

  it('should handle single-quoted strings with } in template interpolations', () => {
    const tokens = tokenize("`${obj['}']}`")
    expect(tokens[0]).toMatchObject({ type: 'TemplateLiteral' })
  })

  it('should handle escaped quotes in strings inside template interpolations', () => {
    const tokens = tokenize('`${obj["\\"}"]}`')
    expect(tokens[0]).toMatchObject({ type: 'TemplateLiteral' })
  })

  it('should track positions correctly', () => {
    const tokens = tokenize('a + b')
    expect(tokens[0]).toMatchObject({ start: 0, end: 1 })
    expect(tokens[1]).toMatchObject({ start: 2, end: 3 })
    expect(tokens[2]).toMatchObject({ start: 4, end: 5 })
  })

  it('should end with EOF token', () => {
    const tokens = tokenize('42')
    expect(tokens[tokens.length - 1].type).toBe('EOF')
  })

  it('should throw ExpressionError on invalid characters', () => {
    expect(() => tokenize('foo @ bar')).toThrow('Unexpected character')
  })

  it('should tokenize ternary operator', () => {
    const tokens = tokenize('a ? b : c')
    expect(tokens[1]).toMatchObject({ type: 'Punctuation', value: '?' })
    expect(tokens[3]).toMatchObject({ type: 'Punctuation', value: ':' })
  })

  it('should tokenize in and not in keywords', () => {
    const tokens = tokenize('"a" in arr')
    expect(tokens[1]).toMatchObject({ type: 'Operator', value: 'in' })
  })

  describe('number formats', () => {
    it('tokenizes hex numbers', () => {
      expect(tokenize('0xFF')[0]).toMatchObject({ type: 'Number', value: '0xFF' })
      expect(tokenize('0x1A2B')[0]).toMatchObject({ type: 'Number', value: '0x1A2B' })
    })

    it('tokenizes binary numbers', () => {
      expect(tokenize('0b1010')[0]).toMatchObject({ type: 'Number', value: '0b1010' })
    })

    it('tokenizes octal numbers', () => {
      expect(tokenize('0o77')[0]).toMatchObject({ type: 'Number', value: '0o77' })
    })

    it('tokenizes scientific notation', () => {
      expect(tokenize('1e5')[0]).toMatchObject({ type: 'Number', value: '1e5' })
      expect(tokenize('1.5e-3')[0]).toMatchObject({ type: 'Number', value: '1.5e-3' })
      expect(tokenize('2E+10')[0]).toMatchObject({ type: 'Number', value: '2E+10' })
    })

    it('tokenizes numeric separators', () => {
      expect(tokenize('1_000_000')[0]).toMatchObject({ type: 'Number', value: '1_000_000' })
      expect(tokenize('0xFF_FF')[0]).toMatchObject({ type: 'Number', value: '0xFF_FF' })
    })
  })

  describe('unterminated literals', () => {
    it('throws on unterminated string', () => {
      expect(() => tokenize('"unclosed')).toThrow('Unterminated string')
    })

    it('throws on unterminated single-quoted string', () => {
      expect(() => tokenize("'unclosed")).toThrow('Unterminated string')
    })

    it('throws on unterminated template literal', () => {
      expect(() => tokenize('`unclosed')).toThrow('Unterminated template literal')
    })

    it('throws on unterminated template with interpolation', () => {
      expect(() => tokenize('`hello ${name')).toThrow('Unterminated template literal')
    })
  })

  describe('string escapes', () => {
    it('handles unicode escapes \\u{XXXX}', () => {
      expect(tokenize('"\\u{0041}"')[0]).toMatchObject({ type: 'String', value: 'A' })
      expect(tokenize('"\\u{1F600}"')[0]).toMatchObject({ type: 'String', value: '\u{1F600}' })
    })

    it('handles unicode escapes \\uXXXX', () => {
      expect(tokenize('"\\u0041"')[0]).toMatchObject({ type: 'String', value: 'A' })
    })

    it('handles hex escapes \\xNN', () => {
      expect(tokenize('"\\x41"')[0]).toMatchObject({ type: 'String', value: 'A' })
    })

    it('handles null escape \\0', () => {
      expect(tokenize('"\\0"')[0]).toMatchObject({ type: 'String', value: '\0' })
    })

    it('throws on truncated \\x escape', () => {
      expect(() => tokenize('"\\x4"')).toThrow('Invalid \\x escape')
    })

    it('throws on non-hex \\x escape', () => {
      expect(() => tokenize('"\\xGG"')).toThrow('Invalid \\x escape')
    })

    it('throws on \\u{} with missing closing brace', () => {
      expect(() => tokenize('"\\u{1F600"')).toThrow('missing closing brace')
    })

    it('throws on \\u{} with empty code point', () => {
      expect(() => tokenize('"\\u{}"')).toThrow('empty code point')
    })

    it('throws on truncated \\u escape without braces', () => {
      expect(() => tokenize('"\\u00"')).toThrow('Invalid \\u escape')
    })

    it('valid \\u{} escape works', () => {
      expect(tokenize('"\\u{41}"')[0]).toMatchObject({ type: 'String', value: 'A' })
    })

    it('valid \\uNNNN escape works', () => {
      expect(tokenize('"\\u0041"')[0]).toMatchObject({ type: 'String', value: 'A' })
    })

    it('throws ExpressionError on non-hex digits in \\u{}', () => {
      expect(() => tokenize('"\\u{zz}"')).toThrow('non-hex digit')
    })

    it('throws ExpressionError on code point out of range', () => {
      expect(() => tokenize('"\\u{110000}"')).toThrow('out of range')
    })

    it('throws ExpressionError not RangeError for invalid \\u{} content', () => {
      expect(() => tokenize('"\\u{GGGG}"')).toThrow('non-hex digit')
    })

    it('accepts maximum valid code point \\u{10FFFF}', () => {
      expect(tokenize('"\\u{10FFFF}"')[0]).toMatchObject({ type: 'String' })
    })
  })
})
