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
            context: true,
            run: (ctx) => (typeof ctx.u === 'string' ? ctx.u : 'none'),
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
