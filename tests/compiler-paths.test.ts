// Async compilation of every node kind. The same host function `id` is
// declared sync in one environment and async in the other; putting a call to
// it in each position forces that node onto the async path, and both
// compilations must agree on the value or the error code.
import { describe, expect, it } from 'vitest'
import { BonsaiError, BonsaiRuntimeError, Duration, bonsai, fn, t } from '../src/index.js'

type Outcome = { value: unknown } | { error: string }

function normalize(value: unknown): unknown {
  if (value instanceof Date) return { iso: value.toISOString() }
  if (value instanceof Duration) return { duration: value.toString() }
  return value
}

function fail(error: unknown): Outcome {
  if (error instanceof BonsaiError) return { error: error.code }
  throw error
}

const syncEnv = bonsai({
  functions: { id: fn({ params: [t.any()], returns: t.any(), run: (x) => x }) },
})
const asyncEnv = bonsai({
  functions: {
    id: fn({
      params: [t.any()],
      returns: t.any(),
      async: true,
      run: async (x) => {
        await Promise.resolve()
        return x
      },
    }),
  },
})

const context = {
  n: null,
  s: 'abc',
  xs: [1, 2, 3],
  m: { a: 1, b: { c: 2 } },
  users: [
    { name: 'ann', age: 30 },
    { name: 'bob', age: 12 },
  ],
  d: new Date('2024-01-01T00:00:00Z'),
}

async function agree(source: string): Promise<Outcome> {
  let expected: Outcome
  try {
    expected = { value: normalize(syncEnv.evaluateSync(source, context)) }
  } catch (error) {
    expected = fail(error)
  }
  const program = asyncEnv.compile(source)
  expect(program.async, source).toBe(true)
  let actual: Outcome
  try {
    actual = { value: normalize(await program.evaluate(context)) }
  } catch (error) {
    actual = fail(error)
  }
  expect(actual, source).toEqual(expected)
  return actual
}

