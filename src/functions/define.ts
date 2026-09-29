import { BLOCKED_NAMES } from '../syntax/lexer.js'
import type { Span } from '../errors.js'
import type { State } from '../runtime/state.js'
import { Duration, isMap, keyListCost, shown } from '../runtime/values.js'
import { formatType, type FunctionType, type Type, type TypeVar } from '../types.js'

/** A lambda as seen by a built-in: called with the item and its index. */
export type Lambda = (item: unknown, index: number) => unknown

/** Call-site information handed to a built-in implementation. */
export interface CallSite {
  readonly state: State
  readonly span: Span
}

export interface Overload {
  /** Parameter types. Function-typed parameters take lambdas. */
  readonly params: readonly Type[]
  /** How many leading parameters are required (default: all). */
  readonly required?: number
  /** Type of any further arguments (variadic). */
  readonly rest?: Type
  /** Result type; may reference type variables bound by the parameters. */
  readonly result: Type
  readonly run: (args: unknown[], site: CallSite) => unknown
  /** Variant used when a lambda argument is asynchronous. */
  readonly runAsync?: (args: unknown[], site: CallSite) => Promise<unknown>
  /** Type variables that must bind to one orderable kind (number, string, timestamp, duration). */
  readonly ordered?: readonly string[]
  /**
   * Static validation of literal arguments (undefined where an argument is
   * not a literal). Returns an error message, so mistakes in constant
   * patterns are reported when the expression is checked.
   */
  readonly literals?: (values: readonly unknown[]) => string | undefined
}

export interface FunctionDef {
  readonly name: string
  readonly description: string
  readonly overloads: readonly Overload[]
  /** Host functions: returns a promise and must be awaited. */
  readonly async?: boolean
  /** Host functions: receives the evaluation context as its first argument. */
  readonly context?: boolean
  readonly host?: boolean
  /** Host functions: steps charged per call (default 32). */
  readonly cost?: number
}

export const T: TypeVar = Object.freeze({ kind: 'var', name: 'T' })
export const U: TypeVar = Object.freeze({ kind: 'var', name: 'U' })
export const K: TypeVar = Object.freeze({ kind: 'var', name: 'K' })

export function fnType(params: readonly Type[], result: Type): FunctionType {
  return Object.freeze({ kind: 'function', params: Object.freeze([...params]), result })
}

/** Whether parameter `index` of any overload is function-typed (lambda position). */
export function isLambdaPosition(def: FunctionDef, index: number): boolean {
  return def.overloads.some((candidate) => candidate.params[index]?.kind === 'function')
}

/** Shallow runtime test used to pick an overload by argument kinds. */
export function matchesKind(value: unknown, type: Type): boolean {
  switch (type.kind) {
    case 'any':
    case 'var':
      return true
    case 'never':
      return false
    case 'null':
      return value === null || value === undefined
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number'
    case 'string':
      return typeof value === 'string'
    case 'literal':
      return value === type.value
    case 'list':
      return Array.isArray(value)
    case 'map':
      return isMap(value)
    case 'timestamp':
      return value instanceof Date
    case 'duration':
      return value instanceof Duration
    case 'union':
      return type.types.some((member) => matchesKind(value, member))
    case 'opaque':
      return (
        value !== null &&
        value !== undefined &&
        (typeof value === 'function' ||
          typeof value === 'symbol' ||
          typeof value === 'bigint' ||
          typeof value === 'object')
      )
    case 'function':
    default:
      return typeof value === 'function'
  }
}

