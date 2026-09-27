import { BonsaiLimitError, type Span } from '../errors.js'
import type { State } from './state.js'

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60_000
export const MS_PER_HOUR = 3_600_000
export const MS_PER_DAY = 86_400_000
export const MS_PER_WEEK = 604_800_000

/** Characters `in` scans per step charged when searching a string. */
const SEARCH_CHARS_PER_STEP = 64
/** String concatenation charges one extra step per 2^8 = 256 characters. */
const CONCAT_COST_SHIFT = 8
/** Durations print at most nanosecond precision. */
const DURATION_FRACTION_DIGITS = 9

/** An exact span of time. Durations are immutable values compared by length. */
export class Duration {
  readonly ms: number

  constructor(ms: number) {
    this.ms = ms === 0 ? 0 : ms
    Object.freeze(this)
  }

  /** ISO-8601 text, e.g. `PT1H30M`, `P2DT3H`, `-PT0.5S`. */
  toString(): string {
    return formatDuration(this.ms)
  }

  toJSON(): string {
    return this.toString()
  }

  /** Readable output in Node's console and util.inspect. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Duration(${this.toString()})`
  }
}

export type Kind =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'list'
  | 'map'
  | 'timestamp'
  | 'duration'
  | 'opaque'

export function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) return 'null'
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'object':
      if (Array.isArray(value)) return 'list'
      if (value instanceof Date) return 'timestamp'
      if (value instanceof Duration) return 'duration'
      return 'map'
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
    default:
      return 'opaque'
  }
}

const KIND_TEXT: Readonly<Record<Kind, string>> = {
  null: 'null',
  boolean: 'a boolean',
  number: 'a number',
  string: 'a string',
  list: 'a list',
  map: 'a map',
  timestamp: 'a timestamp',
  duration: 'a duration',
  opaque: 'an opaque host value',
}

export function describeKind(value: unknown): string {
  return KIND_TEXT[kindOf(value)]
}

const hasOwn = Object.hasOwn
export const BLOCKED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function isMap(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Duration)
  )
}

// === Truthiness, members, indexing ===

/** The logic-operator test: booleans, with null as false. */
export function truth(value: unknown, s: State, at: Span, what: string): boolean {
  if (value === true) return true
  if (value === false || value === null || value === undefined) return false
  throw s.error(
    'TYPE_ERROR',
    `${what} expects a boolean but got ${describeKind(value)}${typeof value === 'number' || typeof value === 'string' ? '; compare explicitly, e.g. x != 0 or x != ""' : ''}`,
    at,
  )
}

export function readMember(object: unknown, name: string, s: State, at: Span): unknown {
  if (object === null || object === undefined) return null
  if (typeof object === 'object') {
    if (Array.isArray(object)) {
      if (name === 'length') return object.length
    } else if (!(object instanceof Date) && !(object instanceof Duration)) {
      if (!hasOwn(object, name)) return null
      const value = (object as Record<string, unknown>)[name]
      return value === undefined ? null : value
    }
  } else if (typeof object === 'string' && name === 'length') {
    return object.length
  }
  throw s.error(
    'TYPE_ERROR',
    `Cannot read property "${name}" of ${describeKind(object)}${Array.isArray(object) || typeof object === 'string' ? ' (only "length" is a property; call functions with name(...))' : ''}`,
    at,
  )
}

export function readIndex(object: unknown, key: unknown, s: State, at: Span): unknown {
  if (object === null || object === undefined || key === null || key === undefined) return null
  if (Array.isArray(object) || typeof object === 'string') {
    if (typeof key !== 'number') {
      throw s.error(
        'TYPE_ERROR',
        `A ${Array.isArray(object) ? 'list' : 'string'} index must be a number, not ${describeKind(key)}`,
        at,
      )
    }
    if (!Number.isInteger(key) || key < 0 || key >= object.length) return null
    const value: unknown = object[key]
    return value === undefined ? null : value
  }
  if (isMap(object)) {
    const name = mapKey(key, s, at)
    if (!hasOwn(object, name)) return null
    const value = object[name]
    return value === undefined ? null : value
  }
  throw s.error('TYPE_ERROR', `Cannot index ${describeKind(object)}`, at)
}

/** Converts a computed key to a property name, rejecting blocked keys. */
export function mapKey(key: unknown, s: State, at: Span): string {
  let name: string
  if (typeof key === 'string') name = key
  else if (typeof key === 'number' && Number.isFinite(key)) name = String(key)
  else throw s.error('TYPE_ERROR', `A map key must be a string, not ${describeKind(key)}`, at)
  if (BLOCKED_KEYS.has(name))
    throw s.error('BLOCKED_PROPERTY', `Property "${name}" is not accessible`, at)
  return name
}

export function hasKey(object: unknown, key: unknown): boolean {
  if (Array.isArray(object))
    return typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < object.length
  if (isMap(object)) {
    const name = typeof key === 'number' ? String(key) : key
    return typeof name === 'string' && !BLOCKED_KEYS.has(name) && hasOwn(object, name)
  }
  return false
}

// === Equality and ordering ===

export function equals(a: unknown, b: unknown, s: State, depth = 0): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined)
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (depth > s.limits.maxValueDepth) {
    throw new BonsaiLimitError(
      'TOO_DEEP',
      `Values nest deeper than ${s.limits.maxValueDepth} (is the data cyclic?)`,
      {
        source: s.source,
      },
    )
  }
  s.charge(1)
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    s.charge(a.length)
    for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i], s, depth + 1)) return false
    return true
  }
  if (Array.isArray(b)) return false
  if (a instanceof Date) return b instanceof Date && timeOf(a, s) === timeOf(b, s)
  if (a instanceof Duration) return b instanceof Duration && a.ms === b.ms
  if (b instanceof Date || b instanceof Duration) return false
  const visible = (key: string): boolean => !BLOCKED_KEYS.has(key)
  const keys = Object.keys(a).filter(visible)
  if (keys.length !== Object.keys(b).filter(visible).length) return false
  s.charge(keys.length)
  for (const key of keys) {
    if (!hasOwn(b, key)) return false
    if (
      !equals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        s,
        depth + 1,
      )
    )
      return false
  }
  return true
}

