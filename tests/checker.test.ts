import { describe, expect, it } from 'vitest'
import { bonsai, fn, t, type Type } from '../src/index.js'

const env = bonsai({
  strict: true,
  variables: {
    user: t.object({
      name: t.string(),
      age: t.number(),
      nick: t.optional(t.string()),
      plan: t.enum('free', 'pro'),
      tags: t.list(t.string()),
      created: t.timestamp(),
    }),
    orders: t.list(t.object({ id: t.string(), total: t.number(), paid: t.boolean() })),
    prefs: t.record(t.string()),
  },
  functions: {
    discount: fn({ params: [t.number(), t.string()], returns: t.number(), run: (n) => n }),
  },
})

const typeOf = (source: string): Type | undefined => env.check(source).type
const codes = (source: string): string[] => env.check(source).diagnostics.map((d) => d.code)
const errors = (source: string): string[] =>
  env
    .check(source)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.code)

describe('inference', () => {
  it.each<[string, Type]>([
    ['user.age + 1', t.number()],
    ['user.name.toUpperCase()', t.string()],
    ['orders.filter(.paid).map(.total)', t.list(t.number())],
    ['orders.map(o => o.id)', t.list(t.string())],
    [
      'orders.first()',
      t.optional(t.object({ id: t.string(), total: t.number(), paid: t.boolean() })),
    ],
    ['orders.map(.total).sum()', t.number()],
    [
      'orders.groupBy(.id)',
      t.record(t.list(t.object({ id: t.string(), total: t.number(), paid: t.boolean() }))),
    ],
    ['user.nick ?? user.name', t.string()],
    ['now() - user.created', t.duration()],
    ['user.created + days(1)', t.timestamp()],
    ['prefs.theme', t.optional(t.string())],
    ['[1, 2, 3]', t.list(t.number())],
    ['{ a: 1, b: "x" }', t.object({ a: t.number(), b: t.string() })],
    ['let n = user.age; n * 2', t.number()],
    ['orders.reduce((sum, o) => sum + o.total, 0)', t.number()],
    ['user.tags.includes("vip")', t.boolean()],
    ['`${user.name}!`', t.string()],
    ['try(user.age / 0, 0)', t.number()],
    ['values(prefs)', t.list(t.string())],
    ['[[1], [2, 3]].flat()', t.list(t.number())],
  ])('%s', (source, expected) => {
    const result = env.check(source)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.type).toEqual(expected)
  })
})

