import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BonsaiCheckError,
  BonsaiSyntaxError,
  bonsai,
  fn,
  t,
  type Environment,
  type Library,
  type Program,
} from '../src/index.js'

describe('environment', () => {
  it('evaluates without declarations (open environment)', () => {
    const env = bonsai()
    expect(env.evaluateSync('a + b', { a: 1, b: 2 })).toBe(3)
    expect(env.evaluateSync('missing')).toBe(null)
  })

  it('reports unknown variables in strict mode, the default with declared variables', () => {
    const variables = { user: t.object({ age: t.number() }) }
    expect(bonsai({ variables, strict: false }).check('usr.age').ok).toBe(true)
    expect(bonsai().check('usr.age').ok).toBe(true)
    expect(bonsai().strict).toBe(false)
    const strict = bonsai({ variables })
    expect(strict.strict).toBe(true)
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
    const env = bonsai({ variables: { xs: t.list(t.number()) }, strict: false })
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

  it('rejects a non-object context as a TypeError, like invalid options', async () => {
    expect(() => bonsai().evaluateSync('1', 5 as never)).toThrow(TypeError)
    await expect(bonsai().evaluate('1', 'x' as never)).rejects.toThrow(TypeError)
    await expect(bonsai().explain('1', 5 as never)).rejects.toThrow(TypeError)
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

  it('composes libraries and rejects duplicate names', () => {
    const f = fn({ params: [], returns: t.number(), run: () => 1 })
    const a: Library = { name: 'a', functions: { one: f } }
    const b: Library = { name: 'b', functions: { two: f } }
    expect(bonsai({ libraries: [a, b] }).evaluateSync('one() + two()')).toBe(2)
    expect(() => bonsai({ libraries: [a, { name: 'c', functions: { one: f } }] })).toThrow(
      /both library "a" and library "c"/u,
    )
  })

  it('types a residual by the program context', () => {
    const env = bonsai({
      variables: { user: t.object({ age: t.number() }), limit: t.number() },
    })
    const result = env.compile('user.age > limit', { expect: t.boolean() }).partial({ limit: 18 })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.evaluateSync({ user: { age: 30 } })).toBe(true)
    // @ts-expect-error: `usr` is not a context variable (untyped, `user` would read as null)
    expect(result.evaluateSync({ usr: { age: 30 } })).toBe(false)
    expectTypeOf(result.evaluateSync).returns.toEqualTypeOf<boolean>()
  })

  it('publishes explanation traces as read-only data', () => {
    const explanation = bonsai().explainSync('1 + 2')
    const trace = explanation.trace
    // @ts-expect-error: traces are read-only
    trace.value = 4
    // @ts-expect-error: their children are read-only too
    trace.children.push(trace)
    // @ts-expect-error: and so is the list of reasons
    explanation.reasons().push(trace)
  })

  it('stores typed programs and environments as the general types', () => {
    const env = bonsai({ variables: { a: t.number() } })
    const program = env.compile('a > 1', { expect: t.boolean() })
    const programs: Program[] = [program]
    const environments: Environment[] = [env]
    const run = program.evaluateSync
    expect(run({ a: 2 })).toBe(true)
    expect(programs[0]?.evaluateSync({ a: 0 })).toBe(false)
    expect(environments.length).toBe(1)
  })

  it('includes library variables in the context type', () => {
    const tenancy = { name: 'tenancy', variables: { tenant: t.string() } } satisfies Library
    const env = bonsai({ libraries: [tenancy] })
    expectTypeOf<Parameters<typeof env.evaluateSync>[1]>().toEqualTypeOf<{
      readonly tenant: string
    }>()
    // @ts-expect-error: the library declares `tenant`, so a context is required
    expect(env.evaluateSync('tenant == "x"')).toBe(false)
    expect(env.evaluateSync('tenant == "x"', { tenant: 'x' })).toBe(true)

    const both = bonsai({ variables: { user: t.string() }, libraries: [tenancy] })
    expectTypeOf<Parameters<typeof both.evaluateSync>[1]>().toEqualTypeOf<{
      readonly user: string
      readonly tenant: string
    }>()
    // @ts-expect-error: `tenant` is missing
    both.evaluateSync('user', { user: 'u' })

    const extended = bonsai({ variables: { user: t.string() } }).extend({ libraries: [tenancy] })
    expectTypeOf<Parameters<typeof extended.evaluateSync>[1]>().toEqualTypeOf<
      { readonly user: string } & { readonly tenant: string }
    >()
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
})

describe('public option types accept undefined (exactOptionalPropertyTypes)', () => {
  it('lets every optional option be passed as undefined', async () => {
    const maybe = <T>(value: T): T | undefined => value
    const env = bonsai({ variables: { n: t.number() } })
    const program = env.compile('n + 1', { expect: maybe(t.number()) })
    const explanation = await program.explain(
      { n: 1 },
      { maxIterations: maybe(5), maxTraceNodes: maybe(100), exhaustive: maybe(false) },
    )
    expect(explanation.ok).toBe(true)
    const partial = program.partial(
      {},
      { unknown: maybe(['n']), callHostFunctions: maybe(false), now: maybe(new Date(0)) },
    )
    expect(partial.status).toBe('residual')
  })
})
