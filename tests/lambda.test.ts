import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'
import { arrays } from '../src/stdlib/arrays.js'

describe('lambda predicates', () => {
  it('simple property accessor still works', () => {
    const expr = bonsai()
    expr.use(arrays)
    expr.addTransform('map', (val: unknown, fn: unknown) =>
      (val as unknown[]).map(fn as (item: unknown) => unknown),
    )
    const result = expr.evaluateSync('items |> map(.name)', {
      items: [{ name: 'a' }, { name: 'b' }],
    })
    expect(result).toEqual(['a', 'b'])
  })

  it('compound predicate .age >= 18', () => {
    const expr = bonsai()
    expr.addTransform('filter', (val: unknown, fn: unknown) =>
      (val as unknown[]).filter(fn as (item: unknown) => boolean),
    )
    const result = expr.evaluateSync('users |> filter(.age >= 18)', {
      users: [
        { name: 'Alice', age: 25 },
        { name: 'Bob', age: 15 },
      ],
    })
    expect(result).toEqual([{ name: 'Alice', age: 25 }])
  })

  it('nested property accessor .address.city', () => {
    const expr = bonsai()
    expr.addTransform('map', (val: unknown, fn: unknown) =>
      (val as unknown[]).map(fn as (item: unknown) => unknown),
    )
    const result = expr.evaluateSync('users |> map(.address.city)', {
      users: [{ address: { city: 'NYC' } }, { address: { city: 'LA' } }],
    })
    expect(result).toEqual(['NYC', 'LA'])
  })

  it('lambda with method call .name.startsWith("A")', () => {
    const expr = bonsai()
    expr.addTransform('filter', (val: unknown, fn: unknown) =>
      (val as unknown[]).filter(fn as (item: unknown) => boolean),
    )
    const result = expr.evaluateSync('users |> filter(.name.startsWith("A"))', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    })
    expect(result).toEqual([{ name: 'Alice' }])
  })

  it('lambda with comparison .price < 100', () => {
    const expr = bonsai()
    expr.addTransform('filter', (val: unknown, fn: unknown) =>
      (val as unknown[]).filter(fn as (item: unknown) => boolean),
    )
    const result = expr.evaluateSync('items |> filter(.price < 100)', {
      items: [{ price: 50 }, { price: 150 }, { price: 75 }],
    })
    expect(result).toEqual([{ price: 50 }, { price: 75 }])
  })

  it('lambda with logical operators .active && .verified', () => {
    const expr = bonsai()
    expr.addTransform('filter', (val: unknown, fn: unknown) =>
      (val as unknown[]).filter(fn as (item: unknown) => boolean),
    )
    const result = expr.evaluateSync('users |> filter(.active && .verified)', {
      users: [
        { active: true, verified: true },
        { active: true, verified: false },
        { active: false, verified: true },
      ],
    })
    expect(result).toEqual([{ active: true, verified: true }])
  })

  it('blocks unsafe lambda property access', () => {
    const expr = bonsai()
    expr.addTransform('map', (val: unknown, fn: unknown) =>
      (val as unknown[]).map(fn as (item: unknown) => unknown),
    )
    expect(() =>
      expr.evaluateSync('items |> map(.constructor)', {
        items: [{ name: 'a' }],
      }),
    ).toThrow('Blocked')
  })
})

describe('lambda with optional chaining', () => {
  it('optional chaining in lambda .address?.city', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('items |> map(.address?.city)', {
      items: [{ address: { city: 'NYC' } }, { address: null }, {}],
    })
    expect(result).toEqual(['NYC', undefined, undefined])
  })

  it('async: optional chaining in lambda .address?.city', async () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = await expr.evaluate('items |> map(.address?.city)', {
      items: [{ address: { city: 'LA' } }, { address: undefined }],
    })
    expect(result).toEqual(['LA', undefined])
  })

  it('deep optional chaining in lambda .a?.b?.c', () => {
    const expr = bonsai()
    expr.use(arrays)
    const result = expr.evaluateSync('items |> map(.a?.b?.c)', {
      items: [{ a: { b: { c: 42 } } }, { a: { b: null } }, { a: null }],
    })
    expect(result).toEqual([42, undefined, undefined])
  })
})

describe('lambda body with ternary expressions', () => {
  const expr = bonsai()
  expr.use(arrays)

  it('ternary in map uses item context correctly', () => {
    const items = [
      { active: true, name: 'Alice' },
      { active: false, name: 'Bob' },
    ]
    const result = expr.evaluateSync('items |> map(.active ? .name : "unknown")', { items })
    expect(result).toEqual(['Alice', 'unknown'])
  })

  it('compound lambda with binary + ternary', () => {
    const items = [
      { age: 25, name: 'Alice' },
      { age: 15, name: 'Bob' },
    ]
    const result = expr.evaluateSync('items |> map(.age >= 18 ? "adult" : "minor")', { items })
    expect(result).toEqual(['adult', 'minor'])
  })

  it('nested ternary in lambda', () => {
    const items = [{ score: 90 }, { score: 75 }, { score: 50 }]
    const result = expr.evaluateSync(
      'items |> map(.score >= 80 ? "A" : (.score >= 60 ? "B" : "C"))',
      { items },
    )
    expect(result).toEqual(['A', 'B', 'C'])
  })

  it('async: ternary in map uses item context correctly', async () => {
    const items = [
      { active: true, name: 'Alice' },
      { active: false, name: 'Bob' },
    ]
    const result = await expr.evaluate('items |> map(.active ? .name : "unknown")', { items })
    expect(result).toEqual(['Alice', 'unknown'])
  })

  it('ternary with method call in lambda', () => {
    const items = [
      { name: 'ALICE', upper: true },
      { name: 'bob', upper: false },
    ]
    const result = expr.evaluateSync('items |> map(.upper ? .name : .name.slice(0, 1))', { items })
    expect(result).toEqual(['ALICE', 'b'])
  })
})

describe('lambda depth accounting', () => {
  it('literal fallthrough in lambda does not double-count depth', () => {
    const expr = bonsai({ maxDepth: 10 })
    expr.use(arrays)
    const items = [{ active: true }, { active: false }]
    // "yes"/"no" are literals that fall through evalLambdaBody's default branch
    // Without the fix, each literal would consume 2 depth levels instead of 1
    expect(expr.evaluateSync('items |> map(.active ? "yes" : "no")', { items })).toEqual([
      'yes',
      'no',
    ])
  })

  it('async: literal fallthrough in lambda does not double-count depth', async () => {
    const expr = bonsai({ maxDepth: 10 })
    expr.use(arrays)
    const items = [{ active: true }, { active: false }]
    const result = await expr.evaluate('items |> map(.active ? "yes" : "no")', { items })
    expect(result).toEqual(['yes', 'no'])
  })
})
