import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'
import { coerceToString } from '../coerce.js'
import { isPromiseLike } from '../promise-like.js'
import { isBonsaiLambda } from '../lambda.js'
import { copyOwnArray, prepareArrayReceiver } from '../array-data.js'
import {
  ARRAY_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  BOOLEAN_TYPE,
  PRIMITIVE_TYPE,
  parameter,
} from './metadata.js'

function expectArray(val: unknown, name: string): unknown[] {
  if (!Array.isArray(val)) throw new BonsaiTypeError(name, 'an array', val)
  return val
}

type ArrayIntrinsic = (this: unknown[], ...args: unknown[]) => unknown

// Capture every native operation used by the bundled plugin once. Pipeline
// transforms must have the same receiver-override guarantees as method syntax.
const ARRAY_EVERY = Array.prototype.every as ArrayIntrinsic
const ARRAY_FILTER = Array.prototype.filter as ArrayIntrinsic
const ARRAY_FLAT = Array.prototype.flat as ArrayIntrinsic
const ARRAY_JOIN = Array.prototype.join as ArrayIntrinsic
const ARRAY_MAP = Array.prototype.map as ArrayIntrinsic
const ARRAY_REVERSE = Array.prototype.reverse as ArrayIntrinsic
const ARRAY_SOME = Array.prototype.some as ArrayIntrinsic
const ARRAY_SORT = Array.prototype.sort as ArrayIntrinsic
// The method is intentionally captured unbound and always invoked with `.call`.
// oxlint-disable-next-line typescript/unbound-method
const STRING_CODE_POINT_AT = String.prototype.codePointAt
const MAX_BASIC_MULTILINGUAL_PLANE_CODE_POINT = 0xffff

function methodArray(val: unknown, name: string): unknown[] {
  return prepareArrayReceiver(expectArray(val, name), name)
}

const LAMBDA_EXPECTED = 'a Bonsai lambda callback (e.g. .field or . > value)'

function isTruthy(value: unknown): boolean {
  return Boolean(value)
}

async function continueMap(
  arr: unknown[],
  fn: (item: unknown) => unknown,
  out: unknown[],
  firstIndex: number,
  firstResult: PromiseLike<unknown>,
): Promise<unknown[]> {
  out[firstIndex] = await firstResult
  for (let index = firstIndex + 1; index < arr.length; index++) {
    if (Object.hasOwn(arr, index)) out[index] = await fn(arr[index])
  }
  return out
}

function mapSequential(
  arr: unknown[],
  fn: (item: unknown) => unknown,
): unknown[] | Promise<unknown[]> {
  const out = new Array<unknown>(arr.length)
  for (let index = 0; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    const result = fn(arr[index])
    if (isPromiseLike(result)) return continueMap(arr, fn, out, index, result)
    out[index] = result
  }
  return out
}

async function continueFilter(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
  out: unknown[],
  firstIndex: number,
  firstResult: PromiseLike<unknown>,
): Promise<unknown[]> {
  if (isTruthy(await firstResult)) out.push(arr[firstIndex])
  for (let index = firstIndex + 1; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    if (isTruthy(await predicate(arr[index]))) out.push(arr[index])
  }
  return out
}

function filterSequential(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
): unknown[] | Promise<unknown[]> {
  const out: unknown[] = []
  for (let index = 0; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    const result = predicate(arr[index])
    if (isPromiseLike(result)) return continueFilter(arr, predicate, out, index, result)
    if (isTruthy(result)) out.push(arr[index])
  }
  return out
}

async function continueFind(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
  firstIndex: number,
  firstResult: PromiseLike<unknown>,
): Promise<unknown> {
  if (isTruthy(await firstResult)) return arr[firstIndex]
  for (let index = firstIndex + 1; index < arr.length; index++) {
    if (isTruthy(await predicate(arr[index]))) return arr[index]
  }
  return undefined
}

function findSequential(arr: unknown[], predicate: (item: unknown) => unknown): unknown {
  for (let index = 0; index < arr.length; index++) {
    const result = predicate(arr[index])
    if (isPromiseLike(result)) return continueFind(arr, predicate, index, result)
    if (isTruthy(result)) return arr[index]
  }
  return undefined
}

