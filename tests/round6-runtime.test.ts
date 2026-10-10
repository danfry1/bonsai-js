import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai } from '../src/index.js'

const env = bonsai()

/** The value of `source`, or the code it throws; a raw JavaScript error shows as RAW. */
function outcome(source: string, context: Record<string, unknown> = {}): unknown {
  try {
    return env.evaluateSync(source, context)
  } catch (error) {
    return error instanceof BonsaiError ? error.code : `RAW:${(error as Error).name}`
  }
}

/** The message of what `source` throws. */
function message(source: string, context: Record<string, unknown> = {}): string {
  try {
    env.evaluateSync(source, context)
    return 'ok'
  } catch (error) {
    return (error as Error).message
  }
}

const EARLIEST = -8.64e15

describe('matches never starts inside a surrogate pair', () => {
  const emoji = 'x\u{1F600}'
  it('agrees with the u flag for a pattern beginning with a lone low surrogate', () => {
    expect(outcome(String.raw`s.matches("\\uDE00")`, { s: emoji })).toBe(/\uDE00/u.test(emoji))
    expect(outcome(String.raw`s.matches("\\uDE00$")`, { s: emoji })).toBe(/\uDE00$/u.test(emoji))
    // A lone low surrogate is still found where one stands on its own.
    expect(outcome(String.raw`s.matches("\\uDE00")`, { s: 'x\uDE00' })).toBe(true)
    // Long enough for the prefilter: pairs first, then a lone one at the end.
    const long = `${'\u{1F600}'.repeat(40)}\uDE00`
    expect(outcome(String.raw`s.matches("\\uDE00$")`, { s: long })).toBe(true)
    expect(outcome(String.raw`s.matches("\\uDE00")`, { s: '\u{1F600}'.repeat(40) })).toBe(false)
  })
})

describe('calendar functions at the ends of the timestamp range', () => {
  it('names the weekday of the earliest instant west of UTC', () => {
    expect(outcome(`dayOfWeek(timestamp(${EARLIEST}), "America/New_York")`)).toBe(1)
    expect(
      outcome(`formatDate(timestamp(${EARLIEST}), "EEEE yyyy-MM-dd HH:mm", "America/New_York")`),
    ).toBe('Monday -271821-04-19 19:03')
    expect(outcome(`formatDate(timestamp(${EARLIEST}), "EEE", "America/New_York")`)).toBe('Mon')
  })

  it('adds zero days at the earliest instant as the instant itself', () => {
    expect(
      outcome(`addDays(timestamp(${EARLIEST}), 0, "America/New_York") == timestamp(${EARLIEST})`),
    ).toBe(true)
  })

  it('agrees with a day count for weekdays across the whole range', () => {
    for (const ms of [EARLIEST, EARLIEST + 86_400_000, 0, -1, 8.64e15, 8.64e15 - 1]) {
      const days = Math.floor(ms / 86_400_000)
      const expected = ((((days + 3) % 7) + 7) % 7) + 1
      expect(outcome(`dayOfWeek(timestamp(${ms}))`)).toBe(expected)
    }
  })
})

describe('numbers', () => {
  it('rounds a finite number too large to shift by leaving it as it is', () => {
    expect(outcome('round(1e300, 9)')).toBe(1e300)
    expect(outcome('round(1e294, 15)')).toBe(1e294)
    expect(outcome('round(1.7976931348623157e308, 1)')).toBe(1.7976931348623157e308)
    expect(outcome('round(9007199254740993, 2)')).toBe(9_007_199_254_740_992)
    expect(outcome('round(1.005, 2)')).toBe(1.01)
  })

  it('writes toFixed in fixed notation however large the number', () => {
    expect(outcome('toFixed(1e21, 2)')).toBe('1000000000000000000000.00')
    expect(outcome('toFixed(-1.5e22, 0)')).toBe('-15000000000000000000000')
    expect(outcome('toFixed(123.456, 2)')).toBe('123.46')
  })

  it('never shows a negative zero when formatting', () => {
    expect(outcome('formatCurrency(0.3 - 0.1 - 0.2, "USD")')).toBe('$0.00')
    expect(outcome('formatCurrency(-0.004, "USD")')).toBe('$0.00')
    expect(outcome('formatNumber(-1e-21)')).toBe('0')
    expect(outcome('formatNumber(-0.0001, 2)')).toBe('0.00')
    expect(outcome('formatCurrency(-1.5, "USD")')).toBe('-$1.50')
    expect(outcome('formatNumber(-2, 1)')).toBe('-2.0')
  })

  it('prints a currency code it has no symbol for as the code', () => {
    expect(outcome('formatCurrency(1, "ZZZ")')).toBe('ZZZ 1.00')
    expect(outcome('formatCurrency(1, "ZZZZ")')).toBe('CHECK')
  })
})

