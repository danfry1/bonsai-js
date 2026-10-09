import { describe, expect, it } from 'vitest'
import { bonsai, formatType, t } from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

// With the u flag a surrogate class matches only a surrogate that is not half of a pair.
const loneSurrogate = /[\uD800-\uDFFF]/u
const pile = '\u{1F4A9}'

describe('a spread after an open declared object', () => {
  const env = bonsai({
    variables: {
      o1: t.object({ a: t.number() }),
      opt2: t.object({ c: t.optional(t.string()) }),
      nobj: t.optional(t.object({ c: t.string() })),
    },
  })
  const typeOf = (source: string): string => {
    const result = env.check(source)
    return result.ok ? formatType(result.type) : `error: ${result.diagnostics[0]?.code}`
  }
  // Declared objects are open: o1 may carry a `c` of any type.
  const data = { o1: { a: 1, c: 5 }, opt2: {}, nobj: null }

  it('reads a key the later spread may lack as whatever the open object held', () => {
    expect(env.evaluateSync('{...o1, ...opt2}.c', data)).toBe(5)
    expect(typeOf('{...o1, ...opt2}.c')).toBe('any')
    expect(env.evaluateSync('{...o1, ...nobj}.c', data)).toBe(5)
    expect(typeOf('{...o1, ...nobj}.c')).toBe('any | null')
  })

  it('does not call a comparison with that key always false', () => {
    const result = env.check('{...o1, ...opt2}.c == 5')
    expect(result.diagnostics).toEqual([])
    expect(env.evaluateSync('{...o1, ...opt2}.c == 5', data)).toBe(true)
  })
})

describe('blocked keys are reported at check time', () => {
  const env = bonsai()

  it('reports a constant computed key that evaluation blocks', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const source = `{["${key}"]: 1, a: 2}`
      const result = env.check(source)
      expect(result.ok).toBe(false)
      expect(result.diagnostics.map((d) => [d.code, d.start, d.end])).toEqual([
        ['BLOCKED_PROPERTY', 2, 4 + key.length],
      ])
      expect(() => env.evaluateSync(source)).toThrow(/is not accessible|cannot be used/u)
    }
  })

  it('keeps the other fields of the literal', () => {
    const result = env.check('{["__proto__"]: 1, a: 2}.a')
    expect(result.diagnostics.map((d) => d.code)).toEqual(['BLOCKED_PROPERTY'])
    expect(env.check('{["a"]: 1}.a').type).toEqual(t.number())
  })
})

describe('code frames and type text never split a surrogate pair', () => {
  const env = bonsai({ variables: { a: t.number(), s: t.string() } })

  it('cuts a long line on either side of the span between characters', () => {
    for (let lead = 30; lead < 90; lead++) {
      for (const tail of [0, 61, 140]) {
        const source = `"${pile.repeat(lead)}" + (a + s) + "${pile.repeat(tail)}"`
        const formatted = env.check(source).diagnostics[0]?.formatted ?? ''
        expect(loneSurrogate.test(formatted)).toBe(false)
      }
    }
  })

  it('cuts type text in messages between characters', () => {
    const message = env.check(`"${pile.repeat(80)}" - a`).diagnostics[0]?.message ?? ''
    expect(message).toContain('…')
    expect(loneSurrogate.test(message)).toBe(false)
    expect(loneSurrogate.test(formatType(t.literal(pile.repeat(600))))).toBe(false)
  })

  it('lines the caret up by characters, keeping tabs', () => {
    const wide = env.check('"\u{1D465}\u{1D465}" + (a + true)').diagnostics[0]?.formatted ?? ''
    const [, code = '', caret = ''] = wide.split('\n')
    expect(Array.from(code.slice(code.indexOf('| ') + 2)).indexOf('(')).toBe(
      caret.slice(caret.indexOf('| ') + 2).indexOf('^'),
    )
    const tabbed = env.check('\t"x" + (a + true)').diagnostics[0]?.formatted ?? ''
    expect(tabbed.split('\n')[2]).toBe('  | \t      ^^^^^^^^^^')
  })
})

