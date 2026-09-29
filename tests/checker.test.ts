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

  it('points diagnostics at the offending span', () => {
    const [diagnostic] = env.check('user.age + user.agee').diagnostics
    expect(diagnostic).toMatchObject({ code: 'UNKNOWN_PROPERTY', start: 11, end: 20 })
  })

  it('is lenient in an open environment', () => {
    const open = bonsai()
    expect(open.check('a.b.c + d.e(1)').ok).toBe(false) // unknown function e
    expect(open.check('a.b.c + d.length').ok).toBe(true)
    expect(open.check('xs.filter(.x > 1).map(.y).sum()').ok).toBe(true)
  })
})
