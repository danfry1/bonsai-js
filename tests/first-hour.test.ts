import { describe, expect, it } from 'vitest'
import * as main from '../src/index.js'
import { bonsai, t } from '../src/index.js'
import * as query from '../src/query/index.js'
import { warmZone } from '../src/runtime/time.js'

describe('"??" beside "&&" or "||"', () => {
  const env = bonsai({ strict: false })
  const first = (source: string) => env.check(source).diagnostics[0]

  it('points at the "??" and shows both readings', () => {
    const left = first('b && a?.endsWith("x") ?? false')
    expect(left?.message).toBe(
      'Parenthesize "??" when mixing it with "&&": write (a && b) ?? c or a && (b ?? c)',
    )
    expect(left?.span).toEqual({ start: 22, end: 24 })
    const right = first('a ?? b || c')
    expect(right?.message).toBe(
      'Parenthesize "??" when mixing it with "||": write (a ?? b) || c or a ?? (b || c)',
    )
    expect(right?.span).toEqual({ start: 2, end: 4 })
  })

  it('frames the line holding the "??" in a multi-line rule', () => {
    const diagnostic = first('b\n  && n > 1\n  && a ?? "z" == "q"')
    expect(diagnostic?.position).toEqual({ line: 3, column: 8 })
    expect(diagnostic?.formatted.split('\n').slice(1)).toEqual([
      '3 |   && a ?? "z" == "q"',
      '  |        ^^',
    ])
  })
})

describe('BonsaiTranslationError', () => {
  it('is exported from the main entry as the same class', () => {
    expect(main.BonsaiTranslationError).toBe(query.BonsaiTranslationError)
    let caught: unknown
    try {
      query.toSQL(bonsai().compile('order.total / 2 > 1'), {
        row: 'order',
        columns: { total: 'number' },
        dialect: 'sqlite',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(main.BonsaiTranslationError)
    expect(caught).toBeInstanceOf(main.BonsaiError)
    expect((caught as main.BonsaiError).name).toBe('BonsaiTranslationError')
  })
})

describe('UNKNOWN_PROPERTY names the receiver', () => {
  const env = bonsai({
    variables: {
      customer: t.object({ tier: t.string(), address: t.object({ city: t.string() }) }),
      items: t.list(t.object({ sku: t.string(), qty: t.number() })),
    },
  })
  const message = (source: string) =>
    env.check(source).diagnostics.find((d) => d.code === 'UNKNOWN_PROPERTY')?.message

  it('by its path when it is one', () => {
    expect(message('customer.teir == "gold"')).toBe(
      'Property "teir" does not exist on customer; did you mean "tier"?',
    )
    expect(message('customer?.address.cty')).toBe(
      'Property "cty" does not exist on customer?.address; did you mean "city"?',
    )
    expect(message('items.map(x => x.qtty)')).toBe(
      'Property "qtty" does not exist on x; did you mean "qty"?',
    )
  })

  it('by its type otherwise', () => {
    expect(message('items.map(.qtty)')).toBe(
      'Property "qtty" does not exist on { sku: string, qty: number }; did you mean "qty"?',
    )
    expect(message('items[0].qtty')).toBe(
      'Property "qtty" does not exist on { sku: string, qty: number }; did you mean "qty"?',
    )
  })

  it('keeps the span and suggestion', () => {
    const diagnostic = env.check('customer.teir').diagnostics[0]
    expect(diagnostic).toMatchObject({ code: 'UNKNOWN_PROPERTY', suggestion: 'tier' })
    expect(diagnostic?.span).toEqual({ start: 9, end: 13 })
  })
})

describe('time zones loaded at compile time', () => {
  const env = bonsai({ variables: { at: t.timestamp(), zone: t.string() } })
  const at = new Date(Date.UTC(2026, 0, 15, 12))

  it('never throws for a zone evaluation rejects, which evaluation still reports', () => {
    for (const zone of ['Mars/Base', 'Europe/LONDON', 'x'.repeat(100), undefined]) {
      expect(() => {
        warmZone(zone)
      }).not.toThrow()
    }
    expect(() => env.compile('hour(at, "Mars/Base")')).not.toThrow()
    expect(() => env.evaluateSync('hour(at, "Mars/Base")', { at, zone: '' })).toThrow(
      /Unknown time zone "Mars\/Base"/u,
    )
    expect(() => env.evaluateSync('hour(at, "Europe/LONDON")', { at, zone: '' })).toThrow(
      /Write the time zone as "Europe\/London"/u,
    )
  })

  it('gives the same results for literal and data zones', () => {
    expect(env.evaluateSync('hour(at, "Asia/Tokyo")', { at, zone: '' })).toBe(21)
    expect(env.evaluateSync('at.hour(zone)', { at, zone: 'Asia/Tokyo' })).toBe(21)
    expect(env.evaluateSync('formatDate(at, "HH:mm", "Europe/Paris")', { at, zone: '' })).toBe(
      '13:00',
    )
  })
})
