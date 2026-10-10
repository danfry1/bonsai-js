import { describe, expect, it } from 'vitest'
import { bonsai, formatType, t } from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

const env = bonsai({
  variables: {
    user: t.object({ age: t.optional(t.number()), verified: t.boolean() }),
    users: t.list(t.object({ name: t.string(), age: t.optional(t.number()) })),
    flag: t.boolean(),
    o1: t.object({ a: t.number() }),
    o2: t.object({ c: t.optional(t.string()) }),
    b: t.boolean(),
    s: t.string(),
    n: t.number(),
    xs: t.list(t.number()),
  },
})
const codes = (source: string): string[] => env.check(source).diagnostics.map((d) => d.code)
const typeOf = (source: string): string => {
  const result = env.check(source)
  return result.ok ? formatType(result.type) : `error: ${result.diagnostics[0]?.code}`
}

describe('MAYBE_NULL looks through what passes a verdict on', () => {
  const data = {
    user: { verified: true },
    users: [{ name: 'a', age: 30 }, { name: 'b' }],
    flag: true,
  }

  it.each([
    ['(flag ? user.age < 18 : false) ? "deny" : "allow"', 'allow'],
    ['users.none(x => flag ? x.age < 18 : false)', true],
    ['!(flag ? user.age < 18 : true)', true],
    ['try(user.age < 18, false) ? "deny" : "allow"', 'allow'],
    ['users.every(x => let a = x.age; a >= 18)', false],
    ['!((user.age < 18) == true)', true],
    ['users.every((.age >= 18) == true)', false],
    ['users.every(.age >= 18 != false)', false],
  ])('warns on %s', (source, value) => {
    expect(codes(source)).toEqual(['MAYBE_NULL'])
    expect(
      env.evaluateSync(source, { ...data, o1: { a: 1 }, o2: {}, b: true, s: '', n: 0, xs: [] }),
    ).toBe(value)
  })

  it('stays quiet where false means skip', () => {
    expect(codes('users.filter(.age >= 18)')).toEqual([])
    expect(codes('users.filter(x => flag ? x.age >= 18 : true)')).toEqual([])
    expect(codes('user.age > 18')).toEqual([])
  })
})

describe('a key a map literal writes is always there', () => {
  it('keeps a literal spread field over an earlier open object', () => {
    expect(typeOf('{...o1, ...{c: o2.c}}.c')).toBe('string | null')
    expect(codes('{...o1, ...{c: o2.c}}.c.toUpperCase()')).toEqual(['NULLABLE_RECEIVER'])
    expect(typeOf('{...o1, ...{c: null}}.c')).toBe('null')
  })

  it('still lets a declared optional field leave an earlier value in place', () => {
    expect(typeOf('{...o1, ...o2}.c')).toBe('any')
    // A null spread adds nothing, so an open earlier object's value may show through.
    expect(typeOf('{...user, ...(b ? {tag: s} : null)}.tag')).toBe('any | null')
  })
})

describe('blocked keys known at check time', () => {
  it.each([
    '{[`__proto__`]: 1}',
    'let key = "constructor"; {[key]: 1}',
    'xs.groupBy(x => "constructor")',
    'groupBy(xs, x => `prototype`)',
  ])('reports %s', (source) => {
    expect(codes(source)).toEqual(['BLOCKED_PROPERTY'])
  })

  it('leaves keys that may be something else to run time', () => {
    expect(codes('{[b ? "prototype" : "a"]: 1}')).toEqual([])
    expect(codes('{[s]: 1}')).toEqual([])
    expect(codes('xs.groupBy(x => x > 1 ? "a" : "b")')).toEqual([])
  })

  it('reads a template without substitutions as its text', () => {
    expect(typeOf('{[`a`]: 1}.a + 1')).toBe('number')
    expect(env.evaluateSync('{[`a`]: 1}.a + 1', {} as never)).toBe(2)
  })
})

describe('code frames and literals', () => {
  it('does not show the carriage return of a CRLF line', () => {
    const frame = env.check('n +\r\n true').diagnostics[0]?.formatted ?? ''
    expect(frame).not.toContain('\r')
    const first = env.check('n + true\r\n+ 1').diagnostics[0]?.formatted ?? ''
    expect(first.split('\n')[1]).toBe('1 | n + true')
  })

  it('accepts an exponent literal that names its integer exactly', () => {
    expect(codes('n < 1.180591620717411303424e21')).toEqual([])
    expect(codes('n < 1e308')).toEqual([])
    expect(codes('n < 9007199254740993e0')).toEqual(['UNSAFE_INTEGER'])
  })
})

describe('completion', () => {
  const service = createLanguageService(
    bonsai({
      variables: {
        o1: t.object({ a: t.number(), name: t.string() }),
        b: t.boolean(),
        nobj: t.optional(t.object({ c: t.string() })),
      },
    }),
  )
  const fields = (source: string): string[] =>
    service
      .complete(source, source.length)
      .items.filter((item) => item.kind === 'property')
      .map((item) => `${item.label}: ${item.detail}`)

  it.each([
    'let v = try(o1.',
    'b ? try(o1.',
    'try(b ? o1.',
    'let v = {[o1.',
    'b ? b ? o1.',
    'try(try(o1.',
    '{[try(o1.',
    'let v = `${try(o1.',
  ])('completes members in %s', (source) => {
    expect(fields(source)).toEqual(['a: number', 'name: string'])
  })

  it('offers nothing after a mistake before the cursor', () => {
    expect(fields('o1.a && let v = try(o1.')).toEqual([])
  })

  it('details a field inside has() as check reads it', () => {
    expect(fields('has(nobj.')).toEqual(['c: string | null'])
    expect(fields('has(nobj?.')).toEqual(['c: string | null'])
  })
})