/** Deep runtime conformance, used to guard host function parameters. */
export function conforms(value: unknown, type: Type, state: State, depth = 0): boolean {
  if (depth > state.limits.maxValueDepth) return false
  switch (type.kind) {
    case 'list': {
      if (!Array.isArray(value)) return false
      if (type.element.kind === 'any') return true
      state.charge(value.length)
      // oxlint-disable-next-line typescript/prefer-for-of -- indexing never invokes a host array's own Symbol.iterator
      for (let i = 0; i < value.length; i++)
        if (!conforms(value[i], type.element, state, depth + 1)) return false
      return true
    }
    case 'map': {
      if (!isMap(value)) return false
      const fields = Object.entries(type.fields)
      state.charge(1 + fields.length)
      for (const [key, fieldType] of fields) {
        if (!conforms(Object.hasOwn(value, key) ? value[key] : null, fieldType, state, depth + 1))
          return false
      }
      if (type.rest !== undefined && type.rest.kind !== 'any') {
        const keys = Object.keys(value)
        state.charge(keyListCost(keys.length))
        for (const key of keys) {
          if (
            !Object.hasOwn(type.fields, key) &&
            !conforms(value[key], type.rest, state, depth + 1)
          )
            return false
        }
      }
      return true
    }
    case 'union':
      return type.types.some((member) => conforms(value, member, state, depth))
    case 'timestamp':
      // An invalid Date is an opaque host value, not a timestamp.
      return value instanceof Date && !Number.isNaN(value.getTime())
    case 'any':
    case 'boolean':
    case 'duration':
    case 'function':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'var':
    default:
      return matchesKind(value, type)
  }
}

const CLOCK_SAMPLE = 1024

function describeValue(value: unknown): string {
  if (value === null) return 'null (missing)'
  if (Array.isArray(value)) return 'a list'
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'an invalid Date' : 'a timestamp'
  if (typeof value === 'object') return 'a map'
  if (typeof value === 'string') return `string ${shown(value)}`
  if (typeof value === 'number' || typeof value === 'boolean')
    return `${typeof value} ${String(value)}`
  return typeof value
}

/** Bounds context validation like evaluation: depth, work, and wall-clock time. */
export interface ValidationBudget {
  readonly maxDepth: number
  remaining: number
  readonly deadline: number
  readonly onExhausted: (reason: 'steps' | 'time' | 'depth') => never
}

