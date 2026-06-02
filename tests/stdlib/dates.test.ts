import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { dates } from '../../src/stdlib/index.js'

describe('stdlib - dates', () => {
  const expr = bonsai()
  expr.use(dates)

  it('now returns a number', () => {
    const result = expr.evaluateSync('now()')
    expect(typeof result).toBe('number')
    expect(result as number).toBeGreaterThan(0)
  })
})

describe('formatDate transform', () => {
  it('formats YYYY-MM-DD', () => {
    const expr = bonsai()
    expr.use(dates)
    const ts = Date.UTC(2026, 2, 7, 12, 30, 45)
    const result = expr.evaluateSync('ts |> formatDate("YYYY-MM-DD")', { ts })
    expect(result).toBe('2026-03-07')
  })

  it('formats HH:mm:ss', () => {
    const expr = bonsai()
    expr.use(dates)
    const ts = Date.UTC(2026, 2, 7, 12, 30, 45)
    const result = expr.evaluateSync('ts |> formatDate("HH:mm:ss")', { ts })
    expect(result).toBe('12:30:45')
  })

  it('formats full datetime', () => {
    const expr = bonsai()
    expr.use(dates)
    const ts = Date.UTC(2026, 2, 7, 9, 5, 3)
    const result = expr.evaluateSync('ts |> formatDate("YYYY-MM-DD HH:mm:ss")', { ts })
    expect(result).toBe('2026-03-07 09:05:03')
  })
})

describe('diffDays transform', () => {
  it('calculates day difference', () => {
    const expr = bonsai()
    expr.use(dates)
    const a = Date.UTC(2026, 2, 7)
    const b = Date.UTC(2026, 2, 10)
    const result = expr.evaluateSync('a |> diffDays(b)', { a, b })
    expect(result).toBe(3)
  })

  it('returns absolute difference', () => {
    const expr = bonsai()
    expr.use(dates)
    const a = Date.UTC(2026, 2, 10)
    const b = Date.UTC(2026, 2, 7)
    const result = expr.evaluateSync('a |> diffDays(b)', { a, b })
    expect(result).toBe(3)
  })
})

describe('formatDate input validation', () => {
  it('throws on NaN timestamp', () => {
    const expr = bonsai()
    expr.use(dates)
    expect(() => expr.evaluateSync('ts |> formatDate("YYYY-MM-DD")', { ts: NaN })).toThrow(
      BonsaiTypeError,
    )
  })

  it('throws on Infinity timestamp', () => {
    const expr = bonsai()
    expr.use(dates)
    expect(() => expr.evaluateSync('ts |> formatDate("YYYY-MM-DD")', { ts: Infinity })).toThrow(
      'valid timestamp',
    )
  })
})
