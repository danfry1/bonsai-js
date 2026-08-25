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
      try {
        evalSync(bad)
      } catch {
        threw = true
      }
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
    expect(evalSync('0xDEAD_BEEF')).toBe(0xdead_beef)
    expect(evalSync('0b101')).toBe(5)
    expect(evalSync('0b1010_1010')).toBe(0b1010_1010)
    expect(evalSync('0o17')).toBe(15)
    expect(evalSync('0o777')).toBe(511)
    expect(evalSync('3.14')).toBe(3.14)
    expect(evalSync('1_000_000')).toBe(1000000)
  })

  it('rejects misplaced numeric separators instead of silently coercing', () => {
    // JS rejects all of these; the old digit loops accepted them and Number()
    // would coerce (e.g. Number('0xff_') === 255, Number('1_') === NaN).
    for (const bad of [
      '1_',
      '1__0',
      '0xff_',
      '0x_ff',
      '0xf__f',
      '0b1_',
      '0b1__0',
      '0o7_',
      '1_.5',
      '1_e5',
      '1e_5',
      '1e5_',
      '1.5_',
      '1_000_',
    ]) {
      expect(() => evalSync(bad), bad).toThrow(ExpressionError)
    }
  })

  it('still accepts well-placed separators in every radix', () => {
    expect(evalSync('1_2_3')).toBe(123)
    expect(evalSync('0xAB_CD')).toBe(0xabcd)
    expect(evalSync('0b1_0_1')).toBe(5)
    expect(evalSync('0o1_7')).toBe(15)
    expect(evalSync('1_000.000_5')).toBe(1000.0005)
    expect(evalSync('1e1_0')).toBe(1e10)
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

  it('handles nested template literals, including braces inside them', () => {
    expect(evalSync('`${ `x` }`')).toBe('x')
    expect(evalSync('`${ `a}b` }`')).toBe('a}b')
    expect(evalSync('`${ `{` }`')).toBe('{')
    expect(evalSync('`outer ${ `inner ${1 + 1}` }`')).toBe('outer inner 2')
    expect(evalSync('`${ `a}b` }-${ `c{d` }`')).toBe('a}b-c{d')
  })
})

describe('grammar ambiguity rules', () => {
  const evalSync = (src: string): unknown => bonsai().evaluateSync(src)

  it('refuses a unary base of ** without parentheses, as JavaScript does', () => {
    expect(() => evalSync('-2 ** 2')).toThrow(/Parenthesize the unary expression/u)
    expect(() => evalSync('!flag ** 2')).toThrow(ExpressionError)
    expect(evalSync('(-2) ** 2')).toBe(4)
    expect(evalSync('-(2 ** 2)')).toBe(-4)
    expect(evalSync('2 ** -3')).toBe(0.125)
    expect(evalSync('2 ** 3 ** 2')).toBe(512)
  })

  it('refuses ?? mixed with && or || without parentheses, as JavaScript does', () => {
    expect(() => parse('a ?? b || c')).toThrow(/Parenthesize "\?\?"/u)
    expect(() => parse('a && b ?? c')).toThrow(ExpressionError)
    expect(() => parse('a || b ?? c')).toThrow(ExpressionError)
    const context = { a: null, b: '', c: 'z' }
    expect(bonsai().evaluateSync('(a ?? b) || c', context)).toBe('z')
    expect(bonsai().evaluateSync('a ?? (b || c)', context)).toBe('z')
    expect(bonsai().evaluateSync('a ?? b', context)).toBe('')
    expect(bonsai().evaluateSync('b || c', context)).toBe('z')
  })

  it('refuses a non-named pipe transform with a typed parse error', () => {
    expect(() => parse('x |> [1, 2]')).toThrow(ExpressionError)
    expect(() => parse('x |> "s"')).toThrow(/named transform/u)
    expect(() => parse('x |> "s"(1)')).toThrow(/named transform/u)
    expect(() => parse('x |> 5')).toThrow(ExpressionError)
  })
})

describe('parser stack safety across template nesting', () => {
  it('fails closed with a typed error when nesting multiplies across template levels', () => {
    // Each template level used to restart the grammar-depth budget, so
    // moderate per-level nesting multiplied into a native stack overflow.
    const level = (inner: string, parens: number): string =>
      `\`\${${'('.repeat(parens)}${inner}${')'.repeat(parens)}}\``
    let source = '1'
    for (let i = 0; i < 6; i++) source = level(source, 460)
    expect(() => parse(source)).toThrow(ExpressionError)
    expect(() => parse(source)).toThrow(/nesting depth/u)

    // Shallow per-level nesting across a few template levels still parses.
    let fine = '1'
    for (let i = 0; i < 4; i++) fine = level(fine, 20)
    expect(parse(fine)).toBeDefined()
  })

  it('parses a nested template containing a backtick inside a quoted string', () => {
    expect(bonsai().evaluateSync('`a${ `b${ "`" }` }c`')).toBe('ab`c')
  })
})

describe('parse-time value limits', () => {
  it('rejects a string literal longer than maxStringLength', () => {
    const expr = bonsai({ maxStringLength: 3 })
    expect(() => expr.evaluateSync('"abcd"')).toThrow(/MAX_STRING_LENGTH|String literal length/u)
    expect(expr.evaluateSync('"abc"')).toBe('abc')
  })

  it('does not constant-fold a concat past maxStringLength', () => {
    // Folding "ab" + "cd" into a literal would bypass the produced-string
    // check that the same expression performs with variable operands.
    const expr = bonsai({ maxStringLength: 3 })
    expect(() => expr.evaluateSync('"ab" + "cd"')).toThrow(/String length/u)
    expect(bonsai().evaluateSync('"ab" + "cd"')).toBe('abcd')
  })

  it('enforces maxCallArguments while parsing lambda-body call arguments', () => {
    const args = Array.from({ length: 5 }, (_, i) => String(i)).join(', ')
    expect(() =>
      bonsai({ maxCallArguments: 3 }).evaluateSync(`items.map(.x.slice(${args}))`, {
        items: [],
      }),
    ).toThrow(/MAX_CALL_ARGUMENTS|argument count/iu)
  })
})