/** Why `value` does not conform to `type` (naming the path), or undefined when it does. */
export function describeMismatch(
  value: unknown,
  type: Type,
  path: string,
  budget: ValidationBudget,
  depth = 0,
): string | undefined {
  if (depth > budget.maxDepth) budget.onExhausted('depth')
  if (--budget.remaining < 0) budget.onExhausted('steps')
  if (
    budget.deadline !== 0 &&
    budget.remaining % CLOCK_SAMPLE === 0 &&
    performance.now() > budget.deadline
  ) {
    budget.onExhausted('time')
  }
  const actual = value === undefined ? null : value
  if (type.kind === 'list' && Array.isArray(actual)) {
    for (let i = 0; i < actual.length; i++) {
      const problem = describeMismatch(actual[i], type.element, `${path}[${i}]`, budget, depth + 1)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  if (type.kind === 'map' && isMap(actual)) {
    for (const [key, fieldType] of Object.entries(type.fields)) {
      const field = Object.hasOwn(actual, key) ? actual[key] : null
      const problem = describeMismatch(field, fieldType, `${path}.${key}`, budget, depth + 1)
      if (problem !== undefined) return problem
    }
    if (type.rest !== undefined) {
      const keys = Object.keys(actual)
      // Listing a map's keys costs per key (see keyListCost), and more for a large one.
      budget.remaining -= keyListCost(keys.length)
      if (budget.remaining < 0) budget.onExhausted('steps')
      for (const key of keys) {
        // Keys the language can never read are not part of the data.
        if (Object.hasOwn(type.fields, key) || BLOCKED_NAMES.has(key)) continue
        const problem = describeMismatch(
          actual[key],
          type.rest,
          `${path}.${key}`,
          budget,
          depth + 1,
        )
        if (problem !== undefined) return problem
      }
    }
    return undefined
  }
  if (type.kind === 'union') {
    if (
      type.types.some(
        (member) => describeMismatch(actual, member, path, budget, depth) === undefined,
      )
    ) {
      return undefined
    }
  } else if (type.kind === 'timestamp') {
    if (actual instanceof Date && !Number.isNaN(actual.getTime())) return undefined
  } else if (type.kind !== 'list' && type.kind !== 'map' && matchesKind(actual, type)) {
    return undefined
  }
  return `${path} should be ${formatType(type)}, got ${describeValue(actual)}`
}

export function overload(
  params: readonly Type[],
  result: Type,
  run: Overload['run'],
  options: {
    required?: number
    rest?: Type
    runAsync?: Overload['runAsync']
    ordered?: readonly string[]
    literals?: Overload['literals']
  } = {},
): Overload {
  return Object.freeze({ params: Object.freeze([...params]), result, run, ...options })
}

export function define(
  name: string,
  description: string,
  overloads: readonly Overload[],
): FunctionDef {
  return Object.freeze({ name, description, overloads: Object.freeze([...overloads]) })
}

// === validation of host-supplied declarations ===

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

const TYPE_DEPTH_LIMIT = 64

/**
 * Throws a TypeError unless `value` is a well-formed Type (as built by `t`).
 * Types come from configuration, so a malformed one is a programming error.
 */
export function assertType(value: unknown, path: string, depth = 0): asserts value is Type {
  if (depth > TYPE_DEPTH_LIMIT) throw new TypeError(`${path} nests deeper than ${TYPE_DEPTH_LIMIT}`)
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError(`${path} must be a type built with t (got ${describe(value)})`)
  }
  switch (value.kind) {
    case 'any':
    case 'never':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'timestamp':
    case 'duration':
      return
    case 'literal':
      if (!['string', 'number', 'boolean'].includes(typeof value.value)) {
        throw new TypeError(
          `${path} is a literal type whose value is not a string, number, or boolean`,
        )
      }
      return
    case 'list':
      assertType(value.element, `${path}.element`, depth + 1)
      return
    case 'map':
      if (!isRecord(value.fields)) throw new TypeError(`${path}.fields must be an object`)
      for (const [key, field] of Object.entries(value.fields))
        assertType(field, `${path}.fields.${key}`, depth + 1)
      if (value.rest !== undefined) assertType(value.rest, `${path}.rest`, depth + 1)
      return
    case 'union':
      if (!Array.isArray(value.types)) throw new TypeError(`${path}.types must be an array`)
      value.types.forEach((member: unknown, i: number) => {
        assertType(member, `${path}.types[${i}]`, depth + 1)
      })
      return
    case 'opaque':
      if (typeof value.name !== 'string')
        throw new TypeError(`${path} is an opaque type without a name`)
      return
    case 'function':
    case 'var':
    default:
      throw new TypeError(`${path} has an unsupported type kind "${value.kind}"`)
  }
}

const HOST_SPEC_KEYS = new Set([
  'params',
  'returns',
  'required',
  'rest',
  'async',
  'context',
  'description',
  'cost',
  'run',
])

/**
 * Throws unless `spec` is a well-formed host function declaration. `label`
 * names it in messages, e.g. `Function "rate"`.
 */
export function assertHostSpec(spec: unknown, label: string): void {
  if (!isRecord(spec)) throw new TypeError(`${label} must be declared with fn()`)
  for (const key of Object.keys(spec)) {
    if (!HOST_SPEC_KEYS.has(key)) throw new TypeError(`${label} has an unknown option "${key}"`)
  }
  if (!Array.isArray(spec.params)) throw new TypeError(`${label} needs a params array`)
  spec.params.forEach((param: unknown, i: number) => {
    assertType(param, `Parameter ${i + 1} of ${label}`)
  })
  assertType(spec.returns, `The returns type of ${label}`)
  if (spec.required !== undefined) {
    if (typeof spec.required !== 'number')
      throw new TypeError(`"required" of ${label} must be a number`)
    if (!Number.isInteger(spec.required) || spec.required < 0 || spec.required > spec.params.length)
      throw new RangeError(
        `"required" of ${label} must be an integer from 0 to ${spec.params.length}`,
      )
  }
  if (spec.rest !== undefined) assertType(spec.rest, `The rest type of ${label}`)
  for (const flag of ['async', 'context'] as const) {
    if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean')
      throw new TypeError(`"${flag}" of ${label} must be a boolean`)
  }
  if (spec.description !== undefined && typeof spec.description !== 'string')
    throw new TypeError(`"description" of ${label} must be a string`)
  if (spec.cost !== undefined) {
    if (typeof spec.cost !== 'number') throw new TypeError(`"cost" of ${label} must be a number`)
    if (!Number.isSafeInteger(spec.cost) || spec.cost < 0)
      throw new RangeError(`"cost" of ${label} must be a non-negative integer`)
  }
  if (typeof spec.run !== 'function') throw new TypeError(`${label} needs a run function`)
}
