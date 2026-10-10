import { isDeepStrictEqual } from 'node:util'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t, type PartialResult } from '../src/index.js'

/** A value or the code of the error evaluation raised. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

describe('an explicit unknown list says the objects above a listed path exist', () => {
  const env = bonsai({
    variables: {
      customer: t.object({ email: t.optional(t.string()), tier: t.string() }),
      cart: t.object({ coupon: t.optional(t.string()), items: t.list(t.number()) }),
    },
  })
  const program = env.compile(
    '(customer.email ?? "").endsWith("@corp.com") || cart.coupon == "VIP"',
  )

  it('keeps a variable known leaves out unknown when a path under it is listed', () => {
    const result = program.partial({ customer: { tier: 'gold' } }, { unknown: ['cart.items'] })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(result.dependsOn).toEqual(['cart.coupon'])
    const cart = { coupon: 'VIP', items: [] }
    expect(result.evaluateSync({ cart })).toBe(true)
    expect(program.evaluateSync({ customer: { tier: 'gold' }, cart })).toBe(true)
  })

  it('applies to an object part way down a listed path', () => {
    const open = bonsai()
    const result = open
      .compile('order.meta.flag == true || order.meta.other == 1')
      .partial({ order: {} }, { unknown: ['order.meta.flag'] })
    expect(result.status).toBe('residual')
    if (result.status === 'residual') {
      expect(result.evaluateSync({ order: { meta: { flag: false, other: 1 } } })).toBe(true)
    }
  })

  it('still reads an unlisted field of a given object as null', () => {
    const result = program.partial(
      { customer: { tier: 'gold' }, cart: { items: [] } },
      { unknown: ['cart.items'] },
    )
    expect(result).toEqual({ status: 'value', value: false })
  })
})

describe('call: true residuals read the context they are given', () => {
  it('pass the caller its own object, however it is shaped', () => {
    let seen: unknown
    const env = bonsai({
      functions: {
        age: fn({
          params: [],
          returns: t.number(),
          call: true,
          run: (call) => {
            seen = call.context
            return 1
          },
        }),
      },
    })
    const known: Record<string, unknown> = { x: 1 }
    known.a = known
    const residual = env.compile('age() + n').partial({ user: known })
    if (residual.status !== 'residual') throw new Error('expected a residual')
    const user: Record<string, unknown> = {}
    for (let i = 0; i < 2000; i++) user[`p${i}`] = i
    user.a = user
    let walked = 0
    const proto = new Proxy(
      {},
      {
        ownKeys(target) {
          walked++
          return Reflect.ownKeys(target)
        },
      },
    )
    const given = Object.assign(Object.create(proto) as Record<string, unknown>, { n: 1, user })
    expect(residual.evaluateSync(given, { maxSteps: 100 })).toBe(2)
    expect(seen).toBe(given)
    expect(walked).toBe(0)
  })
})

describe('residuals of nested implicit lambdas', () => {
  it('gives each lambda made explicit its own parameter name', () => {
    const result = bonsai()
      .compile('xs.map(flag ? . : ys.map(flag ? . : 1))')
      .partial({ flag: false })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(result.source).toBe('xs.map(__item2 => ys.map(__item => 1))')
    expect(result.evaluateSync({ xs: [1, 2], ys: [3] })).toEqual([[1], [1]])
  })

  // Expressions over a flag and a number, with lambdas nested in lambdas; any
  // part may be decided by the known data.
  const leaf = (inLambda: boolean): fc.Arbitrary<string> =>
    fc.oneof(
      fc.integer({ min: 0, max: 9 }).map(String),
      fc.constant('n'),
      ...(inLambda ? [fc.constant('.')] : []),
    )
  const expr = (depth: number, inLambda: boolean): fc.Arbitrary<string> =>
    depth === 0
      ? leaf(inLambda)
      : fc.oneof(
          leaf(inLambda),
          fc
            .tuple(expr(depth - 1, inLambda), expr(depth - 1, inLambda))
            .map(([a, b]) => `(flag ? ${a} : ${b})`),
          fc
            .tuple(expr(depth - 1, inLambda), expr(depth - 1, inLambda))
            .map(([a, b]) => `(${a} + ${b})`),
          lambda(depth).map((body) => `xs.map(${body}).sum()`),
          lambda(depth).map((body) => `ys.map(${body}).sum()`),
        )
  // A lambda body that reads `.` until a known flag folds it away.
  const lambda = (depth: number): fc.Arbitrary<string> =>
    fc
      .tuple(fc.integer({ min: 0, max: 9 }), expr(depth - 1, true))
      .map(([k, rest]) => `(flag ? . : ${k}) + ${rest}`)

  it('prints residuals that parse and evaluate as the original does', () => {
    const env = bonsai()
    const full = { flag: false, n: 4, xs: [1, 2], ys: [3, 5] }
    fc.assert(
      fc.property(
        expr(4, false),
        fc.subarray(['flag', 'n'] as const),
        fc.boolean(),
        (source, knownNames, flag) => {
          const context = { ...full, flag }
          const known = Object.fromEntries(knownNames.map((name) => [name, context[name]]))
          const program = env.compile(source)
          const expected = outcome(() => program.evaluateSync(context))
          const result: PartialResult = program.partial(known)
          if (result.status === 'value') expect({ value: result.value }).toEqual(expected)
          else if (result.status === 'error') expect({ code: result.error.code }).toEqual(expected)
          else {
            expect(outcome(() => result.evaluateSync(context))).toEqual(expected)
            // The printed residual parses back to the same meaning.
            const reparsed = env.compile(result.source)
            expect(
              outcome(() => reparsed.evaluateSync({ ...context, ...result.bindings })),
            ).toEqual(expected)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe('host data failures during partial evaluation', () => {
  it('reports a throwing getter in the known data as HOST_ERROR', () => {
    const user = {
      get plan(): string {
        throw new Error('getter')
      },
    }
    expect(() => bonsai().compile('user.plan == "pro"').partial({ user })).toThrow(
      expect.objectContaining({ code: 'HOST_ERROR' }),
    )
  })

  it('reports a Proxy trap that throws while checking a listed path as HOST_ERROR', () => {
    const cart = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap')
        },
      },
    )
    expect(() =>
      bonsai()
        .compile('cart.coupon == "VIP"')
        .partial({ cart }, { unknown: ['cart.items.x'] }),
    ).toThrow(expect.objectContaining({ code: 'HOST_ERROR' }))
  })

  it('reports a throwing getter found by context validation as HOST_ERROR', () => {
    const env = bonsai({ variables: { user: t.object({ plan: t.string() }) } })
    const user = {
      get plan(): string {
        throw new Error('getter')
      },
    }
    expect(() => env.compile('user.plan == "pro"').partial({ user })).toThrow(
      expect.objectContaining({ code: 'HOST_ERROR' }),
    )
  })
})

describe('repeated partial evaluation of one program', () => {
  it('charges the same steps on every call', () => {
    const source = 'a.b.c + a.b.d + e.f.g > 1 && h'
    const known = { a: { b: { c: 1, d: 2 } } }
    const fits = (program: ReturnType<ReturnType<typeof bonsai>['compile']>, maxSteps: number) =>
      outcome(() => program.partial(known, { maxSteps }).status)
    // The smallest budget a first call needs, each call on a fresh program.
    let lowest = 1
    const residual = { value: 'residual' }
    while (lowest < 1000 && !isDeepStrictEqual(fits(bonsai().compile(source), lowest), residual))
      lowest++
    expect(lowest).toBeGreaterThan(1)
    // Later calls reuse the tree's dependencies, and need exactly as many.
    const program = bonsai().compile(source)
    expect(fits(program, lowest)).toEqual({ value: 'residual' })
    expect(fits(program, lowest - 1)).toEqual({ code: 'STEP_LIMIT' })
    expect(fits(program, lowest)).toEqual({ value: 'residual' })
  })
})

describe('timeouts', () => {
  it('accepts a fractional timeout as a limit, and only 0 as none', () => {
    const env = bonsai()
    expect(env.evaluateSync('1 + 1', {}, { timeout: 5_000.5 })).toBe(2)
    expect(env.compile('a + 1').partial({}, { timeout: 5_000.5 }).status).toBe('residual')
    expect(() => env.evaluateSync('1', {}, { timeout: -0.5 })).toThrow(RangeError)
    expect(() => env.evaluateSync('1', {}, { timeout: Number.NaN })).toThrow(RangeError)
    // A sub-millisecond budget still ends a long evaluation.
    const long = `${'xs.map(. * 2).filter(. > 0).sum() + '.repeat(50)}0`
    const xs = Array.from({ length: 10_000 }, (_, i) => i)
    expect(outcome(() => env.evaluateSync(long, { xs }, { timeout: 0.001 }))).toEqual({
      code: 'TIMEOUT',
    })
  })
})

describe('host contract messages', () => {
  it('says a host function returned undefined, not null', () => {
    const env = bonsai({
      functions: { margin: fn({ params: [], returns: t.number(), run: () => undefined as never }) },
    })
    expect(() => env.evaluateSync('margin()')).toThrow(/margin\(\) returned undefined/u)
  })
})

describe('the program cache', () => {
  it('evicts the least recently used program first, approximately', () => {
    const env = bonsai({ cacheSize: 2 })
    const a = env.compile('1')
    const b = env.compile('2')
    expect(env.compile('1')).toBe(a)
    env.compile('3')
    // `1` was used since it was added, so `2` goes first.
    expect(env.compile('1')).toBe(a)
    expect(env.compile('2')).not.toBe(b)
  })

  it('keeps a program it has just added, even in a cache of one', () => {
    const env = bonsai({ cacheSize: 1 })
    const a = env.compile('1')
    expect(env.compile('1')).toBe(a)
    const b = env.compile('2')
    expect(env.compile('2')).toBe(b)
  })
})
