import { describe, expect, it } from 'vitest'
import { bonsai, print, t } from '../src/index.js'
import { codeOf, run } from './helpers.js'

// Meanings fixed before 1.0, when stored expressions start depending on them.

describe('"." in reduce', () => {
  const typed = bonsai({ variables: { xs: t.list(t.number()) } })

  it('is a check error, since the first lambda parameter is the accumulator', () => {
    for (const env of [bonsai(), typed]) {
      const result = env.check('xs.reduce(. + 10, 0)')
      expect(result.ok).toBe(false)
      expect(result.diagnostics.map((d) => d.code)).toEqual(['INVALID_LAMBDA'])
      expect(result.diagnostics[0]?.message).toContain('(acc, x) => ')
    }
    expect(run('[5, 6, 7].reduce(. + 10, 0)')).toEqual({ code: 'CHECK' })
  })

  it('keeps explicit reduce lambdas and the implicit lambdas of item functions', () => {
    expect(run('[5, 6, 7].reduce((acc, x) => acc + x + 10, 0)')).toEqual({ value: 48 })
    expect(typed.evaluateSync('xs.map(. * 2).filter(. > 2)', { xs: [1, 2] })).toEqual([4])
    expect(run('[[1], [2, 3]].reduce((acc, xs) => acc + xs.map(. * 2).sum(), 0)')).toEqual({
      value: 12,
    })
  })
})

describe('locales in number formatting', () => {
  it('rejects a locale the runtime has no data for instead of using the host default', () => {
    for (const source of [
      'formatNumber(1234.5, 2, "xx-YY")',
      'formatNumber(1234.5, 2, "und")',
      'formatCurrency(1234.5, "EUR", "qq")',
    ]) {
      // A literal locale is checked before anything runs; a computed one when it runs.
      expect(run(source)).toEqual({ code: 'CHECK' })
      expect(run(source.replace(/"(?<tag>[\w-]+)"\)$/u, '"$<tag>" + "")'))).toEqual({
        code: 'INVALID_ARGUMENT',
      })
    }
  })

  it('keeps supported locales and the en-US default', () => {
    expect(run('formatNumber(1234.5, 2)')).toEqual({ value: '1,234.50' })
    expect(run('formatNumber(1234.5, 2, "en-GB")')).toEqual({ value: '1,234.50' })
    expect(run('formatNumber(1234.5, 2, "de-DE")')).toEqual({ value: '1.234,50' })
    expect(run('formatCurrency(5, "USD", null)')).toEqual({ value: '$5.00' })
  })
})

describe('"??" next to comparisons and arithmetic', () => {
  const env = bonsai()

  it('needs parentheses, as it does next to && and ||', () => {
    for (const source of [
      'score ?? 0 > 10',
      'plan ?? "free" == "pro"',
      'score ?? 0 + 5',
      'a > b ?? c',
      'a + 1 ?? b',
      'tag ?? "x" in tags',
      'a ?? b ?? c * 2',
    ]) {
      expect(
        codeOf(() => env.parse(source)),
        source,
      ).toBe('SYNTAX')
    }
  })

  it('accepts the parenthesized forms and chains of "??"', () => {
    expect(run('(score ?? 0) > 10', { score: 30 })).toEqual({ value: true })
    expect(run('score ?? (0 > 10)', { score: null })).toEqual({ value: false })
    expect(run('a ?? b ?? 3', { a: null, b: null })).toEqual({ value: 3 })
    expect(run('-a ?? 1', { a: 2 })).toEqual({ value: -2 })
  })

  it('prints parentheses so a tree round-trips', () => {
    const source = '(score ?? 0) > 10 && (a ?? (b + 1)) == 2'
    expect(print(env.parse(source))).toBe(source)
    // A hand-built tree with a bare comparison under "??" gets parentheses.
    const tree = env.parse('a ?? (b == 1)')
    expect(print(tree)).toBe('a ?? (b == 1)')
    expect(print(env.parse(print(tree)))).toBe(print(tree))
  })
})

describe('host keys holding undefined', () => {
  const ctx = { u: { a: 1, b: undefined } }

  it('are absent from equality, keys, values, entries, has, in, isEmpty, and spread', () => {
    expect(run('u == {a: 1}', ctx)).toEqual({ value: true })
    expect(run('keys(u)', ctx)).toEqual({ value: ['a'] })
    expect(run('values(u)', ctx)).toEqual({ value: [1] })
    expect(run('entries(u).length', ctx)).toEqual({ value: 1 })
    expect(run('has(u.b)', ctx)).toEqual({ value: false })
    expect(run('"b" in u', ctx)).toEqual({ value: false })
    expect(run('isEmpty(v)', { v: { x: undefined } })).toEqual({ value: true })
    expect(run('keys({...u, c: 2})', ctx)).toEqual({ value: ['a', 'c'] })
    expect(run('[u, {a: 1}].unique().length', ctx)).toEqual({ value: 1 })
  })

  it('still read as null, and a null value is still a present key', () => {
    expect(run('u.b == null', ctx)).toEqual({ value: true })
    expect(run('{a: 1, b: null} == {a: 1}')).toEqual({ value: false })
    expect(run('"b" in {b: null}')).toEqual({ value: true })
  })

  it('never match a key with data, in either order', () => {
    const pair = { a: { x: null }, b: { x: undefined, y: 1 } }
    expect(run('a == b', pair)).toEqual({ value: false })
    expect(run('b == a', pair)).toEqual({ value: false })
    expect(run('a == b', { a: { x: 1 }, b: { x: 1, y: undefined } })).toEqual({ value: true })
  })
})

describe('toNumber', () => {
  it('parses decimal text only', () => {
    expect(run('toNumber(" -42.5e1 ")')).toEqual({ value: -425 })
    expect(run('toNumber("+.5")')).toEqual({ value: 0.5 })
    expect(run('toNumber("5.")')).toEqual({ value: 5 })
    for (const text of ['0x10', '0b11', '0o17', '1_000', 'Infinity', '', ' ', '1e', '--1']) {
      expect(run(`toNumber(${JSON.stringify(text)})`), text).toEqual({ code: 'INVALID_ARGUMENT' })
    }
  })
})