describe('diagnostics', () => {
  it.each<[string, string]>([
    ['usr.age', 'UNKNOWN_VARIABLE'],
    ['user.agee', 'UNKNOWN_PROPERTY'],
    ['user.age.foo', 'TYPE_ERROR'],
    ['frobnicate(1)', 'UNKNOWN_FUNCTION'],
    ['user.name + 1', 'TYPE_ERROR'],
    ['user.age > "18"', 'TYPE_ERROR'],
    ['user.age && true', 'TYPE_ERROR'],
    ['user.nick.toUpperCase()', 'NULLABLE_RECEIVER'],
    ['discount(user.age)', 'NO_OVERLOAD'],
    ['discount(user.age, 5)', 'NO_OVERLOAD'],
    ['orders.map(.nope)', 'UNKNOWN_PROPERTY'],
    ['user.tags.map(x => .length)', 'INVALID_LAMBDA'],
    ['.age > 1', 'INVALID_LAMBDA'],
    ['user.age.round(.)', 'INVALID_LAMBDA'],
    ['user.created + 30', 'TYPE_ERROR'],
    ['`${user.tags}`', 'TYPE_ERROR'],
    ['orders.filter(.total)', 'TYPE_ERROR'],
  ])('%s -> %s', (source, code) => {
    expect(codes(source)).toContain(code)
  })

  it('warns on comparisons that can never hold', () => {
    const result = env.check('user.plan == "premium"')
    expect(result.ok).toBe(true)
    expect(result.diagnostics[0]?.message).toContain('always false')
  })

  it('accepts optional calls and defaults on nullable values', () => {
    expect(errors('user.nick?.toUpperCase()')).toEqual([])
    expect(errors('(user.nick ?? "").toUpperCase()')).toEqual([])
    expect(typeOf('user.nick?.toUpperCase()')).toEqual(t.optional(t.string()))
  })

  it('binds . to the nearest function parameter', () => {
    expect(errors('orders.filter(.total > max(.total, 10))')).toEqual([])
    expect(errors('orders.filter(o => orders.some(.id == o.id))')).toEqual([])
  })

  describe('a default written with ||', () => {
    const only = (source: string) => {
      const found = env.check(source).diagnostics
      expect(found, source).toHaveLength(1)
      return found[0]
    }

    it('is one problem, on the value that may be null, pointing to ??', () => {
      expect(only('user.nick || "anon"')).toMatchObject({
        code: 'TYPE_ERROR',
        start: 0,
        end: 9,
        message: '"||" expects a boolean but got string | null; for a default, use ?? for each ||',
      })
      expect(errors('user.nick ?? "anon"')).toEqual([])
    })

    it('is recognised on an untyped value, on the side that is not a boolean', () => {
      const loose = bonsai()
      const [diagnostic, ...rest] = loose.check('discount || 0').diagnostics
      expect(rest).toEqual([])
      expect(diagnostic).toMatchObject({ start: 12, end: 13 })
      expect(diagnostic?.message).toContain('use ?? for each ||')
      expect(only('null || 1').message).toContain('use ?? for each ||')
    })

    it('reports a chain once', () => {
      for (const source of ['user.nick || user.nick || "anon"', 'user.nick || "a" || "b"']) {
        expect(only(source).message, source).toContain('use ?? for each ||')
      }
    })

    it('stands for its value where it is used, so nothing cascades', () => {
      expect(only('(user.nick || "anon").toUpperCase()').start).toBe(1)
      expect(only('user.nick || (user.nick || "anon")').start).toBe(14)
    })

    it('is a test, not a default, where a boolean is wanted, so ?? is not suggested', () => {
      const advice = (source: string, expect_?: Type) =>
        env
          .check(source, expect_ ? { expect: expect_ } : {})
          .diagnostics.map((d) => d.message.split('; ')[1])
      const present = 'to test it is set, write x != null'
      expect(advice('(user.nick || "anon") && true')).toEqual([present, undefined])
      expect(advice('!(user.nick || "anon")')).toEqual([present, undefined])
      expect(advice('(user.nick || "anon") ? 1 : 2')).toEqual([present, undefined])
      expect(advice('user.nick || "anon"', t.boolean())).toContain(present)
      // A boolean on the right: the left is a test too (user.nick != null || ...).
      expect(advice('user.nick || user.age > 1')).toEqual([present])
      // A predicate's lambda, and a place that takes boolean | null, want a boolean as well.
      expect(advice('user.tags.filter(tag => user.nick || "anon")')).toContain(present)
      expect(advice('user.nick || "anon"', t.optional(t.boolean()))).toContain(present)
    })

    it('takes an untyped fallback as a default, and leaves untyped || alone', () => {
      const loose = bonsai({
        variables: { user: t.object({ nick: t.optional(t.string()) }), fallback: t.any() },
      })
      expect(loose.check('user.nick || fallback').diagnostics.map((d) => d.message)).toEqual([
        expect.stringContaining('use ?? for each ||'),
      ])
      const plain = bonsai().check('a || b')
      expect(plain.diagnostics).toEqual([])
      expect(plain.type).toEqual(t.boolean())
    })

    it('still reports the outer || when a default sits after a boolean', () => {
      expect(codes('user.created == user.created || (user.nick || "x")')).toEqual([
        'TYPE_ERROR',
        'TYPE_ERROR',
      ])
    })

    it('still checks the fallback itself', () => {
      expect(codes('user.nick || user.agee')).toEqual(['UNKNOWN_PROPERTY', 'TYPE_ERROR'])
    })
  })

  it('says how to compare a non-boolean in a condition, by its type', () => {
    const hint = (source: string) =>
      env.check(source).diagnostics.map((d) => d.message.split('; ')[1])
    const compare = 'compare explicitly, e.g. x != 0 or x != ""'
    expect(hint('user.age && true')).toEqual([compare])
    expect(hint('!user.name')).toEqual([compare])
    // Null reads as false, so x != 0 would turn it true: test for presence instead.
    expect(hint('user.nick ? 1 : 2')).toEqual(['to test it is set, write x != null'])
    // An enum compared to "" always differs, a constant operand isn't the mistake,
    // and a list has no comparison to suggest.
    expect(hint('!user.plan')).toEqual([undefined])
    expect(hint('true || 10')).toEqual([undefined])
    expect(hint('user.tags && true')).toEqual([undefined])
  })

  it('points diagnostics at the offending span', () => {
    const [diagnostic] = env.check('user.age + user.agee').diagnostics
    expect(diagnostic).toMatchObject({ code: 'UNKNOWN_PROPERTY', start: 16, end: 20 })
  })

  it('is lenient in an open environment', () => {
    const open = bonsai()
    expect(open.check('a.b.c + d.e(1)').ok).toBe(false) // unknown function e
    expect(open.check('a.b.c + d.length').ok).toBe(true)
    expect(open.check('xs.filter(.x > 1).map(.y).sum()').ok).toBe(true)
  })
})
