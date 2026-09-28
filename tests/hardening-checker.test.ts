import { describe, expect, it } from 'vitest'
import { bonsai, fn, formatType, t, type Type } from '../src/index.js'
import { lastTypeWork } from '../src/types.js'
import { createLanguageService } from '../src/service/index.js'

const plan = t.enum('free', 'pro')

const env = bonsai({
  strict: true,
  validateContext: true,
  variables: {
    plan,
    c: t.boolean(),
    n: t.optional(t.string()),
    xs: t.list(t.optional(t.number())),
    ns: t.list(t.number()),
    ss: t.list(t.string()),
    on: t.optional(t.list(t.number())),
    un: t.union(t.list(t.number()), t.list(t.string())),
    nd: t.union(t.number(), t.duration()),
    sl: t.union(t.string(), t.list(t.string())),
    m: t.object({ a: t.optional(t.object({ b: t.number() })) }),
    user: t.object({ name: t.string() }),
    r: t.record(t.number()),
    anyv: t.any(),
  },
  functions: {
    pick: fn({ params: [], returns: plan, run: () => 'pro' as const }),
    setPlans: fn({ params: [t.list(plan)], returns: t.boolean(), run: () => true }),
    setUser: fn({ params: [t.object({ plan })], returns: t.boolean(), run: () => true }),
    tags: fn({ params: [t.record(t.string())], returns: t.number(), run: () => 1 }),
    needA: fn({ params: [t.object({ a: t.number() })], returns: t.number(), run: () => 1 }),
    two: fn({
      params: [t.string(), t.string()],
      returns: t.string(),
      run: (a: string, b: string) => a + b,
    }),
  },
})

const context = {
  plan: 'pro',
  c: true,
  n: null,
  xs: [1, null],
  ns: [1, 2, 3],
  ss: ['a', 'b'],
  on: [1],
  un: [1],
  nd: 2,
  sl: 'abc',
  m: { a: { b: 1 } },
  // Declared objects are open: a record from a database carries more columns.
  user: { name: 'n', age: 5 },
  r: { a: 1 },
  anyv: 3,
} as const

function codes(source: string, expected?: Type): string[] {
  return env
    .check(source, expected === undefined ? undefined : { expect: expected })
    .diagnostics.map((d) => d.code)
}

function typeOf(source: string): string {
  const result = env.check(source)
  return result.type === undefined ? 'none' : formatType(result.type)
}

