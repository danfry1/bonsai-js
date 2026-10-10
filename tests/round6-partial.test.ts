import { runInNewContext } from 'node:vm'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

/** A value or the code of the error evaluation raised. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

/** The value at a dotted path of a context, or null. */
function at(context: unknown, path: string): unknown {
  let value = context
  for (const key of path.split('.')) {
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined
  }
  return value ?? null
}

/** A call: true host function returning the context's value at a path. */
const cv = fn({
  params: [t.string()],
  returns: t.any(),
  call: true,
  run: (call, path) => at(call.context, path),
})

describe('residual bindings are the known values themselves', () => {
  class Money {
    readonly cents: number
    constructor(cents: number) {
      this.cents = cents
    }
    fmt(): string {
      return `$${this.cents / 100}`
    }
  }
  const describeIt = fn({
    params: [t.any(), t.any()],
    returns: t.any(),
    run: (value: unknown, suffix: unknown) => {
      if (value instanceof Money) return value.fmt() + String(suffix)
      if (Array.isArray(value))
        return `list${value.length}:${String((value as { extra?: unknown }).extra)}:${String(1 in value)}`
      return `${Object.getPrototypeOf(value) === null ? 'null-proto' : 'object'}:${String(suffix)}`
    },
  })
  const env = bonsai({ functions: { describeIt } })
  const program = env.compile('describeIt(k, n)')

  it('passes class instances, lists with holes, and null-prototype objects as they are', () => {
    const holes: unknown[] = [1]
    holes[2] = 3
    Object.assign(holes, { extra: 'E' })
    const cases = [new Money(150), holes, Object.assign(Object.create(null) as object, { a: 1 })]
    for (const k of cases) {
      const result = program.partial({ k }, { unknown: ['n'] })
      expect(result.status).toBe('residual')
      if (result.status !== 'residual') continue
      expect(result.evaluateSync({ n: '!' })).toEqual(program.evaluateSync({ k, n: '!' }))
    }
  })

  it('returns the known object itself where evaluation would', () => {
    const price = new Money(150)
    const choose = bonsai().compile('n > 0 ? price : null')
    const result = choose.partial({ price }, { unknown: ['n'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.evaluateSync({ n: 1 })).toBe(price)
    expect(Object.isFrozen(price)).toBe(false)
  })

  it('reads a large known object only where the expression does', () => {
    const prices: Record<string, number> = {}
    for (let i = 0; i < 200_000; i++) prices[`s${i}`] = i
    const lookup = bonsai().compile('prices[sku] ?? 0')
    const started = performance.now()
    const result = lookup.partial({ prices }, { unknown: ['sku'], maxSteps: 1000 })
    expect(performance.now() - started).toBeLessThan(200)
    expect(result.status).toBe('residual')
    if (result.status === 'residual') expect(result.evaluateSync({ sku: 's5' })).toBe(5)
  })
})

describe('call: true residuals read the context they are given', () => {
  const env = bonsai({ functions: { cv } })

  it('require every variable known to partial(), before any host code runs', async () => {
    let calls = 0
    const hasFeature = fn({
      params: [t.string()],
      returns: t.boolean(),
      call: true,
      run: (call, name) => {
        calls++
        const tenant = call.context.tenant as { features?: string[] } | undefined
        return (tenant?.features ?? []).includes(name)
      },
    })
    const program = bonsai({ functions: { hasFeature } }).compile(
      'order.total > 100 && hasFeature("bulk")',
    )
    const tenant = { id: 't1', features: ['bulk'] }
    const result = program.partial({ tenant })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.dependsOn).toEqual(['order.total'])
    expect(result.readsContext).toBe(true)
    const partOnly = { order: { total: 200 } }
    expect(outcome(() => result.evaluateSync(partOnly))).toEqual({ code: 'INVALID_CONTEXT' })
    await expect(result.evaluate(partOnly)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' })
    expect(result.explainSync(partOnly).ok).toBe(false)
    expect(calls).toBe(0)
    expect(result.evaluateSync({ order: { total: 200 }, tenant })).toBe(true)
  })

  it('do not require a variable listed whole as unknown', () => {
    const result = env
      .compile('cv("user.plan")')
      .partial({ user: { plan: 'x' } }, { unknown: ['user'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.evaluateSync({})).toBe(null)
  })

  it('run no getter the expression does not read', () => {
    const result = env.compile('cv("user.a") + n').partial({ user: { a: 1 } }, { unknown: ['n'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    let reads = 0
    const user = {
      a: 1,
      get secret(): number {
        reads++
        throw new Error('not read')
      },
    }
    expect(result.evaluateSync({ user, n: 1 })).toBe(2)
    expect(reads).toBe(0)
  })

  it('see non-enumerable keys and objects from another realm as evaluation does', () => {
    const program = env.compile('[cv("user.age"), user.plan]')
    const result = program.partial({ user: { age: 30, plan: 'old' } }, { unknown: ['user.plan'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    const hidden = Object.defineProperty({ plan: 'pro' }, 'age', { value: 30, enumerable: false })
    expect(result.evaluateSync({ user: hidden })).toEqual(program.evaluateSync({ user: hidden }))
    const foreign = runInNewContext('({ plan: "pro", age: 30 })') as object
    expect(result.evaluateSync({ user: foreign })).toEqual([30, 'pro'])
  })
})

describe('validateContext with partial evaluation', () => {
  it('validates the known data partial() folds in, all but the listed unknown paths', () => {
    const env = bonsai({
      variables: { user: t.object({ roles: t.list(t.string()), risk: t.number() }) },
      validateContext: true,
    })
    const program = env.compile('"admin" in user.roles && user.risk < 5')
    const folded = program.partial({ user: { roles: 'superadmin', risk: 0 } } as never, {
      unknown: ['user.risk'],
    })
    expect(folded.status).toBe('error')
    if (folded.status === 'error') expect(folded.error.code).toBe('INVALID_CONTEXT')
    // The listed path itself is not checked: it is incomplete by design.
    const listed = program.partial({ user: { roles: ['admin'], risk: 'later' } } as never, {
      unknown: ['user.risk'],
    })
    expect(listed.status).toBe('residual')
  })

  it('validates the whole context of a residual whose call: true functions read it', () => {
    const tierOf = fn({
      params: [],
      returns: t.string(),
      call: true,
      run: (call) => String((call.context.org as { tier: unknown }).tier).toUpperCase(),
    })
    const env = bonsai({
      variables: { org: t.object({ tier: t.string() }), user: t.object({ id: t.string() }) },
      validateContext: true,
      functions: { tierOf },
    })
    const result = env.compile('user.id == "x" || tierOf() == "GOLD"').partial({
      org: { tier: 'gold' },
    })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.dependsOn).toEqual(['user.id'])
    const wrong: unknown = { user: { id: 'y' }, org: { tier: ['gold'] } }
    expect(outcome(() => result.evaluateSync(wrong as never))).toEqual({ code: 'INVALID_CONTEXT' })
    expect(result.evaluateSync({ user: { id: 'y' }, org: { tier: 'gold' } })).toBe(true)
  })

  it('validates only the paths a residual reads, typed through optional parents, records, and unions', () => {
    const env = bonsai({
      variables: {
        user: t.optional(t.object({ risk: t.number() })),
        order: t.object({ items: t.list(t.object({ price: t.number() })) }),
        tiers: t.record(t.number()),
        shape: t.union(t.object({ r: t.number() }), t.object({ r: t.string() })),
        k: t.number(),
      },
      validateContext: true,
    })
    const program = env.compile(
      '(user.risk ?? 0) + (order.items[k].price ?? 0) + (tiers.gold ?? 0) + (shape.r == "x" ? 1 : 0)',
    )
    const result = program.partial({ k: 1 })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.dependsOn).toEqual(['order.items', 'shape.r', 'tiers.gold', 'user.risk'])
    const context = { order: { items: [{ price: 2 }, { price: 3 }] }, tiers: {}, shape: { r: 'x' } }
    expect(result.evaluateSync(context)).toBe(program.evaluateSync({ ...context, k: 1 }))
    const wrongs: unknown[] = [
      { ...context, user: { risk: 'high' } },
      { ...context, tiers: { gold: 'x' } },
      { ...context, shape: { r: true } },
      { ...context, order: { items: 'none' } },
    ]
    for (const wrong of wrongs)
      expect(outcome(() => result.evaluateSync(wrong as never))).toEqual({
        code: 'INVALID_CONTEXT',
      })
  })
})

describe('partial residual differential property', () => {
  const env = bonsai({
    variables: {
      user: t.object({ plan: t.string(), age: t.optional(t.number()), tags: t.list(t.string()) }),
      org: t.object({ tier: t.string(), pct: t.number() }),
      n: t.number(),
    },
    validateContext: true,
    functions: { cv },
  })
  const SOURCES = [
    'user.plan == "pro" && (user.age ?? 0) > n',
    'org.tier == "gold" ? user.tags.length : org.pct + n',
    '"vip" in user.tags || org.pct > n',
    'cv("org.tier") == "gold" && user.plan == "pro"',
    '[user.plan, org.tier, n, cv("user.plan")]',
    '{...org, n: n}.pct',
  ]
  const VARIABLES = ['user', 'org', 'n'] as const
  const UNKNOWN = ['user', 'user.plan', 'user.age', 'user.tags', 'org', 'org.tier', 'org.pct', 'n']
  const scenario = fc.record({
    source: fc.constantFrom(...SOURCES),
    plan: fc.constantFrom('pro', 'free'),
    age: fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }),
    tags: fc.subarray(['vip', 'new', 'old']),
    tier: fc.constantFrom('gold', 'silver'),
    pct: fc.integer({ min: 0, max: 100 }),
    n: fc.integer({ min: 0, max: 100 }),
    known: fc.subarray([...VARIABLES]),
    unknown: fc.option(fc.subarray(UNKNOWN), { nil: undefined }),
  })

  it('agrees with evaluation of the full context, and of dependsOn alone when it can', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const user = { plan: s.plan, tags: s.tags, ...(s.age === undefined ? {} : { age: s.age }) }
        const full = { user, org: { tier: s.tier, pct: s.pct }, n: s.n }
        const program = env.compile(s.source)
        const expected = outcome(() => program.evaluateSync(full))
        const known = Object.fromEntries(s.known.map((name) => [name, full[name]]))
        // An explicit list says what is unknown; the variables left out of `known` are.
        const unknown =
          s.unknown === undefined
            ? undefined
            : [...s.unknown, ...VARIABLES.filter((name) => !s.known.includes(name))]
        const result = program.partial(known, unknown === undefined ? undefined : { unknown })
        if (result.status === 'value') return isEqual({ value: result.value }, expected)
        if (result.status === 'error') return isEqual({ code: result.error.code }, expected)
        expect(outcome(() => result.evaluateSync(full))).toEqual(expected)
        if (!result.readsContext) {
          const minimal: Record<string, unknown> = {}
          for (const path of result.dependsOn) {
            const segments = path.split('.')
            let from: unknown = full
            let to = minimal
            segments.forEach((segment, i) => {
              from = (from as Record<string, unknown> | undefined)?.[segment]
              if (i === segments.length - 1) {
                if (from !== undefined) to[segment] = from
              } else {
                to[segment] ??= {}
                to = to[segment] as Record<string, unknown>
              }
            })
          }
          expect(outcome(() => result.evaluateSync(minimal as never))).toEqual(expected)
        }
        return true
      }),
      { numRuns: 2000, seed: 6 },
    )
  })
})

function isEqual(a: unknown, b: unknown): boolean {
  expect(a).toEqual(b)
  return true
}
