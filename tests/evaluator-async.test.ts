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
    expr.addTransform('asyncDouble', (val: unknown) => Promise.resolve((val as number) * 2))
    const result = await expr.evaluate('5 |> asyncDouble')
    expect(result).toBe(10)
  })

  it('awaits async function results', async () => {
    const expr = bonsai()
    expr.addFunction('fetchValue', () => Promise.resolve(42))
    const result = await expr.evaluate('fetchValue()')
    expect(result).toBe(42)
  })

  it('handles async transforms in chained pipes', async () => {
    const expr = bonsai()
    expr.addTransform('asyncDouble', (val: unknown) => Promise.resolve((val as number) * 2))
    expr.addTransform('asyncAdd', (val: unknown, n: unknown) =>
      Promise.resolve((val as number) + (n as number)),
    )
    const result = await expr.evaluate('5 |> asyncDouble |> asyncAdd(3)')
    expect(result).toBe(13)
  })

  it('handles async in ternary branches', async () => {
    const expr = bonsai()
    expr.addFunction('asyncVal', () => Promise.resolve('yes'))
    const result = await expr.evaluate('true ? asyncVal() : "no"')
    expect(result).toBe('yes')
  })

  it('does NOT evaluate async branch when short-circuited (&&)', async () => {
    const expr = bonsai()
    let called = false
    expr.addFunction('sideEffect', () => {
      called = true
      return Promise.resolve(1)
    })
    await expr.evaluate('false && sideEffect()')
    expect(called).toBe(false)
  })

  it('does NOT evaluate async branch when short-circuited (||)', async () => {
    const expr = bonsai()
    let called = false
    expr.addFunction('sideEffect', () => {
      called = true
      return Promise.resolve(1)
    })
    await expr.evaluate('true || sideEffect()')
    expect(called).toBe(false)
  })

  it('does NOT evaluate async branch when short-circuited (??)', async () => {
    const expr = bonsai()
    let called = false
    expr.addFunction('sideEffect', () => {
      called = true
      return Promise.resolve(1)
    })
    await expr.evaluate('1 ?? sideEffect()')
    expect(called).toBe(false)
  })

  it('propagates errors from async transforms', async () => {
    const expr = bonsai()
    expr.addTransform('fail', () => Promise.reject(new Error('async boom')))
    await expect(expr.evaluate('1 |> fail')).rejects.toThrow('async boom')
  })

  it('propagates errors from async functions', async () => {
    const expr = bonsai()
    expr.addFunction('fail', () => Promise.reject(new Error('async boom')))
    await expect(expr.evaluate('fail()')).rejects.toThrow('async boom')
  })

  it('respects timeout for async evaluation', async () => {
    const expr = bonsai({ timeout: 50 })
    expr.addFunction('slow', async () => {
      await new Promise<void>((r) => {
        setTimeout(r, 200)
      })
      return 1
    })
    await expect(expr.evaluate('slow()')).rejects.toThrow('Expression timeout')
  })

  it('enforces maxDepth during async evaluation', async () => {
    const expr = bonsai({ maxDepth: 3 })
    await expect(
      expr.evaluate('a.b.c.d.e', {
        a: { b: { c: { d: { e: 1 } } } },
      }),
    ).rejects.toThrow('Maximum expression depth')
  })

  it('async compiled expression works', async () => {
    const expr = bonsai()
    expr.addTransform('asyncDouble', (val: unknown) => Promise.resolve((val as number) * 2))
    const compiled = expr.compile('x |> asyncDouble')
    const result = await compiled.evaluate({ x: 5 })
    expect(result).toBe(10)
  })

  it('handles async in template literals', async () => {
    const expr = bonsai()
    expr.addFunction('asyncName', () => Promise.resolve('World'))
    const result = await expr.evaluate('`Hello ${asyncName()}`')
    expect(result).toBe('Hello World')
  })

  it('handles async in array literals', async () => {
    const expr = bonsai()
    expr.addFunction('asyncVal', () => Promise.resolve(42))
    const result = await expr.evaluate('[1, asyncVal(), 3]')
    expect(result).toEqual([1, 42, 3])
  })

  it('handles async in object literals', async () => {
    const expr = bonsai()
    expr.addFunction('asyncVal', () => Promise.resolve(42))
    const result = await expr.evaluate('{ a: asyncVal(), b: 2 }')
    expect(result).toEqual({ a: 42, b: 2 })
  })
})

