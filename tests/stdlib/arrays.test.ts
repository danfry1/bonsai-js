import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { arrays } from '../../src/stdlib/index.js'

const unreadableTail = (firstFlag: boolean): { flag: boolean }[] => {
  const tail = Object.defineProperty({}, 'flag', {
    get() {
      throw new Error('predicate should have short-circuited')
    },
  }) as { flag: boolean }
  return [{ flag: firstFlag }, tail]
}

describe('stdlib - arrays', () => {
  const expr = bonsai()
  expr.use(arrays)

  it('count', () => {
    expect(expr.evaluateSync('items |> count', { items: [1, 2, 3] })).toBe(3)
  })
  it('first', () => {
    expect(expr.evaluateSync('items |> first', { items: [1, 2, 3] })).toBe(1)
  })
  it('last', () => {
    expect(expr.evaluateSync('items |> last', { items: [1, 2, 3] })).toBe(3)
  })
  it('reverse', () => {
    expect(expr.evaluateSync('items |> reverse', { items: [1, 2, 3] })).toEqual([3, 2, 1])
  })
  it('flatten', () => {
    expect(
      expr.evaluateSync('items |> flatten', {
        items: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toEqual([1, 2, 3, 4])
  })
  it('unique', () => {
    expect(expr.evaluateSync('items |> unique', { items: [1, 2, 2, 3, 3] })).toEqual([1, 2, 3])
  })
  it('join', () => {
    expect(expr.evaluateSync('items |> join(", ")', { items: ['a', 'b', 'c'] })).toBe('a, b, c')
  })
  it('sort numbers', () => {
    expect(expr.evaluateSync('items |> sort', { items: [3, 1, 2] })).toEqual([1, 2, 3])
  })
})

describe('stdlib - arrays type guards', () => {
  const expr = bonsai()
  expr.use(arrays)

  it('throws BonsaiTypeError when passing non-array to count', () => {
    expect(() => expr.evaluateSync('x |> count', { x: 'hello' })).toThrow(BonsaiTypeError)
    expect(() => expr.evaluateSync('x |> count', { x: 'hello' })).toThrow(
      'expects an array, got string',
    )
  })

  it('throws BonsaiTypeError when passing number to sort', () => {
    expect(() => expr.evaluateSync('x |> sort', { x: 42 })).toThrow(BonsaiTypeError)
  })

  it('throws BonsaiTypeError when passing null to filter', () => {
    expect(() => expr.evaluateSync('x |> filter', { x: null })).toThrow('got null')
  })
})

describe('higher-order array transforms', () => {
  it('defines the no-callback behavior for every higher-order transform', () => {
    const expr = bonsai().use(arrays)
    const items = [0, 1, false, 2]
    expect(expr.evaluateSync('items |> filter', { items })).toEqual([1, 2])
    expect(expr.evaluateSync('items |> map', { items })).toBe(items)
    expect(expr.evaluateSync('items |> find', { items })).toBeUndefined()
    expect(expr.evaluateSync('items |> some', { items })).toBe(true)
    expect(expr.evaluateSync('items |> every', { items })).toBe(false)
    expect(expr.evaluateSync('items |> some', { items: [0, false] })).toBe(false)
    expect(expr.evaluateSync('items |> every', { items: [1, true] })).toBe(true)
  })

  it('filter with lambda predicate', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('users |> filter(.active)', {
      users: [
        { active: true, name: 'A' },
        { active: false, name: 'B' },
      ],
    })
    expect(result).toEqual([{ active: true, name: 'A' }])
  })

  it('filter with compound predicate', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('users |> filter(.age >= 18)', {
      users: [{ age: 25 }, { age: 15 }, { age: 30 }],
    })
    expect(result).toEqual([{ age: 25 }, { age: 30 }])
  })

  it('map with lambda', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('users |> map(.name)', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    })
    expect(result).toEqual(['Alice', 'Bob'])
  })

  it('find with lambda', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('users |> find(.name == "Bob")', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    })
    expect(result).toEqual({ name: 'Bob' })
  })

  it('find returns undefined when not found', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('users |> find(.name == "Charlie")', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    })
    expect(result).toBeUndefined()
  })

  it('some with lambda', () => {
    const expr = bonsai()
    expr.use(arrays)
    expect(
      expr.evaluateSync('users |> some(.active)', {
        users: [{ active: false }, { active: true }],
      }),
    ).toBe(true)
  })

  it('every with lambda', () => {
    const expr = bonsai()
    expr.use(arrays)
    expect(
      expr.evaluateSync('users |> every(.active)', {
        users: [{ active: true }, { active: true }],
      }),
    ).toBe(true)
    expect(
      expr.evaluateSync('users |> every(.active)', {
        users: [{ active: true }, { active: false }],
      }),
    ).toBe(false)
  })

  it('chained filter and map', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('users |> filter(.age >= 18) |> map(.name)', {
      users: [
        { name: 'Alice', age: 25 },
        { name: 'Bob', age: 15 },
        { name: 'Charlie', age: 30 },
      ],
    })
    expect(result).toEqual(['Alice', 'Charlie'])
  })
})

