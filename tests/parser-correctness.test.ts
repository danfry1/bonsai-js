import { describe, it, expect } from 'vitest'
import { bonsai, ExpressionError } from '../src/index.js'
import { parse } from '../src/parser.js'

describe('numeric literal validation', () => {
  it('rejects an exponent with no digits instead of producing NaN', () => {
    expect(() => bonsai().evaluateSync('1e')).toThrow(ExpressionError)
    expect(() => bonsai().evaluateSync('1e+')).toThrow(ExpressionError)
    expect(() => parse('123E-')).toThrow(ExpressionError)
  })

  it('rejects a base prefix with no digits instead of producing NaN', () => {
    expect(() => bonsai().evaluateSync('0x')).toThrow(ExpressionError)
    expect(() => bonsai().evaluateSync('0b')).toThrow(ExpressionError)
    expect(() => bonsai().evaluateSync('0o')).toThrow(ExpressionError)
  })

  it('still accepts well-formed numeric literals', () => {
    expect(bonsai().evaluateSync('1e3')).toBe(1000)
    expect(bonsai().evaluateSync('1.5e-2')).toBe(0.015)
    expect(bonsai().evaluateSync('0xff')).toBe(255)
    expect(bonsai().evaluateSync('0b101')).toBe(5)
    expect(bonsai().evaluateSync('0o17')).toBe(15)
    expect(bonsai().evaluateSync('1_000')).toBe(1000)
  })
})

describe('template literal brace handling', () => {
  it('parses interpolations containing strings with braces', () => {
    expect(bonsai().evaluateSync('`${ "x}" }`')).toBe('x}')
    expect(bonsai().evaluateSync('`a${ "{" }b`')).toBe('a{b')
    expect(bonsai().evaluateSync('`${ "}{" }`')).toBe('}{')
  })

  it('still handles object literals inside interpolations', () => {
    expect(bonsai().evaluateSync('`${ {a: 1}["a"] }`')).toBe('1')
  })
})
