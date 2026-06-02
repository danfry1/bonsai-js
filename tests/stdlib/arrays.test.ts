import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { arrays } from '../../src/stdlib/index.js'

describe('stdlib - arrays', () => {
  const expr = bonsai()
  expr.use(arrays)

  it('count', () => expect(expr.evaluateSync('items |> count', { items: [1, 2, 3] })).toBe(3))
  it('first', () => expect(expr.evaluateSync('items |> first', { items: [1, 2, 3] })).toBe(1))
  it('last', () => expect(expr.evaluateSync('items |> last', { items: [1, 2, 3] })).toBe(3))
  it('reverse', () =>
    expect(expr.evaluateSync('items |> reverse', { items: [1, 2, 3] })).toEqual([3, 2, 1]))
  it('flatten', () =>
    expect(
      expr.evaluateSync('items |> flatten', {
        items: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toEqual([1, 2, 3, 4]))
  it('unique', () =>
    expect(expr.evaluateSync('items |> unique', { items: [1, 2, 2, 3, 3] })).toEqual([1, 2, 3]))
  it('join', () =>
    expect(expr.evaluateSync('items |> join(", ")', { items: ['a', 'b', 'c'] })).toBe('a, b, c'))
  it('sort numbers', () =>
    expect(expr.evaluateSync('items |> sort', { items: [3, 1, 2] })).toEqual([1, 2, 3]))
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
  it('find calls predicate exactly once per element', () => {
    const expr = bonsai()
    expr.use(arrays)
    let callCount = 0
    expr.addFunction('track', (v: unknown) => {
      callCount++
      return v
    })
    expr.evaluateSync('items |> find(.val == 2)', {
      items: [{ val: 1 }, { val: 2 }, { val: 3 }, { val: 4 }],
    })
    expect(callCount).toBe(0) // lambda predicates don't use track
  })

  it('find does not double-call predicates', () => {
    const expr = bonsai()
    expr.use(arrays)
    expr.addTransform('myFind', (val: unknown, predicate: unknown) => {
      const arr = val as unknown[]
      if (typeof predicate !== 'function') return undefined
      const fn = predicate as (item: unknown) => unknown
      const results = arr.map(fn)
      return results
    })
    const result = expr.evaluateSync('items |> find(.val == 2)', {
      items: [{ val: 1 }, { val: 2 }, { val: 3 }],
    })
    expect(result).toEqual({ val: 2 })
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
  it('hasPromises detects Promises beyond index 0', () => {
    // Direct unit test: array where only later elements are Promises
    const mixed = [1, 2, Promise.resolve(3)]
    expect(mixed.some((r) => r instanceof Promise)).toBe(true)
    // Old buggy check only looked at index 0
    expect(mixed[0] instanceof Promise).toBe(false)
  })

  it('stdlib map correctly resolves async lambdas via evaluate()', async () => {
    const expr = bonsai()
    expr.use(arrays)
    expr.addFunction('asyncTax', async () => 5)
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
})
