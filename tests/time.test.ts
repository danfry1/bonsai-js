import { describe, expect, it } from 'vitest'
import { Duration, bonsai } from '../src/index.js'

const clock = new Date('2026-03-29T00:30:00Z')
const env = bonsai({ clock: () => clock })
const iso = (source: string, ctx: Record<string, unknown> = {}): string =>
  env.evaluateSync<Date>(source, ctx).toISOString()

describe('timestamps and durations', () => {
  it('parses ISO-8601 strictly', () => {
    expect(iso('timestamp("2026-02-03")')).toBe('2026-02-03T00:00:00.000Z')
    expect(iso('timestamp("2026-02-03T04:05:06.789+02:00")')).toBe('2026-02-03T02:05:06.789Z')
    for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow', '2026-02-03T25:00', '']) {
      expect(() => env.evaluateSync(`timestamp("${bad}")`)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    }
  })

  it('does duration arithmetic', () => {
    expect(env.evaluateSync('inHours(days(1) + hours(2))')).toBe(26)
    expect(env.evaluateSync('`${days(2) + seconds(1.5)}`')).toBe('P2DT1.5S')
    expect(env.evaluateSync('days(1) / hours(1)')).toBe(24)
    expect(env.evaluateSync('days(1) > hours(23)')).toBe(true)
    expect(env.evaluateSync('d', { d: new Duration(5) })).toEqual(new Duration(5))
  })

  it('fixes now() for one evaluation', () => {
    expect(iso('now()')).toBe(clock.toISOString())
    expect(env.evaluateSync('now() - t < days(1)', { t: new Date('2026-03-28T12:00:00Z') })).toBe(
      true,
    )
  })

  it('rejects numbers where durations are meant', () => {
    expect(() => env.evaluateSync('t + 30', { t: clock })).toThrow(/use a duration/u)
  })

  it('treats an invalid Date as an error when used', () => {
    expect(() => env.evaluateSync('t < now()', { t: new Date('nope') })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })
})

describe('calendar and time zones', () => {
  it('reads fields in a zone', () => {
    const t = new Date('2026-12-31T23:30:00Z')
    expect(env.evaluateSync('year(t)', { t })).toBe(2026)
    expect(env.evaluateSync('year(t, "Asia/Tokyo")', { t })).toBe(2027)
    expect(env.evaluateSync('dayOfWeek(t)', { t })).toBe(4)
    expect(() => env.evaluateSync('year(t, "Mars/Olympus")', { t })).toThrow(/Unknown time zone/u)
  })

  it('handles DST in startOfDay and addDays', () => {
    // Europe/Berlin springs forward on 2026-03-29 at 02:00 local.
    expect(iso('startOfDay(t, "Europe/Berlin")', { t: new Date('2026-03-29T12:00:00Z') })).toBe(
      '2026-03-28T23:00:00.000Z',
    )
    expect(iso('addDays(t, 1, "Europe/Berlin")', { t: new Date('2026-03-28T11:00:00Z') })).toBe(
      '2026-03-29T10:00:00.000Z',
    )
    // America/New_York falls back on 2026-11-01.
    expect(iso('startOfDay(t, "America/New_York")', { t: new Date('2026-11-01T18:00:00Z') })).toBe(
      '2026-11-01T04:00:00.000Z',
    )
    expect(iso('addDays(t, 1, "America/New_York")', { t: new Date('2026-10-31T16:00:00Z') })).toBe(
      '2026-11-01T17:00:00.000Z',
    )
  })

  it('clamps month arithmetic', () => {
    expect(iso('addMonths(timestamp("2026-01-31"), 1)')).toBe('2026-02-28T00:00:00.000Z')
    expect(iso('addMonths(timestamp("2026-03-15"), -15)')).toBe('2024-12-15T00:00:00.000Z')
  })

  it('formats dates', () => {
    const t = new Date('2026-07-04T09:05:03.007Z')
    expect(env.evaluateSync('formatDate(t, "yyyy-MM-dd HH:mm:ss.SSS")', { t })).toBe(
      '2026-07-04 09:05:03.007',
    )
    expect(env.evaluateSync('formatDate(t, "dd \'at\' HH:mm", "America/Los_Angeles")', { t })).toBe(
      '04 at 02:05',
    )
  })
})
