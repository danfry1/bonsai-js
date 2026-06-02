import { describe, expect, it } from 'vitest'
import { ExpressionError, BonsaiSecurityError, BonsaiTypeError, bonsai } from '../src/index.js'
import { parse } from '../src/parser.js'

function nestedContext(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { value: 'ok' }
  for (let i = depth - 1; i >= 0; i--) {
    current = { [`level${i}`]: current }
  }
  return current
}

function nestedMemberExpression(depth: number): string {
  return ['root', ...Array.from({ length: depth }, (_, index) => `level${index}`), 'value'].join('.')
}

describe('adversarial inputs', () => {
  it('handles deeply nested valid parentheses', () => {
    const depth = 250
    const source = `${'('.repeat(depth)}1${')'.repeat(depth)}`
    expect(bonsai().evaluateSync(source)).toBe(1)
  })

  it('fails closed on very deep member chains in sync and async mode', async () => {
    const depth = 24
    const source = nestedMemberExpression(depth)
    const context = { root: nestedContext(depth) }
    const expr = bonsai({ maxDepth: 10 })

    expect(() => expr.evaluateSync(source, context)).toThrow('Maximum expression depth')
    await expect(expr.evaluate(source, context)).rejects.toThrow('Maximum expression depth')
  })

  it('rejects large array materialization at evaluation time', () => {
    const source = `[${Array.from({ length: 128 }, () => '1').join(', ')}]`
    const expr = bonsai({ maxArrayLength: 32 })
    expect(() => expr.evaluateSync(source)).toThrow('Array length')
  })

  it('throws a typed error for non-iterable spread in call arguments', () => {
    const expr = bonsai()
    expr.addFunction('count', (...args: unknown[]) => args.length)
    expect(() => expr.evaluateSync('count(...value)', { value: 42 })).toThrow(BonsaiTypeError)
  })

  it('blocks nested unsafe object keys, including computed keys', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('{ safe: { ["__proto__"]: 1 } }')).toThrow('Blocked')
    expect(() => expr.evaluateSync('{ safe: { constructor: 1 } }')).toThrow('Blocked')
  })

  it('keeps parser failures typed for long malformed inputs', () => {
    const malformed = `${'('.repeat(512)}x`
    expect(() => parse(malformed)).toThrow(ExpressionError)
  })
})

