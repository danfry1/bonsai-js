import { describe, expect, it } from 'vitest'
import { coerceToNumber, coerceToString } from '../src/coerce.js'
import { BonsaiTypeError } from '../src/errors.js'
import {
  isMethodAllowedOn,
  methodSignatureArgument,
  methodSignatureCode,
  methodSignatureHasRest,
  methodSignatureParamCount,
  methodSignatureRequired,
  methodsForReceiverType,
  safeMethodFor,
} from '../src/safe-methods.js'

const errorOf = (fn: () => unknown): BonsaiTypeError => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(BonsaiTypeError)
    return error as BonsaiTypeError
  }
  throw new Error('expected a BonsaiTypeError')
}

describe('primitive-only coercion', () => {
  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    ['', ''],
    ['42', '42'],
    [0, '0'],
    [42, '42'],
    [false, 'false'],
    [true, 'true'],
  ] as const)('stringifies %s without host conversion hooks', (value, expected) => {
    expect(coerceToString(value)).toBe(expected)
  })

  it.each([
    [null, 0],
    [undefined, Number.NaN],
    ['', 0],
    ['42', 42],
    [0, 0],
    [42, 42],
    [false, 0],
    [true, 1],
  ] as const)('converts %s to a number without host conversion hooks', (value, expected) => {
    if (Number.isNaN(expected)) expect(coerceToNumber(value)).toBeNaN()
    else expect(coerceToNumber(value)).toBe(expected)
  })

  it.each([
    [{}, 'object'],
    [[], 'array'],
    [Symbol('x'), 'symbol'],
    [1n, 'bigint'],
    [() => 1, 'function'],
  ] as const)('rejects %s for both coercions with structured diagnostics', (value, received) => {
    const stringError = errorOf(() => coerceToString(value, 'computed key'))
    expect(stringError).toMatchObject({
      transform: 'computed key',
      expected: 'a string, number, boolean, null, or undefined',
      received,
    })

    const numberError = errorOf(() => coerceToNumber(value, 'numeric input'))
    expect(numberError).toMatchObject({
      transform: 'numeric input',
      expected: 'a string, number, boolean, null, or undefined',
      received,
    })
  })

  it('uses stable default operation names', () => {
    expect(errorOf(() => coerceToString({})).transform).toBe('string conversion')
    expect(errorOf(() => coerceToNumber({})).transform).toBe('number conversion')
  })
})

describe('safe intrinsic method resolution', () => {
  it('distinguishes receiver families and rejects unsupported values', () => {
    expect(isMethodAllowedOn('text', 'trim')).toBe(true)
    expect(isMethodAllowedOn([], 'trim')).toBe(false)
    expect(isMethodAllowedOn([], 'map')).toBe(true)
    expect(isMethodAllowedOn(1, 'toFixed')).toBe(true)
    expect(isMethodAllowedOn({}, 'toString')).toBe(false)
    expect(isMethodAllowedOn(null, 'toString')).toBe(false)
  })

  it('decodes fixed, optional, and variadic signatures exactly', () => {
    expect(methodSignatureCode('string', 'trim')).toBe('0')
    expect(methodSignatureCode('array', 'with')).toBe('2nu')
    expect(methodSignatureCode('number', 'missing')).toBeUndefined()

    expect(methodSignatureRequired('2nu')).toBe(2)
    expect(methodSignatureParamCount('2nu')).toBe(2)
    expect(methodSignatureHasRest('2nu')).toBe(false)
    expect(methodSignatureArgument('2nu', 0)).toBe('n')
    expect(methodSignatureArgument('2nu', 1)).toBe('u')
    expect(methodSignatureArgument('2nu', 2)).toBeUndefined()

    expect(methodSignatureRequired('0p*')).toBe(0)
    expect(methodSignatureParamCount('0p*')).toBe(1)
    expect(methodSignatureHasRest('0p*')).toBe(true)
    expect(methodSignatureArgument('0p*', 0)).toBe('p')
    expect(methodSignatureArgument('0p*', 5)).toBe('p')
    expect(methodSignatureArgument('0', 0)).toBeUndefined()
  })

  it('returns only an audited intrinsic for an allowed receiver/method pair', () => {
    expect(safeMethodFor(' text ', 'trim')?.call(' text ')).toBe('text')
    expect(safeMethodFor([1, 2], 'map')?.call([1, 2], (value: number) => value * 2)).toEqual([2, 4])
    expect(safeMethodFor(1, 'toFixed')?.call(1, 2)).toBe('1.00')
    expect(safeMethodFor([], 'trim')).toBeUndefined()
    expect(safeMethodFor({}, 'toString')).toBeUndefined()
    expect(safeMethodFor(null, 'toString')).toBeUndefined()
    expect(safeMethodFor('text', 'missing')).toBeUndefined()
  })

  it('publishes method catalogs that are receiver-specific and complete enough to audit', () => {
    expect(methodsForReceiverType('string')).toEqual(expect.arrayContaining(['trim', 'includes']))
    expect(methodsForReceiverType('string')).not.toContain('map')
    expect(methodsForReceiverType('array')).toEqual(expect.arrayContaining(['map', 'includes']))
    expect(methodsForReceiverType('number')).toEqual(
      expect.arrayContaining(['toFixed', 'toString']),
    )
  })
})
