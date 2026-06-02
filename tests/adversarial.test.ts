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
  return ['root', ...Array.from({ length: depth }, (_, index) => `level${index}`), 'value'].join(
    '.',
  )
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
    expect(() => expr.evaluateSync('obj.secret', { obj: { secret: 42 } })).toThrow(
      BonsaiSecurityError,
    )
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
    expect(() => expr.evaluateSync('items.startsWith("a")', { items: [1, 2] })).toThrow(
      BonsaiSecurityError,
    )
    expect(() => expr.evaluateSync('items.replace("a", "b")', { items: [1, 2] })).toThrow(
      BonsaiSecurityError,
    )
  })

  it('receiver-aware method validation: array methods rejected on strings', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('text.toFixed(2)', { text: 'hello' })).toThrow(
      BonsaiSecurityError,
    )
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200)
      })
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
    expect(() => expr.evaluateSync('"hello" |> asyncUpper')).toThrow(
      /synchronous transform result/u,
    )
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
      return results.some((r) => r instanceof Promise) ? Promise.all(results) : results
    })
    const result = await expr.evaluate('items |> map(.price + asyncTax())', {
      items: [{ price: 10 }, { price: 20 }],
    })
    expect(result).toEqual([15, 25])
  })

  it('async filter with stdlib correctly awaits predicates', async () => {
    const { arrays } = await import('../src/stdlib/index.js')
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

  it('computed access cannot bypass denied properties', () => {
    const expr = bonsai({ deniedProperties: ['secret'] })
    expect(() => expr.evaluateSync('obj["secret"]', { obj: { secret: 1 } })).toThrow(
      BonsaiSecurityError,
    )
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

    const [r1, r2] = await Promise.all([expr.evaluate(deep, ctx), expr.evaluate(shallow)])
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

describe('resource-exhaustion limits', () => {
  // Parser nesting depth guard: deep nesting must fail closed with a typed
  // ExpressionError, never a raw native RangeError (stack overflow).
  it('throws a typed ExpressionError on pathologically deep parenthesis nesting', () => {
    const deep = `${'('.repeat(50_000)}1${')'.repeat(50_000)}`
    expect(() => parse(deep)).toThrow(ExpressionError)
  })

  it('throws a typed ExpressionError on pathologically deep unary nesting', () => {
    const deep = `${'!'.repeat(50_000)}x`
    expect(() => parse(deep)).toThrow(ExpressionError)
  })

  it('surfaces deep nesting through evaluateSync and validate without a raw RangeError', () => {
    const deep = `${'('.repeat(50_000)}1${')'.repeat(50_000)}`
    expect(() => bonsai().evaluateSync(deep)).toThrow(ExpressionError)
    const result = bonsai().validate(deep)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors[0].message).toMatch(/nesting depth/iu)
      expect(result.errors[0].message).not.toMatch(/call stack/iu)
    }
  })

  it('still parses reasonably deep but legal nesting', () => {
    const ok = `${'('.repeat(300)}1${')'.repeat(300)}`
    expect(bonsai().evaluateSync(ok)).toBe(1)
  })

  // String-output cap on the method path (the stdlib transform path already
  // caps padStart/padEnd; the method path previously did not).
  it('caps padStart/padEnd output length on the method path', () => {
    expect(() => bonsai().evaluateSync('"x".padStart(50000000)')).toThrow(BonsaiSecurityError)
    expect(() => bonsai().evaluateSync('"x".padEnd(50000000)')).toThrow(BonsaiSecurityError)
  })

  it('respects a custom maxStringLength for padStart/padEnd', () => {
    const expr = bonsai({ maxStringLength: 100 })
    expect(expr.evaluateSync('"x".padStart(100)')).toHaveLength(100)
    expect(() => expr.evaluateSync('"x".padStart(101)')).toThrow(BonsaiSecurityError)
  })

  it('caps repeat by output length as well as by count', () => {
    // 10 chars * 101 = 1010 > 1000
    expect(() =>
      bonsai({ maxStringLength: 1000 }).evaluateSync('"xxxxxxxxxx".repeat(101)'),
    ).toThrow(BonsaiSecurityError)
    // existing count cap still applies under the default policy
    expect(() => bonsai().evaluateSync('"x".repeat(200000000)')).toThrow('count')
  })

  // Array-output cap: maxArrayLength previously covered only array literals and
  // spread, not array-producing method outputs.
  it('enforces maxArrayLength on array-producing method outputs (sync)', () => {
    const expr = bonsai({ maxArrayLength: 5 })
    expect(() => expr.evaluateSync('"a,b,c,d,e,f,g".split(",")')).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('items.map(. + 1)', { items: [1, 2, 3, 4, 5, 6] })).toThrow(
      BonsaiSecurityError,
    )
    expect(() => expr.evaluateSync('a.concat(b)', { a: [1, 2, 3], b: [4, 5, 6] })).toThrow(
      BonsaiSecurityError,
    )
    expect(() =>
      expr.evaluateSync('m.flat()', {
        m: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      }),
    ).toThrow(BonsaiSecurityError)
  })

  it('enforces maxArrayLength on array-producing method outputs (async)', async () => {
    const expr = bonsai({ maxArrayLength: 5 })
    await expect(expr.evaluate('items.map(. + 1)', { items: [1, 2, 3, 4, 5, 6] })).rejects.toThrow(
      BonsaiSecurityError,
    )
    await expect(expr.evaluate('"a,b,c,d,e,f,g".split(",")')).rejects.toThrow(BonsaiSecurityError)
  })

  // --- Parser depth guard: all recursion paths, boundaries, messages ---

  it('bounds deep array-literal nesting with a typed ExpressionError', () => {
    const deep = `${'['.repeat(50_000)}1${']'.repeat(50_000)}`
    expect(() => parse(deep)).toThrow(ExpressionError)
  })

  it('bounds deep nesting reached through computed member access', () => {
    const deep = `a${'[a'.repeat(50_000)}${']'.repeat(50_000)}`
    expect(() => parse(deep)).toThrow(ExpressionError)
  })

  it('bounds deep nesting inside a template interpolation', () => {
    const deep = `\`\${${'('.repeat(50_000)}1${')'.repeat(50_000)}}\``
    expect(() => bonsai().evaluateSync(deep)).toThrow(ExpressionError)
  })

  it('reports a clear nesting-depth message rather than a stack-overflow', () => {
    const deep = `${'('.repeat(50_000)}1${')'.repeat(50_000)}`
    expect(() => parse(deep)).toThrow(/nesting depth/iu)
  })

  it('still parses moderately deep array nesting at the parser level', () => {
    const ok = `${'['.repeat(300)}1${']'.repeat(300)}`
    expect(() => parse(ok)).not.toThrow()
  })

  // --- String-output cap: async parity, boundaries, error code ---

  it('caps string growth in async mode too', async () => {
    await expect(bonsai().evaluate('"x".padStart(50000000)')).rejects.toThrow(BonsaiSecurityError)
  })

  it('respects a custom maxStringLength for padEnd at the boundary', () => {
    const expr = bonsai({ maxStringLength: 100 })
    expect(expr.evaluateSync('"x".padEnd(100)')).toHaveLength(100)
    expect(() => expr.evaluateSync('"x".padEnd(101)')).toThrow(BonsaiSecurityError)
  })

  it('caps repeat at the produced-length boundary', () => {
    const expr = bonsai({ maxStringLength: 50 })
    expect(expr.evaluateSync('"xxxxx".repeat(10)')).toHaveLength(50) // 5 * 10 = 50, allowed
    expect(() => expr.evaluateSync('"xxxxx".repeat(11)')).toThrow(BonsaiSecurityError) // 55 > 50
  })

  // --- Array-output cap: full method set, boundaries, within-limit, async ---

  it('enforces maxArrayLength across every array-returning method (sync)', () => {
    const expr = bonsai({ maxArrayLength: 5 })
    const ctx = { arr: [1, 2, 3, 4, 5, 6] }
    expect(() => expr.evaluateSync('arr.slice(0)', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('arr.toSorted()', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('arr.toReversed()', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('arr.with(0, 9)', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('arr.toSpliced(0, 0, 9)', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('arr.flatMap(. * 1)', ctx)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('arr.filter(. > 0)', ctx)).toThrow(BonsaiSecurityError) // all 6 survive
  })

  it('allows array method outputs within the limit (regression)', () => {
    const expr = bonsai({ maxArrayLength: 5 })
    expect(expr.evaluateSync('"a,b,c,d,e".split(",")')).toHaveLength(5) // exactly at limit
    // The 6-element source comes from context (a literal would hit the cap at construction).
    expect(expr.evaluateSync('arr.filter(. > 4)', { arr: [1, 2, 3, 4, 5, 6] })).toEqual([5, 6])
    expect(expr.evaluateSync('[1,2,3].map(. * 2)')).toEqual([2, 4, 6])
    expect(() => expr.evaluateSync('"a,b,c,d,e,f".split(",")')).toThrow(BonsaiSecurityError) // 6 > 5
  })

  it('enforces maxArrayLength across methods in async mode', async () => {
    const expr = bonsai({ maxArrayLength: 5 })
    const ctx = { arr: [1, 2, 3, 4, 5, 6] }
    await expect(expr.evaluate('arr.filter(. > 0)', ctx)).rejects.toThrow(BonsaiSecurityError)
    await expect(expr.evaluate('arr.flatMap(. * 1)', ctx)).rejects.toThrow(BonsaiSecurityError)
    await expect(expr.evaluate('arr.toSorted()', ctx)).rejects.toThrow(BonsaiSecurityError)
  })

  it('uses the documented machine-readable error codes', () => {
    const expr = bonsai({ maxStringLength: 10, maxArrayLength: 3 })
    let strCode: string | undefined
    try {
      expr.evaluateSync('"x".padStart(50)')
    } catch (e) {
      strCode = (e as BonsaiSecurityError).code
    }
    expect(strCode).toBe('MAX_STRING_LENGTH')
    let arrCode: string | undefined
    try {
      expr.evaluateSync('"a,b,c,d".split(",")')
    } catch (e) {
      arrCode = (e as BonsaiSecurityError).code
    }
    expect(arrCode).toBe('MAX_ARRAY_LENGTH')
  })

  // String-output cap on every string-returning method. padStart/padEnd/repeat
  // are checked before allocation; join/concat/slice/... are checked on output.
  // arr.join(sep) is the worst single-call amplifier (length x separator length).
  describe('maxStringLength bounds every string-returning method output', () => {
    it('caps join output (the array-length x separator-length amplifier)', () => {
      const expr = bonsai({ maxStringLength: 10 })
      // 3 elements joined by a 10-char separator => 23 chars, past the cap.
      expect(() => expr.evaluateSync('a.join(s)', { a: ['x', 'y', 'z'], s: '0123456789' })).toThrow(
        BonsaiSecurityError,
      )
      // Within the cap is still allowed.
      expect(expr.evaluateSync('a.join(s)', { a: ['x', 'y'], s: '00' })).toBe('x00y')
    })

    it('uses MAX_STRING_LENGTH for an over-cap join (not a raw allocation)', () => {
      const expr = bonsai({ maxStringLength: 10 })
      let code: string | undefined
      try {
        expr.evaluateSync('a.join(s)', { a: ['x', 'y', 'z'], s: '0123456789' })
      } catch (e) {
        code = (e as BonsaiSecurityError).code
      }
      expect(code).toBe('MAX_STRING_LENGTH')
    })

    it('caps string concat and slice output', () => {
      const expr = bonsai({ maxStringLength: 10 })
      expect(() => expr.evaluateSync('a.concat(b)', { a: 'xxxxxx', b: 'yyyyyy' })).toThrow(
        BonsaiSecurityError,
      )
      expect(() => expr.evaluateSync('big.slice(0)', { big: 'x'.repeat(11) })).toThrow(
        BonsaiSecurityError,
      )
      // A slice that stays within the cap is allowed.
      expect(expr.evaluateSync('big.slice(0, 10)', { big: 'x'.repeat(11) })).toHaveLength(10)
    })

    it('enforces the join cap in async mode too', async () => {
      const expr = bonsai({ maxStringLength: 10 })
      await expect(
        expr.evaluate('a.join(s)', { a: ['x', 'y', 'z'], s: '0123456789' }),
      ).rejects.toThrow(BonsaiSecurityError)
    })

    it('bounds join under the default policy (regression for the documented guarantee)', () => {
      // Default maxStringLength = 100,000. A separator at the cap joined across a
      // handful of elements produces a multi-hundred-KB string in one native
      // call; it must be rejected rather than silently allocated.
      const expr = bonsai()
      const arr = Array.from({ length: 10 }, (_, i) => String(i))
      expect(() => expr.evaluateSync('a.join(s)', { a: arr, s: 'x'.repeat(100000) })).toThrow(
        BonsaiSecurityError,
      )
    })
  })
})