describe('MAYBE_NULL on an ordering whose false is a verdict', () => {
  const env = bonsai({
    variables: {
      users: t.list(t.object({ name: t.string(), age: t.optional(t.number()) })),
      user: t.object({ age: t.optional(t.number()) }),
      amount: t.number(),
      limit: t.optional(t.number()),
    },
  })
  const codes = (source: string): string[] => env.check(source).diagnostics.map((d) => d.code)

  it('warns where null would be negated or branched on', () => {
    expect(codes('user.age < 18 ? "deny" : "allow"')).toEqual(['MAYBE_NULL'])
    expect(codes('users.filter(!(.age >= 18))')).toEqual(['MAYBE_NULL'])
    expect(codes('!(amount > limit)')).toEqual(['MAYBE_NULL'])
    expect(codes('users.map(.age < 18 ? "minor" : "adult")')).toEqual(['MAYBE_NULL'])
    expect(codes('users.every(.age >= 18)')).toEqual(['MAYBE_NULL'])
    expect(codes('users.none(.age < 18)')).toEqual(['MAYBE_NULL'])
    expect(codes('(user.age < 18) == false')).toEqual(['MAYBE_NULL'])
    expect(codes('(user.age < 18) != true')).toEqual(['MAYBE_NULL'])
    expect(codes('!(user.age < 18 && amount > 1)')).toEqual(['MAYBE_NULL'])
  })

  it('stays quiet where false means skip, or the side is checked first', () => {
    expect(codes('users.filter(.age >= 18)')).toEqual([])
    expect(codes('users.filter(.age >= 18 && .name != "x")')).toEqual([])
    expect(codes('users.some(.age < 18)')).toEqual([])
    expect(codes('users.find(.age < 18)')).toEqual([])
    expect(codes('amount > limit')).toEqual([])
    expect(codes('(user.age < 18) == true')).toEqual([])
    expect(codes('user.age != null && user.age < 18 ? "deny" : "allow"')).toEqual([])
    expect(codes('(user.age ?? 0) < 18 ? "deny" : "allow"')).toEqual([])
  })
})

describe('member completion in nested positions', () => {
  const env = bonsai({
    variables: {
      o1: t.object({ a: t.number(), b: t.string() }),
      b: t.boolean(),
      xs: t.list(t.object({ a: t.number(), b: t.optional(t.string()) })),
      nobj: t.optional(t.object({ c: t.string() })),
      o2: t.object({ c: t.optional(t.string()) }),
    },
  })
  const service = createLanguageService(env)
  const properties = (source: string): string[] =>
    service
      .complete(source, source.length)
      .items.filter((item) => item.kind === 'property')
      .map((item) => `${item.label}: ${item.detail}`)

  it('completes inside brackets, calls, lambdas, templates, and branches of a let value', () => {
    for (const source of [
      'let v = abs(o1.',
      'let v = [o1.',
      'let v = `${o1.',
      'let v = b ? o1.',
      '{[abs(o1.',
      'try(abs(o1.',
    ]) {
      expect(properties(source)).toEqual(['a: number', 'b: string'])
    }
    expect(properties('let v = xs.map(.')).toEqual(['a: number', 'b: string | null'])
    expect(properties('let v = xs.map(x => x.')).toEqual(['a: number', 'b: string | null'])
  })

  it('details each member with the type check() gives the read', () => {
    expect(properties('xs[0].')).toEqual(['a: number | null', 'b: string | null'])
    expect(properties('nobj.')).toEqual(['c: string | null'])
    expect(properties('o2.c != null ? o2.')).toEqual(['c: string'])
    expect(properties('o2.')).toEqual(['c: string | null'])
  })
})

describe('UNSAFE_INTEGER on exponent literals', () => {
  const env = bonsai({ variables: { n: t.number() } })
  const codes = (source: string): string[] => env.check(source).diagnostics.map((d) => d.code)

  it('warns when the number cannot keep every digit written', () => {
    expect(codes('n < 9007199254740993e0')).toEqual(['UNSAFE_INTEGER'])
    expect(codes('n < 123456789012345678e2')).toEqual(['UNSAFE_INTEGER'])
    expect(codes('n < 9.007199254740993e15')).toEqual(['UNSAFE_INTEGER'])
  })

  it('stays quiet when it does', () => {
    expect(codes('n < 1e308')).toEqual([])
    expect(codes('n < 1.5e300')).toEqual([])
    expect(codes('n < 1_000e20')).toEqual([])
    expect(codes('n < 2e53')).toEqual([])
  })
})