describe('checking time is bounded', () => {
  const open = bonsai({ variables: { c: t.boolean() } })

  function timed(run: () => unknown): number {
    const start = performance.now()
    run()
    return performance.now() - start
  }

  /** Checker work units at n and 4n: deterministic, so no timing noise. */
  function workGrowth(check: (n: number) => unknown, n: number): number {
    check(n)
    const small = lastTypeWork()
    check(4 * n)
    return lastTypeWork() / Math.max(small, 1)
  }

  it('does not expand shared types (let-bound maps nested in maps)', () => {
    const parts = ['let v0 = 1;']
    for (let i = 1; i <= 40; i++) parts.push(`let v${i} = {x: v${i - 1}, y: v${i - 1}};`)
    const lets = parts.join(' ')
    // Expanding the shared types would take 2^40 steps; bounded work takes milliseconds.
    expect(timed(() => open.check(`${lets} c ? v40 : 1`))).toBeLessThan(5000)
    const failed = open.check(`${lets} v40 + 1`)
    expect(failed.diagnostics[0]?.code).toBe('TYPE_ERROR')
    // Type text in messages is capped.
    expect(failed.diagnostics[0]?.message.length).toBeLessThan(2500)
    expect(failed.diagnostics[0]?.message).toContain('…')
  })

  it('does near-linear checker work on long chains', () => {
    const plain = bonsai({ limits: { maxSourceLength: 2_000_000, maxNodes: 1_000_000 } })
    const and = (n: number): string => Array.from({ length: n }, (_, i) => `x${i}`).join(' && ')
    const nullish = (n: number): string =>
      Array.from({ length: n }, (_, i) => String(i)).join(' ?? ')
    const maps = (n: number): string =>
      `[${Array.from({ length: n }, (_, i) => `{k${i}: ${i}}`).join(', ')}]`
    for (const [make, n] of [
      [and, 8000],
      [nullish, 6000],
      [maps, 5000],
    ] as const) {
      // About 4 when linear, 16 when quadratic.
      expect(workGrowth((size) => plain.check(make(size)), n)).toBeLessThan(5)
    }
  })

  it('handles wide enums without quadratic unions', () => {
    const values = (prefix: string): string[] =>
      Array.from({ length: 5000 }, (_, i) => `${prefix}${i}`)
    const wide = bonsai({
      variables: {
        a: t.optional(t.number()),
        e: t.enum(...values('a')),
        f: t.enum(...values('b')),
      },
    })
    const enumOf = (n: number, prefix: string): Type => t.enum(...values(prefix).slice(0, n))
    const join = (n: number): unknown =>
      bonsai({
        variables: { a: t.optional(t.number()), e: enumOf(n, 'a'), f: enumOf(n, 'b') },
      }).check('a == null ? e : f')
    expect(workGrowth(join, 1250)).toBeLessThan(5)
    const compared = wide.check('e == f')
    expect(compared.diagnostics.map((d) => d.code)).toEqual(['ALWAYS_FALSE'])
    expect(compared.diagnostics[0]?.message.length).toBeLessThan(2500)
  })

  it('fails with a limit error rather than running long', () => {
    // Nested reduce whose accumulators keep widening re-checks lambdas; the
    // work budget stops a pathological nesting cleanly.
    let source = 'x'
    for (let i = 0; i < 30; i++) source = `reduce(xs, (a${i}, v${i}) => [a${i}, ${source}], [])`
    const nested = bonsai()
    const start = performance.now()
    const result = nested.check(source)
    expect(performance.now() - start).toBeLessThan(10_000)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('LIMIT')
  })
})

describe('declared objects are open (extra keys at run time)', () => {
  it('reads values, entries, and dynamic keys of a declared object as unknown', () => {
    expect(typeOf('values(user)')).toBe('any[]')
    expect(typeOf('entries(user)')).toBe('{ key: string, value: any }[]')
    expect(typeOf('user[n ?? "name"]')).toBe('any')
    expect(env.evaluateSync('values(user)', context)).toEqual(['n', 5])
  })

  it('keeps precise types for map literals, which hold exactly their keys', () => {
    expect(typeOf('values({a: 1, b: "x"})')).toBe('(number | string)[]')
    expect(typeOf('{a: 1, b: 2}[n ?? "a"]')).toBe('number | null')
  })

  it('does not pass a declared object where every value must have one type', () => {
    expect(codes('tags(user)')).toEqual(['NO_OVERLOAD'])
    expect(codes('tags({a: "x"})')).toEqual([])
  })

  it('does not pass a record where a field is required', () => {
    expect(codes('needA(r)')).toEqual(['NO_OVERLOAD'])
    expect(codes('needA({a: 1})')).toEqual([])
  })

  it('lets has() probe a key the type does not list', () => {
    expect(codes('has(user.age)')).toEqual([])
    expect(env.evaluateSync('has(user.age)', context)).toBe(true)
  })
})

