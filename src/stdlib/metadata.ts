import type { BonsaiType, ParameterMetadata } from '../types.js'

export const UNKNOWN_TYPE: BonsaiType = Object.freeze({ kind: 'unknown' })
export const STRING_TYPE: BonsaiType = Object.freeze({ kind: 'string' })
export const NUMBER_TYPE: BonsaiType = Object.freeze({ kind: 'number' })
export const BOOLEAN_TYPE: BonsaiType = Object.freeze({ kind: 'boolean' })
export const UNDEFINED_TYPE: BonsaiType = Object.freeze({ kind: 'undefined' })
export const ARRAY_TYPE: BonsaiType = Object.freeze({ kind: 'array', element: UNKNOWN_TYPE })
export const PRIMITIVE_TYPE: BonsaiType = Object.freeze({
  kind: 'union',
  members: Object.freeze([
    STRING_TYPE,
    NUMBER_TYPE,
    BOOLEAN_TYPE,
    Object.freeze({ kind: 'null' }),
    UNDEFINED_TYPE,
  ]),
})

export function parameter(
  name: string,
  type: BonsaiType,
  options: { optional?: boolean; rest?: boolean } = {},
): ParameterMetadata {
  return Object.freeze({
    name,
    type,
    ...(options.optional === true ? { optional: true } : {}),
    ...(options.rest === true ? { rest: true } : {}),
  })
}
