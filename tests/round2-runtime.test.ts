import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Duration, bonsai, fn, print, t, type Node } from '../src/index.js'
import { minimalSteps, run } from './helpers.js'

// Runtime, built-in, checker, and printer fixes found in the second pre-1.0 review.

describe('locale and currency inputs are bounded before Intl sees them', () => {
  it('rejects an over-long locale tag or currency code without formatting', () => {
    const long = `en-${Array.from({ length: 30 }, (_, i) => `v${String(i).padStart(4, '0')}`).join('-')}`
    expect(long.length).toBeGreaterThan(64)
    expect(run('formatNumber(1, 2, tag)', { tag: long })).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(run('formatCurrency(1, "EUR", tag)', { tag: long })).toEqual({
      code: 'INVALID_ARGUMENT',
    })
    expect(run('formatCurrency(1, code)', { code: 'EURO' })).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(run('formatCurrency(1, code)', { code: 'E'.repeat(10_000) })).toEqual({
      code: 'INVALID_ARGUMENT',
    })
    expect(run('formatCurrency(1234.5, "EUR", "de-DE")')).toEqual({ value: '1.234,50\u00a0€' })
    expect(run('formatNumber(1234.5, 1, "en-US-u-nu-latn")')).toEqual({ value: '1,234.5' })
  })

  it('rejects an over-long time zone name before Intl sees it', () => {
    const zone = `Europe/${'A'.repeat(10_000)}`
    expect(run('hour(t, z)', { t: new Date(0), z: zone })).toEqual({ code: 'INVALID_ARGUMENT' })
  })

  it('formats negative zero as zero, so -0 is never visible in text', () => {
    expect(run('formatNumber(x * y)', { x: -0, y: 1 })).toEqual({ value: '0' })
    expect(run('formatCurrency(x, "EUR")', { x: -0 })).toEqual({ value: '€0.00' })
  })
})