describe('sandbox hardening', () => {
  it('identifiers only resolve own properties, not prototype chain', () => {
    const proto = { inherited: 'leaked' }
    const ctx = Object.create(proto) as Record<string, unknown>
    ctx.own = 'safe'
    const expr = bonsai()
    expect(expr.evaluateSync('own', ctx)).toBe('safe')
    expect(expr.evaluateSync('inherited', ctx)).toBeUndefined()
  })

  it('object literals have null prototype', () => {
    const expr = bonsai()
    const result = expr.evaluateSync('{ a: 1, b: 2 }') as object
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect((result as Record<string, unknown>).hasOwnProperty).toBeUndefined()
  })

  it('blocks __proto__, constructor, prototype on member access', () => {
    const expr = bonsai()
    const ctx = { obj: { safe: 1 } }
    expect(() => expr.evaluateSync('obj.__proto__', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('obj.constructor', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('obj.prototype', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('obj["__proto__"]', ctx)).toThrow(BonsaiSecurityError)
  })

  it('blocks __proto__, constructor, prototype on identifiers too', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('__proto__', { __proto__: {} })).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('constructor', { constructor: {} })).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('prototype', { prototype: {} })).toThrow(BonsaiSecurityError)
  })

  it('AccessKind: identifiers bypass allow/deny lists', () => {
    const expr = bonsai({ allowedProperties: ['name'] })
    // Identifier 'secret' is not subject to allowedProperties
    expect(expr.evaluateSync('secret', { secret: 42 })).toBe(42)
    // But member access to 'secret' IS blocked
    expect(() => expr.evaluateSync('obj.secret', { obj: { secret: 42 } })).toThrow(BonsaiSecurityError)
  })

  it('AccessKind: object-key bypasses allow/deny lists', () => {
    const expr = bonsai({ allowedProperties: ['name'] })
    // Object keys like 'anything' are allowed (only blocked props are checked)
    expect(expr.evaluateSync('{ anything: 1 }')).toEqual({ anything: 1 })
  })

  it('canonical numeric indices bypass allow/deny lists', () => {
    const expr = bonsai({ allowedProperties: ['name'] })
    const ctx = { items: ['a', 'b', 'c'] }
    expect(expr.evaluateSync('items[0]', ctx)).toBe('a')
    expect(expr.evaluateSync('items[2]', ctx)).toBe('c')
    // Non-numeric member access still blocked
    expect(() => expr.evaluateSync('items.length', ctx)).toThrow(BonsaiSecurityError)
  })

  it('receiver-aware method validation: string methods rejected on arrays', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('items.startsWith("a")', { items: [1, 2] })).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('items.replace("a", "b")', { items: [1, 2] })).toThrow(BonsaiSecurityError)
  })

  it('receiver-aware method validation: array methods rejected on strings', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('text.toFixed(2)', { text: 'hello' })).toThrow(BonsaiSecurityError)
  })

  it('receiver-aware method validation: toString only on string and number', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('"hi".toString()')).toBe('hi')
    expect(expr.evaluateSync('num.toString()', { num: 42 })).toBe('42')
    expect(() => expr.evaluateSync('obj.toString()', { obj: {} })).toThrow(BonsaiSecurityError)
  })

  it('timeout enforcement via injectable clock', async () => {
    const expr = bonsai({ timeout: 50 })
    // Async functions that exceed the timeout should throw
    expr.addFunction('slow', async () => {
      await new Promise<void>(resolve => { setTimeout(resolve, 200) })
      return 'done'
    })
    await expect(expr.evaluate('slow()')).rejects.toThrow('Expression timeout')
  })

  it('deniedProperties blocks member and method access', () => {
    const expr = bonsai({ deniedProperties: ['password'] })
    const ctx = { user: { name: 'Dan', password: 'secret' } }
    expect(expr.evaluateSync('user.name', ctx)).toBe('Dan')
    expect(() => expr.evaluateSync('user.password', ctx)).toThrow(BonsaiSecurityError)
  })

  it('evaluateSync rejects Promise return from async functions', () => {
    const expr = bonsai()
    expr.addFunction('slow', async () => 'done')
    expect(() => expr.evaluateSync('slow()')).toThrow(/synchronous function result/u)
  })

  it('evaluateSync rejects Promise return from async transforms', () => {
    const expr = bonsai()
    expr.addTransform('asyncUpper', async (val: unknown) => (val as string).toUpperCase())
    expect(() => expr.evaluateSync('"hello" |> asyncUpper')).toThrow(/synchronous transform result/u)
  })

  it('sync Promise rejection errors identify the call kind and suggest evaluate()', () => {
    const expr = bonsai()
    expr.addFunction('asyncFn', async () => 1)
    expr.addTransform('asyncTx', async (v: unknown) => v)

    expect(() => expr.evaluateSync('asyncFn()')).toThrow(/synchronous function result/u)
    expect(() => expr.evaluateSync('"x" |> asyncTx')).toThrow(/synchronous transform result/u)
    expect(() => expr.evaluateSync('asyncFn()')).toThrow(/evaluate\(\)/u)
  })

  it('async lambdas correctly await async function calls', async () => {
    const expr = bonsai()
    expr.addFunction('asyncTax', async () => 5)
    expr.addTransform('map', (val: unknown, fn: unknown) => {
      const arr = val as unknown[]
      const results = arr.map(fn as (item: unknown) => unknown)
      return results.some(r => r instanceof Promise) ? Promise.all(results) : results
    })
    const result = await expr.evaluate(
      'items |> map(.price + asyncTax())',
      { items: [{ price: 10 }, { price: 20 }] },
    )
    expect(result).toEqual([15, 25])
  })

  it('async filter with stdlib correctly awaits predicates', async () => {
    const { arrays } = await import('../src/stdlib/index.js')
    const expr = bonsai()
    expr.use(arrays)
    const result = await expr.evaluate(
      'users |> filter(.active) |> map(.name)',
      { users: [
        { name: 'Alice', active: true },
        { name: 'Bob', active: false },
        { name: 'Charlie', active: true },
      ] },
    )
    expect(result).toEqual(['Alice', 'Charlie'])
  })

  it('computed access cannot bypass denied properties', () => {
    const expr = bonsai({ deniedProperties: ['secret'] })
    expect(() => expr.evaluateSync('obj["secret"]', { obj: { secret: 1 } })).toThrow(BonsaiSecurityError)
  })

  it('computed method call cannot bypass denied properties', () => {
    const expr = bonsai({ deniedProperties: ['slice'] })
    expect(() => expr.evaluateSync('"hello"["slice"](0, 3)')).toThrow(BonsaiSecurityError)
  })

  it('rejects method call on wrong receiver type', () => {
    const expr = bonsai()
    const ctx = { obj: { slice: () => 'hacked' } }
    expect(() => expr.evaluateSync('obj.slice()', ctx)).toThrow(BonsaiSecurityError)
  })

  it('two concurrent async evaluations have independent state', async () => {
    const expr = bonsai({ maxDepth: 5 })
    const deep = 'a.b.c.d.e'
    const shallow = '1 + 2'
    const ctx = { a: { b: { c: { d: { e: 42 } } } } }

    const [r1, r2] = await Promise.all([
      expr.evaluate(deep, ctx),
      expr.evaluate(shallow),
    ])
    expect(r1).toBe(42)
    expect(r2).toBe(3)
  })

  it('async member chains hit depth limit', async () => {
    const expr = bonsai({ maxDepth: 3 })
    const ctx = { a: { b: { c: { d: { e: 1 } } } } }
    await expect(expr.evaluate('a.b.c.d.e', ctx)).rejects.toThrow('Maximum expression depth')
  })

  it('own-property only: prototype chain does not leak', () => {
    const expr = bonsai()
    expect(expr.evaluateSync('toString', {})).toBeUndefined()
  })
})