describe('predicate call count', () => {
  it('visits every dense element exactly once when no short-circuit occurs', () => {
    const expr = bonsai().use(arrays)
    let calls = 0
    const observed = (values: readonly unknown[]) =>
      values.map((value) =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get() {
            calls++
            return value
          },
        }),
      )

    for (const [source, values] of [
      ['items |> map(.value)', [1, 2, 3]],
      ['items |> filter(.value)', [1, 2, 3]],
      ['items |> find(.value)', [0, 0, 0]],
      ['items |> some(.value)', [0, 0, 0]],
      ['items |> every(.value)', [1, 1, 1]],
    ] as const) {
      calls = 0
      const items = observed(values)
      expr.evaluateSync(source, { items })
      expect(calls, source).toBe(items.length)
    }
  })

  it('find and some stop at the first match; every stops at the first failure', () => {
    const expr = bonsai().use(arrays)
    const truthy = unreadableTail(true)
    const falsy = unreadableTail(false)

    expect(expr.evaluateSync('items |> find(.flag)', { items: truthy })).toBe(truthy[0])
    expect(expr.evaluateSync('items |> some(.flag)', { items: truthy })).toBe(true)
    expect(expr.evaluateSync('items |> every(.flag)', { items: falsy })).toBe(false)
  })

  it('some uses computed results without re-calling predicate', () => {
    const expr = bonsai()
    expr.use(arrays)
    expect(
      expr.evaluateSync('items |> some(.val > 3)', {
        items: [{ val: 1 }, { val: 5 }],
      }),
    ).toBe(true)
  })

  it('every uses computed results without re-calling predicate', () => {
    const expr = bonsai()
    expr.use(arrays)
    expect(
      expr.evaluateSync('items |> every(.val > 0)', {
        items: [{ val: 1 }, { val: 2 }],
      }),
    ).toBe(true)
    expect(
      expr.evaluateSync('items |> every(.val > 1)', {
        items: [{ val: 1 }, { val: 2 }],
      }),
    ).toBe(false)
  })
})

describe('async array transforms with mixed sync/async lambdas', () => {
  it('stdlib map correctly resolves async lambdas via evaluate()', async () => {
    const expr = bonsai()
    expr.use(arrays)
    expr.addFunction('asyncTax', () => Promise.resolve(5))
    const result = await expr.evaluate('items |> map(.price + asyncTax())', {
      items: [{ price: 10 }, { price: 20 }],
    })
    expect(result).toEqual([15, 25])
  })

  it('stdlib filter correctly resolves async predicates via evaluate()', async () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = await expr.evaluate('users |> filter(.active) |> map(.name)', {
      users: [
        { name: 'Alice', active: true },
        { name: 'Bob', active: false },
        { name: 'Charlie', active: true },
      ],
    })
    expect(result).toEqual(['Alice', 'Charlie'])
  })

  it('short-circuits async find/some/every predicates before later elements', async () => {
    const expr = bonsai().use(arrays)
    expr.addFunction('asyncFalse', () => Promise.resolve(false))
    expr.addFunction('asyncTrue', () => Promise.resolve(true))
    const truthy = unreadableTail(true)
    const falsy = unreadableTail(false)

    await expect(
      expr.evaluate('items |> find(.flag || asyncFalse())', { items: truthy }),
    ).resolves.toBe(truthy[0])
    await expect(
      expr.evaluate('items |> some(.flag || asyncFalse())', { items: truthy }),
    ).resolves.toBe(true)
    await expect(
      expr.evaluate('items |> every(.flag && asyncTrue())', { items: falsy }),
    ).resolves.toBe(false)
  })

  it('awaits async map callbacks sequentially by default', async () => {
    const expr = bonsai().use(arrays)
    let active = 0
    let maximumActive = 0
    expr.addFunction('pause', async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      active--
      return 0
    })

    await expect(expr.evaluate('items |> map(. + pause())', { items: [1, 2, 3] })).resolves.toEqual(
      [1, 2, 3],
    )
    expect(maximumActive).toBe(1)
  })

  it('continues async transforms across sparse arrays without materializing holes', async () => {
    const expr = bonsai().use(arrays)
    expr.addFunction('asyncValue', (value) => Promise.resolve(value))

    const sparse: unknown[] = new Array(4)
    sparse[1] = { value: false }
    sparse[3] = { value: true }

    const mapped = await expr.evaluate<unknown[]>('items |> map(asyncValue(.value))', {
      items: sparse,
    })
    expect(mapped).toHaveLength(4)
    expect(Object.hasOwn(mapped, 0)).toBe(false)
    expect(Object.hasOwn(mapped, 1)).toBe(true)
    expect(mapped[1]).toBe(false)
    expect(Object.hasOwn(mapped, 2)).toBe(false)
    expect(mapped[3]).toBe(true)

    await expect(
      expr.evaluate('items |> filter(asyncValue(.value))', { items: sparse }),
    ).resolves.toEqual([sparse[3]])
    await expect(
      expr.evaluate('items |> find(asyncValue(.value))', { items: sparse }),
    ).resolves.toBe(sparse[3])
    await expect(
      expr.evaluate('items |> some(asyncValue(.value))', { items: sparse }),
    ).resolves.toBe(true)

    sparse[1] = { value: true }
    sparse[3] = { value: false }
    await expect(
      expr.evaluate('items |> every(asyncValue(.value))', { items: sparse }),
    ).resolves.toBe(false)
    sparse[3] = { value: true }
    await expect(
      expr.evaluate('items |> every(asyncValue(.value))', { items: sparse }),
    ).resolves.toBe(true)
  })
})
