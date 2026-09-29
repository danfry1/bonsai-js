import { describe, expect, it } from 'vitest'
import { bonsai, t } from '../src/index.js'
import { outcome } from './helpers.js'
import { createLanguageService } from '../src/service/index.js'

describe('context that does not match its declared types', () => {
  const env = bonsai({ variables: { s: t.string(), d: t.timestamp(), xs: t.list(t.string()) } })

  it('never calls functions found in mistyped data', () => {
    let called = false
    const s = { trim: () => ((called = true), 'x') }
    expect(outcome(() => env.evaluateSync('s.trim()', { s } as never))).toEqual({
      code: 'NO_OVERLOAD',
    })
    expect(
      outcome(() =>
        env.evaluateSync('d.year()', { d: { getTime: () => ((called = true), 0) } } as never),
      ),
    ).toEqual({
      code: 'NO_OVERLOAD',
    })
    expect(called).toBe(false)
  })

  it('reports missing declared data as a Bonsai error that try() can catch', () => {
    expect(outcome(() => env.evaluateSync('s.startsWith("a")', {} as never))).toEqual({
      code: 'NULL_RECEIVER',
    })
    expect(env.evaluateSync('try(s.startsWith("a"), false)', {} as never)).toBe(false)
    expect(outcome(() => env.evaluateSync('xs.map(.toUpperCase())', { xs: [1] } as never))).toEqual(
      {
        code: 'NO_OVERLOAD',
      },
    )
  })

  it('types fields a spread may overwrite', () => {
    const typed = bonsai({
      variables: { m: t.record(t.number()), u: t.object({ name: t.string() }) },
    })
    // The record's values may replace `s`, so `s` is string | number.
    expect(typed.check('{ s: "x", ...m }.s.toUpperCase()').ok).toBe(false)
    // A closed object may still carry undeclared keys at runtime.
    expect(typed.check('{ s: "x", ...u }.s.toUpperCase()').ok).toBe(true)
    expect(
      outcome(() =>
        typed.evaluateSync('{ s: "x", ...u }.s.toUpperCase()', { u: { name: 'a', s: 5 } } as never),
      ),
    ).toEqual({
      code: 'NO_OVERLOAD',
    })
  })
})

describe('deep expressions fail closed or balance', () => {
  const env = bonsai()
  const service = createLanguageService(env)

  it('balances long logical chains', () => {
    const rule = Array.from({ length: 3000 }, (_, i) => `x != ${i + 1}`).join(' && ')
    expect(env.evaluateSync(rule, { x: 0 })).toBe(true)
    expect(
      env.evaluateSync(`${Array.from({ length: 3000 }, () => 'null').join(' ?? ')} ?? 7`),
    ).toBe(7)
    expect(() => service.diagnostics(rule)).not.toThrow()
  })

  it('bounds other deep chains with TOO_DEEP', () => {
    for (const source of [
      Array.from({ length: 2000 }, () => '1').join(' + '),
      `x${'.a'.repeat(5000)}`,
      `"a"${'.trim()'.repeat(5000)}`,
      `x${'[0]'.repeat(2000)}`,
    ]) {
      expect(outcome(() => env.evaluateSync(source, { x: null }))).toEqual({ code: 'TOO_DEEP' })
      expect(() => service.diagnostics(source)).not.toThrow()
      expect(() => service.complete(source, source.length)).not.toThrow()
    }
  })
})

describe('work is bounded by steps', () => {
  it('charges lambda bodies by size', () => {
    const env = bonsai({ limits: { maxSteps: 100_000 } })
    const body = `[${Array.from({ length: 500 }, () => 'x').join(',')}]`
    expect(
      outcome(() =>
        env.evaluateSync(`xs.map(x => ${body}).length`, {
          xs: Array.from({ length: 1000 }, (_, i) => i),
        }),
      ),
    ).toEqual({
      code: 'STEP_LIMIT',
    })
  })

  it('charges string work by length', () => {
    const env = bonsai({ limits: { maxSteps: 100_000 } })
    const big = `'${'x'.repeat(50_000)}'`
    expect(
      outcome(() =>
        env.evaluateSync('xs.count(x => formatDate(now(), big).length > 0)', {
          big,
          xs: Array.from({ length: 1000 }, () => 0),
        }),
      ),
    ).toEqual({
      code: 'STEP_LIMIT',
    })
  })

  it('checks every produced string and list', () => {
    const env = bonsai({ limits: { maxStringLength: 1000, maxListLength: 100 } })
    expect(outcome(() => env.evaluateSync('toUpperCase(s)', { s: 'ß'.repeat(600) }))).toEqual({
      code: 'STRING_LIMIT',
    })
    expect(outcome(() => env.evaluateSync('replace(s, "", s)', { s: 'a'.repeat(600) }))).toEqual({
      code: 'STRING_LIMIT',
    })
    const xs = Array.from({ length: 200 }, (_, i) => i)
    for (const source of ['xs.reverse()', 'xs.slice(0)', 'xs.unique()', 'split(s, ",")']) {
      expect(outcome(() => env.evaluateSync(source, { xs, s: ','.repeat(500) }))).toEqual({
        code: 'LIST_LIMIT',
      })
    }
  })
})