/** Epoch milliseconds of a valid timestamp; an invalid Date is an error. */
export function timeOf(date: Date, s: State, at?: Span): number {
  const time = date.getTime()
  if (Number.isNaN(time)) throw s.error('INVALID_ARGUMENT', 'Invalid timestamp', at)
  return time
}

/**
 * Ordering. Returns undefined when either side is null (every ordering
 * comparison is then false); a negative, zero, positive, or NaN number otherwise.
 */
export function order(a: unknown, b: unknown, s: State, at: Span): number | undefined {
  if (a === null || a === undefined || b === null || b === undefined) return undefined
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') {
    if (a < b) return -1
    return a > b ? 1 : 0
  }
  if (a instanceof Date && b instanceof Date) return timeOf(a, s, at) - timeOf(b, s, at)
  if (a instanceof Duration && b instanceof Duration) return a.ms - b.ms
  throw s.error('TYPE_ERROR', `Cannot compare ${describeKind(a)} with ${describeKind(b)}`, at)
}

/** Total order used by sort functions: like `order`, with null sorting first. */
export function sortOrder(a: unknown, b: unknown, s: State, at: Span): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) {
    if (aNull === bNull) return 0
    return aNull ? -1 : 1
  }
  const result = order(a, b, s, at) as number
  return Number.isNaN(result) ? 0 : result
}

export function contains(container: unknown, item: unknown, s: State, at: Span): boolean {
  if (container === null || container === undefined) return false
  if (Array.isArray(container)) {
    s.charge(container.length)
    if (item === null || item === undefined || typeof item !== 'object') {
      // oxlint-disable-next-line typescript/prefer-for-of -- indexing never invokes a host array's own Symbol.iterator
      for (let i = 0; i < container.length; i++) {
        const element: unknown = container[i]
        if (
          element === item ||
          ((item === null || item === undefined) && (element === null || element === undefined))
        ) {
          return true
        }
      }
      return false
    }
    // oxlint-disable-next-line typescript/prefer-for-of -- indexing never invokes a host array's own Symbol.iterator
    for (let i = 0; i < container.length; i++) if (equals(item, container[i], s)) return true
    return false
  }
  if (typeof container === 'string') {
    if (typeof item !== 'string') {
      throw s.error(
        'TYPE_ERROR',
        `"in" on a string needs a string on the left, not ${describeKind(item)}`,
        at,
      )
    }
    s.charge(Math.ceil(container.length / SEARCH_CHARS_PER_STEP))
    return container.includes(item)
  }
  if (isMap(container)) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw s.error(
        'TYPE_ERROR',
        `"in" on a map needs a string key on the left, not ${describeKind(item)}`,
        at,
      )
    }
    const key = String(item)
    return !BLOCKED_KEYS.has(key) && hasOwn(container, key)
  }
  throw s.error(
    'TYPE_ERROR',
    `"in" needs a list, string, or map on the right, not ${describeKind(container)}`,
    at,
  )
}

// === Arithmetic ===

function finite(value: number, s: State, at: Span): number {
  if (!Number.isFinite(value)) {
    throw s.error('NON_FINITE', 'Arithmetic produced a non-finite number', at)
  }
  return value
}

function timestamp(ms: number, s: State, at: Span): Date {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) throw s.error('INVALID_ARGUMENT', 'Timestamp out of range', at)
  return date
}

function arithmeticError(operator: string, a: unknown, b: unknown, s: State, at: Span): Error {
  let hint = ''
  if (a === null || a === undefined || b === null || b === undefined)
    hint = '; use ?? to supply a default'
  else if (operator === '+' && (typeof a === 'string' || typeof b === 'string'))
    hint = `; use a template to build text, e.g. \`\${a}\${b}\``
  else if (
    (a instanceof Date || b instanceof Date) &&
    (typeof a === 'number' || typeof b === 'number')
  )
    hint = '; use a duration, e.g. days(30)'
  return s.error(
    'TYPE_ERROR',
    `Cannot apply "${operator}" to ${describeKind(a)} and ${describeKind(b)}${hint}`,
    at,
  )
}