describe('async higher-order array method parity with sync', () => {
  // Accessors are forbidden by the data-only member policy. Placing one after
  // a decisive element therefore proves short-circuiting: touching it would
  // raise ACCESSOR_NOT_ALLOWED.
  function mustNotVisit(): { flag: boolean } {
    return Object.defineProperty({} as { flag: boolean }, 'flag', {
      get() {
        throw new Error('predicate should have short-circuited')
      },
    })
  }

  it('does not inflate maxDepth by array length (matches sync)', async () => {
    const arr = Array.from({ length: 60 }, (_, i) => i)
    const expr = bonsai({ maxDepth: 10 })
    // Sync handles this fine: actual nesting is shallow. Async must too.
    expect(expr.evaluateSync('arr.map(. + 1)', { arr })).toHaveLength(60)
    await expect(expr.evaluate('arr.map(. + 1)', { arr })).resolves.toHaveLength(60)
  })

  it('some short-circuits at the first truthy element', async () => {
    const arr = [{ flag: true }, mustNotVisit()]
    await expect(bonsai().evaluate('arr.some(.flag)', { arr })).resolves.toBe(true)
  })

  it('every short-circuits at the first falsy element', async () => {
    const arr = [{ flag: false }, mustNotVisit()]
    await expect(bonsai().evaluate('arr.every(.flag)', { arr })).resolves.toBe(false)
  })

  it('find short-circuits once a match is found', async () => {
    const arr = [{ flag: false }, { flag: true }, mustNotVisit()]
    const result = await bonsai().evaluate('arr.find(.flag)', { arr })
    expect(result).toBe(arr[1])
  })

  it('map and filter still visit every element and preserve order', async () => {
    const expr = bonsai()
    expect(await expr.evaluate('arr.map(. * 2)', { arr: [1, 2, 3] })).toEqual([2, 4, 6])
    expect(await expr.evaluate('arr.filter(. > 1)', { arr: [1, 2, 3] })).toEqual([2, 3])
  })

  it('findIndex short-circuits and returns the matching index', async () => {
    const arr = [{ flag: false }, { flag: true }, mustNotVisit()]
    const result = await bonsai().evaluate('arr.findIndex(.flag)', { arr })
    expect(result).toBe(1)
  })

  it('map preserves element order', async () => {
    const arr = [{ flag: 1 }, { flag: 2 }, { flag: 3 }]
    await expect(bonsai().evaluate('arr.map(.flag)', { arr })).resolves.toEqual([1, 2, 3])
  })

  it('returns the not-found sentinels for find/findIndex/some/every', async () => {
    const expr = bonsai()
    expect(await expr.evaluate('arr.find(. > 9)', { arr: [1, 2, 3] })).toBeUndefined()
    expect(await expr.evaluate('arr.findIndex(. > 9)', { arr: [1, 2, 3] })).toBe(-1)
    expect(await expr.evaluate('arr.some(. > 9)', { arr: [1, 2, 3] })).toBe(false)
    expect(await expr.evaluate('arr.every(. > 0)', { arr: [1, 2, 3] })).toBe(true)
    expect(await expr.evaluate('arr.some(. > 9)', { arr: [] })).toBe(false)
    expect(await expr.evaluate('arr.every(. > 9)', { arr: [] })).toBe(true)
  })

  it('awaits Promise-returning predicates (map and filter)', async () => {
    const expr = bonsai()
    expr.addFunction('asyncTax', () => Promise.resolve(5))
    expr.addFunction('thresh', () => Promise.resolve(1))
    // Lambda bodies that await an async function become Promise-returning predicates.
    expect(
      await expr.evaluate('items.map(.price + asyncTax())', {
        items: [{ price: 10 }, { price: 20 }],
      }),
    ).toEqual([15, 25])
    expect(await expr.evaluate('items.filter(. > thresh())', { items: [1, 2, 3] })).toEqual([2, 3])
  })

  it('flatMap awaits and flattens one level', async () => {
    const result = await bonsai().evaluate('data.flatMap(.vals)', {
      data: [{ vals: [1, 2] }, { vals: [3] }],
    })
    expect(result).toEqual([1, 2, 3])
  })

  it('handles nested higher-order methods (sync and async agree)', async () => {
    const expr = bonsai()
    const ctx = { matrix: [{ row: [1, 2, 3] }, { row: [4, 5] }] }
    expect(expr.evaluateSync('matrix.map(.row.filter(. > 2))', ctx)).toEqual([[3], [4, 5]])
    expect(await expr.evaluate('matrix.map(.row.filter(. > 2))', ctx)).toEqual([[3], [4, 5]])
  })

  it('propagates errors thrown while evaluating a predicate', async () => {
    const expr = bonsai()
    expr.addFunction('boom', () => Promise.reject(new Error('predicate boom')))
    await expect(expr.evaluate('items.map(boom())', { items: [1, 2] })).rejects.toThrow(
      'predicate boom',
    )
  })
})

