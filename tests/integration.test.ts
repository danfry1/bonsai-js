import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'
import { strings, arrays, math, types } from '../src/stdlib/index.js'

describe('integration - server-driven UI conditions', () => {
  it('should evaluate isAdult() function', () => {
    const expr = bonsai()
    expr.addFunction('isAdult', (age: unknown) => (age as number) >= 18)
    expect(expr.evaluateSync('isAdult(age)', { age: 25 })).toBe(true)
    expect(expr.evaluateSync('isAdult(age)', { age: 15 })).toBe(false)
  })

  it('should evaluate complex visibility conditions', () => {
    const expr = bonsai()
    const ctx = { user: { age: 25, tier: 'gold', verified: true } }
    expect(expr.evaluateSync('user.age >= 18 && user.verified', ctx)).toBe(true)
    expect(expr.evaluateSync('user.tier == "gold" || user.tier == "platinum"', ctx)).toBe(true)
  })

  it('should handle null-safe navigation', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('user?.profile?.avatar ?? "default.png"', { user: null })).toBe(
      'default.png',
    )
    expect(
      expr.evaluateSync('user?.profile?.avatar ?? "default.png"', {
        user: { profile: { avatar: 'me.png' } },
      }),
    ).toBe('me.png')
  })
})

describe('integration - transforms pipeline', () => {
  it('should chain multiple stdlib transforms', () => {
    const expr = bonsai()
    expr.use(strings)
    expect(expr.evaluateSync('name |> trim |> upper', { name: '  dan  ' })).toBe('DAN')
  })

  it('should use math transforms', () => {
    const expr = bonsai()
    expr.use(math)
    expect(expr.evaluateSync('items |> sum', { items: [10, 20, 30] })).toBe(60)
    expect(expr.evaluateSync('items |> avg', { items: [10, 20, 30] })).toBe(20)
  })
})

describe('integration - compiled expressions', () => {
  it('should compile once and evaluate many times', () => {
    const expr = bonsai()
    const compiled = expr.compile('user.age >= minAge')
    expect(compiled.evaluateSync({ user: { age: 25 }, minAge: 18 })).toBe(true)
    expect(compiled.evaluateSync({ user: { age: 15 }, minAge: 18 })).toBe(false)
    expect(compiled.evaluateSync({ user: { age: 25 }, minAge: 30 })).toBe(false)
  })
})

describe('integration - safety', () => {
  it('should block prototype pollution attempts', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('obj.__proto__', { obj: {} })).toThrow()
    expect(() => expr.evaluateSync('obj.constructor', { obj: {} })).toThrow()
  })

  it('should respect maxDepth', () => {
    const expr = bonsai({ maxDepth: 3 })
    // A deeply nested expression should throw
    expect(() =>
      expr.evaluateSync('a.b.c.d.e', {
        a: { b: { c: { d: { e: 1 } } } },
      }),
    ).toThrow('depth')
  })
})

describe('integration - plugins', () => {
  it('should compose multiple plugins', () => {
    const expr = bonsai()
    expr.use(strings)
    expr.use(arrays)
    expr.use(math)
    expr.use(types)

    expect(expr.evaluateSync('[1, 2, 3] |> count')).toBe(3)
    expect(expr.evaluateSync('"hello" |> upper')).toBe('HELLO')
    expect(expr.evaluateSync('42 |> isNumber')).toBe(true)
    expect(expr.evaluateSync('[5, 1, 3] |> sort |> first')).toBe(1)
  })
})

describe('integration - error messages', () => {
  it('should provide helpful error for syntax errors', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('1 +')).toThrow()
  })

  it('should validate without throwing', () => {
    const expr = bonsai()
    const result = expr.validate('1 +')
    expect(result.valid).toBe(false)
    expect(result.errors[0].message).toBeDefined()
  })
})

describe('completeness integration tests', () => {
  it('async pipeline with filter and map', async () => {
    const expr = bonsai()
    expr.use(arrays)
    expr.addTransform('asyncEnrich', async (val: unknown) => {
      const items = val as { name: string }[]
      return items.map((item) => ({ ...item, enriched: true }))
    })
    const result = await expr.evaluate('users |> filter(.age >= 18) |> asyncEnrich |> map(.name)', {
      users: [
        { name: 'Alice', age: 25 },
        { name: 'Bob', age: 15 },
        { name: 'Charlie', age: 30 },
      ],
    })
    expect(result).toEqual(['Alice', 'Charlie'])
  })

  it('complex expression with all features', () => {
    const expr = bonsai()
    expr.use(strings)
    expr.use(arrays)
    expr.use(math)
    const result = expr.evaluateSync(
      'items |> filter(.price < 100) |> map(.name) |> join(", ") |> upper',
      {
        items: [
          { name: 'apple', price: 50 },
          { name: 'steak', price: 150 },
          { name: 'bread', price: 30 },
        ],
      },
    )
    expect(result).toBe('APPLE, BREAD')
  })

  it('hex numbers in expressions', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('0xFF + 1')).toBe(256)
  })

  it('shorthand objects with trailing commas', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('{ name, age, }', { name: 'Dan', age: 30 })).toEqual({
      name: 'Dan',
      age: 30,
    })
  })

  it('method calls chained with pipes', () => {
    const expr = bonsai()
    expr.use(strings)
    expect(expr.evaluateSync('"hello world".slice(0, 5) |> upper')).toBe('HELLO')
  })

  it('computed optional chaining with nullish coalescing', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('data?.[key] ?? "default"', { data: null, key: 'x' })).toBe('default')
    expect(expr.evaluateSync('data?.[key] ?? "default"', { data: { x: 42 }, key: 'x' })).toBe(42)
  })

  it('not in operator', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('"admin" not in roles', { roles: ['user', 'editor'] })).toBe(true)
  })

  it('spread in function calls', () => {
    const expr = bonsai()
    expr.addFunction('add', (a: unknown, b: unknown) => (a as number) + (b as number))
    expect(expr.evaluateSync('add(...nums)', { nums: [3, 4] })).toBe(7)
  })

  it('numeric separators', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('1_000_000 + 500_000')).toBe(1500000)
  })

  it('unary + coercion', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('+val', { val: '42' })).toBe(42)
  })

  it('scientific notation', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('1.5e3 + 500')).toBe(2000)
  })
})