const cases: [string, Outcome][] = [
  // templates
  ['`a${id(1)}b${id(null)}c`', { value: 'a1bc' }],
  ['`${id("x")}${s}`', { value: 'xabc' }],
  ['`${id([1])}`', { error: 'TYPE_ERROR' }],
  // lists and spread
  ['[id(1), 2, ...xs]', { value: [1, 2, 1, 2, 3] }],
  ['[...id(xs), ...n]', { value: [1, 2, 3] }],
  ['[0, ...id(m)]', { error: 'TYPE_ERROR' }],
  ['[id(1), id(2)]', { value: [1, 2] }],
  // maps: static, computed, shorthand, spread
  ['{ a: id(1), [id("k")]: 2, [s]: id(3) }', { value: { a: 1, k: 2, abc: 3 } }],
  ['{ ...id(m), a: 9 }', { value: { a: 9, b: { c: 2 } } }],
  ['{ ...id(n), s }', { value: { s: 'abc' } }],
  ['{ [id(1)]: true }', { value: { 1: true } }],
  ['{ ...id(xs) }', { error: 'TYPE_ERROR' }],
  ['{ [id(xs)]: 1 }', { error: 'TYPE_ERROR' }],
  // conditionals
  ['id(true) ? "y" : "n"', { value: 'y' }],
  ['id(null) ? "y" : "n"', { value: 'n' }],
  ['true ? id("y") : "n"', { value: 'y' }],
  ['false ? "y" : id("n")', { value: 'n' }],
  ['id(1) ? "y" : "n"', { error: 'TYPE_ERROR' }],
  // let
  ['let x = id(2); x * x', { value: 4 }],
  ['let x = 2; id(x) + x', { value: 4 }],
  // try
  ['try(id(1) + "a", "fallback")', { value: 'fallback' }],
  ['try(xs[0] + s, id("fallback"))', { value: 'fallback' }],
  ['try(id(5), 0)', { value: 5 }],
  // limit errors are never caught by try
  ['try(repeat(id("ab"), 1e6), "x")', { error: 'STRING_LIMIT' }],
  // has
  ['has(id(m).a)', { value: true }],
  ['has(id(m).zzz)', { value: false }],
  ['has(id(m)[id("b")])', { value: true }],
  ['has(xs[id(5)])', { value: false }],
  // index
  ['id(xs)[1]', { value: 2 }],
  ['xs[id(0)]', { value: 1 }],
  ['id(m)["a"]', { value: 1 }],
  ['id(s)[1.5]', { value: null }],
  ['id(xs)["a"]', { error: 'TYPE_ERROR' }],
  // member chains
  ['id(m).b.c', { value: 2 }],
  ['id(m).a', { value: 1 }],
  ['id(m).zzz.c', { value: null }],
  ['id(n).a.b', { value: null }],
  ['id(xs).length', { value: 3 }],
  ['id(s).length', { value: 3 }],
  ['id(s).nope', { error: 'TYPE_ERROR' }],
  ['id(1).b.c', { error: 'TYPE_ERROR' }],
  // unary
  ['!id(false)', { value: true }],
  ['!id(null)', { value: true }],
  ['-id(3)', { value: -3 }],
  ['-id(0)', { value: 0 }],
  ['-id(hours(1))', { value: { duration: '-PT1H' } }],
  ['-id("a")', { error: 'TYPE_ERROR' }],
  ['!id(1)', { error: 'TYPE_ERROR' }],
  // logic
  ['id(true) && id(false)', { value: false }],
  ['id(false) && id(1)', { value: false }],
  ['id(false) || id(true)', { value: true }],
  ['id(true) || id(1)', { value: true }],
  ['id(1) && true', { error: 'TYPE_ERROR' }],
  ['id(null) ?? "d"', { value: 'd' }],
  ['id(0) ?? "d"', { value: 0 }],
  ['n ?? id("d")', { value: 'd' }],
  // equality and ordering
  ['id([1, 2]) == [1, 2]', { value: true }],
  ['id(1) != 1', { value: false }],
  ['id({ a: 1 }) != { a: 2 }', { value: true }],
  ['id(1) < 2', { value: true }],
  ['id(2) <= 2', { value: true }],
  ['id(3) > 2', { value: true }],
  ['id(1) >= 2', { value: false }],
  ['id("a") < "b"', { value: true }],
  ['id("b") <= "a"', { value: false }],
  ['id("b") > "a"', { value: true }],
  ['id("a") >= "a"', { value: true }],
  ['id(null) < 1', { value: false }],
  ['id(null) >= 1', { value: false }],
  ['id(1) < "a"', { error: 'TYPE_ERROR' }],
  // membership
  ['id(2) in xs', { value: true }],
  ['id(9) not in xs', { value: true }],
  ['"b" in id(s)', { value: true }],
  ['"a" in id(m)', { value: true }],
  ['1 in id(n)', { value: false }],
  // arithmetic
  ['id(1) + 2', { value: 3 }],
  ['id("a") + "b"', { value: 'ab' }],
  ['id([1]) + [2]', { value: [1, 2] }],
  ['id(1e308) + 1e308', { error: 'NON_FINITE' }],
  ['id(5) - 2', { value: 3 }],
  ['id(d) - days(1)', { value: { iso: '2023-12-31T00:00:00.000Z' } }],
  ['id(1e308) - -1e308', { error: 'NON_FINITE' }],
  ['id(3) * 4', { value: 12 }],
  ['id(hours(1)) * 2', { value: { duration: 'PT2H' } }],
  ['id(1e308) * 10', { error: 'NON_FINITE' }],
  ['id(7) / 2', { value: 3.5 }],
  ['id(1) / 0', { error: 'DIVISION_BY_ZERO' }],
  ['id(7) % 4', { value: 3 }],
  ['id(7) % 0', { error: 'DIVISION_BY_ZERO' }],
  ['id(2) ** 10', { value: 1024 }],
  ['id(10) ** 400', { error: 'NON_FINITE' }],
  ['id(null) + 1', { error: 'TYPE_ERROR' }],
  // calls: values, optional calls, spread arguments, lambdas
  ['id(s).toUpperCase()', { value: 'ABC' }],
  ['id(n)?.toUpperCase()', { value: null }],
  ['id(n).toUpperCase()', { error: 'NULL_RECEIVER' }],
  ['n?.slice(id(1))', { value: null }],
  ['max(...id(xs))', { value: 3 }],
  ['max(0, ...id(xs), ...n)', { value: 3 }],
  ['max(0, ...id(m))', { error: 'TYPE_ERROR' }],
  ['max(...[id(4), 5])', { value: 5 }],
  ['slice(...id(["abc", 1]))', { value: 'bc' }],
  ['slice(...id(["abc"]))', { error: 'NO_OVERLOAD' }],
  ['users.filter(.age >= id(18)).map(.name)', { value: ['ann'] }],
  ['id(users).map(u => u.name)', { value: ['ann', 'bob'] }],
  ['xs.map((x, i) => id(x) + i)', { value: [1, 3, 5] }],
  ['xs.map(x => id(x) / 0)', { error: 'DIVISION_BY_ZERO' }],
  ['[id(xs)].map(ys => ys.map(y => y * 2))', { value: [[2, 4, 6]] }],
  ['users.map(.name.length + id(0))', { value: [3, 3] }],
]

describe('async compilation agrees with sync compilation', () => {
  for (const [source, expected] of cases) {
    it(source, async () => {
      expect(await agree(source)).toEqual(expected)
    })
  }
})

