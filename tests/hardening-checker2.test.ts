import { describe, expect, it } from 'vitest'
import { bonsai, fn, formatType, t, type Type } from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

const plan = t.enum('free', 'pro')
const zone = t.enum(...Array.from({ length: 300 }, (_, i) => `Z${i}`))

const env = bonsai({
  validateContext: true,
  variables: {
    c: t.boolean(),
    k: t.string(),
    plan,
    oplan: t.optional(plan),
    plans: t.list(plan),
    users: t.list(t.object({ plan })),
    tz: zone,
    otz: t.optional(zone),
    xs: t.list(t.number()),
    orders: t.list(t.object({ total: t.number() })),
    user: t.object({ name: t.string() }),
    acct: t.object({ id: t.number() }),
    m: t.object({ a: t.optional(t.object({ b: t.number() })) }),
    u: t.union(t.object({ a: t.number() }), t.object({ b: t.string() })),
    nested: t.union(t.union(t.number(), t.string()), t.null()),
  },
  functions: {
    setPlan: fn({ params: [plan], returns: t.string(), run: (p: string) => p }),
    setPlans: fn({
      params: [t.list(plan)],
      returns: t.number(),
      run: (p: readonly string[]) => p.length,
    }),
    setTz: fn({ params: [zone], returns: t.string(), run: (z: string) => z }),
  },
})

const context = {
  c: true,
  k: 'name',
  plan: 'pro',
  oplan: null,
  plans: ['pro', 'free'],
  users: [{ plan: 'free' }],
  tz: 'Z1',
  otz: null,
  xs: [1, 2, 3, 4, 5, 6, 7, 8],
  orders: [{ total: 5, id: 'o1' }],
  // Declared objects are open: extra keys may be present.
  user: { name: 'n', age: 'x' },
  acct: { id: 1, active: true },
  m: { a: { b: 1 } },
  u: { a: 1 },
  nested: 1,
} as const

function codes(source: string, expected?: Type): string[] {
  return env
    .check(source, expected === undefined ? undefined : { expect: expected })
    .diagnostics.map((d) => d.code)
}

function typeOf(source: string): string {
  const result = env.check(source)
  return result.type === undefined ? '-' : formatType(result.type)
}

describe('declared enums survive optional, nested, and generic positions', () => {
  it('compares an optional enum without spurious warnings', () => {
    expect(codes('oplan == "pro"')).toEqual([])
    expect(codes('oplan != "free"')).toEqual([])
    expect(codes('oplan in ["pro"]')).toEqual([])
    expect(codes('nested == 1')).toEqual([])
    expect(codes('oplan == "gold"')).toEqual(['ALWAYS_FALSE'])
  })

  it('flattens nested unions built with t.union and t.optional', () => {
    const optional = t.optional(plan) as Type
    expect(optional.kind === 'union' && optional.types.map((m) => m.kind)).toEqual([
      'literal',
      'literal',
      'null',
    ])
  })

  it('keeps enum element types through generic built-ins', () => {
    for (const source of [
      'setPlans(users.map(.plan))',
      'setPlans(plans.filter(. != "pro"))',
      'setPlans(plans.sort())',
      'setPlans(plans.unique())',
      'setPlans(plans.reverse())',
      'setPlans(plans + ["free"])',
      'setPlan(plans.first() ?? "free")',
      'setPlan(max(plans) ?? "free")',
      'setPlan(plans.at(0) ?? "pro")',
      'setPlan(reduce(plans, (a, p) => p, "free"))',
    ]) {
      expect(codes(source), source).toEqual([])
    }
    expect(codes('users.map(.plan)', t.list(plan))).toEqual([])
    expect(codes('setPlans(plans + ["gold"])')).toEqual(['NO_OVERLOAD'])
  })

  it('widens only the literals written in the source in a call result', () => {
    expect(typeOf('max(1, 2)')).toBe('number')
    expect(typeOf('xs.flatMap(. > 1 ? [.] : "x")')).toBe('(number | string)[]')
  })

  it('never widens a large declared enum', () => {
    for (const source of [
      'setTz(otz ?? tz)',
      'setTz(c ? tz : "Z0")',
      'setTz(try(tz, "Z0"))',
      'setTz(otz ?? "Z0")',
    ]) {
      expect(codes(source), source).toEqual([])
    }
    expect(codes('tz', zone)).toEqual([])
  })
})

describe('soundness', () => {
  it('gives up on a reduce accumulator that keeps growing, and checks the result at run time', () => {
    const shape = t.union(t.number(), t.object({ v: t.number() }))
    expect(codes('reduce(xs, (a, x) => {v: a}, 0)', shape)).toEqual([])
    const program = env.compile('reduce(xs, (a, x) => {v: a}, 0)', { expect: shape })
    expect(() => program.evaluateSync(context)).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })

  it('does not keep an exact map type when an open object joins it', () => {
    const source = 'values(reduce(orders, (b, o) => o.total > b.total ? o : b, {total: 0}))'
    expect(typeOf(source)).toBe('any[]')
    expect(env.evaluateSync(source, context)).toEqual([5, 'o1'])
    expect(typeOf('reduce(xs, (a, x) => user, {})[k]')).not.toBe('never | null')
    expect(env.evaluateSync('reduce(xs, (a, x) => user, {})[k]', context)).toBe('n')
  })

  it('treats keys only some open members declare as unknown in a spread', () => {
    const source = 'values({...(c ? acct : user)})'
    expect(typeOf(source)).toBe('any[]')
    expect(env.evaluateSync(source, context)).toEqual([1, true])
  })

  it('checks at run time a result an open object may not match', () => {
    const expected = t.object({ name: t.string(), age: t.optional(t.number()) })
    expect(codes('user', expected)).toEqual([])
    const program = env.compile('user', { expect: expected })
    expect(() => program.evaluateSync(context)).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
    expect(program.evaluateSync({ ...context, user: { name: 'n' } })).toEqual({ name: 'n' })
  })
})