describe('soundness', () => {
  it('types flatMap results with nulls and non-list results', () => {
    expect(typeOf('xs.flatMap(.)')).toBe('(number | null)[]')
    expect(env.evaluateSync('xs.flatMap(.)', context)).toEqual([1, null])
    expect(typeOf('ns.flatMap(. > 1 ? [.] : "x")')).toBe('(number | string)[]')
    expect(codes('ns.flatMap(. > 1 ? [.] : "x").map(.length)')).toContain('TYPE_ERROR')
  })

  it("re-checks reduce's lambda with the accumulator's final type", () => {
    expect(codes('reduce(ss, (acc, x) => acc + 1 > 0 ? x : x, 0)')).toContain('TYPE_ERROR')
    expect(codes('reduce(ss, (acc, x) => acc.toFixed(1), 0)')).toContain('NO_OVERLOAD')
    expect(typeOf('reduce(ns, (acc, x) => acc + x, 0)')).toBe('number')
    expect(typeOf('reduce(ss, (acc, x) => acc + x, "")')).toBe('string')
    expect(env.evaluateSync('reduce(ss, (acc, x) => acc + x, "")', context)).toBe('ab')
  })

  it('checks that spread items fit every position they may fill', () => {
    expect(codes('toUpperCase(...on)')).toEqual(['NO_OVERLOAD'])
    expect(codes('two(...on)')).toEqual(['NO_OVERLOAD'])
    expect(codes('toUpperCase(...un)')).toEqual(['NO_OVERLOAD'])
    expect(codes('two(...c)')).toContain('TYPE_ERROR')
    expect(codes('two(...ss)')).toEqual([])
    expect(codes('max(1, ...ss)')).toEqual(['NO_OVERLOAD'])
    // How many items a spread holds is only known at run time.
    expect(env.evaluateSync('max(1, ...ns)', context)).toBe(3)
  })

  it('makes the keys of a spread that may be null optional', () => {
    const typed = bonsai({
      variables: { items: t.list(t.object({ name: t.string() })) },
    })
    const result = typed.check('{ id: 1, ...(items[0]) }')
    // A declared record may also hold an `id` of its own, which would win.
    expect(result.type === undefined ? '' : formatType(result.type)).toBe(
      '{ id: any, name: string | null }',
    )
    expect(typed.evaluateSync('{ id: 1, ...(items[0]) }', { items: [] })).toEqual({ id: 1 })
  })

  it('does not read a missing key through ?. on an optional record', () => {
    const typed = bonsai({ variables: { items: t.list(t.object({ id: t.number() })) } })
    expect(typed.check('items[0]?.length').diagnostics.map((d) => d.code)).toEqual([
      'UNKNOWN_PROPERTY',
    ])
  })

  it('checks map results against expected records and objects', () => {
    expect(codes('{a: "x"}', t.record(t.number()))).toEqual(['EXPECTED_TYPE'])
    expect(codes('{a: 1}', t.record(t.number()))).toEqual([])
    expect(codes('let k = "z"; {[k]: "s"}', t.object({ a: t.number() }))).toEqual(['EXPECTED_TYPE'])
  })

  it('refines results over a union of lists', () => {
    expect(typeOf('(c ? [["a"]] : [1]).flat()')).toBe('string[] | number[]')
  })

  it('types negation of an unknown value as number or duration', () => {
    expect(typeOf('-anyv')).toBe('number | duration')
    expect(typeOf('-nd')).toBe('number | duration')
    expect(typeOf('(anyv % 2)')).toBe('number')
  })
})

