import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BonsaiCheckError,
  BonsaiError,
  BonsaiRuntimeError,
  BonsaiSyntaxError,
  bonsai,
  fn,
  t,
  type Library,
} from '../src/index.js'

describe('environment', () => {
  it('evaluates without declarations (open environment)', () => {
    const env = bonsai()
    expect(env.evaluateSync('a + b', { a: 1, b: 2 })).toBe(3)
    expect(env.evaluateSync('missing')).toBe(null)
  })

  it('reports unknown variables only in strict mode', () => {
    const variables = { user: t.object({ age: t.number() }) }
    expect(bonsai({ variables }).check('usr.age').ok).toBe(true)
    const strict = bonsai({ variables, strict: true })
    const result = strict.check('usr.age')
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('UNKNOWN_VARIABLE')
    expect(result.diagnostics[0]?.message).toContain('did you mean "user"')
  })

  it('reports unknown properties of declared maps', () => {
    const env = bonsai({ variables: { user: t.object({ age: t.number(), name: t.string() }) } })
    const result = env.check('user.agee > 1')
    expect(result.diagnostics.map((d) => d.code)).toContain('UNKNOWN_PROPERTY')
    expect(result.diagnostics[0]?.message).toContain('did you mean "age"')
  })

  it('compile throws BonsaiCheckError with every diagnostic', () => {
    const env = bonsai({ variables: { a: t.string() }, strict: true })
    try {
      env.compile('a + 1 + b')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BonsaiCheckError)
      const check = error as BonsaiCheckError
      expect(check.diagnostics.length).toBeGreaterThanOrEqual(2)
      expect(check.formatted).toContain('^')
    }
  })

  it('check never throws on syntax errors', () => {
    const result = bonsai().check('1 +')
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('SYNTAX')
  })

  it('syntax errors carry a position and a code frame', () => {
    try {
      bonsai().evaluateSync('a +\n  * 2')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BonsaiSyntaxError)
      const e = error as BonsaiSyntaxError
      expect(e.position).toEqual({ line: 2, column: 3 })
      expect(e.formatted).toContain('2 |   * 2')
    }
  })

  it('expect types the program and checks the result', () => {
    const env = bonsai({ variables: { age: t.number() } })
    const program = env.compile('age >= 18', { expect: t.boolean() })
    expectTypeOf<ReturnType<typeof program.evaluateSync>>().toEqualTypeOf<boolean>()
    expect(program.evaluateSync({ age: 20 })).toBe(true)
    expect(() => env.compile('age + 1', { expect: t.boolean() })).toThrow(
      /Expected the expression to produce boolean/u,
    )
  })

  it('infers the context type from declared variables', () => {
    const env = bonsai({
      variables: {
        user: t.object({ age: t.number(), nick: t.optional(t.string()) }),
        tags: t.list(t.string()),
      },
    })
    const program = env.compile('user.age')
    expectTypeOf<Parameters<typeof program.evaluateSync>[0]>().toEqualTypeOf<{
      readonly user: { readonly age: number; readonly nick?: string | null | undefined }
      readonly tags: readonly string[]
    }>()
    // @ts-expect-error: missing required context
    expect(() => program.evaluateSync()).not.toThrow()
  })

  it('exposes type, references, and warnings', () => {
    const env = bonsai({ variables: { xs: t.list(t.number()) } })
    const program = env.compile('xs.map(. * 2).sum() > limit')
    expect(program.type).toEqual(t.boolean())
    expect(program.references.variables).toEqual(['xs', 'limit'])
    expect([...program.references.functions].sort()).toEqual(['map', 'sum'])
    expect(env.compile('xs ?? []').warnings[0]?.message).toContain('never null')
  })

  it('caches compiled programs for evaluate(source)', () => {
    let calls = 0
    const env = bonsai({
      functions: { f: fn({ params: [], returns: t.number(), run: () => ++calls }) },
    })
    expect(env.evaluateSync('f()')).toBe(1)
    expect(env.evaluateSync('f()')).toBe(2)
  })

  it('rejects a non-object context', () => {
    expect(() => bonsai().evaluateSync('1', 5 as never)).toThrow(BonsaiRuntimeError)
  })

  it('programs are reentrant', () => {
    const env = bonsai({
      functions: {
        inner: fn({
          params: [t.number()],
          returns: t.number(),
          run: (n): number => program.evaluateSync({ n: n - 1 }) as number,
        }),
      },
    })
    const program = env.compile('n <= 0 ? 0 : n + inner(n)')
    expect(program.evaluateSync({ n: 3 })).toBe(6)
  })
})