describe('open objects passed to a parameter with optional fields', () => {
  const host = bonsai({
    variables: { user: t.object({ name: t.string() }) },
    functions: {
      greet: fn({
        params: [t.object({ name: t.string(), age: t.optional(t.number()) })],
        returns: t.number(),
        run: (u) => (u.age ?? 0) + 1,
      }),
    },
  })

  it('are accepted, and the argument is checked at run time', () => {
    expect(host.check('greet(user)').ok).toBe(true)
    expect(host.evaluateSync('greet(user)', { user: { name: 'n' } })).toBe(1)
    expect(host.evaluateSync('greet(user)', { user: { name: 'n', age: 4 } } as never)).toBe(5)
    expect(() =>
      host.evaluateSync('greet(user)', { user: { name: 'n', age: 'x' } } as never),
    ).toThrow(expect.objectContaining({ code: 'NO_OVERLOAD' }))
  })
})

describe('false positives', () => {
  it('indexes a union with a literal key like member access', () => {
    expect(codes('u.b')).toEqual([])
    expect(codes('u["b"]')).toEqual([])
    expect(typeOf('u["b"]')).toBe(typeOf('u.b'))
  })

  it('narrows the parents of a path has() proves', () => {
    expect(codes('has(m.a.b) ? m.a.b + 1 : 0')).toEqual([])
    expect(env.evaluateSync('has(m.a.b) ? m.a.b + 1 : 0', context)).toBe(2)
    expect(env.evaluateSync('has(m.a.b) ? m.a.b + 1 : 0', { ...context, m: { a: null } })).toBe(0)
  })
})

describe('the check budget bounds time', () => {
  const timed = (source: string): { ms: number; ok: boolean | string } => {
    const start = performance.now()
    let ok: boolean | string
    try {
      ok = env.check(source).ok
    } catch (error) {
      ok = (error as { code?: string }).code ?? 'threw'
    }
    return { ms: performance.now() - start, ok }
  }

  it('checks thousands of generated enum clauses', () => {
    const source = Array.from(
      { length: 2000 },
      (_, k) => `setTz(c ? tz : "Z${k % 300}") != ""`,
    ).join(' && ')
    expect(timed(source).ok).toBe(true)
  })

  it('stops pathological joins quickly', () => {
    const big = t.enum(...Array.from({ length: 5000 }, (_, i) => `E${i}`))
    const wide = bonsai({ variables: { c: t.boolean(), e: big } })
    const source = Array.from({ length: 200 }, (_, k) => `(c ? e : "X${k}") == "E1"`).join(' || ')
    const start = performance.now()
    let code: string | undefined
    try {
      wide.check(source)
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(['TOO_COMPLEX', undefined]).toContain(code)
    // A generous bound: unbudgeted, this shape takes minutes.
    expect(performance.now() - start).toBeLessThan(5000)
  })

  it('reports TOO_COMPLEX with the source when the budget runs out', () => {
    const zones = t.enum(...Array.from({ length: 5000 }, (_, i) => `Zone/${i}`))
    const zoned = bonsai({
      variables: { users: t.list(t.object({ home: t.optional(zones) })), tz: zones },
    })
    const clause = 'reduce(users, (acc, u) => u.home ?? acc, tz) != "Zone/1"'
    const source = Array.from({ length: 800 }, () => clause).join(' && ')
    let error: unknown
    try {
      zoned.compile(source)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'TOO_COMPLEX', source })
    expect((error as { formatted: string }).formatted).toContain('^')
    // check() reports it as a diagnostic instead of throwing.
    expect(zoned.check(source).diagnostics.map((d) => d.code)).toEqual(['LIMIT'])
    // The same clause, repeated reasonably, checks.
    expect(zoned.check(Array.from({ length: 50 }, () => clause).join(' && ')).ok).toBe(true)
  })
})

describe('language service', () => {
  const service = createLanguageService(
    bonsai({
      variables: {
        items: t.list(t.object({ 'k-k': t.number(), a: t.number() })),
        sl: t.union(t.list(t.string()), t.string()),
        user: t.object({ name: t.string() }),
        oplan: t.optional(plan),
        p: t.object({ plan: t.optional(plan) }),
      },
    }),
  )
  const labels = (source: string): string[] =>
    service.complete(source, source.length).items.map((item) => item.label)

  it('indexes a non-identifier key of the current item after its own dot', () => {
    const result = service.complete('items.map(.', 11)
    const item = result.items.find((i) => i.label === 'k-k')
    expect(item?.insertText).toBe('.["k-k"]')
    expect(item?.range).toEqual({ start: 10, end: 11 })
  })

  it('offers functions every member of a union receiver accepts', () => {
    expect(labels('sl.')).toEqual(expect.arrayContaining(['includes', 'slice', 'at', 'length']))
  })

  it('offers values and entries on declared objects', () => {
    expect(labels('user.')).toEqual(expect.arrayContaining(['name', 'values', 'entries']))
  })

  it('completes members after a comment following the dot', () => {
    expect(labels('user./* c */')).toContain('name')
    expect(labels('user. // c\n')).toContain('name')
  })

  it('offers the values of an optional enum', () => {
    expect(labels('oplan == "')).toEqual(['free', 'pro'])
    expect(labels('p.plan in ["')).toEqual(['free', 'pro'])
  })
})
