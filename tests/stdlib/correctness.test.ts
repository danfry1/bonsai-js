import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { math, arrays, dates } from '../../src/stdlib/index.js'

describe('stdlib correctness', () => {
  describe('formatDate', () => {
    const expr = bonsai().use(dates)
    // 2021-02-03T04:05:06Z
    const ts = Date.UTC(2021, 1, 3, 4, 5, 6)

    it('replaces every occurrence of a repeated token, not just the first', () => {
      expect(expr.evaluateSync('ts |> formatDate("YYYY/YYYY")', { ts })).toBe('2021/2021')
      expect(expr.evaluateSync('ts |> formatDate("DD-DD")', { ts })).toBe('03-03')
      expect(expr.evaluateSync('ts |> formatDate("MM:MM:MM")', { ts })).toBe('02:02:02')
    })

    it('still formats a normal pattern', () => {
      expect(expr.evaluateSync('ts |> formatDate("YYYY-MM-DD HH:mm:ss")', { ts })).toBe('2021-02-03 04:05:06')
    })
  })

  describe('min / max', () => {
    const expr = bonsai().use(math)

    it('returns undefined for no arguments instead of leaking Infinity', () => {
      expect(expr.evaluateSync('min()')).toBeUndefined()
      expect(expr.evaluateSync('max()')).toBeUndefined()
      expect(expr.evaluateSync('min(...xs)', { xs: [] })).toBeUndefined()
    })

    it('rejects non-number arguments instead of silently coercing', () => {
      expect(() => expr.evaluateSync('min(1, "2")')).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('max(1, "2")')).toThrow(BonsaiTypeError)
    })

    it('still computes over numeric arguments', () => {
      expect(expr.evaluateSync('min(3, 7, 1)')).toBe(1)
      expect(expr.evaluateSync('max(3, 7, 1)')).toBe(7)
      expect(expr.evaluateSync('min(...xs)', { xs: [4, 2, 6] })).toBe(2)
    })
  })

  describe('clamp', () => {
    const expr = bonsai().use(math)

    it('rejects inverted bounds (min > max) instead of returning nonsense', () => {
      expect(() => expr.evaluateSync('5 |> clamp(10, 0)')).toThrow(BonsaiTypeError)
    })

    it('rejects non-finite bounds', () => {
      expect(() => expr.evaluateSync('5 |> clamp(lo, 10)', { lo: Number.NaN })).toThrow(BonsaiTypeError)
      expect(() => expr.evaluateSync('5 |> clamp(0, hi)', { hi: Number.POSITIVE_INFINITY })).toThrow(BonsaiTypeError)
    })

    it('still clamps with valid bounds', () => {
      expect(expr.evaluateSync('15 |> clamp(0, 10)')).toBe(10)
      expect(expr.evaluateSync('-5 |> clamp(0, 10)')).toBe(0)
      expect(expr.evaluateSync('5 |> clamp(0, 10)')).toBe(5)
    })
  })

  describe('sort', () => {
    const expr = bonsai().use(arrays)

    it('sorts strings by code point for cross-environment determinism', () => {
      // Code-point order puts uppercase before lowercase ('B' = 66 < 'a' = 97),
      // unlike locale-aware ordering which is environment-dependent.
      expect(expr.evaluateSync('items |> sort', { items: ['a', 'B'] })).toEqual(['B', 'a'])
      expect(expr.evaluateSync('items |> sort', { items: ['banana', 'Apple', 'cherry'] })).toEqual(['Apple', 'banana', 'cherry'])
    })

    it('orders astral-plane characters by true code point, not UTF-16 code unit', () => {
      // U+1F600 (emoji, code point 128512, leading surrogate 0xD83D = 55357) vs
      // U+FB00 (BMP, code point 64256). A code-unit `<` would order the emoji
      // first (55357 < 64256); true code-point order puts U+FB00 first.
      expect(expr.evaluateSync('items |> sort', { items: ['\u{1F600}', 'ﬀ'] }))
        .toEqual(['ﬀ', '\u{1F600}'])
    })

    it('still sorts numbers numerically', () => {
      expect(expr.evaluateSync('items |> sort', { items: [3, 1, 2, 10] })).toEqual([1, 2, 3, 10])
    })
  })
})