describe('host functions', () => {
  it('infers run parameter types from params', () => {
    fn({
      params: [t.string(), t.list(t.number())],
      returns: t.boolean(),
      run: (a, b) => {
        expectTypeOf(a).toEqualTypeOf<string>()
        expectTypeOf(b).toEqualTypeOf<readonly number[]>()
        return true
      },
    })
  })

  it('checks arguments statically and at runtime', () => {
    const env = bonsai({
      functions: { twice: fn({ params: [t.number()], returns: t.number(), run: (n) => n * 2 }) },
    })
    expect(env.evaluateSync('twice(21)')).toBe(42)
    expect(env.evaluateSync('x.twice()', { x: 4 })).toBe(8)
    expect(env.check('twice("a")').ok).toBe(false)
    expect(() => env.evaluateSync('twice(x)', { x: 'a' })).toThrow(
      expect.objectContaining({ code: 'NO_OVERLOAD' }),
    )
  })

  it('validates list elements deeply before calling host code', () => {
    const seen: unknown[] = []
    const env = bonsai({
      functions: {
        total: fn({
          params: [t.list(t.number())],
          returns: t.number(),
          run: (xs) => (seen.push(xs), xs.length),
        }),
      },
    })
    expect(() => env.evaluateSync('total(xs)', { xs: [1, 'two'] })).toThrow(
      expect.objectContaining({ code: 'NO_OVERLOAD' }),
    )
    expect(seen).toEqual([])
  })

  it('validates the result kind', () => {
    const env = bonsai({
      functions: {
        bad: fn({ params: [], returns: t.number(), run: () => 'nope' as unknown as number }),
      },
    })
    expect(() => env.evaluateSync('bad()')).toThrow(expect.objectContaining({ code: 'HOST_ERROR' }))
  })

  it('wraps host exceptions, which try() can catch', () => {
    const env = bonsai({
      functions: {
        boom: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw new Error('kaput')
          },
        }),
      },
    })
    expect(() => env.evaluateSync('boom()')).toThrow(/boom\(\) failed: kaput/u)
    expect(env.evaluateSync('try(boom(), -1)')).toBe(-1)
  })

  it('pads missing optional arguments with null', () => {
    const env = bonsai({
      functions: {
        greet: fn({
          params: [t.string(), t.optional(t.string())],
          required: 1,
          returns: t.string(),
          run: (name, greeting) => `${greeting ?? 'Hello'} ${name}`,
        }),
      },
    })
    expect(env.evaluateSync('greet("Ada")')).toBe('Hello Ada')
    expect(env.evaluateSync('greet("Ada", "Hi")')).toBe('Hi Ada')
  })

  it('passes the context to context functions', () => {
    const env = bonsai({
      functions: {
        tenant: fn({
          params: [],
          returns: t.string(),
          context: true,
          run: (ctx) => String(ctx.tenant),
        }),
      },
    })
    expect(env.evaluateSync('tenant()', { tenant: 'acme' })).toBe('acme')
  })

  it('replaces a built-in of the same name', () => {
    const env = bonsai({
      functions: { sum: fn({ params: [t.list(t.any())], returns: t.number(), run: () => 42 }) },
    })
    expect(env.evaluateSync('[1, 2].sum()')).toBe(42)
    expect(bonsai().evaluateSync('[1, 2].sum()')).toBe(3)
  })

  it('rejects invalid names', () => {
    const f = fn({ params: [], returns: t.number(), run: () => 1 })
    expect(() => bonsai({ functions: { has: f } })).toThrow(/Invalid function name/u)
    expect(() => bonsai({ functions: { 'a-b': f } })).toThrow(/Invalid function name/u)
  })

  it('composes libraries and rejects duplicate names', () => {
    const f = fn({ params: [], returns: t.number(), run: () => 1 })
    const a: Library = { name: 'a', functions: { one: f } }
    const b: Library = { name: 'b', functions: { two: f } }
    expect(bonsai({ libraries: [a, b] }).evaluateSync('one() + two()')).toBe(2)
    expect(() => bonsai({ libraries: [a, { name: 'c', functions: { one: f } }] })).toThrow(
      /both library "a" and library "c"/u,
    )
  })

  it('extend adds variables and functions', () => {
    const base = bonsai({ variables: { a: t.number() }, strict: true })
    const child = base.extend({
      variables: { b: t.number() },
      functions: { inc: fn({ params: [t.number()], returns: t.number(), run: (n) => n + 1 }) },
    })
    expect(child.evaluateSync('inc(a + b)', { a: 1, b: 2 })).toBe(4)
    expect(base.check('b').ok).toBe(false)
  })

  it('lists and describes functions', () => {
    const env = bonsai()
    const info = env.describeFunction('includes')
    expect(info?.signatures.length).toBe(2)
    expect(env.listFunctions().some((f) => f.name === 'groupBy')).toBe(true)
  })
})

