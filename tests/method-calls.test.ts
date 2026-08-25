import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiSecurityError, BonsaiTypeError } from '../src/index.js'

describe('method calls on values', () => {
  describe('string methods', () => {
    const expr = bonsai()

    it('enforces declared arity and argument types at runtime', () => {
      expect(() => expr.evaluateSync('"abc".at()')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('"123".includes(2)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('"x".trim(1)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('"x".padStart(3, 0)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('[1].with(0)')).toThrow(BonsaiTypeError)
    })

    it('str.includes(substr)', () => {
      expect(expr.evaluateSync('"hello world".includes("world")')).toBe(true)
      expect(expr.evaluateSync('"hello".includes("xyz")')).toBe(false)
    })

    it('str.startsWith(s)', () => {
      expect(expr.evaluateSync('"hello".startsWith("hel")')).toBe(true)
    })

    it('str.endsWith(s)', () => {
      expect(expr.evaluateSync('"hello".endsWith("llo")')).toBe(true)
    })

    it('str.indexOf(s)', () => {
      expect(expr.evaluateSync('"hello".indexOf("ll")')).toBe(2)
    })

    it('str.slice(start, end)', () => {
      expect(expr.evaluateSync('"hello".slice(1, 3)')).toBe('el')
    })

    it('str.charAt(i)', () => {
      expect(expr.evaluateSync('"hello".charAt(0)')).toBe('h')
    })

    it('str.repeat(n)', () => {
      expect(expr.evaluateSync('"ab".repeat(3)')).toBe('ababab')
    })

    it('str.trimStart()', () => {
      expect(expr.evaluateSync('"  hi  ".trimStart()')).toBe('hi  ')
    })

    it('str.trimEnd()', () => {
      expect(expr.evaluateSync('"  hi  ".trimEnd()')).toBe('  hi')
    })

    it('str.at(i)', () => {
      expect(expr.evaluateSync('"hello".at(-1)')).toBe('o')
    })

    it('str.substring(start, end)', () => {
      expect(expr.evaluateSync('"hello".substring(1, 3)')).toBe('el')
    })
  })

  describe('array methods', () => {
    const expr = bonsai()

    it('arr.includes(val)', () => {
      expect(expr.evaluateSync('[1,2,3].includes(2)')).toBe(true)
      expect(expr.evaluateSync('[1,2,3].includes(5)')).toBe(false)
    })

    it('arr.indexOf(val)', () => {
      expect(expr.evaluateSync('[1,2,3].indexOf(2)')).toBe(1)
    })

    it('arr.slice(start, end)', () => {
      expect(expr.evaluateSync('[1,2,3,4].slice(1, 3)')).toEqual([2, 3])
      expect(expr.evaluateSync('[1,2,3,4].slice(-2, 99)')).toEqual([3, 4])
      const sparse = new Array<unknown>(3)
      sparse[1] = 'middle'
      const result = expr.evaluateSync<unknown[]>('items.slice()', { items: sparse })
      expect(result).toHaveLength(3)
      expect(Object.hasOwn(result, 0)).toBe(false)
      expect(result[1]).toBe('middle')
      expect(Object.hasOwn(result, 2)).toBe(false)
    })

    it('arr.at(i)', () => {
      expect(expr.evaluateSync('[1,2,3].at(-1)')).toBe(3)
    })

    it('normalizes invalid with indices instead of leaking native RangeError', () => {
      expect(() => expr.evaluateSync('[1].with(1, 2)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('[1].with(-2, 2)')).toThrow(BonsaiTypeError)
      expect(expr.evaluateSync('[1, 2].with(-2, 9)')).toEqual([9, 2])
      expect(expr.evaluateSync('[1, 2].with(1, 9)')).toEqual([1, 9])
    })

    it('bounds native flat recursion with the evaluation depth policy', () => {
      const recursive: unknown[] = []
      recursive.push(recursive)
      expect(() =>
        expr.evaluateSync('items.flat(depth)', { items: recursive, depth: 100_000 }),
      ).toThrow(BonsaiSecurityError)
      expect(expr.evaluateSync('[[1]].flat(100)')).toEqual([1])
    })
  })

  describe('number methods', () => {
    const expr = bonsai()

    it('num.toFixed(digits)', () => {
      expect(expr.evaluateSync('(3.14159).toFixed(2)')).toBe('3.14')
      expect(expr.evaluateSync('(1).toFixed()')).toBe('1')
      expect(expr.evaluateSync('(1.5).toFixed(0)')).toBe('2')
      expect(expr.evaluateSync('(1).toFixed(100)')).toHaveLength(102)
    })

    it('num.toString()', () => {
      expect(expr.evaluateSync('(42).toString()')).toBe('42')
      expect(expr.evaluateSync('(3).toString(2)')).toBe('11')
      expect(expr.evaluateSync('(35).toString(36)')).toBe('z')
    })

    it('normalizes native numeric range failures as BonsaiTypeError', () => {
      expect(() => expr.evaluateSync('(1).toFixed(-1)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('(1).toFixed(101)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('(1).toString(radix)', { radix: Number.NaN })).toThrow(
        BonsaiTypeError,
      )
      expect(() => expr.evaluateSync('(1).toString(1)')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('(1).toString(37)')).toThrow(BonsaiTypeError)
    })
  })

  describe('property access', () => {
    const expr = bonsai()

    it('str.length', () => {
      expect(expr.evaluateSync('"hello".length')).toBe(5)
    })

    it('arr.length', () => {
      expect(expr.evaluateSync('[1,2,3].length')).toBe(3)
    })
  })

  describe('chained methods', () => {
    const expr = bonsai()

    it('"hello".slice(1).includes("ell")', () => {
      expect(expr.evaluateSync('"hello".slice(1).includes("ell")')).toBe(true)
    })
  })

  describe('context value methods', () => {
    const expr = bonsai()

    it('name.includes("an")', () => {
      expect(expr.evaluateSync('name.includes("an")', { name: 'Dan' })).toBe(true)
    })
  })

  describe('safety', () => {
    const expr = bonsai()

    it('blocks prototype access through methods', () => {
      expect(() => expr.evaluateSync('"hello".constructor')).toThrow()
    })

    it('blocks __proto__ through methods', () => {
      expect(() => expr.evaluateSync('"hello".__proto__')).toThrow()
    })

    it('throws BonsaiTypeError when calling method on null receiver', () => {
      expect(() => expr.evaluateSync('val.slice(0)', { val: null })).toThrow('non-null value')
    })

    it('throws BonsaiTypeError when calling method on undefined receiver', () => {
      expect(() => expr.evaluateSync('val.slice(0)', { val: undefined })).toThrow('non-null value')
    })
  })

  describe('argument validation', () => {
    const expr = bonsai()
    expr.addFunction('makeFn', () => () => 'injected')
    expr.addFunction('makeRegex', () => /x/u)

    it('blocks function args to replace', () => {
      expect(() => expr.evaluateSync('"abc".replace("a", makeFn())')).toThrow('string argument')
    })

    it('blocks function args to replaceAll', () => {
      expect(() => expr.evaluateSync('"abc".replaceAll("a", makeFn())')).toThrow('string argument')
    })

    it('blocks RegExp args to replace', () => {
      expect(() => expr.evaluateSync('"abc".replace(makeRegex(), "x")')).toThrow('string argument')
    })

    it('allows string args to replace', () => {
      expect(expr.evaluateSync('"abc".replace("a", "x")')).toBe('xbc')
    })

    it('allows string args to replaceAll', () => {
      expect(expr.evaluateSync('"abc".replaceAll("a", "x")')).toBe('xbc')
    })

    it('blocks object args to replace (Symbol.replace hole)', () => {
      const expr2 = bonsai()
      expr2.addFunction('makeObj', () => ({ toString: () => 'a' }))
      expect(() => expr2.evaluateSync('"abc".replace(makeObj(), "x")')).toThrow('string argument')
    })

    it('caps repeat count to prevent DoS', () => {
      const expr2 = bonsai()
      expect(() => expr2.evaluateSync('"x".repeat(200000000)')).toThrow('count')
    })

    it('allows reasonable repeat count', () => {
      const expr2 = bonsai()
      expect(expr2.evaluateSync('"ab".repeat(3)')).toBe('ababab')
    })
  })
})