describe('sum dispatches on the items, not only on the list', () => {
  const ds = [new Duration(3_600_000), new Duration(1_800_000)]

  it('sums durations whose type is not known statically', () => {
    expect(run('ds.sum()', { ds })).toEqual({ value: new Duration(5_400_000) })
    expect(run('items.map(.d).sum()', { items: ds.map((d) => ({ d })) })).toEqual({
      value: new Duration(5_400_000),
    })
    expect(run('[null, hours(1)].sum()')).toEqual({ value: new Duration(3_600_000) })
  })

  it('is sound for a list typed as numbers or durations', () => {
    const env = bonsai({
      variables: { flag: t.boolean(), ds: t.list(t.duration()), ns: t.list(t.number()) },
    })
    const ctx = { flag: true, ds, ns: [1, 2] }
    expect(env.evaluateSync('(flag ? ds : ns).sum()', ctx)).toEqual(new Duration(5_400_000))
    expect(env.evaluateSync('(flag ? ds : ns).sum()', { ...ctx, flag: false })).toBe(3)
  })

  it('rejects a list mixing numbers and durations, and keeps empty results', () => {
    expect(run('xs.sum()', { xs: [1, new Duration(1)] })).toEqual({ code: 'TYPE_ERROR' })
    expect(run('xs.sum()', { xs: [new Duration(1), 1] })).toEqual({ code: 'TYPE_ERROR' })
    expect(run('xs.sum()', { xs: [] })).toEqual({ value: 0 })
    const typed = bonsai({ variables: { ds: t.list(t.duration()) } })
    expect(typed.evaluateSync('ds.sum()', { ds: [] })).toEqual(new Duration(0))
    expect(() => typed.evaluateSync('ds.sum()', { ds: [1] as never })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })
})

describe('negating an unknown value', () => {
  it('is unknown too, so it can be passed where a number is expected', () => {
    for (const source of ['round(-x)', 'xs.at(-n)', 'xs.slice(-n)', 'max(-x, 1)', 'sqrt(-x)']) {
      expect(bonsai().check(source).ok, source).toBe(true)
    }
    expect(run('xs.at(-n)', { xs: [1, 2, 3], n: 1 })).toEqual({ value: 3 })
    expect(run('round(-x)', { x: 2.4 })).toEqual({ value: -2 })
    expect(run('-d', { d: new Duration(5) })).toEqual({ value: new Duration(-5) })
  })
})

describe('durations stay finite and exact', () => {
  it('rejects a non-finite or out-of-range length at construction', () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, 1e300, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => new Duration(ms), String(ms)).toThrow(RangeError)
    }
    expect(new Duration(Number.MAX_SAFE_INTEGER).ms).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('reports arithmetic beyond the range as an error, never a huge or non-finite duration', () => {
    expect(run('days(1e300)')).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(run('milliseconds(1e300)')).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(run('days(1e8) * 1000')).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(run('days(1e8) + days(1e8) * 3')).toEqual({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects an invalid duration from host data under validateContext and in host results', () => {
    const fake = Object.create(Duration.prototype) as Duration
    Object.defineProperty(fake, 'ms', { value: Number.NaN })
    const env = bonsai({ variables: { d: t.duration() }, validateContext: true })
    expect(() => env.evaluateSync('d', { d: fake })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    )
    const host = bonsai({
      functions: { bad: fn({ params: [], returns: t.duration(), run: () => fake }) },
    })
    expect(() => host.evaluateSync('bad()')).toThrow(
      expect.objectContaining({ code: 'HOST_CONTRACT' }),
    )
  })
})

describe('printing keeps the meaning of hand-built trees', () => {
  it('prints adjacent template text so it re-parses as text', () => {
    const tree = { type: 'Template', parts: ['$', '{b}'], start: 0, end: 0 } as unknown as Node
    const source = print(tree)
    expect(bonsai().evaluateSync(source, { b: 'x' })).toBe('${b}')
  })

  it('prints any mix of template text and values so it evaluates to the same text', () => {
    const env = bonsai()
    const textPart = fc.stringMatching(/^[a-z${}`\\\n]{0,6}$/u)
    const part = fc.oneof(textPart, fc.constantFrom('v', 'w'))
    fc.assert(
      fc.property(fc.array(part, { maxLength: 8 }), (raw) => {
        // 'v' and 'w' stand for interpolated variables; other strings are text.
        const parts = raw.map((p) =>
          p === 'v' || p === 'w' ? { type: 'Variable', name: p, start: 0, end: 0 } : p,
        )
        const tree = { type: 'Template', parts, start: 0, end: 0 } as unknown as Node
        const ctx: Record<string, string> = { v: 'V', w: 'W' }
        const expected = raw.map((p) => ctx[p] ?? p).join('')
        expect(env.evaluateSync(print(tree), ctx)).toBe(expected)
      }),
      { numRuns: 2000 },
    )
  })

  it('prints a negative zero literal so it evaluates the same in the language', () => {
    const tree = { type: 'Literal', value: -0, start: 0, end: 0 } as unknown as Node
    expect(bonsai().evaluateSync(`formatNumber(${print(tree)})`)).toBe('0')
  })
})

describe('host values are read without running their own methods', () => {
  it('checks a Date subclass by the Date internals, not its overridden getTime', () => {
    class Shifty extends Date {
      override getTime(): number {
        return Number.NaN
      }
    }
    const env = bonsai({
      functions: { at: fn({ params: [], returns: t.timestamp(), run: () => new Shifty(0) }) },
    })
    expect(env.evaluateSync('at() == t', { t: new Date(0) })).toBe(true)
    const checked = bonsai({ variables: { t: t.timestamp() }, validateContext: true })
    expect(checked.evaluateSync('t', { t: new Shifty(5) })).toEqual(new Shifty(5))
  })

  it('aborts the signal of a call: true function that wrongly returns a promise', () => {
    let aborted = false
    const env = bonsai({
      functions: {
        wrong: fn({
          params: [],
          returns: t.number(),
          call: true,
          run: (call) => {
            call.signal.addEventListener('abort', () => {
              aborted = true
            })
            return Promise.resolve(1) as unknown as number
          },
        }),
      },
    })
    expect(() => env.evaluateSync('wrong()')).toThrow(
      expect.objectContaining({ code: 'HOST_CONTRACT' }),
    )
    expect(aborted).toBe(true)
  })
})

describe('literal types are finite', () => {
  it('rejects NaN and infinities as literal types', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => t.literal(value), String(value)).toThrow(TypeError)
      expect(() => t.enum(1, value), String(value)).toThrow(TypeError)
    }
  })
})

describe('turning a timestamp into text is charged by its cost', () => {
  it('charges each timestamp joined into text more than a plain item', () => {
    const env = bonsai()
    const hts = Array.from({ length: 100 }, (_, i) => new Date(i))
    const strings = hts.map((d) => d.toISOString())
    const timestamps = minimalSteps(env, 'join(xs, "")', { xs: hts })
    const text = minimalSteps(env, 'join(xs, "")', { xs: strings })
    expect(timestamps - text).toBeGreaterThanOrEqual(100 * 3)
  })

  it('writes timestamps exactly as Date#toISOString does, across the whole Date range', () => {
    const edges = [
      0,
      -1,
      1,
      -8.64e15,
      8.64e15,
      -62_198_755_200_000,
      -62_198_755_200_001,
      253_402_300_799_999,
      253_402_300_800_000,
      Date.UTC(2024, 1, 29, 23, 59, 59, 999),
    ]
    let seed = 7
    const random = (): number => {
      seed = (seed * 48_271) % 2_147_483_647
      return seed / 2_147_483_647
    }
    const instants = [
      ...edges,
      ...Array.from({ length: 20_000 }, () => Math.floor((random() * 2 - 1) * 8.64e15)),
    ]
    const env = bonsai()
    for (const ms of instants) {
      expect(env.evaluateSync('`${t}`', { t: new Date(ms) }), String(ms)).toBe(
        new Date(ms).toISOString(),
      )
    }
  })
})

describe('diagnostic spans fit their quick-fix', () => {
  const env = bonsai({
    variables: { order: t.object({ total: t.number(), tags: t.list(t.string()) }) },
  })
  const fix = (source: string): string => {
    const d = env.check(source).diagnostics[0]
    if (d?.suggestion === undefined) throw new Error(`no suggestion for ${source}`)
    return source.slice(0, d.start) + d.suggestion + source.slice(d.end)
  }

  it('replaces only the misspelled name', () => {
    expect(fix('order.totl > 1')).toBe('order.total > 1')
    expect(fix('order?.totl > 1')).toBe('order?.total > 1')
    expect(fix('ordr.total > 1')).toBe('order.total > 1')
    expect(fix('order["totl"] > 1')).toBe('order["total"] > 1')
  })

  it('underlines the operand that may be null, not the whole expression', () => {
    const typed = bonsai({ variables: { base: t.number(), bonus: t.optional(t.number()) } })
    const source = 'base + bonus'
    const d = typed.check(source).diagnostics[0]
    expect(d?.message).toContain('may be null')
    expect(source.slice(d?.start, d?.end)).toBe('bonus')
  })
})
