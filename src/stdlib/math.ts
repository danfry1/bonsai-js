import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'

function expectNumber(val: unknown, name: string): number {
  if (typeof val !== 'number') throw new BonsaiTypeError(name, 'a number', val)
  return val
}

function expectNumberArray(val: unknown, name: string): number[] {
  if (!Array.isArray(val)) throw new BonsaiTypeError(name, 'an array of numbers', val)
  for (const item of val) {
    if (typeof item !== 'number')
      throw new BonsaiTypeError(name, 'an array of numbers (all elements must be numbers)', item)
  }
  return val as number[]
}

export const math: BonsaiPlugin = (expr) => {
  expr.addTransform('round', (val: unknown) => Math.round(expectNumber(val, 'round')))
  expr.addTransform('floor', (val: unknown) => Math.floor(expectNumber(val, 'floor')))
  expr.addTransform('ceil', (val: unknown) => Math.ceil(expectNumber(val, 'ceil')))
  expr.addTransform('abs', (val: unknown) => Math.abs(expectNumber(val, 'abs')))
  expr.addTransform('sum', (val: unknown) =>
    expectNumberArray(val, 'sum').reduce((a, b) => a + b, 0),
  )
  expr.addTransform('avg', (val: unknown) => {
    const arr = expectNumberArray(val, 'avg')
    if (arr.length === 0) return 0
    return arr.reduce((a, b) => a + b, 0) / arr.length
  })
  expr.addTransform('clamp', (val: unknown, min: unknown, max: unknown) => {
    const v = expectNumber(val, 'clamp')
    const lo = expectNumber(min, 'clamp')
    const hi = expectNumber(max, 'clamp')
    if (!Number.isFinite(lo)) throw new BonsaiTypeError('clamp', 'a finite number for min', min)
    if (!Number.isFinite(hi)) throw new BonsaiTypeError('clamp', 'a finite number for max', max)
    if (lo > hi) throw new BonsaiTypeError('clamp', 'min to be <= max', max)
    return Math.min(Math.max(v, lo), hi)
  })

  // Functions, not transforms: called as min(a, b, ...) / max(...arr). With no
  // arguments they return undefined (not Infinity/-Infinity), and every argument
  // is validated as a number rather than silently coerced.
  expr.addFunction('min', (...args: unknown[]) =>
    args.length === 0 ? undefined : Math.min(...args.map((a) => expectNumber(a, 'min'))),
  )
  expr.addFunction('max', (...args: unknown[]) =>
    args.length === 0 ? undefined : Math.max(...args.map((a) => expectNumber(a, 'max'))),
  )
}