describe('no false positives', () => {
  it('accepts enum and literal results', () => {
    expect(codes('plan', plan)).toEqual([])
    expect(codes('"pro"', plan)).toEqual([])
    expect(codes('true', t.literal(true))).toEqual([])
    expect(codes('pick()', plan)).toEqual([])
    expect(codes('"gold"', plan)).toEqual(['EXPECTED_TYPE'])
  })

  it('checks list and map literals against the parameter they are passed to', () => {
    expect(codes('setPlans(["pro"])')).toEqual([])
    expect(codes('setPlans([plan])')).toEqual([])
    expect(codes('setUser({plan: "pro"})')).toEqual([])
    expect(codes('{plan: plan}', t.object({ plan }))).toEqual([])
    expect(codes('setPlans(["gold"])')).toEqual(['NO_OVERLOAD'])
  })

  it('treats null for an optional parameter as omitted, as the runtime does', () => {
    expect(codes('join(ns, null)')).toEqual([])
    expect(codes('split("a,b", ",", null)')).toEqual([])
    expect(codes('[1, 2, 3].slice(1, null)')).toEqual([])
    expect(env.evaluateSync('[1, 2, 3].slice(1, null)', context)).toEqual([2, 3])
  })

  it('blames a nullable argument, not an unknown one', () => {
    const open = bonsai()
    expect(open.check('xs.slice(1, null)').diagnostics).toEqual([])
    const typed = bonsai({ variables: { s: t.optional(t.string()) } })
    expect(typed.check('toUpperCase(s)').diagnostics[0]?.message).toContain('may be null')
  })

  it('still requires orderable items for each member of a union receiver', () => {
    const typed = bonsai({
      variables: { items: t.list(t.object({ id: t.number() })), maybe: t.optional(t.number()) },
    })
    expect(
      typed.check('(maybe == null ? items : maybe)?.min()').diagnostics.map((d) => d.code),
    ).toEqual(['NO_OVERLOAD'])
  })

  it('accepts union receivers that every member supports', () => {
    expect(typeOf('abs(nd)')).toBe('number | duration')
    expect(codes('sl.includes("a")')).toEqual([])
    expect(typeOf('{...(c ? {x: 1} : {y: 2})}')).toBe('{ [key: string]: number }')
    expect(typeOf('[...(c ? [1] : ["a"])]')).toBe('(number | string)[]')
    expect(typeOf('(c ? [1] : ["a"]) + ["b"]')).toBe('(number | string)[]')
    expect(env.evaluateSync('abs(nd)', context)).toBe(2)
  })

  it('narrows m["a"] and m.a as the same path', () => {
    expect(codes('m["a"] != null && m.a.b > 0')).toEqual([])
    expect(codes('m.a != null && m["a"].b > 0')).toEqual([])
  })

  it('warns when an enum can never be in a literal list', () => {
    expect(codes('plan in ["gold"]')).toEqual(['ALWAYS_FALSE'])
    expect(codes('plan in ["pro", "gold"]')).toEqual([])
  })

  it('reads a key only some records in a union have as optional', () => {
    const records = '[{a: 1}, {a: 2, b: 3}]'
    expect(typeOf(`${records}.map(.b)`)).toBe('(null | number)[]')
    expect(typeOf(`${records}.map(.b ?? 0)`)).toBe('number[]')
    expect(env.evaluateSync(`${records}.map(.b ?? 0)`, context)).toEqual([0, 3])
  })

  it('leaves JavaScript-looking names to the context in an open environment', () => {
    const open = bonsai()
    // Math.abs() is abs(Math): fine if the context holds a number called Math.
    const result = open.check('Math.abs()')
    expect(result.ok).toBe(true)
    expect(result.diagnostics[0]?.severity).toBe('warning')
    expect(open.evaluateSync('Math.abs()', { Math: -2 })).toBe(2)
    expect(env.check('Math.abs()').ok).toBe(false)
  })
})

describe('language service', () => {
  const service = createLanguageService(
    bonsai({
      variables: {
        user: t.object({ 'first-name': t.string(), plan }),
        u: t.union(t.object({ a: t.number() }), t.object({ b: t.string() })),
      },
    }),
  )

  it('reports the replaced range as start and end', () => {
    const result = service.complete('user.pl', 7)
    expect(result).toMatchObject({ start: 5, end: 7 })
  })

  it('inserts a field that is not a plain name with brackets, replacing the dot', () => {
    const item = service.complete('user.', 5).items.find((i) => i.label === 'first-name')
    expect(item).toMatchObject({ insertText: '["first-name"]', range: { start: 4, end: 5 } })
  })

  it('offers the fields of every member of a union', () => {
    const labels = service.complete('u.', 2).items.map((i) => i.label)
    expect(labels).toContain('a')
    expect(labels).toContain('b')
  })

  it('treats a non-numeric offset as the end of the source', () => {
    const result = service.complete('user.', Number.NaN)
    expect(result.start).toBe(5)
    expect(service.hover('user', Number.NaN)).toBeUndefined()
  })

  it('keeps diagnostic spans inside the source', () => {
    for (const source of ['user.', 'user.plan ==', '{', '(']) {
      for (const d of service.diagnostics(source)) {
        expect(d.start).toBeGreaterThanOrEqual(0)
        expect(d.end).toBeLessThanOrEqual(source.length)
        expect(d.start).toBeLessThanOrEqual(d.end)
      }
    }
  })

  it('offers enum values inside a list after in', () => {
    const labels = service.complete('user.plan in ["', 15).items.map((i) => i.label)
    expect(labels).toEqual(expect.arrayContaining(['free', 'pro']))
    const next = service.complete('user.plan in ["free", "p', 24).items.map((i) => i.label)
    expect(next).toContain('pro')
  })
})
