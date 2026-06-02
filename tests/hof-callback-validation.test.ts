import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../src/index.js'
import { arrays } from '../src/stdlib/index.js'

// bonsai's `.x` / `. > 0` lambda shorthand is a function value. Passing a
// computed value where a callback is expected (e.g. `map(inc(.x))`, which
// eagerly evaluates `inc(.x)` to a non-function) previously caused stdlib HOFs
// to SILENTLY return the input unchanged, and method-path HOFs to throw a raw
// V8 TypeError. Both now fail loud with a typed BonsaiTypeError.

describe('higher-order callback validation', () => {
  const withInc = () => bonsai().use(arrays).addFunction('inc', (x: unknown) => (x as number) + 1)

  describe('stdlib transforms throw on a non-function callback', () => {
    it('map throws a typed error instead of silently returning the input', () => {
      const expr = withInc()
      expect(() => expr.evaluateSync('items |> map(inc(.x))', { items: [{ x: 1 }, { x: 2 }] })).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('items |> map(inc(.x))', { items: [{ x: 1 }] })).toThrow(/lambda/iu)
    })

    it('filter/find/some/every throw on a non-function callback', () => {
      const expr = withInc()
      for (const t of ['filter', 'find', 'some', 'every']) {
        expect(() => expr.evaluateSync(`items |> ${t}(inc(.x))`, { items: [{ x: 1 }] }), t).toThrow(BonsaiTypeError)
      }
    })
  })

  describe('no-argument transform forms still work', () => {
    const expr = bonsai().use(arrays)
    it('map with no arg is identity', () => {
      expect(expr.evaluateSync('items |> map', { items: [1, 2, 3] })).toEqual([1, 2, 3])
    })
    it('filter with no arg keeps truthy values', () => {
      expect(expr.evaluateSync('items |> filter', { items: [0, 1, '', 'a', null, 2] })).toEqual([1, 'a', 2])
    })
    it('some/every with no arg test truthiness', () => {
      expect(expr.evaluateSync('items |> some', { items: [0, 0, 1] })).toBe(true)
      expect(expr.evaluateSync('items |> every', { items: [1, 1, 0] })).toBe(false)
    })
  })

  describe('valid lambda callbacks are unaffected', () => {
    const expr = bonsai().use(arrays)
    it('accessor, operator, and member lambdas still work', () => {
      expect(expr.evaluateSync('items |> map(.x)', { items: [{ x: 1 }, { x: 2 }] })).toEqual([1, 2])
      expect(expr.evaluateSync('nums |> map(. * 2)', { nums: [1, 2, 3] })).toEqual([2, 4, 6])
      expect(expr.evaluateSync('nums |> filter(. > 1)', { nums: [1, 2, 3] })).toEqual([2, 3])
    })
    it('a function that legitimately returns a callback still works', () => {
      // identity returns its argument; `.x` is the accessor function, so map applies it.
      const expr2 = bonsai().use(arrays).addFunction('identity', (f: unknown) => f)
      expect(expr2.evaluateSync('items |> map(identity(.x))', { items: [{ x: 1 }, { x: 2 }] })).toEqual([1, 2])
    })
  })

  describe('method-path HOFs throw a typed error (not a raw TypeError)', () => {
    it('.map(inc(.x)) throws BonsaiTypeError', () => {
      const expr = withInc()
      expect(() => expr.evaluateSync('items.map(inc(.x))', { items: [{ x: 1 }] })).toThrow(BonsaiTypeError)
    })
    it('every higher-order method rejects a non-function callback', () => {
      const expr = withInc()
      for (const m of ['filter', 'find', 'some', 'every', 'findIndex', 'flatMap']) {
        expect(() => expr.evaluateSync(`items.${m}(inc(.x))`, { items: [{ x: 1 }] }), m).toThrow(BonsaiTypeError)
      }
    })
    it('valid method-path lambdas still work', () => {
      const expr = bonsai()
      expect(expr.evaluateSync('items.map(.x)', { items: [{ x: 1 }, { x: 2 }] })).toEqual([1, 2])
      expect(expr.evaluateSync('nums.filter(. > 1)', { nums: [1, 2, 3] })).toEqual([2, 3])
    })
  })

  describe('async parity', () => {
    it('async HOFs throw on a non-function callback too', async () => {
      const expr = withInc()
      await expect(expr.evaluate('items |> map(inc(.x))', { items: [{ x: 1 }] })).rejects.toThrow(BonsaiTypeError)
      await expect(expr.evaluate('items.filter(inc(.x))', { items: [{ x: 1 }] })).rejects.toThrow(BonsaiTypeError)
    })
  })
})
