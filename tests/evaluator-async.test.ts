import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'

describe('async evaluation', () => {
  it('evaluates simple expressions asynchronously', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('1 + 2')
    expect(result).toBe(3)
  })

  it('awaits async transform results', async () => {
    const expr = bonsai()
    expr.addTransform('asyncDouble', async (val: unknown) => {
      return (val as number) * 2
    })
    const result = await expr.evaluate('5 |> asyncDouble')
    expect(result).toBe(10)
  })

  it('awaits async function results', async () => {
    const expr = bonsai()
    expr.addFunction('fetchValue', async () => {
      return 42
    })
    const result = await expr.evaluate('fetchValue()')
    expect(result).toBe(42)
  })

  it('handles async transforms in chained pipes', async () => {
    const expr = bonsai()
    expr.addTransform('asyncDouble', async (val: unknown) => (val as number) * 2)
    expr.addTransform('asyncAdd', async (val: unknown, n: unknown) => (val as number) + (n as number))
    const result = await expr.evaluate('5 |> asyncDouble |> asyncAdd(3)')
    expect(result).toBe(13)
  })

  it('handles async in ternary branches', async () => {
    const expr = bonsai()
    expr.addFunction('asyncVal', async () => 'yes')
    const result = await expr.evaluate('true ? asyncVal() : "no"')
    expect(result).toBe('yes')
  })

  it('does NOT evaluate async branch when short-circuited (&&)', async () => {
    const expr = bonsai()
    let called = false
    expr.addFunction('sideEffect', async () => { called = true; return 1 })
    await expr.evaluate('false && sideEffect()')
    expect(called).toBe(false)
  })

  it('does NOT evaluate async branch when short-circuited (||)', async () => {
    const expr = bonsai()
    let called = false
    expr.addFunction('sideEffect', async () => { called = true; return 1 })
    await expr.evaluate('true || sideEffect()')
    expect(called).toBe(false)
  })

  it('does NOT evaluate async branch when short-circuited (??)', async () => {
    const expr = bonsai()
    let called = false
    expr.addFunction('sideEffect', async () => { called = true; return 1 })
    await expr.evaluate('1 ?? sideEffect()')
    expect(called).toBe(false)
  })

  it('propagates errors from async transforms', async () => {
    const expr = bonsai()
    expr.addTransform('fail', async () => { throw new Error('async boom') })
    await expect(expr.evaluate('1 |> fail')).rejects.toThrow('async boom')
  })

  it('propagates errors from async functions', async () => {
    const expr = bonsai()
    expr.addFunction('fail', async () => { throw new Error('async boom') })
    await expect(expr.evaluate('fail()')).rejects.toThrow('async boom')
  })

  it('respects timeout for async evaluation', async () => {
    const expr = bonsai({ timeout: 50 })
    expr.addFunction('slow', async () => {
      await new Promise<void>(r => { setTimeout(r, 200) })
      return 1
    })
    await expect(expr.evaluate('slow()')).rejects.toThrow('Expression timeout')
  })

  it('enforces maxDepth during async evaluation', async () => {
    const expr = bonsai({ maxDepth: 3 })
    await expect(expr.evaluate('a.b.c.d.e', {
      a: { b: { c: { d: { e: 1 } } } },
    })).rejects.toThrow('Maximum expression depth')
  })

  it('async compiled expression works', async () => {
    const expr = bonsai()
    expr.addTransform('asyncDouble', async (val: unknown) => (val as number) * 2)
    const compiled = expr.compile('x |> asyncDouble')
    const result = await compiled.evaluate({ x: 5 })
    expect(result).toBe(10)
  })

  it('handles async in template literals', async () => {
    const expr = bonsai()
    expr.addFunction('asyncName', async () => 'World')
    const result = await expr.evaluate('`Hello ${asyncName()}`')
    expect(result).toBe('Hello World')
  })

  it('handles async in array literals', async () => {
    const expr = bonsai()
    expr.addFunction('asyncVal', async () => 42)
    const result = await expr.evaluate('[1, asyncVal(), 3]')
    expect(result).toEqual([1, 42, 3])
  })

  it('handles async in object literals', async () => {
    const expr = bonsai()
    expr.addFunction('asyncVal', async () => 42)
    const result = await expr.evaluate('{ a: asyncVal(), b: 2 }')
    expect(result).toEqual({ a: 42, b: 2 })
  })
})

describe('async higher-order array method parity with sync', () => {
  // A getter that records the element index each time it is read, so we can
  // observe exactly which elements a predicate was evaluated against.
  function logged(log: number[], specs: Array<[number, boolean]>): Array<{ flag: boolean }> {
    return specs.map(([id, flag]) => ({ get flag() { log.push(id); return flag } }))
  }

  it('does not inflate maxDepth by array length (matches sync)', async () => {
    const arr = Array.from({ length: 60 }, (_, i) => i)
    const expr = bonsai({ maxDepth: 10 })
    // Sync handles this fine: actual nesting is shallow. Async must too.
    expect(expr.evaluateSync('arr.map(. + 1)', { arr })).toHaveLength(60)
    await expect(expr.evaluate('arr.map(. + 1)', { arr })).resolves.toHaveLength(60)
  })

  it('some short-circuits at the first truthy element', async () => {
    const log: number[] = []
    const arr = logged(log, [[0, true], [1, false], [2, false]])
    await bonsai().evaluate('arr.some(.flag)', { arr })
    expect(log).toEqual([0])
  })

  it('every short-circuits at the first falsy element', async () => {
    const log: number[] = []
    const arr = logged(log, [[0, false], [1, true], [2, true]])
    await bonsai().evaluate('arr.every(.flag)', { arr })
    expect(log).toEqual([0])
  })

  it('find short-circuits once a match is found', async () => {
    const log: number[] = []
    const arr = logged(log, [[0, false], [1, true], [2, false]])
    const result = await bonsai().evaluate('arr.find(.flag)', { arr })
    expect(log).toEqual([0, 1])
    expect(result).toBe(arr[1])
  })

  it('map and filter still visit every element and preserve order', async () => {
    const expr = bonsai()
    expect(await expr.evaluate('arr.map(. * 2)', { arr: [1, 2, 3] })).toEqual([2, 4, 6])
    expect(await expr.evaluate('arr.filter(. > 1)', { arr: [1, 2, 3] })).toEqual([2, 3])
  })
})
