import { describe, expect, it } from 'vitest'
import { bonsai, fn, t, type PartialResult } from '../src/index.js'

const env = bonsai({
  variables: {
    user: t.object({
      plan: t.enum('free', 'pro'),
      age: t.number(),
      country: t.string(),
      riskScore: t.number(),
    }),
    order: t.object({
      total: t.number(),
      status: t.string(),
      items: t.list(t.object({ sku: t.string(), qty: t.number() })),
    }),
    limits: t.object({ minTotal: t.number() }),
  },
})
const user = { plan: 'pro' as const, age: 30, country: 'DE', riskScore: 70 }
const order = { total: 150, status: 'paid', items: [{ sku: 'a', qty: 3 }] }

const residualSource = (result: PartialResult<unknown>): string => {
  if (result.status !== 'residual') throw new Error(`expected a residual, got ${result.status}`)
  return result.source
}

describe('partial', () => {
  it('returns the value when the known data decides it', () => {
    const rule = env.compile('user.plan == "pro" && order.total > limits.minTotal')
    expect(rule.partial({ user: { ...user, plan: 'free' }, limits: { minTotal: 100 } })).toEqual({
      status: 'value',
      value: false,
    })
  })

  it('returns a residual that needs only the unknown data', () => {
    const rule = env.compile('user.plan == "pro" && order.total > limits.minTotal')
    const result = rule.partial({ user, limits: { minTotal: 100 } })
    expect(residualSource(result)).toBe('order.total > 100')
    expect(result.status === 'residual' && result.dependsOn).toEqual(['order.total'])
    expect(result.status === 'residual' && result.evaluateSync({ order })).toBe(true)
  })

  it('treats dotted paths as unknown, and unknown wins over known values', () => {
    const rule = env.compile('user.age >= 18 && user.riskScore < 50 && order.status == "paid"')
    const result = rule.partial({ user }, { unknown: ['user.riskScore', 'order'] })
    expect(residualSource(result)).toBe('user.riskScore < 50 && order.status == "paid"')
  })

  it('folds constants into lambdas while the item stays symbolic', () => {
    const rule = env.compile('order.items.filter(.qty > limits.minTotal).length > 0')
    expect(residualSource(rule.partial({ limits: { minTotal: 2 } }))).toBe(
      'order.items.filter(.qty > 2).length > 0',
    )
    const constant = bonsai().compile('xs.map(k ?? .id)')
    const result = constant.partial({ k: 1 })
    expect(residualSource(result)).toBe('xs.map(__item => 1)')
    expect(result.status === 'residual' && result.evaluateSync({ xs: [{}, {}] })).toEqual([1, 1])
  })

  it('evaluates let bindings and removes them', () => {
    const rule = env.compile('let min = limits.minTotal * 2; order.total > min ? "big" : "small"')
    expect(residualSource(rule.partial({ limits: { minTotal: 50 } }))).toBe(
      'order.total > 100 ? "big" : "small"',
    )
  })

  it('keeps known values that are not short primitives as bindings', () => {
    const tiers = { gold: 1000, silver: 500 }
    const rule = bonsai().compile('order.total > tiers[level]')
    const result = rule.partial({ tiers, level: 'gold' })
    expect(residualSource(result)).toBe('order.total > 1000')
    const list = bonsai()
      .compile('order.sku in allowed')
      .partial({ allowed: ['a', 'b'] })
    expect(list.status === 'residual' && list.source).toBe('order.sku in __known1')
    expect(list.status === 'residual' && list.bindings).toEqual({ __known1: ['a', 'b'] })
    expect(list.status === 'residual' && list.evaluateSync({ order: { sku: 'b' } })).toBe(true)
  })

  it('simplifies && and || only when the result is exact', () => {
    const open = bonsai()
    expect(residualSource(open.compile('known && x').partial({ known: true }))).toBe('true && x')
    expect(residualSource(open.compile('known && x > 1').partial({ known: true }))).toBe('x > 1')
    expect(residualSource(open.compile('x > 1 && known').partial({ known: false }))).toBe(
      'x > 1 && false',
    )
    expect(residualSource(open.compile('x == "a" && known').partial({ known: false }))).toBe(
      'x == "a" && false',
    )
    expect(open.compile('known || x').partial({ known: true })).toEqual({
      status: 'value',
      value: true,
    })
  })

  it('keeps expressions that fail, so the error happens when evaluation reaches them', () => {
    const rule = bonsai().compile('x > 5 || age / 0 > 1')
    const result = rule.partial({ age: 30 })
    expect(residualSource(result)).toBe('x > 5 || age / 0 > 1')
    expect(result.status === 'residual' && result.evaluateSync({ x: 10, age: 30 })).toBe(true)
    expect(() => result.status === 'residual' && result.evaluateSync({ x: 1, age: 30 })).toThrow(
      /Division by zero/u,
    )
  })

  it('reports errors that happen whatever the unknown data is', () => {
    const result = bonsai().compile('age / 0 > 1 && x').partial({ age: 1 })
    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.error.code).toBe('DIVISION_BY_ZERO')
  })

  it('leaves now() and host functions in the residual unless allowed', () => {
    let calls = 0
    const host = bonsai({
      functions: {
        score: fn({ params: [t.string()], returns: t.number(), run: () => (calls++, 7) }),
      },
    })
    const rule = host.compile('score(id) > threshold && now() > since')
    const result = rule.partial({ id: 'a', since: new Date('2020-01-01T00:00:00Z') })
    expect(residualSource(result)).toBe('score("a") > threshold && now() > __known1')
    expect(calls).toBe(0)
    const allowed = rule.partial(
      { id: 'a', threshold: 5, since: new Date('2020-01-01T00:00:00Z') },
      {
        callHostFunctions: true,
        now: new Date('2026-01-01T00:00:00Z'),
      },
    )
    expect(allowed).toEqual({ status: 'value', value: true })
    expect(calls).toBe(1)
  })

  it('does not treat has() on an unknown path as known', () => {
    const result = bonsai()
      .compile('has(user.email) && known')
      .partial({ known: true }, { unknown: ['user.email'] })
    expect(residualSource(result)).toBe('has(user.email)')
  })

  it('respects let bindings that shadow unknown variables', () => {
    const result = bonsai()
      .compile('let order = { total: 5 }; order.total > limit')
      .partial({ limit: 1 }, { unknown: ['order'] })
    expect(result).toEqual({ status: 'value', value: true })
  })

  it('stops with a limit error instead of guessing', () => {
    const limited = bonsai({ limits: { maxSteps: 50 } })
    const xs = Array.from({ length: 1000 }, (_, i) => i)
    expect(() => limited.compile('xs.map(. * 2).length > n').partial({ xs })).toThrow(
      expect.objectContaining({ code: 'STEP_LIMIT' }),
    )
  })

  it('does not run getters in the residual context while merging bindings', () => {
    let reads = 0
    const result = bonsai()
      .compile('order.total > 1 && allowed.length > 0')
      .partial({ allowed: ['a'] })
    const context = {
      get order(): { total: number } {
        reads++
        return { total: 5 }
      },
    }
    expect(result.status === 'residual' && result.evaluateSync(context)).toBe(true)
    expect(reads).toBe(1)
  })

  it('evaluates residuals asynchronously too', async () => {
    const result = bonsai().compile('order.total > limit').partial({ limit: 1 })
    await expect(
      result.status === 'residual'
        ? result.evaluate({ order: { total: 2 } })
        : Promise.reject(new Error('no')),
    ).resolves.toBe(true)
  })

  describe('review findings', () => {
    const agree = (
      source: string,
      known: Record<string, unknown>,
      full: Record<string, unknown>,
    ): void => {
      const program = bonsai().compile(source)
      const outcome = (f: () => unknown): unknown => {
        try {
          return { value: f() }
        } catch (error) {
          return { code: (error as { code: string }).code }
        }
      }
      const expected = outcome(() => program.evaluateSync(full))
      const result = program.partial(known)
      let actual: unknown
      if (result.status === 'value') actual = { value: result.value }
      else if (result.status === 'error') actual = { code: result.error.code }
      else actual = outcome(() => result.evaluateSync(full))
      expect(actual, source).toEqual(expected)
    }

    it('does linear work on nested conditionals and charges steps', () => {
      const nested = Array.from({ length: 40 }).reduce<string>(
        (acc) => `(${acc} ? true : false)`,
        'u',
      )
      const started = performance.now()
      bonsai().compile(nested).partial({})
      expect(performance.now() - started).toBeLessThan(500)
      expect(() =>
        bonsai({ limits: { maxSteps: 20 } })
          .compile(nested)
          .partial({}),
      ).toThrow(expect.objectContaining({ code: 'STEP_LIMIT' }))
    })

    it('rewrites locals inside has()', () => {
      agree('let tags = t; has(tags[i])', { t: ['a', 'b'] }, { t: ['a', 'b'], i: 1 })
      agree('let user = k; has(user[i])', { k: { a: 1 } }, { k: { a: 1 }, user: {}, i: 'a' })
    })

    it('does not fold a comparison that can fail', () => {
      agree('u.a == 1 || true', {}, { u: 'str' })
      agree('u.a != 1 && false', {}, { u: 5 })
    })

    it('never lets a binding name collide with a local', () => {
      agree('let __known1 = u; [__known1, xs]', { xs: [1, 2] }, { xs: [1, 2], u: 9 })
      agree('map(u, (__known1) => [__known1, xs])', { xs: [1, 2] }, { xs: [1, 2], u: [7] })
      agree('map(xs, (__item) => map(ys, k ?? .))', { k: 7 }, { k: 7, xs: [1], ys: [2, 3] })
    })

    it('knows that x?.f(...) skips its arguments when x is null', () => {
      const known = { name: null, limit: 5, count: 0 }
      agree('name?.slice(limit / count, u)', known, { ...known, u: 1 })
      agree('try(name?.slice(limit / count, u), "fb")', known, { ...known, u: 1 })
      agree(
        'name?.slice(limit / count, u)',
        { limit: 5, count: 0 },
        { name: 'abc', limit: 5, count: 0, u: 1 },
      )
    })

    it('does not call context or async host functions with partial data', async () => {
      const host = bonsai({
        functions: {
          tenant: fn({
            params: [],
            returns: t.string(),
            call: true,
            run: (call) => (typeof call.context.u === 'string' ? call.context.u : 'none'),
          }),
          aget: fn({
            params: [t.number()],
            returns: t.number(),
            async: true,
            run: (x) => Promise.resolve(x + 1),
          }),
        },
      })
      const tenant = host
        .compile('tenant() == "acme" && k')
        .partial({ k: true }, { callHostFunctions: true })
      expect(tenant.status === 'residual' && tenant.evaluateSync({ k: true, u: 'acme' })).toBe(true)
      const asyncCall = host
        .compile('try(aget(k), 0) + u')
        .partial({ k: 1 }, { callHostFunctions: true })
      expect(asyncCall.status).toBe('residual')
      await expect(
        asyncCall.status === 'residual' ? asyncCall.evaluate({ k: 1, u: 10 }) : 0,
      ).resolves.toBe(12)
    })

    it('reports dependencies without binding paths', () => {
      const result = bonsai()
        .compile('let o = obj; u ? 1 : o.a.b')
        .partial({ obj: { a: 5 } })
      expect(result.status === 'residual' && result.dependsOn).toEqual(['u'])
    })
  })
})