describe('sync compilation of the same node kinds', () => {
  const env = bonsai()
  it('evaluates spreads, computed keys, and operators without async calls', () => {
    expect(env.evaluateSync('[0, ...xs, ...n]', context)).toEqual([0, 1, 2, 3])
    expect(env.evaluateSync('{ [s]: 1, ...m, ...n }', context)).toEqual({
      abc: 1,
      a: 1,
      b: { c: 2 },
    })
    expect(env.evaluateSync('max(...xs, 0)', context)).toBe(3)
    expect(env.evaluateSync('[2 / 4, 7 % 4, 2 ** 3, "a" < "b", 2 in xs]', context)).toEqual([
      0.5,
      3,
      8,
      true,
      true,
    ])
    expect(env.evaluateSync('[1 != 2, "a" <= "a", "b" > "a", "a" >= "b"]')).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(env.evaluateSync('[d - days(1), hours(1) * 2]', context)).toEqual([
      new Date('2023-12-31T00:00:00Z'),
      new Duration(7_200_000),
    ])
  })

  it('rejects a spread of a non-list into arguments or a list', () => {
    expect(() => env.evaluateSync('max(...m)', context)).toThrow(/spread into arguments/u)
    expect(() => env.evaluateSync('[...m]', context)).toThrow(/spread into a list/u)
    expect(() => env.evaluateSync('{ ...xs }', context)).toThrow(/spread into a map/u)
  })

  it('charges steps for two-parameter lambdas', () => {
    const xs = Array.from({ length: 2000 }, (_, i) => i)
    expect(env.evaluateSync('xs.map((x, i) => x + i).length', { xs })).toBe(2000)
    const limited = bonsai({ limits: { maxSteps: 3000 } })
    expect(() => limited.evaluateSync('xs.map((x, i) => x + i + 1 + 2)', { xs })).toThrow(
      /step limit/u,
    )
  })

  it('drops blocked keys from spread maps', () => {
    const hostile = JSON.parse('{"__proto__": {"x": 1}, "ok": 2}') as Record<string, unknown>
    const result = env.evaluateSync('{ ...h }', { h: hostile })
    expect(result).toEqual({ ok: 2 })
    expect(Object.hasOwn(result as object, '__proto__')).toBe(false)
  })

  it('reads undefined list items and map values as null', () => {
    expect(env.evaluateSync('[...xs]', { xs: [undefined] })).toEqual([null])
    expect(env.evaluateSync('{ ...m }', { m: { a: undefined } })).toEqual({ a: null })
    // A spread undefined is a null argument, which max(number, ...number) rejects.
    expect(() => env.evaluateSync('max(...xs)', { xs: [1, undefined] })).toThrow(/cannot take/u)
  })
})

describe('host call boundaries', () => {
  it('rejects a promise from a host function not declared async', async () => {
    const env = bonsai({
      functions: {
        sneaky: fn({
          params: [],
          returns: t.any(),
          run: () => Promise.reject(new Error('never observed')) as unknown,
        }),
      },
    })
    expect(() => env.evaluateSync('sneaky()')).toThrow(/not declared async/u)
    await expect(env.evaluate('sneaky()')).rejects.toMatchObject({ code: 'ASYNC_IN_SYNC' })
    // The orphaned rejection is swallowed rather than surfacing as unhandled.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })

  it('wraps async host failures and checks async host results', async () => {
    const env = bonsai({
      functions: {
        boom: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: async () => {
            await Promise.resolve()
            throw new Error('down')
          },
        }),
        text: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: async () => {
            await Promise.resolve()
            return 'not a number' as unknown as number
          },
        }),
        raw: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: () => Promise.reject(new Error('plain')),
        }),
      },
    })
    await expect(env.evaluate('boom()')).rejects.toMatchObject({
      code: 'HOST_ERROR',
      message: expect.stringMatching(/boom\(\) failed: down/u),
    })
    await expect(env.evaluate('text()')).rejects.toMatchObject({ code: 'HOST_ERROR' })
    await expect(env.evaluate('try(boom(), 7)')).resolves.toBe(7)
    await expect(env.evaluate('raw()')).rejects.toMatchObject({ code: 'HOST_ERROR' })
    // With a deadline, the rejection passes through the limit race unchanged.
    await expect(env.evaluate('raw()', {}, { timeout: 1000 })).rejects.toMatchObject({
      code: 'HOST_ERROR',
      message: expect.stringMatching(/plain/u),
    })
  })

  it('stops waiting for a slow host function on timeout or abort', async () => {
    let release = (): void => undefined
    const env = bonsai({
      functions: {
        slow: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: () =>
            new Promise<number>((resolve) => {
              release = () => {
                resolve(1)
              }
            }),
        }),
      },
    })
    await expect(env.evaluate('slow()', {}, { timeout: 20 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    release()
    const controller = new AbortController()
    const pending = env.evaluate('slow()', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    release()
  })

  it('passes through Bonsai errors thrown by host functions', () => {
    const env = bonsai({
      functions: {
        reject: fn({
          params: [t.string()],
          returns: t.boolean(),
          run: (reason) => {
            throw new BonsaiRuntimeError('INVALID_ARGUMENT', reason)
          },
        }),
      },
    })
    expect(() => env.evaluateSync('reject("nope")')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'nope' }),
    )
    expect(env.evaluateSync('try(reject("nope"), false)')).toBe(false)
  })

  it('resolves a host promise that settles before the deadline', async () => {
    const env = bonsai({
      functions: {
        quick: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: async () => {
            await Promise.resolve()
            return 5
          },
        }),
      },
    })
    const controller = new AbortController()
    await expect(
      env.evaluate('quick()', {}, { timeout: 1000, signal: controller.signal }),
    ).resolves.toBe(5)
  })
})