describe('checker soundness', () => {
  const env = bonsai({
    strict: true,
    variables: {
      o: t.list(
        t.object({ tags: t.list(t.string()), opt: t.optional(t.string()), id: t.number() }),
      ),
      a: t.number(),
    },
  })
  it.each([
    'o.groupBy(.tags)',
    'o.groupBy(.opt)',
    'o.max()',
    '[days(1), 1].sort()',
    'o.sortBy(.id > 1)',
    'o.map(.tags).join("-")',
    '"a" in (a == 1)',
    'map(...[[1, 2]], x => x)',
    'toString',
    'toString + 1',
  ])('rejects %s', (source) => {
    expect(env.check(source).ok).toBe(false)
  })

  it.each(['o.first()?.opt != null ? o.first()?.opt?.length : 0', '[].find(.x)', '[].sum()'])(
    'accepts %s',
    (source) => {
      expect(env.check(source).ok).toBe(true)
    },
  )
})

describe('time and number edge cases', () => {
  const env = bonsai()
  const iso = (source: string): string => env.evaluateSync<Date>(source).toISOString()

  it('keeps years 0-99', () => {
    expect(iso('timestamp("0050-06-15")')).toBe('0050-06-15T00:00:00.000Z')
    expect(iso('addMonths(timestamp("0050-01-31"), 1)')).toBe('0050-02-28T00:00:00.000Z')
    expect(env.evaluateSync('dayOfWeek(timestamp("0001-01-01"))')).toBe(1)
  })

  it('resolves DST gaps forward and overlaps to the earlier instant, preserving the offset', () => {
    expect(iso('startOfDay(timestamp("2024-09-08T12:00:00Z"), "America/Santiago")')).toBe(
      '2024-09-08T04:00:00.000Z',
    )
    expect(iso('addDays(timestamp("2024-11-03T06:30:00Z"), 0, "America/New_York")')).toBe(
      '2024-11-03T06:30:00.000Z',
    )
    expect(iso('addDays(timestamp("2024-10-27T00:30:00Z"), 0, "Europe/Berlin")')).toBe(
      '2024-10-27T00:30:00.000Z',
    )
    expect(iso('addDays(timestamp("2024-03-09T07:30:00Z"), 1, "America/New_York")')).toBe(
      '2024-03-10T07:30:00.000Z',
    )
  })

  it('rounds any magnitude', () => {
    expect(env.evaluateSync('round(0.0000001, 2)')).toBe(0)
    expect(env.evaluateSync('round(0.000000123, 9)')).toBe(1.23e-7)
    expect(env.evaluateSync('round(1e21)')).toBe(1e21)
  })

  it('rejects non-finite literals and invalid offsets', () => {
    expect(outcome(() => env.evaluateSync('1e999'))).toEqual({ code: 'SYNTAX' })
    expect(outcome(() => env.evaluateSync('timestamp("2024-01-01T00:00+99:99")'))).toEqual({
      code: 'INVALID_ARGUMENT',
    })
  })
})

describe('second review round', () => {
  const env = bonsai()
  const matches = (pattern: string, text: string): unknown =>
    outcome(() => env.evaluateSync('matches(text, pattern)', { text, pattern }))

  it('bounds regex compilation and nesting', () => {
    const started = performance.now()
    expect(matches('(?:(?:(?:){1000}){1000}){1000}', 'x')).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('parses class ranges with escaped endpoints and code points', () => {
    expect(matches('[\\x00-\\x1f]', '\u0005')).toEqual({ value: true })
    expect(matches('[a-\\x7a]', 'z')).toEqual({ value: true })
    expect(matches('[😀]', '😁')).toEqual({ value: false })
  })

  it('reports a context value of the wrong kind as INVALID_CONTEXT', () => {
    const typed = bonsai({
      validateContext: true,
      variables: { n: t.number(), r: t.record(t.number()) },
    })
    expect(outcome(() => typed.evaluateSync('n', { n: 1n, r: {} } as never))).toEqual({
      code: 'INVALID_CONTEXT',
    })
  })

  it('reports only the unknown function for a misspelled lambda call', () => {
    expect(env.check('xs.fitler(. == "a")').diagnostics.map((d) => d.code)).toEqual([
      'UNKNOWN_FUNCTION',
    ])
  })

  it('ignores blocked keys in equality like keys() does', () => {
    expect(
      env.evaluateSync('j == {ok: 2}', { j: JSON.parse('{"__proto__":{},"ok":2}') as object }),
    ).toBe(true)
  })
})