describe('partial on the hardened engine', () => {
  const open = bonsai()

  it('folds long chains with many unknowns quickly', () => {
    const program = open.compile(Array.from({ length: 9900 }, (_, i) => `v${i}`).join(' && '))
    const unknown = Array.from({ length: 10_000 }, (_, i) => `u${i}`)
    const start = performance.now()
    expect(program.partial({}).status).toBe('residual')
    program.partial({}, { unknown })
    // Unindexed, this took seconds.
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('applies expect to decided results and residuals', () => {
    const decided = open.compile('x', { expect: t.number() }).partial({ x: 'str' })
    expect(decided).toMatchObject({ status: 'error', error: { code: 'TYPE_ERROR' } })
    const result = open
      .compile('x ?? y', { expect: t.number() })
      .partial({ x: null }, { unknown: ['y'] })
    expect(result.status).toBe('residual')
    if (result.status === 'residual') {
      expect(() => result.evaluateSync({ y: 'str' })).toThrow(
        expect.objectContaining({ code: 'TYPE_ERROR' }),
      )
      expect(result.evaluateSync({ y: 2 })).toBe(2)
    }
  })

  it('never lets try() swallow a host contract violation', () => {
    const hosted = bonsai({
      functions: {
        f: fn({ params: [], returns: t.number(), run: () => 'bad' as unknown as number }),
      },
    })
    const program = hosted.compile('try(f() + u, 0)')
    expect(() => program.evaluateSync({ u: 1 })).toThrow(
      expect.objectContaining({ code: 'HOST_CONTRACT' }),
    )
    const result = program.partial({}, { unknown: ['u'], callHostFunctions: true })
    expect(result).toMatchObject({ status: 'error', error: { code: 'HOST_CONTRACT' } })
  })

  it('reports unreadable host data as Bonsai errors', () => {
    // Only the variables the expression reads are read from `known`.
    const hostile = new Proxy(
      { x: 1 },
      {
        get() {
          throw new Error('get trap')
        },
      },
    )
    for (const options of [{ unknown: ['y'] }, {}]) {
      expect(() => open.compile('x + y').partial(hostile, options)).toThrow(
        expect.objectContaining({ code: 'HOST_ERROR' }),
      )
    }
    const result = open.compile('x + y').partial({ x: 1 })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(() => result.evaluateSync(new Map([['y', 1]]) as never)).toThrow(TypeError)
    const unreadable = new Proxy(
      { y: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap')
        },
      },
    )
    expect(() => result.evaluateSync(unreadable)).toThrow(
      expect.objectContaining({ code: 'HOST_ERROR' }),
    )
  })

  it('validates options like the other APIs', () => {
    const program = open.compile('now() > x')
    const run = (options: unknown): void => {
      program.partial({}, options as never)
    }
    for (const options of [
      null,
      { unknwon: ['x'] },
      { unknown: 'x' },
      { unknown: [1] },
      { callHostFunctions: 'yes' },
      { now: new Date(Number.NaN) },
      { now: 'tomorrow' },
      { now: Object.create(Date.prototype) },
    ]) {
      expect(
        () => {
          run(options)
        },
        String(Object.keys(options ?? {})),
      ).toThrow(TypeError)
    }
  })
})

describe('partial residuals evaluate as the program does', () => {
  const residualOf = <R>(result: PartialResult<R>) => {
    if (result.status !== 'residual') throw new Error(`expected a residual, got ${result.status}`)
    return result
  }

  it('resolves overloads with the declared types', () => {
    const typed = bonsai({ variables: { xs: t.list(t.duration()), k: t.number() } })
    const context = { xs: [], k: 1 }
    const sum = typed.compile('xs.sum()')
    expect(String(sum.evaluateSync(context))).toBe('PT0S')
    expect(
      String(residualOf(sum.partial({ k: 1 }, { unknown: ['xs'] })).evaluateSync(context)),
    ).toBe('PT0S')
    const plus = typed.compile('xs.sum() + hours(k)')
    expect(String(residualOf(plus.partial({ k: 1 })).evaluateSync(context))).toBe('PT1H')
  })

  it('keeps the static type of a known value it refers to by name', () => {
    const typed = bonsai({ variables: { ds: t.list(t.duration()), xs: t.list(t.duration()) } })
    const program = typed.compile('(ds + xs).sum()')
    const result = residualOf(program.partial({ ds: [] }))
    expect(Object.keys(result.bindings)).toEqual(['__known1'])
    expect(String(result.evaluateSync({ ds: [], xs: [] }))).toBe('PT0S')
  })

  it('runs each call with the overload the original chose, even when folding narrows it', () => {
    const typed = bonsai({
      variables: { b: t.boolean(), a: t.any(), ds: t.list(t.duration()), ns: t.list(t.number()) },
    })
    // The original sums a list that may hold numbers or durations, so an empty
    // one sums to 0; the residual ds.sum() must not switch to the duration overload.
    const branch = typed.compile('(b ? ds : ns).sum()')
    const residual = residualOf(branch.partial({ b: true }))
    expect(residual.source).toBe('ds.sum()')
    expect(residual.evaluateSync({ b: true, ds: [], ns: [] })).toBe(0)
    expect(branch.evaluateSync({ b: true, ds: [], ns: [] })).toBe(0)
    const fallback = typed.compile('(a ?? ds).sum()')
    expect(residualOf(fallback.partial({ a: null })).evaluateSync({ a: null, ds: [] })).toBe(0)
  })

  it('keeps the original overloads in an open environment', () => {
    const program = bonsai().compile('(n > 0 ? [hours(k)].filter(v => v > hours(9)) : []).sum()')
    expect(String(program.evaluateSync({ n: 1, k: 1 }))).toBe('PT0S')
    expect(String(residualOf(program.partial({ k: 1 })).evaluateSync({ n: 1, k: 1 }))).toBe('PT0S')
  })

  it('applies evaluation options', async () => {
    const program = bonsai().compile('xs.map(. * 2).sum() + k')
    const result = residualOf(program.partial({ k: 1 }, { unknown: ['xs'] }))
    expect(() => result.evaluateSync({ xs: [1, 2, 3] }, { maxSteps: 2 })).toThrow(
      expect.objectContaining({ code: 'STEP_LIMIT' }),
    )
    const aborted = AbortSignal.abort()
    await expect(result.evaluate({ xs: [1] }, { signal: aborted })).rejects.toMatchObject({
      code: 'ABORTED',
    })
    expect(() => result.evaluateSync({ xs: [1] }, { maxSteps: -1 })).toThrow(RangeError)
  })

  it('passes context functions the caller context, prototype included', () => {
    class Session {
      readonly n = 1
      readonly ys = [1]
      can(role: string): boolean {
        return role === 'admin'
      }
    }
    const host = bonsai({
      functions: {
        can: fn({
          params: [t.string()],
          returns: t.boolean(),
          call: true,
          run: (call, role) => (call.context as unknown as Session).can(role),
        }),
      },
    })
    const program = host.compile('can("admin") && n in ys')
    const session = new Session()
    expect(program.evaluateSync(session)).toBe(true)
    expect(residualOf(program.partial({ ys: [1] })).evaluateSync(session)).toBe(true)
  })

  it('validates the known variables when validateContext is on', () => {
    const strictEnv = bonsai({
      variables: {
        user: t.object({ age: t.number(), riskScore: t.number() }),
        order: t.object({ total: t.number() }),
      },
      validateContext: true,
    })
    const program = strictEnv.compile('user.age > 30 && order.total > user.riskScore')
    const bad = program.partial({ user: { age: '36', riskScore: 1 } } as never)
    expect(bad.status === 'error' && bad.error.code).toBe('INVALID_CONTEXT')
    // A variable with an unknown path inside it is incomplete by design.
    const partlyKnown = program.partial(
      { user: { age: 40 } },
      {
        unknown: ['order', 'user.riskScore'],
      },
    )
    expect(residualOf(partlyKnown).source).toBe('order.total > user.riskScore')
  })
})

describe('residuals read the caller context as it is', () => {
  const open = bonsai()

  it('runs context getters on the caller object, with or without bindings', () => {
    const secret = new WeakMap<object, number>()
    const context = {}
    Object.defineProperty(context, 'age', {
      enumerable: true,
      get(this: object) {
        return secret.get(this)
      },
    })
    secret.set(context, 30)
    for (const source of ['age > limit', 'age > limit && "x" in tags']) {
      const result = open.compile(source).partial({ limit: 18, tags: ['x', 'y'] })
      if (result.status !== 'residual') throw new Error('expected a residual')
      expect(result.evaluateSync(context), source).toBe(true)
    }
  })

  it('keeps bindings ahead of a context key with the same name', () => {
    const result = open.compile('n in tags').partial({ tags: ['x', 'y'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    const [name] = Object.keys(result.bindings)
    expect(name).toBeDefined()
    expect(result.evaluateSync({ n: 'x', [name]: ['other'] })).toBe(true)
  })
})