async function continueSome(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
  firstIndex: number,
  firstResult: PromiseLike<unknown>,
): Promise<boolean> {
  if (isTruthy(await firstResult)) return true
  for (let index = firstIndex + 1; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    if (isTruthy(await predicate(arr[index]))) return true
  }
  return false
}

function someSequential(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
): boolean | Promise<boolean> {
  for (let index = 0; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    const result = predicate(arr[index])
    if (isPromiseLike(result)) return continueSome(arr, predicate, index, result)
    if (isTruthy(result)) return true
  }
  return false
}

async function continueEvery(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
  firstIndex: number,
  firstResult: PromiseLike<unknown>,
): Promise<boolean> {
  if (!isTruthy(await firstResult)) return false
  for (let index = firstIndex + 1; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    if (!isTruthy(await predicate(arr[index]))) return false
  }
  return true
}

function everySequential(
  arr: unknown[],
  predicate: (item: unknown) => unknown,
): boolean | Promise<boolean> {
  for (let index = 0; index < arr.length; index++) {
    if (!Object.hasOwn(arr, index)) continue
    const result = predicate(arr[index])
    if (isPromiseLike(result)) return continueEvery(arr, predicate, index, result)
    if (!isTruthy(result)) return false
  }
  return true
}

// Compare two strings by Unicode code point, deterministically and independent
// of locale. String iteration yields whole code points (surrogate pairs as one
// unit), so astral-plane characters order by their scalar value rather than by
// the leading UTF-16 surrogate, which a plain `<` comparison would use. Use a
// captured intrinsic rather than the live String iterator.
function compareCodePoints(a: string, b: string): number {
  let ai = 0
  let bi = 0
  while (ai < a.length && bi < b.length) {
    const ac = STRING_CODE_POINT_AT.call(a, ai) ?? 0
    const bc = STRING_CODE_POINT_AT.call(b, bi) ?? 0
    if (ac !== bc) return ac - bc
    ai += ac > MAX_BASIC_MULTILINGUAL_PLANE_CODE_POINT ? 2 : 1
    bi += bc > MAX_BASIC_MULTILINGUAL_PLANE_CODE_POINT ? 2 : 1
  }
  return (a.length - ai > 0 ? 1 : 0) - (b.length - bi > 0 ? 1 : 0)
}

