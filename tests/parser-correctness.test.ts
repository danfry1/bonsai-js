import { describe, it, expect } from 'vitest'
import { bonsai, ExpressionError } from '../src/index.js'
import { parse } from '../src/parser.js'

describe('numeric literal validation', () => {
  const evalSync = (src: string): unknown => bonsai().evaluateSync(src)

  it('rejects an exponent with no digits instead of producing NaN', () => {
    for (const bad of ['1e', '1E', '1e+', '1e-', '123e', '12E+']) {
      expect(() => evalSync(bad), bad).toThrow(ExpressionError)
    }
    expect(() => parse('123E-')).toThrow(ExpressionError)
  })

  it('rejects a base prefix with no digits instead of producing NaN', () => {
    for (const bad of ['0x', '0X', '0b', '0B', '0o', '0O', '0xG', '0b2', '0o8']) {
      expect(() => evalSync(bad), bad).toThrow(ExpressionError)
    }
  })

  it('never yields NaN from a malformed numeric literal', () => {
    for (const bad of ['1e', '0x', '0b', '0o', '1e+']) {
      let threw = false
      try { evalSync(bad) } catch { threw = true }
      expect(threw, bad).toBe(true)
    }
  })

  it('still accepts well-formed numeric literals', () => {
    expect(evalSync('1e3')).toBe(1000)
    expect(evalSync('1E5')).toBe(100000)
    expect(evalSync('1e+5')).toBe(100000)
    expect(evalSync('1.5e-2')).toBe(0.015)
    expect(evalSync('0xff')).toBe(255)
    expect(evalSync('0XAB')).toBe(171)
    expect(evalSync('0xDEAD_BEEF')).toBe(0xDEAD_BEEF)
    expect(evalSync('0b101')).toBe(5)
    expect(evalSync('0b1010_1010')).toBe(0b1010_1010)
    expect(evalSync('0o17')).toBe(15)
    expect(evalSync('0o777')).toBe(511)
    expect(evalSync('3.14')).toBe(3.14)
    expect(evalSync('1_000_000')).toBe(1000000)
  })
})

describe('template literal brace handling', () => {
  const evalSync = (src: string): unknown => bonsai().evaluateSync(src)

  it('parses interpolations containing strings with braces', () => {
    expect(evalSync('`${ "x}" }`')).toBe('x}')
    expect(evalSync('`a${ "{" }b`')).toBe('a{b')
    expect(evalSync('`${ "}{" }`')).toBe('}{')
    expect(evalSync('`${ "{}" }`')).toBe('{}')
  })

  it('handles single-quoted strings in interpolations', () => {
    expect(evalSync("`${ '}' }`")).toBe('}')
    expect(evalSync("`${ '{' }`")).toBe('{')
  })

  it('handles escaped quotes inside the interpolated string', () => {
    expect(evalSync('`${ "a\\"}b" }`')).toBe('a"}b')
  })

  it('handles multiple interpolations each containing braces', () => {
    expect(evalSync('`${ "{" }-${ "}" }`')).toBe('{-}')
  })

  it('still handles object literals inside interpolations', () => {
    expect(evalSync('`${ {a: 1}["a"] }`')).toBe('1')
    expect(evalSync('`${ {a: 1}.a }`')).toBe('1')
  })

  it('still handles plain interpolations and surrounding text', () => {
    expect(bonsai().evaluateSync('`hi ${name}, ${1 + 2}`', { name: 'dan' })).toBe('hi dan, 3')
  })
})
