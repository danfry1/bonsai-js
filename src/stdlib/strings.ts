import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'

function expectString(val: unknown, name: string): string {
  if (typeof val !== 'string') throw new BonsaiTypeError(name, 'a string', val)
  return val
}

// Coerce an arbitrary argument value to a string using JS default coercion.
// Argument values originate from user expressions and may be anything; the
// `unknown` parameter keeps the rule from narrowing to `{}` while preserving
// the exact `String(value)` runtime semantics.
function coerceToString(value: unknown): string {
  return String(value)
}

const MAX_STRING_LENGTH = 100_000

export const strings: BonsaiPlugin = (expr) => {
  expr.addTransform('upper', (val: unknown) => expectString(val, 'upper').toUpperCase())
  expr.addTransform('lower', (val: unknown) => expectString(val, 'lower').toLowerCase())
  expr.addTransform('trim', (val: unknown) => expectString(val, 'trim').trim())
  expr.addTransform('split', (val: unknown, sep: unknown) => {
    if (sep === undefined) throw new BonsaiTypeError('split', 'a separator argument', sep)
    return expectString(val, 'split').split(coerceToString(sep))
  })
  expr.addTransform('replace', (val: unknown, search: unknown, replacement: unknown) =>
    expectString(val, 'replace').replace(String(search), String(replacement)),
  )
  expr.addTransform('replaceAll', (val: unknown, search: unknown, replacement: unknown) =>
    expectString(val, 'replaceAll').replaceAll(String(search), String(replacement)),
  )
  expr.addTransform('startsWith', (val: unknown, search: unknown) =>
    expectString(val, 'startsWith').startsWith(String(search)),
  )
  expr.addTransform('endsWith', (val: unknown, search: unknown) =>
    expectString(val, 'endsWith').endsWith(String(search)),
  )
  expr.addTransform('includes', (val: unknown, search: unknown) =>
    expectString(val, 'includes').includes(String(search)),
  )
  expr.addTransform('padStart', (val: unknown, length: unknown, fill: unknown) => {
    const len = Number(length)
    if (!Number.isFinite(len) || len < 0)
      throw new BonsaiTypeError('padStart', 'a non-negative number for length', length)
    if (len > MAX_STRING_LENGTH)
      throw new BonsaiTypeError('padStart', `a length ≤ ${MAX_STRING_LENGTH}`, length)
    return expectString(val, 'padStart').padStart(
      len,
      fill === undefined ? ' ' : coerceToString(fill),
    )
  })
  expr.addTransform('padEnd', (val: unknown, length: unknown, fill: unknown) => {
    const len = Number(length)
    if (!Number.isFinite(len) || len < 0)
      throw new BonsaiTypeError('padEnd', 'a non-negative number for length', length)
    if (len > MAX_STRING_LENGTH)
      throw new BonsaiTypeError('padEnd', `a length ≤ ${MAX_STRING_LENGTH}`, length)
    return expectString(val, 'padEnd').padEnd(len, fill === undefined ? ' ' : coerceToString(fill))
  })
}
