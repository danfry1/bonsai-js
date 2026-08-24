import type { BonsaiPlugin } from '../types.js'
import { coerceToNumber, coerceToString } from '../coerce.js'
import { UNKNOWN_TYPE, BOOLEAN_TYPE, NUMBER_TYPE, STRING_TYPE, PRIMITIVE_TYPE } from './metadata.js'

export const types: BonsaiPlugin = (expr) => {
  const booleanOutput = {
    inputType: UNKNOWN_TYPE,
    parameters: [],
    returnType: BOOLEAN_TYPE,
  } as const
  expr.addTransform('isString', (val: unknown) => typeof val === 'string', booleanOutput)
  expr.addTransform('isNumber', (val: unknown) => typeof val === 'number', booleanOutput)
  expr.addTransform('isArray', (val: unknown) => Array.isArray(val), booleanOutput)
  expr.addTransform('isNull', (val: unknown) => val === null, booleanOutput)
  expr.addTransform('toBool', (val: unknown) => Boolean(val), booleanOutput)
  expr.addTransform('toNumber', (val: unknown) => coerceToNumber(val, 'toNumber'), {
    inputType: PRIMITIVE_TYPE,
    parameters: [],
    returnType: NUMBER_TYPE,
  })
  expr.addTransform('toString', (val: unknown) => coerceToString(val, 'toString'), {
    inputType: PRIMITIVE_TYPE,
    parameters: [],
    returnType: STRING_TYPE,
  })
}