describe('durations', () => {
  it('sums durations checking the range at each step, as a + b + c does', () => {
    const items = '[milliseconds(9007199254740991), milliseconds(2), milliseconds(-2)]'
    expect(outcome(`${items}.sum()`)).toBe('INVALID_ARGUMENT')
    expect(outcome('milliseconds(9007199254740991) + milliseconds(2)')).toBe('INVALID_ARGUMENT')
    expect(outcome(`${items}.avg()`)).toBe('INVALID_ARGUMENT')
    expect(outcome('[milliseconds(5), milliseconds(-2)].sum() == milliseconds(3)')).toBe(true)
  })
})

describe('formatDate quoting', () => {
  it("follows LDML: '' inside quotes is a quote", () => {
    expect(outcome(`formatDate(timestamp(0), "'it''s' HH")`)).toBe("it's 00")
    expect(outcome(`formatDate(timestamp(0), "HH '' mm")`)).toBe("00 ' 00")
    expect(outcome(`formatDate(timestamp(0), "'at' HH")`)).toBe('at 00')
  })

  it('rejects a quote left open, at check time for a literal pattern and at run time otherwise', () => {
    expect(outcome(`formatDate(timestamp(0), "'unterminated")`)).toBe('CHECK')
    expect(outcome(`formatDate(timestamp(0), "'a")`)).toBe('CHECK')
    expect(outcome('formatDate(timestamp(0), p)', { p: "'a" })).toBe('INVALID_ARGUMENT')
    expect(message('formatDate(timestamp(0), p)', { p: "HH 'x" })).toMatch(/not closed/u)
  })
})

describe('regular expression errors', () => {
  it('names flag groups when it rejects one', () => {
    expect(message('"a".matches(p)', { p: '(?i:a)' })).toMatch(/Flag groups/u)
    expect(message('"a".matches(p)', { p: '(?-i:a)' })).toMatch(/Flag groups/u)
    expect(message('"a".matches(p)', { p: '(?=a)' })).toMatch(/Lookaround/u)
  })
})

describe('timestamp text reads back', () => {
  it('parses the extended years a timestamp renders outside 0000-9999', () => {
    for (const ms of [-1e14, 3e14, -8.64e15, 8.64e15, -62_198_755_200_000]) {
      expect(outcome(`timestamp(toString(timestamp(${ms}))) == timestamp(${ms})`)).toBe(true)
      expect(outcome(`timestamp(\`\${timestamp(${ms})}\`) == timestamp(${ms})`)).toBe(true)
    }
    expect(outcome('timestamp("+012345-01-01")')).toEqual(new Date('+012345-01-01T00:00:00Z'))
    expect(outcome('timestamp("-000000-01-01")')).toBe('INVALID_ARGUMENT')
    expect(outcome('timestamp("12345-01-01")')).toBe('INVALID_ARGUMENT')
  })

  it('drops a fraction of epoch milliseconds toward zero', () => {
    expect(outcome('timestamp(1.9) == timestamp(1)')).toBe(true)
    expect(outcome('timestamp(-1.5) == timestamp(-1)')).toBe(true)
  })
})

describe('error messages quote input on a character boundary', () => {
  it('never ends a shortened quote on half of a surrogate pair', () => {
    const s = `${'a'.repeat(39)}\u{1F4A9}`
    const text = message('toNumber(s)', { s })
    expect(text).not.toMatch(/\\ud83d/u)
    expect(text).toContain(`"${'a'.repeat(39)}..."`)
  })
})
