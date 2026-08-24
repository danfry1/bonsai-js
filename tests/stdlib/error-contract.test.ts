import { describe, expect, it } from 'vitest'
import { bonsai, BonsaiTypeError } from '../../src/index.js'
import { arrays, dates, math, strings, types } from '../../src/stdlib/index.js'

const expr = bonsai().use(arrays).use(dates).use(math).use(strings).use(types)

function typeError(source: string, context: Record<string, unknown> = {}): BonsaiTypeError {
  try {
    expr.evaluateSync(source, context)
  } catch (error) {
    expect(error).toBeInstanceOf(BonsaiTypeError)
    return error as BonsaiTypeError
  }
  throw new Error(`expected BonsaiTypeError from ${source}`)
}

describe('bundled stdlib error identity', () => {
  it.each([
    'count',
    'first',
    'last',
    'reverse',
    'flatten',
    'unique',
    'join',
    'sort',
    'filter',
    'map',
    'find',
    'some',
    'every',
  ])('%s identifies itself when its input is not an array', (name) => {
    expect(typeError(`value |> ${name}`, { value: 1 })).toMatchObject({
      transform: name,
      expected: 'an array',
      received: 'number',
    })
  })

  it.each(['filter', 'map', 'find', 'some', 'every'])(
    '%s identifies an invalid callback',
    (name) => {
      expect(typeError(`items |> ${name}(1)`, { items: [1] })).toMatchObject({
        transform: name,
        expected: 'a Bonsai lambda callback (e.g. .field or . > value)',
        received: 'number',
      })
    },
  )

  it.each([
    ['upper', 'value |> upper'],
    ['lower', 'value |> lower'],
    ['trim', 'value |> trim'],
    ['split', 'value |> split(",")'],
    ['replace', 'value |> replace("a", "b")'],
    ['replaceAll', 'value |> replaceAll("a", "b")'],
    ['startsWith', 'value |> startsWith("a")'],
    ['endsWith', 'value |> endsWith("a")'],
    ['includes', 'value |> includes("a")'],
    ['padStart', 'value |> padStart(2)'],
    ['padEnd', 'value |> padEnd(2)'],
  ])('%s identifies itself when its input is not a string', (name, source) => {
    expect(typeError(source, { value: 1 })).toMatchObject({
      transform: name,
      expected: 'a string',
      received: 'number',
    })
  })

  it.each(['round', 'floor', 'ceil', 'abs'])(
    '%s identifies itself when its input is not numeric',
    (name) => {
      expect(typeError(`value |> ${name}`, { value: '1' })).toMatchObject({
        transform: name,
        expected: 'a number',
        received: 'string',
      })
    },
  )

  it.each(['sum', 'avg'])('%s identifies invalid arrays and elements', (name) => {
    expect(typeError(`value |> ${name}`, { value: 1 })).toMatchObject({
      transform: name,
      expected: 'an array of numbers',
      received: 'number',
    })
    expect(typeError(`value |> ${name}`, { value: [1, '2'] })).toMatchObject({
      transform: name,
      expected: 'an array of numbers (all elements must be numbers)',
      received: 'string',
    })
  })

  it('preserves clamp/min/max error identities for every argument position', () => {
    for (const [source, transform] of [
      ['value |> clamp(0, 1)', 'clamp'],
      ['1 |> clamp(value, 1)', 'clamp'],
      ['1 |> clamp(0, value)', 'clamp'],
      ['min(1, value)', 'min'],
      ['max(1, value)', 'max'],
    ] as const) {
      expect(typeError(source, { value: 'bad' }).transform).toBe(transform)
    }

    expect(typeError('1 |> clamp(lo, 2)', { lo: Number.NaN })).toMatchObject({
      transform: 'clamp',
      expected: 'a finite number for min',
    })
    expect(typeError('1 |> clamp(0, hi)', { hi: Number.POSITIVE_INFINITY })).toMatchObject({
      transform: 'clamp',
      expected: 'a finite number for max',
    })
    expect(typeError('1 |> clamp(2, 1)')).toMatchObject({
      transform: 'clamp',
      expected: 'min to be <= max',
    })
  })

  it('preserves date-transform error identities for input and argument failures', () => {
    expect(typeError('value |> formatDate("YYYY")', { value: 'bad' }).transform).toBe('formatDate')
    expect(
      typeError('value |> formatDate(format)', { value: 'bad', format: 'YYYY' }),
    ).toMatchObject({
      transform: 'formatDate',
      expected: 'a number (timestamp)',
    })
    expect(typeError('0 |> formatDate(value)', { value: 1 })).toMatchObject({
      transform: 'formatDate',
      expected: 'a string',
    })
    expect(typeError('value |> diffDays(0)', { value: 'bad' })).toMatchObject({
      transform: 'diffDays',
      expected: 'a number (timestamp)',
    })
    expect(typeError('0 |> diffDays(value)', { value: 'bad' })).toMatchObject({
      transform: 'diffDays',
      expected: 'a number (timestamp)',
    })
    expect(
      typeError('value |> formatDate(format)', { value: Number.NaN, format: 'YYYY' }),
    ).toMatchObject({
      transform: 'formatDate',
      expected: 'a valid timestamp',
    })
  })

  it('normalizes string allocation and required-argument failures', () => {
    expect(typeError('text |> split', { text: 'x' })).toMatchObject({
      transform: 'split',
      expected: 'a separator argument',
    })
    for (const name of ['padStart', 'padEnd'] as const) {
      expect(typeError(`text |> ${name}(length)`, { text: 'x', length: Number.NaN })).toMatchObject(
        {
          transform: name,
          expected: 'a non-negative number for length',
        },
      )
      expect(typeError(`text |> ${name}(100001)`, { text: 'x' })).toMatchObject({
        transform: name,
        expected: 'a length ≤ 100000',
      })
      expect(typeError(`text |> ${name}(length)`, { text: 'x', length: {} }).transform).toBe(name)
    }
  })

  it('identifies unsafe join conversion positions', () => {
    expect(typeError('items |> join(separator)', { items: [1], separator: {} }).transform).toBe(
      'join',
    )
    expect(typeError('items |> join(separator)', { items: [{}], separator: ',' }).transform).toBe(
      'join',
    )
  })

  it('preserves conversion-transform error identities', () => {
    const value = {}
    expect(typeError('value |> toNumber', { value }).transform).toBe('toNumber')
    expect(typeError('value |> toString', { value }).transform).toBe('toString')
  })
})