describe('async host functions', () => {
  const env = bonsai({
    functions: {
      rate: fn({
        params: [t.string()],
        returns: t.number(),
        async: true,
        run: async (currency) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 1)
          })
          return currency === 'EUR' ? 2 : 1
        },
      }),
    },
  })

  it('awaits async functions in evaluate()', async () => {
    const orders = [
      { cur: 'EUR', amount: 10 },
      { cur: 'USD', amount: 5 },
    ]
    await expect(
      env.evaluate('orders.map(o => rate(o.cur) * o.amount).sum()', { orders }),
    ).resolves.toBe(25)
    await expect(env.evaluate('orders.map(rate(.cur) * .amount)', { orders })).resolves.toEqual([
      20, 5,
    ])
  })

  it('rejects async calls in evaluateSync before running host code', () => {
    let ran = false
    const tracked = bonsai({
      functions: {
        a: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: () => {
            ran = true
            return Promise.resolve(1)
          },
        }),
      },
    })
    expect(() => tracked.evaluateSync('a()')).toThrow(
      expect.objectContaining({ code: 'ASYNC_IN_SYNC' }),
    )
    expect(ran).toBe(false)
  })

  it('rejects a promise from a function not declared async', () => {
    const sneaky = bonsai({
      functions: {
        p: fn({
          params: [],
          returns: t.number(),
          run: () => Promise.resolve(1) as unknown as number,
        }),
      },
    })
    expect(() => sneaky.evaluateSync('p()')).toThrow(
      expect.objectContaining({ code: 'ASYNC_IN_SYNC' }),
    )
  })

  it('short-circuits without starting the right-hand call', async () => {
    let calls = 0
    const counting = bonsai({
      functions: {
        slow: fn({
          params: [],
          returns: t.boolean(),
          async: true,
          run: () => {
            calls++
            return Promise.resolve(true)
          },
        }),
      },
    })
    await expect(counting.evaluate('false && slow()')).resolves.toBe(false)
    await expect(counting.evaluate('[1, 2, 3].some(. > 1 && slow())')).resolves.toBe(true)
    expect(calls).toBe(1)
  })

  it('runs lambda invocations sequentially', async () => {
    const log: string[] = []
    const seq = bonsai({
      functions: {
        visit: fn({
          params: [t.number()],
          returns: t.number(),
          async: true,
          run: async (n) => {
            log.push(`start ${n}`)
            await new Promise((resolve) => {
              setTimeout(resolve, 3 - n)
            })
            log.push(`end ${n}`)
            return n
          },
        }),
      },
    })
    await expect(seq.evaluate('[1, 2].map(x => visit(x) + x)')).resolves.toEqual([2, 4])
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('evaluate works for sync-only expressions', async () => {
    await expect(bonsai().evaluate('1 + 1')).resolves.toBe(2)
    await expect(bonsai().evaluate('1 +')).rejects.toBeInstanceOf(BonsaiError)
  })
})
