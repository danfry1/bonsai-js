import { describe, expect, it } from 'vitest'
import { bonsai } from '../../src/index.js'
import { arrays, createDates, math, strings, types } from '../../src/stdlib/index.js'

const unknownType = { kind: 'unknown' } as const
const stringType = { kind: 'string' } as const
const numberType = { kind: 'number' } as const
const booleanType = { kind: 'boolean' } as const
const undefinedType = { kind: 'undefined' } as const
const arrayType = { kind: 'array', element: unknownType } as const
const numberArrayType = { kind: 'array', element: numberType } as const
const stringArrayType = { kind: 'array', element: stringType } as const
const primitiveType = {
  kind: 'union',
  members: [stringType, numberType, booleanType, { kind: 'null' }, undefinedType],
} as const

const parameter = (
  name: string,
  type: unknown,
  options: { optional?: boolean; rest?: boolean } = {},
) => ({ name, type, ...options })

describe('bundled stdlib metadata contract', () => {
  const expr = bonsai()
    .use(arrays)
    .use(math)
    .use(strings)
    .use(types)
    .use(createDates({ now: () => 0 }))

  const expectedTransforms = {
    count: { inputType: arrayType, parameters: [], returnType: numberType },
    first: { inputType: arrayType, parameters: [], arrayTypeRule: 'optional-element' },
    last: { inputType: arrayType, parameters: [], arrayTypeRule: 'optional-element' },
    reverse: {
      inputType: arrayType,
      parameters: [],
      returnType: arrayType,
      arrayTypeRule: 'preserve',
    },
    flatten: {
      inputType: arrayType,
      parameters: [],
      returnType: arrayType,
      arrayTypeRule: 'flatten',
    },
    unique: {
      inputType: arrayType,
      parameters: [],
      returnType: arrayType,
      arrayTypeRule: 'preserve',
    },
    join: {
      inputType: arrayType,
      parameters: [parameter('separator', primitiveType, { optional: true })],
      returnType: stringType,
    },
    sort: {
      inputType: arrayType,
      parameters: [],
      returnType: arrayType,
      arrayTypeRule: 'preserve',
    },
    filter: { inputType: arrayType, returnType: arrayType, arrayTypeRule: 'filter' },
    map: { inputType: arrayType, returnType: arrayType, arrayTypeRule: 'map' },
    find: { inputType: arrayType, arrayTypeRule: 'find' },
    some: { inputType: arrayType, returnType: booleanType, arrayTypeRule: 'some' },
    every: { inputType: arrayType, returnType: booleanType, arrayTypeRule: 'every' },
    round: { inputType: numberType, parameters: [], returnType: numberType },
    floor: { inputType: numberType, parameters: [], returnType: numberType },
    ceil: { inputType: numberType, parameters: [], returnType: numberType },
    abs: { inputType: numberType, parameters: [], returnType: numberType },
    sum: { inputType: numberArrayType, parameters: [], returnType: numberType },
    avg: { inputType: numberArrayType, parameters: [], returnType: numberType },
    clamp: {
      inputType: numberType,
      parameters: [parameter('min', numberType), parameter('max', numberType)],
      returnType: numberType,
    },
    upper: { inputType: stringType, parameters: [], returnType: stringType },
    lower: { inputType: stringType, parameters: [], returnType: stringType },
    trim: { inputType: stringType, parameters: [], returnType: stringType },
    split: {
      inputType: stringType,
      parameters: [parameter('separator', primitiveType)],
      returnType: stringArrayType,
    },
    replace: {
      inputType: stringType,
      parameters: [parameter('search', primitiveType), parameter('replacement', primitiveType)],
      returnType: stringType,
    },
    replaceAll: {
      inputType: stringType,
      parameters: [parameter('search', primitiveType), parameter('replacement', primitiveType)],
      returnType: stringType,
    },
    startsWith: {
      inputType: stringType,
      parameters: [parameter('search', primitiveType)],
      returnType: booleanType,
    },
    endsWith: {
      inputType: stringType,
      parameters: [parameter('search', primitiveType)],
      returnType: booleanType,
    },
    includes: {
      inputType: stringType,
      parameters: [parameter('search', primitiveType)],
      returnType: booleanType,
    },
    padStart: {
      inputType: stringType,
      parameters: [
        parameter('length', primitiveType),
        parameter('fill', primitiveType, { optional: true }),
      ],
      returnType: stringType,
    },
    padEnd: {
      inputType: stringType,
      parameters: [
        parameter('length', primitiveType),
        parameter('fill', primitiveType, { optional: true }),
      ],
      returnType: stringType,
    },
    isString: { inputType: unknownType, parameters: [], returnType: booleanType },
    isNumber: { inputType: unknownType, parameters: [], returnType: booleanType },
    isArray: { inputType: unknownType, parameters: [], returnType: booleanType },
    isNull: { inputType: unknownType, parameters: [], returnType: booleanType },
    toBool: { inputType: unknownType, parameters: [], returnType: booleanType },
    toNumber: { inputType: primitiveType, parameters: [], returnType: numberType },
    toString: { inputType: primitiveType, parameters: [], returnType: stringType },
    formatDate: {
      inputType: numberType,
      parameters: [parameter('format', stringType)],
      returnType: stringType,
    },
    diffDays: {
      inputType: numberType,
      parameters: [parameter('other', numberType)],
      returnType: numberType,
    },
  } as const

  it('publishes the exact transform catalog consumed by checker and autocomplete', () => {
    expect([...expr.listTransforms()].sort()).toEqual(Object.keys(expectedTransforms).sort())
    for (const [name, metadata] of Object.entries(expectedTransforms)) {
      expect(expr.getTransformMetadata(name)).toEqual(metadata)
    }
  })

  it('publishes exact function signatures', () => {
    expect([...expr.listFunctions()].sort()).toEqual(['max', 'min', 'now'])
    for (const name of ['min', 'max'] as const) {
      expect(expr.getFunctionMetadata(name)).toEqual({
        parameters: [parameter('value', numberType, { optional: true, rest: true })],
        returnType: {
          kind: 'union',
          members: [numberType, undefinedType],
        },
      })
    }
    expect(expr.getFunctionMetadata('now')).toEqual({ parameters: [], returnType: numberType })
  })
})