describe('sync/async node-kind parity', () => {
  // Every AST node kind, exercised in compound (non-argument) position. Bare
  // lambdas evaluate to callable values in both walks; everything else must
  // produce an identical value or an identical typed error. Guards the async
  // walk against missing a node case the sync walk handles (a real v1-rc bug:
  // `evaluate('.x')` threw a plain Error while evaluateSync returned a lambda).
  const context = { user: { name: 'Ada', age: 30 }, nums: [1, 2, 3], flag: true }
  const cases: string[] = [
    '42',
    '"text"',
    'true',
    'null',
    'undefined',
    'user',
    '-user.age',
    'user.age + 1',
    'flag ? 1 : 2',
    'user.name',
    'user?.name',
    'nums[1]',
    '[1, ...nums]',
    '{ a: user.age, ["k"]: 1 }',
    '`${user.name}!`',
    'nums.map(. * 2)',
    '`a` in user.name',
  ]

  it.each(cases)('%s evaluates identically sync and async', async (source) => {
    const expr = bonsai()
    let syncResult: { value?: unknown; error?: unknown }
    try {
      syncResult = { value: expr.evaluateSync(source, context) }
    } catch (error) {
      syncResult = { error }
    }
    let asyncResult: { value?: unknown; error?: unknown }
    try {
      asyncResult = { value: await expr.evaluate(source, context) }
    } catch (error) {
      asyncResult = { error }
    }
    expect(asyncResult.error === undefined).toBe(syncResult.error === undefined)
    if (syncResult.error === undefined) {
      expect(asyncResult.value).toEqual(syncResult.value)
    } else {
      expect((asyncResult.error as Error).constructor).toBe((syncResult.error as Error).constructor)
    }
  })

  it.each(['.x', '. > 1', '[.x]', '{ f: .x }', 'flag ? .x : .x'])(
    'bare lambda position %s yields callables in both walks',
    async (source) => {
      const expr = bonsai()
      const flatten = (value: unknown): unknown[] => {
        if (Array.isArray(value)) return value
        if (value !== null && typeof value === 'object') return Object.values(value)
        return [value]
      }
      for (const item of flatten(expr.evaluateSync(source, context))) {
        expect(typeof item).toBe('function')
      }
      for (const item of flatten(await expr.evaluate(source, context))) {
        expect(typeof item).toBe('function')
      }
    },
  )

  it('flatMap over an oversized callback result raises the typed limit error in both walks', async () => {
    // A 130k-element context array exceeds V8's spread-argument ceiling
    // (~125k); the async flatten must append by index so the typed
    // MAX_ARRAY_LENGTH error is raised instead of an engine RangeError.
    const big = Array.from({ length: 130_000 }, (_, index) => index)
    const expr = bonsai()
    const ctx = { items: [1], big }
    const source = 'items.flatMap(. == 1 ? big : [])'

    expect(() => expr.evaluateSync(source, ctx)).toThrow(
      expect.objectContaining({ code: 'MAX_ARRAY_LENGTH' }) as Error,
    )
    await expect(expr.evaluate(source, ctx)).rejects.toMatchObject({
      code: 'MAX_ARRAY_LENGTH',
    })
  })
})

