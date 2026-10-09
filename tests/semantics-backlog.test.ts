import { describe, expect, it } from 'vitest'
import { Duration, bonsai, t } from '../src/index.js'
import { run } from './helpers.js'

// Meanings settled before 1.0, when stored expressions start depending on them.

describe('durations are whole milliseconds', () => {
  const d1960 = new Date('1960-01-01T00:00:00Z')
  const d2026 = new Date('2026-01-01T00:00:00Z')

  it('rounds at creation and after arithmetic, halves away from zero', () => {
    expect(run('inMilliseconds(milliseconds(0.5))')).toEqual({ value: 1 })
    expect(run('inMilliseconds(milliseconds(-0.5))')).toEqual({ value: -1 })
    expect(run('inMilliseconds(milliseconds(0.4))')).toEqual({ value: 0 })
    expect(run('inMilliseconds(days(1) / 7)')).toEqual({ value: 12_342_857 })
    expect(run('inMilliseconds(seconds(1) * 0.0015)')).toEqual({ value: 2 })
    expect(new Duration(2.5).ms).toBe(3)
    expect(Object.is(new Duration(-0.4).ms, 0)).toBe(true)
  })

  it('keeps duration and timestamp arithmetic exact, whatever the epoch sign', () => {
    expect(run('(t + days(1) / 7) - t == days(1) / 7', { t: d2026 })).toEqual({ value: true })
    for (const at of [d1960, d2026]) {
      expect(run('t + milliseconds(0.5) == t + milliseconds(1)', { t: at })).toEqual({
        value: true,
      })
    }
    expect(run('`${milliseconds(0.0001)}`')).toEqual({ value: 'PT0S' })
  })
})

describe('computed reads of blocked names', () => {
  const dict = JSON.parse('{"constructor":"Konstrukteur","hello":"hallo"}') as object

  it('read as null, like in, has, and keys, so ?? supplies the default', () => {
    for (const k of ['constructor', '__proto__', 'prototype']) {
      expect(run('dict[k]', { dict, k })).toEqual({ value: null })
      expect(run('dict[k] ?? k', { dict, k })).toEqual({ value: k })
    }
    expect(run('words.map(dict[.] ?? .)', { dict, words: ['hello', 'constructor'] })).toEqual({
      value: ['hallo', 'constructor'],
    })
  })

  it('stay errors when written, and as static keys', () => {
    expect(run('{[k]: 1}', { k: 'constructor' })).toEqual({ code: 'BLOCKED_PROPERTY' })
    expect(run('dict.constructor', { dict })).toEqual({ code: 'SYNTAX' })
  })
})

describe('time zone names', () => {
  const at = new Date('2026-01-01T00:00:00Z')

  it('accept UTC and IANA names in canonical case', () => {
    expect(run('hour(t, "UTC")', { t: at })).toEqual({ value: 0 })
    expect(run('hour(t, "America/Argentina/Buenos_Aires")', { t: at })).toEqual({ value: 21 })
    expect(run('hour(t, "Etc/GMT+5")', { t: at })).toEqual({ value: 19 })
    expect(run('hour(t, "US/Eastern")', { t: at })).toEqual({ value: 19 })
  })

  it('reject names whose meaning depends on the engine', () => {
    for (const zone of [
      'EST',
      'GB',
      'utc',
      'GMT',
      'europe/london',
      'Europe/LONDON',
      '+05:30',
      'Z',
    ]) {
      expect(run(`hour(t, ${JSON.stringify(zone)})`, { t: at }), zone).toEqual({
        code: 'INVALID_ARGUMENT',
      })
    }
  })
})

describe('warnings that say what a comparison does', () => {
  const env = bonsai({
    variables: {
      u: t.object({ age: t.number(), ok: t.optional(t.boolean()) }),
      plan: t.enum('free', 'pro'),
    },
  })
  const codes = (source: string): string[] => env.check(source).diagnostics.map((d) => d.code)

  it('report an always-true comparison as ALWAYS_TRUE', () => {
    expect(codes('u.age != null')).toEqual(['ALWAYS_TRUE'])
    expect(codes('u.age == null')).toEqual(['ALWAYS_FALSE'])
    expect(codes('plan not in ["gold"]')).toEqual(['ALWAYS_TRUE'])
    expect(codes('plan in ["gold"]')).toEqual(['ALWAYS_FALSE'])
  })

  it('warn when a condition may be null, which counts as false', () => {
    for (const source of ['!u.ok', 'u.ok && true', 'true || u.ok', 'u.ok ? 1 : 2']) {
      expect(codes(source), source).toEqual(['MAYBE_NULL'])
    }
    for (const source of ['u.ok == true', '!(u.ok ?? false)', 'u.ok != null && u.ok']) {
      expect(codes(source), source).toEqual([])
    }
  })

  it('warn on integer literals beyond the safe range', () => {
    expect(codes('9007199254740993 == 9007199254740992')).toEqual([
      'UNSAFE_INTEGER',
      'UNSAFE_INTEGER',
    ])
    expect(codes('1e20 + 1 == 1e20')).toEqual(['UNSAFE_INTEGER', 'UNSAFE_INTEGER'])
    expect(codes('9007199254740991 + 0.5 + 1.5e300')).toEqual(['UNSAFE_INTEGER'])
    expect(codes('9007199254740991 + 0.5 + 1e-300')).toEqual([])
  })
})
