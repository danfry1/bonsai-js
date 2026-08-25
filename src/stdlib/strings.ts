import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'
import { coerceToNumber, coerceToString } from '../coerce.js'
import { STRING_TYPE, PRIMITIVE_TYPE, parameter } from './metadata.js'

function expectString(val: unknown, name: string): string {
  if (typeof val !== 'string') throw new BonsaiTypeError(name, 'a string', val)
  return val
}

const MAX_STRING_LENGTH = 100_000

export const strings: BonsaiPlugin = (expr) => {
  const stringToString = {
    inputType: STRING_TYPE,
    parameters: [],
    returnType: STRING_TYPE,
  } as const
  expr.addTransform(
    'upper',
    (val: unknown) => expectString(val, 'upper').toUpperCase(),
    stringToString,
  )
  expr.addTransform(
    'lower',
    (val: unknown) => expectString(val, 'lower').toLowerCase(),
    stringToString,
  )
  expr.addTransform('trim', (val: unknown) => expectString(val, 'trim').trim(), stringToString)
  expr.addTransform(
    'split',
    (val: unknown, sep: unknown) => {
      if (sep === undefined) throw new BonsaiTypeError('split', 'a separator argument', sep)
      return expectString(val, 'split').split(coerceToString(sep))
    },
    {
      inputType: STRING_TYPE,
      parameters: [parameter('separator', PRIMITIVE_TYPE)],
      returnType: { kind: 'array', element: STRING_TYPE },
    },
  )
  expr.addTransform(
    'replace',
    (val: unknown, search: unknown, replacement: unknown) =>
      expectString(val, 'replace').replace(coerceToString(search), coerceToString(replacement)),
    {
      ...stringToString,
      parameters: [parameter('search', PRIMITIVE_TYPE), parameter('replacement', PRIMITIVE_TYPE)],
    },
  )
  expr.addTransform(
    'replaceAll',
    (val: unknown, search: unknown, replacement: unknown) =>
      expectString(val, 'replaceAll').replaceAll(
        coerceToString(search),
        coerceToString(replacement),
      ),
    {
      ...stringToString,
      parameters: [parameter('search', PRIMITIVE_TYPE), parameter('replacement', PRIMITIVE_TYPE)],
    },
  )
  expr.addTransform(
    'startsWith',
    (val: unknown, search: unknown) =>
      expectString(val, 'startsWith').startsWith(coerceToString(search)),
    {
      inputType: STRING_TYPE,
      parameters: [parameter('search', PRIMITIVE_TYPE)],
      returnType: { kind: 'boolean' },
    },
  )
  expr.addTransform(
    'endsWith',
    (val: unknown, search: unknown) =>
      expectString(val, 'endsWith').endsWith(coerceToString(search)),
    {
      inputType: STRING_TYPE,
      parameters: [parameter('search', PRIMITIVE_TYPE)],
      returnType: { kind: 'boolean' },
    },
  )
  expr.addTransform(
    'includes',
    (val: unknown, search: unknown) =>
      expectString(val, 'includes').includes(coerceToString(search)),
    {
      inputType: STRING_TYPE,
      parameters: [parameter('search', PRIMITIVE_TYPE)],
      returnType: { kind: 'boolean' },
    },
  )
  expr.addTransform(
    'padStart',
    (val: unknown, length: unknown, fill: unknown) => {
      const len = coerceToNumber(length, 'padStart')
      if (!Number.isFinite(len) || len < 0)
        throw new BonsaiTypeError('padStart', 'a non-negative number for length', length)
      if (len > MAX_STRING_LENGTH)
        throw new BonsaiTypeError('padStart', `a length ≤ ${MAX_STRING_LENGTH}`, length)
      return expectString(val, 'padStart').padStart(
        len,
        fill === undefined ? ' ' : coerceToString(fill),
      )
    },
    {
      ...stringToString,
      parameters: [
        parameter('length', PRIMITIVE_TYPE),
        parameter('fill', PRIMITIVE_TYPE, { optional: true }),
      ],
    },
  )
  expr.addTransform(
    'padEnd',
    (val: unknown, length: unknown, fill: unknown) => {
      const len = coerceToNumber(length, 'padEnd')
      if (!Number.isFinite(len) || len < 0)
        throw new BonsaiTypeError('padEnd', 'a non-negative number for length', length)
      if (len > MAX_STRING_LENGTH)
        throw new BonsaiTypeError('padEnd', `a length ≤ ${MAX_STRING_LENGTH}`, length)
      return expectString(val, 'padEnd').padEnd(
        len,
        fill === undefined ? ' ' : coerceToString(fill),
      )
    },
    {
      ...stringToString,
      parameters: [
        parameter('length', PRIMITIVE_TYPE),
        parameter('fill', PRIMITIVE_TYPE, { optional: true }),
      ],
    },
  )
}
