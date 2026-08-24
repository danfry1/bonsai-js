import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'
import { NUMBER_TYPE, UNDEFINED_TYPE, parameter } from './metadata.js'

const NUMBER_ARRAY_TYPE = Object.freeze({ kind: 'array', element: NUMBER_TYPE } as const)
const OPTIONAL_NUMBER_TYPE = Object.freeze({
  kind: 'union',
  members: Object.freeze([NUMBER_TYPE, UNDEFINED_TYPE]),
} as const)
const ARRAY_REDUCE = Array.prototype.reduce as (
  callback: (sum: number, value: number) => number,
  initialValue: number,
) => number

function expectNumber(val: unknown, name: string): number {
  if (typeof val !== 'number') throw new BonsaiTypeError(name, 'a number', val)
  return val
}

function expectNumberArray(val: unknown, name: string): number[] {
  if (!Array.isArray(val)) throw new BonsaiTypeError(name, 'an array of numbers', val)
  // Index access deliberately avoids invoking a receiver-provided iterator.
  // oxlint-disable-next-line typescript/prefer-for-of
  for (let index = 0; index < val.length; index++) {
    // Index iteration ignores a receiver-provided iterator; sumNumbers below
    // likewise invokes a captured reduce rather than an own override.
    const item = val[index]
    if (typeof item !== 'number')
      throw new BonsaiTypeError(name, 'an array of numbers (all elements must be numbers)', item)
  }
  return val
}

function sumNumbers(values: readonly number[]): number {
  return ARRAY_REDUCE.call(values, (sum, value) => sum + value, 0)
}

export const math: BonsaiPlugin = (expr) => {
  const numberToNumber = {
    inputType: NUMBER_TYPE,
    parameters: [],
    returnType: NUMBER_TYPE,
  } as const
  expr.addTransform(
    'round',
    (val: unknown) => Math.round(expectNumber(val, 'round')),
    numberToNumber,
  )
  expr.addTransform(
    'floor',
    (val: unknown) => Math.floor(expectNumber(val, 'floor')),
    numberToNumber,
  )
  expr.addTransform('ceil', (val: unknown) => Math.ceil(expectNumber(val, 'ceil')), numberToNumber)
  expr.addTransform('abs', (val: unknown) => Math.abs(expectNumber(val, 'abs')), numberToNumber)
  expr.addTransform('sum', (val: unknown) => sumNumbers(expectNumberArray(val, 'sum')), {
    inputType: NUMBER_ARRAY_TYPE,
    parameters: [],
    returnType: NUMBER_TYPE,
  })
  expr.addTransform(
    'avg',
    (val: unknown) => {
      const arr = expectNumberArray(val, 'avg')
      if (arr.length === 0) return 0
      return sumNumbers(arr) / arr.length
    },
    {
      inputType: NUMBER_ARRAY_TYPE,
      parameters: [],
      returnType: NUMBER_TYPE,
    },
  )
  expr.addTransform(
    'clamp',
    (val: unknown, min: unknown, max: unknown) => {
      const v = expectNumber(val, 'clamp')
      const lo = expectNumber(min, 'clamp')
      const hi = expectNumber(max, 'clamp')
      if (!Number.isFinite(lo)) throw new BonsaiTypeError('clamp', 'a finite number for min', min)
      if (!Number.isFinite(hi)) throw new BonsaiTypeError('clamp', 'a finite number for max', max)
      if (lo > hi) throw new BonsaiTypeError('clamp', 'min to be <= max', max)
      return Math.min(Math.max(v, lo), hi)
    },
    {
      ...numberToNumber,
      parameters: [parameter('min', NUMBER_TYPE), parameter('max', NUMBER_TYPE)],
    },
  )

  // Functions, not transforms: called as min(a, b, ...) / max(...arr). With no
  // arguments they return undefined (not Infinity/-Infinity), and every argument
  // is validated as a number rather than silently coerced.
  expr.addFunction(
    'min',
    (...args: unknown[]) =>
      args.length === 0 ? undefined : Math.min(...args.map((a) => expectNumber(a, 'min'))),
    {
      parameters: [parameter('value', NUMBER_TYPE, { optional: true, rest: true })],
      returnType: OPTIONAL_NUMBER_TYPE,
    },
  )
  expr.addFunction(
    'max',
    (...args: unknown[]) =>
      args.length === 0 ? undefined : Math.max(...args.map((a) => expectNumber(a, 'max'))),
    {
      parameters: [parameter('value', NUMBER_TYPE, { optional: true, rest: true })],
      returnType: OPTIONAL_NUMBER_TYPE,
    },
  )
}