export function add(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') return finite(a + b, s, at)
  if (typeof a === 'string' && typeof b === 'string') {
    s.stringLimit(a.length + b.length, at)
    s.charge(1 + ((a.length + b.length) >>> CONCAT_COST_SHIFT))
    return a + b
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    s.listLimit(a.length + b.length, at)
    s.charge(1 + a.length + b.length)
    const out = new Array<unknown>(a.length + b.length)
    for (let i = 0; i < a.length; i++) out[i] = a[i]
    for (let i = 0; i < b.length; i++) out[a.length + i] = b[i]
    return out
  }
  if (a instanceof Duration && b instanceof Duration)
    return new Duration(finite(a.ms + b.ms, s, at))
  if (a instanceof Date && b instanceof Duration) return timestamp(timeOf(a, s, at) + b.ms, s, at)
  if (a instanceof Duration && b instanceof Date) return timestamp(timeOf(b, s, at) + a.ms, s, at)
  throw arithmeticError('+', a, b, s, at)
}

export function subtract(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') return finite(a - b, s, at)
  if (a instanceof Date && b instanceof Date)
    return new Duration(timeOf(a, s, at) - timeOf(b, s, at))
  if (a instanceof Date && b instanceof Duration) return timestamp(timeOf(a, s, at) - b.ms, s, at)
  if (a instanceof Duration && b instanceof Duration)
    return new Duration(finite(a.ms - b.ms, s, at))
  throw arithmeticError('-', a, b, s, at)
}

export function multiply(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') return finite(a * b, s, at)
  if (a instanceof Duration && typeof b === 'number') return new Duration(finite(a.ms * b, s, at))
  if (typeof a === 'number' && b instanceof Duration) return new Duration(finite(a * b.ms, s, at))
  throw arithmeticError('*', a, b, s, at)
}

export function divide(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') {
    if (b === 0) throw s.error('DIVISION_BY_ZERO', 'Division by zero', at)
    return finite(a / b, s, at)
  }
  if (a instanceof Duration && typeof b === 'number') {
    if (b === 0) throw s.error('DIVISION_BY_ZERO', 'Division by zero', at)
    return new Duration(finite(a.ms / b, s, at))
  }
  if (a instanceof Duration && b instanceof Duration) {
    if (b.ms === 0) throw s.error('DIVISION_BY_ZERO', 'Division by a zero duration', at)
    return finite(a.ms / b.ms, s, at)
  }
  throw arithmeticError('/', a, b, s, at)
}

export function remainder(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') {
    if (b === 0) throw s.error('DIVISION_BY_ZERO', 'Remainder by zero', at)
    return finite(a % b, s, at)
  }
  throw arithmeticError('%', a, b, s, at)
}

export function power(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') return finite(a ** b, s, at)
  throw arithmeticError('**', a, b, s, at)
}

export function negate(a: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number') return a === 0 ? 0 : -a
  if (a instanceof Duration) return new Duration(-a.ms)
  throw s.error(
    'TYPE_ERROR',
    `Cannot negate ${describeKind(a)}${a === null || a === undefined ? '; use ?? to supply a default' : ''}`,
    at,
  )
}

// === Text ===

/** Template rendering of one interpolated value. */
export function toText(value: unknown, s: State, at: Span): string {
  if (value === null || value === undefined) return ''
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
      return String(value)
    case 'bigint':
    case 'function':
    case 'object':
    case 'symbol':
    case 'undefined':
    default:
      if (value instanceof Date) {
        timeOf(value, s, at)
        return value.toISOString()
      }
      if (value instanceof Duration) return value.toString()
      throw s.error(
        'TYPE_ERROR',
        `Cannot render ${describeKind(value)} in a template${Array.isArray(value) ? '; use join(list, ", ")' : ''}`,
        at,
      )
  }
}

function formatDuration(ms: number): string {
  if (ms === 0) return 'PT0S'
  const sign = ms < 0 ? '-' : ''
  let rest = Math.abs(ms)
  const days = Math.floor(rest / MS_PER_DAY)
  rest -= days * MS_PER_DAY
  const hours = Math.floor(rest / MS_PER_HOUR)
  rest -= hours * MS_PER_HOUR
  const minutes = Math.floor(rest / MS_PER_MINUTE)
  rest -= minutes * MS_PER_MINUTE
  const seconds = rest / MS_PER_SECOND
  let time = ''
  if (hours > 0) time += `${hours}H`
  if (minutes > 0) time += `${minutes}M`
  if (seconds > 0) time += `${Number(seconds.toFixed(DURATION_FRACTION_DIGITS))}S`
  return `${sign}P${days > 0 ? `${days}D` : ''}${time === '' ? '' : `T${time}`}`
}