describe('Promise-like context values at the async read boundary', () => {
  const thenable = {
    calls: 0,
    then(resolve: (value: string) => void) {
      this.calls++
      resolve('DB RESULT')
    },
  }

  it('evaluateSync passes thenable context values through as inert data', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('q', { q: thenable })).toBe(thenable)
    expect(expr.evaluateSync('user.q', { user: { q: thenable } })).toBe(thenable)
    expect(thenable.calls).toBe(0)
  })

  it('evaluate() rejects a thenable read with a typed error instead of awaiting it', async () => {
    const expr = bonsai()
    await expect(expr.evaluate('q', { q: thenable })).rejects.toMatchObject({
      name: 'BonsaiTypeError',
    })
    await expect(expr.evaluate('user.q', { user: { q: thenable } })).rejects.toMatchObject({
      name: 'BonsaiTypeError',
    })
    await expect(
      expr.evaluate('items.map(.q)', { items: [{ q: thenable }] }),
    ).rejects.toMatchObject({ name: 'BonsaiTypeError' })
    // The host then() was never invoked: the ORM query never ran.
    expect(thenable.calls).toBe(0)
  })

  it('evaluate() no longer hangs on a never-settling thenable', async () => {
    const never = { then: () => undefined }
    await expect(bonsai().evaluate('n', { n: never })).rejects.toMatchObject({
      name: 'BonsaiTypeError',
    })
  })

  it('extension results are still awaited (the purpose of evaluate)', async () => {
    const expr = bonsai()
    expr.addFunction('f', () => Promise.resolve(7))
    expr.addTransform('later', (value) => Promise.resolve((value as number) + 1))
    await expect(expr.evaluate('f() + 1')).resolves.toBe(8)
    await expect(expr.evaluate('f() |> later')).resolves.toBe(8)
  })

  it('a non-function then property is plain data in both modes', async () => {
    const expr = bonsai()
    expect(expr.evaluateSync('o.then', { o: { then: 1 } })).toBe(1)
    await expect(expr.evaluate('o.then', { o: { then: 1 } })).resolves.toBe(1)
  })
})

describe('declared transform arity at the call site', () => {
  it('rejects surplus arguments for transforms with declared parameters', async () => {
    const { math, strings } = await import('../src/stdlib/index.js')
    const expr = bonsai().use(math).use(strings)
    expect(() => expr.evaluateSync('total |> round(2)', { total: 120.5 })).toThrow(
      /no transform arguments/u,
    )
    expect(expr.evaluateSync('total |> round', { total: 120.5 })).toBe(121)
    expect(() => expr.evaluateSync('name |> split(",", 1, 9)', { name: 'a,b' })).toThrow(
      /at most 1 transform argument/u,
    )
    expect(expr.evaluateSync('name |> split(",")', { name: 'a,b' })).toEqual(['a', 'b'])
    await expect(expr.evaluate('total |> round(2)', { total: 120.5 })).rejects.toMatchObject({
      name: 'BonsaiTypeError',
    })
  })

  it('transforms without declared parameters accept any arguments', () => {
    const expr = bonsai()
    expr.addTransform('anything', (value) => value)
    expect(expr.evaluateSync('1 |> anything(1, 2, 3)')).toBe(1)
  })
})
