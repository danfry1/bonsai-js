import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'

function expectArray(val: unknown, name: string): unknown[] {
  if (!Array.isArray(val)) throw new BonsaiTypeError(name, 'an array', val)
  return val
}

function hasPromises(results: unknown[]): boolean {
  return results.some((r) => r instanceof Promise)
}

// Coerce an arbitrary argument value to a string using JS default coercion.
// Argument values originate from user expressions and may be anything; the
// `unknown` parameter keeps the rule from narrowing to `{}` while preserving
// the exact `String(value)` runtime semantics.
function coerceToString(value: unknown): string {
  return String(value)
}

const LAMBDA_EXPECTED = 'a lambda or function callback (e.g. .field or . > value)'

// Compare two strings by Unicode code point, deterministically and independent
// of locale. String iteration yields whole code points (surrogate pairs as one
// unit), so astral-plane characters order by their scalar value rather than by
// the leading UTF-16 surrogate, which a plain `<` comparison would use.
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const x = ia.next()
    const y = ib.next()
    if (x.done === true || y.done === true)
      return (x.done === true ? 0 : 1) - (y.done === true ? 0 : 1)
    if (x.value !== y.value) {
      return (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0)
    }
  }
}

export const arrays: BonsaiPlugin = (expr) => {
  expr.addTransform('count', (val: unknown) => expectArray(val, 'count').length)
  expr.addTransform('first', (val: unknown) => expectArray(val, 'first')[0])
  expr.addTransform('last', (val: unknown) => {
    const arr = expectArray(val, 'last')
    return arr[arr.length - 1]
  })
  expr.addTransform('reverse', (val: unknown) => [...expectArray(val, 'reverse')].reverse())
  expr.addTransform('flatten', (val: unknown) => expectArray(val, 'flatten').flat())
  expr.addTransform('unique', (val: unknown) => [...new Set(expectArray(val, 'unique'))])
  expr.addTransform('join', (val: unknown, sep: unknown) =>
    expectArray(val, 'join').join(coerceToString(sep ?? ',')),
  )
  expr.addTransform('sort', (val: unknown) => {
    const arr = [...expectArray(val, 'sort')]
    return arr.sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return a - b
      // Code-point comparison rather than localeCompare: deterministic across
      // runtimes/locales, which matters for a rules engine that must behave
      // identically everywhere. Iterating by code point (not the UTF-16
      // code-unit `<`) keeps astral-plane characters ordered by their actual
      // scalar value.
      return compareCodePoints(String(a), String(b))
    })
  })

  // Higher-order transforms. A `undefined` predicate selects the no-argument
  // default behavior (`|> filter` keeps truthy values, `|> map` is identity).
  // Any other non-function value is a mistake (e.g. `map(inc(.x))`, where the
  // lambda shorthand `.x` was passed to a function and evaluated to a value
  // rather than used as a callback) and fails loud rather than silently
  // returning the input.
  expr.addTransform('filter', (val: unknown, predicate: unknown) => {
    const arr = expectArray(val, 'filter')
    if (predicate === undefined) return arr.filter(Boolean)
    if (typeof predicate !== 'function')
      throw new BonsaiTypeError('filter', LAMBDA_EXPECTED, predicate)
    const fn = predicate as (item: unknown) => unknown
    const results = arr.map(fn)
    if (hasPromises(results)) {
      return Promise.all(results).then((resolved) => arr.filter((_, i) => Boolean(resolved[i])))
    }
    return arr.filter((_, i) => Boolean(results[i]))
  })

  expr.addTransform('map', (val: unknown, fn: unknown) => {
    const arr = expectArray(val, 'map')
    if (fn === undefined) return arr
    if (typeof fn !== 'function') throw new BonsaiTypeError('map', LAMBDA_EXPECTED, fn)
    const results = arr.map(fn as (item: unknown) => unknown)
    return hasPromises(results) ? Promise.all(results) : results
  })

  expr.addTransform('find', (val: unknown, predicate: unknown) => {
    const arr = expectArray(val, 'find')
    if (predicate === undefined) return undefined
    if (typeof predicate !== 'function')
      throw new BonsaiTypeError('find', LAMBDA_EXPECTED, predicate)
    const fn = predicate as (item: unknown) => unknown
    const results = arr.map(fn)
    if (hasPromises(results)) {
      return Promise.all(results).then((resolved) => {
        const idx = resolved.findIndex(Boolean)
        return idx >= 0 ? arr[idx] : undefined
      })
    }
    const idx = results.findIndex(Boolean)
    return idx >= 0 ? arr[idx] : undefined
  })

  expr.addTransform('some', (val: unknown, predicate: unknown) => {
    const arr = expectArray(val, 'some')
    if (predicate === undefined) return arr.some(Boolean)
    if (typeof predicate !== 'function')
      throw new BonsaiTypeError('some', LAMBDA_EXPECTED, predicate)
    const fn = predicate as (item: unknown) => unknown
    const results = arr.map(fn)
    if (hasPromises(results)) {
      return Promise.all(results).then((resolved) => resolved.some(Boolean))
    }
    return results.some(Boolean)
  })

  expr.addTransform('every', (val: unknown, predicate: unknown) => {
    const arr = expectArray(val, 'every')
    if (predicate === undefined) return arr.every(Boolean)
    if (typeof predicate !== 'function')
      throw new BonsaiTypeError('every', LAMBDA_EXPECTED, predicate)
    const fn = predicate as (item: unknown) => unknown
    const results = arr.map(fn)
    if (hasPromises(results)) {
      return Promise.all(results).then((resolved) => resolved.every(Boolean))
    }
    return results.every(Boolean)
  })
}
