import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, t } from '../src/index.js'
import { compileRegex, searchRegex } from '../src/runtime/regex.js'
import { createLanguageService } from '../src/service/index.js'

const env = bonsai()
const message = (f: () => unknown): string => {
  try {
    f()
  } catch (error) {
    expect(error).toBeInstanceOf(BonsaiError)
    return (error as BonsaiError).message
  }
  return ''
}

describe('matches (linear-time regular expressions)', () => {
  it('matches like RE2', () => {
    expect(env.evaluateSync('matches("api-users", "^api-")')).toBe(true)
    expect(env.evaluateSync('"Hello".matches("(?i)^hello$")')).toBe(true)
    expect(env.evaluateSync('matches("555-1234", "^\\\\d{3}-\\\\d{4}$")')).toBe(true)
    expect(env.evaluateSync('matches("concat", "\\\\bcat\\\\b")')).toBe(false)
  })

  it('rejects unsupported or invalid patterns, statically when literal', () => {
    expect(env.check('matches(x, "(a")').diagnostics[0]?.code).toBe('INVALID_ARGUMENT')
    expect(env.check('matches(x, "(?=a)")').diagnostics[0]?.message).toMatch(/Lookaround/u)
    expect(message(() => env.evaluateSync('matches("a", p)', { p: '\\1' }))).toMatch(
      /Backreferences/u,
    )
  })

  it('stays linear on patterns that make backtracking engines hang', () => {
    const started = performance.now()
    expect(env.evaluateSync('matches(s, "^(a+)+$")', { s: `${'a'.repeat(20_000)}b` })).toBe(false)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

const regexAtom = fc.constantFrom('a', 'b', '.', '\\d', '[ab]', '[^a]', '(a|b)', '(?:ab)', 'x')
const regexQuantifier = fc.constantFrom('', '*', '+', '?', '{2}', '{1,3}')
const regexPattern = fc
  .tuple(
    fc.boolean(),
    fc.array(fc.tuple(regexAtom, regexQuantifier), { minLength: 1, maxLength: 5 }),
    fc.boolean(),
  )
  .map(
    ([start, parts, end]) =>
      `${start ? '^' : ''}${parts.map(([a, q]) => a + q).join('')}${end ? '$' : ''}`,
  )

test.prop([regexPattern, fc.stringMatching(/^[abx1 ]{0,12}$/u)], { numRuns: 2000 })(
  'matches agrees with JavaScript RegExp on generated patterns',
  (pattern, text) => {
    expect(searchRegex(compileRegex(pattern), text, () => undefined)).toBe(
      new RegExp(pattern, 'u').test(text),
    )
  },
)

describe('formatting', () => {
  const at = new Date('2026-07-04T21:05:03.007Z')

  it('formats dates with names, 12-hour clocks, and time zones', () => {
    expect(env.evaluateSync('formatDate(t, "EEEE d MMMM yyyy, h:mm a")', { t: at })).toBe(
      'Saturday 4 July 2026, 9:05 PM',
    )
    expect(env.evaluateSync('formatDate(t, "EEE, MMM d", "Asia/Tokyo")', { t: at })).toBe(
      'Sun, Jul 5',
    )
    expect(env.check('formatDate(now(), "YYYY-MM-DD")').diagnostics[0]?.message).toMatch(
      /Unknown date format letter "Y"/u,
    )
  })

  it('formats numbers and currencies', () => {
    expect(env.evaluateSync('formatNumber(1234567.891, 2)')).toBe('1,234,567.89')
    expect(env.evaluateSync('formatNumber(1234567.891, 2, "de-DE")')).toBe('1.234.567,89')
    expect(env.evaluateSync('formatCurrency(1234.5, "EUR")')).toBe('€1,234.50')
    expect(message(() => env.evaluateSync('formatCurrency(1, "EURO")'))).toMatch(
      /Currency codes are three letters/u,
    )
  })
})

describe('help for common mistakes', () => {
  it.each([
    ['a = 1', 'use == to compare'],
    ['a === 1', 'there is no ==='],
    ['a !== 1', 'there is no !=='],
    ['a and b', 'use &&'],
    ['a or b', 'use ||'],
    ['a & b', 'use &&'],
    ['not a', 'use ! to negate'],
    ['/^A/.test(x)', 'patterns are strings'],
    ['new Date()', 'there is no "new"'],
  ])('%s', (source, hint) => {
    expect(message(() => env.evaluateSync(source))).toContain(hint)
  })

  it.each([
    ['contains("ab", "a")', 'includes'],
    ['x.size()', 'x.length'],
    ['substring(s, 1)', 'slice'],
    ['x.lower()', 'toLowerCase'],
    ['Math.max(1, 2)', 'max(a, b)'],
    ['Date.now()', 'now()'],
  ])('%s suggests %s', (source, hint) => {
    expect(env.check(source).diagnostics[0]?.message).toContain(hint)
  })
})

describe('checker guidance', () => {
  const typed = bonsai({
    variables: {
      order: t.object({ total: t.number(), coupon: t.optional(t.string()) }),
      events: t.list(t.object({ durationMs: t.optional(t.number()) })),
    },
  })

  it('warns on an ordering that may see null only where its false becomes a verdict', () => {
    expect(typed.check('events.filter(.durationMs < 5000)').diagnostics).toEqual([])
    // every() counts an event without a duration as a failure.
    const result = typed.check('events.every(.durationMs < 5000)')
    expect(result.ok).toBe(true)
    expect(result.diagnostics.map((d) => d.code)).toEqual(['MAYBE_NULL'])
    expect(
      typed.check('events.every(.durationMs != null && .durationMs < 5000)').diagnostics,
    ).toEqual([])
  })

  it('names missing and unexpected fields of an expected record', () => {
    const expected = t.object({ discount: t.number(), reason: t.string() })
    expect(typed.check('{ discount: 5 }', { expect: expected }).diagnostics[0]?.message).toContain(
      'missing "reason"',
    )
    // Extra fields are allowed (an expected type means "at least these fields"), but flagged.
    const extra = typed.check('{ discount: 5, reason: "x", reson: "y" }', { expect: expected })
    expect(extra.ok).toBe(true)
    expect(extra.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'EXPECTED_TYPE' })
    expect(extra.diagnostics[0]?.message).toContain('unexpected "reson"')
  })

  it('points a nullable receiver diagnostic at the receiver', () => {
    const [diagnostic] = typed.check('order.coupon.toUpperCase()').diagnostics
    expect(diagnostic).toMatchObject({ code: 'NULLABLE_RECEIVER', start: 0, end: 12 })
  })
})

describe('host functions and context', () => {
  it('validates the context on request', () => {
    const strict = bonsai({
      validateContext: true,
      variables: { user: t.object({ plan: t.enum('free', 'pro'), created: t.timestamp() }) },
    })
    expect(
      message(() =>
        strict.evaluateSync('user.plan', { user: { plan: 'trial', created: new Date() } } as never),
      ),
    ).toContain('user.plan should be "free" | "pro", got string "trial"')
    expect(
      message(() =>
        strict.evaluateSync('user.plan', { user: { plan: 'pro', created: '2026-01-01' } } as never),
      ),
    ).toContain('user.created should be timestamp')
    expect(strict.evaluateSync('user.plan', { user: { plan: 'pro', created: new Date() } })).toBe(
      'pro',
    )
  })
})

describe('editor support', () => {
  const service = createLanguageService(
    bonsai({ variables: { user: t.object({ plan: t.enum('free', 'pro') }) } }),
  )

  it('completes enum values after == and inside the string', () => {
    expect(
      service
        .complete('user.plan == ', 13)
        .items.slice(0, 2)
        .map((i) => i.insertText),
    ).toEqual(['"free"', '"pro"'])
    const inString = service.complete('user.plan == "p', 15)
    expect(inString).toMatchObject({ start: 14, end: 15 })
    expect(inString.items.map((i) => i.label)).toEqual(['pro'])
  })

  it('hovers with the precise type', () => {
    expect(service.hover('user.plan', 6)?.detail).toBe('"free" | "pro"')
  })
})