export const arrays: BonsaiPlugin = (expr) => {
  const arrayToArray = {
    inputType: ARRAY_TYPE,
    parameters: [],
    returnType: ARRAY_TYPE,
    arrayTypeRule: 'preserve',
  } as const
  expr.addTransform('count', (val: unknown) => expectArray(val, 'count').length, {
    inputType: ARRAY_TYPE,
    parameters: [],
    returnType: NUMBER_TYPE,
  })
  expr.addTransform('first', (val: unknown) => expectArray(val, 'first')[0], {
    inputType: ARRAY_TYPE,
    parameters: [],
    arrayTypeRule: 'optional-element',
  })
  expr.addTransform(
    'last',
    (val: unknown) => {
      const arr = expectArray(val, 'last')
      return arr[arr.length - 1]
    },
    { inputType: ARRAY_TYPE, parameters: [], arrayTypeRule: 'optional-element' },
  )
  expr.addTransform(
    'reverse',
    (val: unknown) => {
      const out = copyOwnArray(expectArray(val, 'reverse'), { materializeHoles: true })
      return ARRAY_REVERSE.call(out)
    },
    arrayToArray,
  )
  expr.addTransform('flatten', (val: unknown) => ARRAY_FLAT.call(methodArray(val, 'flatten')), {
    ...arrayToArray,
    arrayTypeRule: 'flatten',
  })
  expr.addTransform(
    'unique',
    (val: unknown) => {
      const input = copyOwnArray(expectArray(val, 'unique'), { materializeHoles: true })
      const seen = new Set<unknown>()
      const out: unknown[] = []
      for (const item of input) {
        if (!seen.has(item)) {
          seen.add(item)
          out.push(item)
        }
      }
      return out
    },
    arrayToArray,
  )
  expr.addTransform(
    'join',
    (val: unknown, sep: unknown) => {
      const separator = coerceToString(sep ?? ',', 'join')
      const mapped = ARRAY_MAP.call(methodArray(val, 'join'), (item: unknown) =>
        item === null || item === undefined ? '' : coerceToString(item, 'join'),
      ) as unknown[]
      return ARRAY_JOIN.call(mapped, separator)
    },
    {
      inputType: ARRAY_TYPE,
      parameters: [parameter('separator', PRIMITIVE_TYPE, { optional: true })],
      returnType: STRING_TYPE,
    },
  )
  expr.addTransform(
    'sort',
    (val: unknown) => {
      const arr = copyOwnArray(expectArray(val, 'sort'), { materializeHoles: true })
      return ARRAY_SORT.call(arr, (a: unknown, b: unknown) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b
        // Code-point comparison rather than localeCompare: deterministic across
        // runtimes/locales, which matters for a rules engine that must behave
        // identically everywhere. Iterating by code point (not the UTF-16
        // code-unit `<`) keeps astral-plane characters ordered by their actual
        // scalar value.
        return compareCodePoints(coerceToString(a), coerceToString(b))
      })
    },
    {
      inputType: ARRAY_TYPE,
      parameters: [],
      returnType: ARRAY_TYPE,
      arrayTypeRule: 'preserve',
    },
  )

  // Higher-order transforms. A `undefined` predicate selects the no-argument
  // default behavior (`|> filter` keeps truthy values, `|> map` is identity).
  // Any other non-function value is a mistake (e.g. `map(inc(.x))`, where the
  // lambda shorthand `.x` was passed to a function and evaluated to a value
  // rather than used as a callback) and fails loud rather than silently
  // returning the input.
  expr.addTransform(
    'filter',
    (val: unknown, predicate: unknown) => {
      const arr = methodArray(val, 'filter')
      if (predicate === undefined) return ARRAY_FILTER.call(arr, Boolean)
      if (!isBonsaiLambda(predicate))
        throw new BonsaiTypeError('filter', LAMBDA_EXPECTED, predicate)
      return filterSequential(arr, predicate)
    },
    { inputType: ARRAY_TYPE, returnType: ARRAY_TYPE, arrayTypeRule: 'filter' },
  )

  expr.addTransform(
    'map',
    (val: unknown, fn: unknown) => {
      const arr = methodArray(val, 'map')
      if (fn === undefined) return arr
      if (!isBonsaiLambda(fn)) throw new BonsaiTypeError('map', LAMBDA_EXPECTED, fn)
      return mapSequential(arr, fn)
    },
    { inputType: ARRAY_TYPE, returnType: ARRAY_TYPE, arrayTypeRule: 'map' },
  )

  expr.addTransform(
    'find',
    (val: unknown, predicate: unknown) => {
      const arr = methodArray(val, 'find')
      if (predicate === undefined) return undefined
      if (!isBonsaiLambda(predicate)) throw new BonsaiTypeError('find', LAMBDA_EXPECTED, predicate)
      return findSequential(arr, predicate)
    },
    { inputType: ARRAY_TYPE, arrayTypeRule: 'find' },
  )

  expr.addTransform(
    'some',
    (val: unknown, predicate: unknown) => {
      const arr = methodArray(val, 'some')
      if (predicate === undefined) return ARRAY_SOME.call(arr, Boolean)
      if (!isBonsaiLambda(predicate)) throw new BonsaiTypeError('some', LAMBDA_EXPECTED, predicate)
      return someSequential(arr, predicate)
    },
    {
      inputType: ARRAY_TYPE,
      returnType: BOOLEAN_TYPE,
      arrayTypeRule: 'some',
    },
  )

  expr.addTransform(
    'every',
    (val: unknown, predicate: unknown) => {
      const arr = methodArray(val, 'every')
      if (predicate === undefined) return ARRAY_EVERY.call(arr, Boolean)
      if (!isBonsaiLambda(predicate)) throw new BonsaiTypeError('every', LAMBDA_EXPECTED, predicate)
      return everySequential(arr, predicate)
    },
    {
      inputType: ARRAY_TYPE,
      returnType: BOOLEAN_TYPE,
      arrayTypeRule: 'every',
    },
  )
}
