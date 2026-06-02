import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { math } from '../../src/stdlib/index.js'

describe('stdlib - math', () => {
  const expr = bonsai()
  expr.use(math)

  it('round', () => {
    expect(expr.evaluateSync('x |> round', { x: 3.7 })).toBe(4)
  })
  it('floor', () => {
    expect(expr.evaluateSync('x |> floor', { x: 3.7 })).toBe(3)
  })
  it('ceil', () => {
    expect(expr.evaluateSync('x |> ceil', { x: 3.2 })).toBe(4)
  })
  it('abs', () => {
    expect(expr.evaluateSync('x |> abs', { x: -5 })).toBe(5)
  })
  it('min', () => {
    expect(expr.evaluateSync('min(3, 7)', {})).toBe(3)
  })
  it('max', () => {
    expect(expr.evaluateSync('max(3, 7)', {})).toBe(7)
  })
  it('sum', () => {
    expect(expr.evaluateSync('items |> sum', { items: [1, 2, 3] })).toBe(6)
  })
  it('avg', () => {
    expect(expr.evaluateSync('items |> avg', { items: [2, 4, 6] })).toBe(4)
  })
  it('clamp', () => {
    expect(expr.evaluateSync('x |> clamp(0, 10)', { x: 15 })).toBe(10)
    expect(expr.evaluateSync('x |> clamp(0, 10)', { x: -5 })).toBe(0)
    expect(expr.evaluateSync('x |> clamp(0, 10)', { x: 5 })).toBe(5)
  })

  it('avg returns 0 for empty array', () => {
    expect(expr.evaluateSync('items |> avg', { items: [] })).toBe(0)
  })
})

describe('stdlib - math element type validation', () => {
  const expr = bonsai()
  expr.use(math)

  it('sum throws on mixed array with strings', () => {
    expect(() => expr.evaluateSync('items |> sum', { items: [1, 'two', 3] })).toThrow(
      BonsaiTypeError,
    )
  })

  it('avg throws on mixed array', () => {
    expect(() => expr.evaluateSync('items |> avg', { items: [1, null, 3] })).toThrow(
      BonsaiTypeError,
    )
  })
})
