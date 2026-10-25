import { describe, expect, it } from 'vitest'
import { bonsai, formatType, t } from '../src/index.js'

// The types arithmetic checks to, and what it reports when an operation cannot
// apply: the message, its hint, and the range it underlines.

const env = bonsai({
  variables: {
    n: t.number(),
    s: t.string(),
    ts: t.timestamp(),
    ns: t.list(t.number()),
    ss: t.list(t.string()),
    nd: t.union(t.number(), t.duration()),
    on: t.optional(t.number()),
    lists: t.union(t.list(t.number()), t.list(t.string())),
  },
})

const typeOf = (result: { type?: Parameters<typeof formatType>[0] | undefined }): string => {
  if (result.type === undefined) throw new Error('expected the source to parse')
  return formatType(result.type)
}

const checked = (source: string) => {
  const result = env.check(source)
  return {
    type: typeOf(result),
    problems: result.diagnostics.map((d) => [d.message, d.start, d.end]),
  }
}

describe('arithmetic types', () => {
  it.each([
    ['ns + ss', '(number | string)[]'],
    ['lists + ns', '(number | string)[]'],
    ['ns + lists', '(number | string)[]'],
    ['nd * n', 'number | duration'],
    ['n * nd', 'number | duration'],
  ])('%s checks to %s', (source, type) => {
    expect(checked(source)).toEqual({ type, problems: [] })
  })

  it.each([
    ['ns + n', 'Cannot apply "+" to number[] and number', 6],
    ['n + ns', 'Cannot apply "+" to number and number[]', 6],
    ['ns - ns', 'Cannot apply "-" to number[] and number[]', 7],
    // One member pair (duration + number) cannot apply, so the whole union cannot.
    ['nd + n', 'Cannot apply "+" to number | duration and number', 6],
  ])('%s cannot apply', (source, message, end) => {
    expect(checked(source)).toEqual({ type: 'any', problems: [[message, 0, end]] })
  })
})

describe('a nullable operand', () => {
  it('is reported where it is, and the result keeps its type', () => {
    const message = 'An operand of "+" may be null; use ?? to supply a default'
    expect(checked('on + 1')).toEqual({ type: 'number', problems: [[message, 0, 2]] })
    expect(checked('n + on')).toEqual({ type: 'number', problems: [[message, 4, 6]] })
  })

  it('in an operation that fails anyway is reported as that failure', () => {
    expect(checked('on + s').problems).toEqual([
      ['Cannot apply "+" to number | null and string; use a template to build text', 0, 6],
    ])
  })
})

describe('an operand of unknown type', () => {
  // In an open environment an undeclared variable is any: + with text is text,
  // %, and ** are numbers, and the other operators stay unknown.
  const open = bonsai()
  it.each([
    ['x + "a"', 'string'],
    ['"a" + x', 'string'],
    ['x + 1', 'any'],
    ['x - 1', 'any'],
    ['x * 2', 'any'],
    ['x / 2', 'any'],
    ['x % 2', 'number'],
    ['x ** 2', 'number'],
  ])('%s checks to %s', (source, type) => {
    const result = open.check(source)
    expect([typeOf(result), result.diagnostics]).toEqual([type, []])
  })
})

describe('hints', () => {
  it.each([
    ['s + 1', 'Cannot apply "+" to string and 1; use a template to build text'],
    ['1 + s', 'Cannot apply "+" to 1 and string; use a template to build text'],
    ['ts + 1', 'Cannot apply "+" to timestamp and 1; use a duration such as days(30)'],
    ['n - ts', 'Cannot apply "-" to number and timestamp; use a duration such as days(30)'],
    ['ts * 2', 'Cannot apply "*" to timestamp and 2; use a duration such as days(30)'],
    // Only + builds text, so other operators on a string get no template hint.
    ['s - 1', 'Cannot apply "-" to string and 1'],
    // The duration hint is for a timestamp with a number, not with anything.
    ['ts - s', 'Cannot apply "-" to timestamp and string'],
    ['n - s', 'Cannot apply "-" to number and string'],
  ])('%s', (source, message) => {
    expect(checked(source).problems.map(([text]) => text)).toEqual([message])
  })
})
