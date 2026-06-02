import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { strings } from '../../src/stdlib/index.js'

describe('stdlib - strings', () => {
  const expr = bonsai()
  expr.use(strings)

  it('upper', () => expect(expr.evaluateSync('name |> upper', { name: 'dan' })).toBe('DAN'))
  it('lower', () => expect(expr.evaluateSync('name |> lower', { name: 'DAN' })).toBe('dan'))
  it('trim', () => expect(expr.evaluateSync('name |> trim', { name: '  dan  ' })).toBe('dan'))
  it('split', () =>
    expect(expr.evaluateSync('s |> split(",")', { s: 'a,b,c' })).toEqual(['a', 'b', 'c']))
  it('replace', () =>
    expect(expr.evaluateSync('s |> replace("world", "Dan")', { s: 'hello world' })).toBe(
      'hello Dan',
    ))
  it('replaceAll', () =>
    expect(expr.evaluateSync('s |> replaceAll("l", "r")', { s: 'hello llama' })).toBe(
      'herro rrama',
    ))
  it('startsWith', () =>
    expect(expr.evaluateSync('s |> startsWith("he")', { s: 'hello' })).toBe(true))
  it('endsWith', () => expect(expr.evaluateSync('s |> endsWith("lo")', { s: 'hello' })).toBe(true))
  it('includes', () => expect(expr.evaluateSync('s |> includes("ell")', { s: 'hello' })).toBe(true))
  it('padStart', () =>
    expect(expr.evaluateSync('s |> padStart(5, "0")', { s: '42' })).toBe('00042'))
  it('padEnd', () => expect(expr.evaluateSync('s |> padEnd(5, "0")', { s: '42' })).toBe('42000'))
})

describe('stdlib - strings type guards', () => {
  const expr = bonsai()
  expr.use(strings)

  it('upper throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> upper', { x: 42 })).toThrow(BonsaiTypeError)
    expect(() => expr.evaluateSync('x |> upper', { x: 42 })).toThrow('expects a string, got number')
  })

  it('lower throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> lower', { x: null })).toThrow('got null')
  })

  it('trim throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> trim', { x: [1] })).toThrow('got array')
  })

  it('split throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> split(",")', { x: 42 })).toThrow(BonsaiTypeError)
  })

  it('replace throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> replace("a", "b")', { x: 42 })).toThrow(BonsaiTypeError)
  })

  it('replaceAll throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> replaceAll("a", "b")', { x: 42 })).toThrow(BonsaiTypeError)
  })

  it('startsWith throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> startsWith("a")', { x: true })).toThrow('got boolean')
  })

  it('endsWith throws on non-string', () => {
    expect(() => expr.evaluateSync('x |> endsWith("a")', { x: undefined })).toThrow('got undefined')
  })
})

describe('stdlib - strings input validation', () => {
  const expr = bonsai()
  expr.use(strings)

  it('split throws when separator is missing', () => {
    expect(() => expr.evaluateSync('"hello" |> split')).toThrow('separator')
  })

  it('split works with empty string separator', () => {
    expect(expr.evaluateSync('"abc" |> split("")')).toEqual(['a', 'b', 'c'])
  })

  it('padStart throws on NaN length', () => {
    expect(() => expr.evaluateSync('"hi" |> padStart(x, "0")', { x: NaN })).toThrow(
      'non-negative number',
    )
  })

  it('padEnd throws on NaN length', () => {
    expect(() => expr.evaluateSync('"hi" |> padEnd(x, "0")', { x: NaN })).toThrow(
      'non-negative number',
    )
  })

  it('padStart throws on negative length', () => {
    expect(() => expr.evaluateSync('"hi" |> padStart(-5, "0")')).toThrow('non-negative number')
  })

  it('padStart defaults fill to space when omitted', () => {
    expect(expr.evaluateSync('"hi" |> padStart(5)')).toBe('   hi')
  })

  it('padStart throws on excessively large length', () => {
    expect(() => expr.evaluateSync('"x" |> padStart(200000000)')).toThrow('length')
  })

  it('padEnd throws on excessively large length', () => {
    expect(() => expr.evaluateSync('"x" |> padEnd(200000000)')).toThrow('length')
  })
})
