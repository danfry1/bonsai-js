import type { Span } from '../errors.js'
import { BLOCKED_NAMES } from '../syntax/lexer.js'
import type { State } from './state.js'

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60_000
export const MS_PER_HOUR = 3_600_000
export const MS_PER_DAY = 86_400_000
export const MS_PER_WEEK = 604_800_000

/** Searching, comparing, or scanning text costs one step per 2^6 = 64 characters. */
export const SCAN_SHIFT = 6
const SCAN_CHARS = 1 << SCAN_SHIFT
/**
 * A computed property name longer than KEY_FREE_CHARS costs one step per
 * 2^3 = 8 characters: the engine flattens, hashes, and interns it.
 */
const KEY_SHIFT = 3
const KEY_FREE_CHARS = 64
/**
 * Character comparisons per step for a substring search. Native search is
 * O(text x needle) in the worst case, and a single native call cannot be
 * interrupted, so the worst case is charged before it runs.
 */
const SEARCH_COMPARISONS_PER_STEP = 512
/**
 * Producing text costs one step per 2^5 = 32 characters of the result (a
 * concatenation, a template, a built-in's output), as does passing text to a
 * built-in. Engines join strings
 * lazily, but a later read flattens the whole string into new memory, so the
 * text an evaluation creates, and so the memory it can hold, is bounded by
 * the budget: at most about 32 million characters at the default.
 */
export const TEXT_SHIFT = 5
/** Durations print at most nanosecond precision. */
/** Durations are whole milliseconds, so seconds have at most three decimals. */
const DURATION_FRACTION_DIGITS = 3

/**
 * An exact span of time in whole milliseconds, the resolution of timestamps.
 * Durations are immutable values compared by length.
 */
export class Duration {
  readonly ms: number

  constructor(ms: number) {
    // Rounded once, halves away from zero, so duration arithmetic stays exact
    // and adding one to a timestamp never depends on which side of 1970 it is.
    const whole = ms < 0 ? -Math.round(-ms) : Math.round(ms)
    this.ms = whole === 0 ? 0 : whole
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
      // An invalid Date (or a fake one) is not a timestamp: it is an opaque host value.
      if (value instanceof Date) return Number.isNaN(dateTime(value)) ? 'opaque' : 'timestamp'
      if (value instanceof Duration) return 'duration'
      return isOpaqueObject(value) ? 'opaque' : 'map'
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
const getPrototypeOf = Object.getPrototypeOf
const OBJECT_PROTOTYPE: object = Object.prototype
/**
 * Whether `key` is an own enumerable property: the only properties that are
 * data. (A non-enumerable own property, like a class's hidden field, is not.)
 */
// oxlint-disable-next-line typescript/unbound-method -- always invoked with .call
const isEnumerable = Object.prototype.propertyIsEnumerable

/**
 * Whether a map holds `key` as data: an own key the language can read whose
 * value is not `undefined`. Host `undefined` reads as null, and a key holding
 * it counts as absent everywhere (==, keys, has, in, spread), so a record
 * means the same whether it came from JSON (key left out) or from an object
 * that set the key to undefined.
 */
export function holdsKey(map: Readonly<Record<string, unknown>>, key: string): boolean {
  return !BLOCKED_NAMES.has(key) && hasOwn(map, key) && map[key] !== undefined
}

/**
 * Whether a value is a map: a plain object, or a class instance, read through
 * its own properties. Lists, timestamps, durations, and built-in host objects
 * (a Map, a RegExp, a Promise, ...) are not.
 */
export function isMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (isPlainData(value)) return true
  if (Array.isArray(value) || value instanceof Date || value instanceof Duration) return false
  return !isOpaqueObject(value)
}

/**
 * The quick test for the common case, a plain data object: its constructor
 * is Object (or it has none, as with a null prototype). A false answer is not
 * final: `isMap` then classifies it fully. (Reading `constructor` is cheaper
 * than the prototype on varied shapes. Host data is trusted, so an object that
 * sets its own `constructor` to Object is read as the plain object it claims to be.)
 */
function isPlainData(value: object): boolean {
  const constructor = (value as { constructor?: unknown }).constructor
  return constructor === Object || constructor === undefined
}

/** Built-in prototypes whose instances keep their data in internal slots. */
const OPAQUE_PROTOTYPES: ReadonlySet<object> = new Set(
  [
    Map,
    Set,
    WeakMap,
    WeakSet,
    WeakRef,
    RegExp,
    Promise,
    Error,
    ArrayBuffer,
    DataView,
    Object.getPrototypeOf(Uint8Array) as { prototype: object },
    Number,
    String,
    Boolean,
    Symbol,
    BigInt,
    Date,
    ...(typeof SharedArrayBuffer === 'function' ? [SharedArrayBuffer] : []),
  ].map((constructor) => constructor.prototype as object),
)

/**
 * What each prototype chain means, from the chain alone (so the answer never
 * depends on which value was seen first): `true` for a built-in from this
 * realm, `false` for a plain or class chain from this realm, and `undefined`
 * for another realm (an iframe, `node:vm`), whose values are judged one by one.
 */
const chainVerdicts = new WeakMap<object, boolean | undefined>()
// oxlint-disable-next-line typescript/unbound-method -- always invoked with .call
const objectToString = Object.prototype.toString

function chainVerdict(proto: object): boolean | undefined {
  if (chainVerdicts.has(proto)) return chainVerdicts.get(proto)
  let verdict: boolean | undefined
  let link: object | null = proto
  let builtin = false
  for (;;) {
    if (OPAQUE_PROTOTYPES.has(link)) builtin = true
    const next = getPrototypeOf(link) as object | null
    if (next === null) {
      verdict = link === OBJECT_PROTOTYPE ? builtin : undefined
      break
    }
    link = next
  }
  chainVerdicts.set(proto, verdict)
  return verdict
}

/**
 * Built-in host objects keep their data internally (a Map's entries, a
 * RegExp's pattern), so reading them as maps of own properties would silently
 * see nothing. They are opaque: passed around, compared by identity, never read.
 * Plain objects, class instances, and objects that merely have a `then` method
 * are maps of their own properties; Bonsai never awaits a value it reads.
 */
function isOpaqueObject(value: object): boolean {
  const proto = getPrototypeOf(value) as object | null
  if (proto === OBJECT_PROTOTYPE || proto === null) return false
  const verdict = chainVerdict(proto)
  if (verdict !== undefined) return verdict
  // Another realm: its built-ins report their internal tag (a plain object or
  // class instance reports "Object"), checked per value, never cached.
  return objectToString.call(value) !== '[object Object]'
}

/**
 * Epoch milliseconds of a real Date, or NaN for an invalid Date and for an
 * object that only inherits from Date.prototype (which has no time slot).
 */
export function dateTime(value: Date): number {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return Number.NaN
  }
}

/** A valid timestamp: a real Date holding a time. */
export function isTimestamp(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(dateTime(value))
}

/**
 * The message of something host code threw, read defensively: a message
 * getter that throws, or a revoked Proxy, gives a fixed text instead.
 */
export function errorText(error: unknown): string {
  try {
    if (!(error instanceof Error)) return String(error)
    const message: unknown = error.message
    return typeof message === 'string' ? message : String(message)
  } catch {
    return 'an error that could not be read'
  }
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

/** Reads a member. Plain objects, the common case, take the short path first. */
export function readMember(object: unknown, name: string, s: State, at: Span): unknown {
  // The plain-object test inline (not via isPlainData), so this stays small enough to inline.
  if (typeof object === 'object' && object !== null && object.constructor === Object) {
    return hasOwn(object, name) ? ((object as Record<string, unknown>)[name] ?? null) : null
  }
  return readOtherMember(object, name, s, at)
}

function readOtherMember(object: unknown, name: string, s: State, at: Span): unknown {
  if (object === null || object === undefined) return null
  if (typeof object === 'object') {
    if (Array.isArray(object)) {
      if (name === 'length') return object.length
    } else if (isMap(object)) {
      if (!hasOwn(object, name)) return null
      const value = object[name]
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
    const name = keyName(key, s, at)
    // A blocked name is never data (in, has, and keys skip it too), so reading it is null.
    if (BLOCKED_NAMES.has(name)) return null
    chargeIndexKey(s, name)
    if (!hasOwn(object, name)) return null
    const value = object[name]
    return value === undefined ? null : value
  }
  throw s.error('TYPE_ERROR', `Cannot index ${describeKind(object)}`, at)
}

/**
 * Charges using a computed string as a property name. The engine hashes (and
 * flattens) the whole string to look it up or store it, so a long key costs
 * work in proportion to its length.
 */
export function chargeKey(s: State, key: string): void {
  if (key.length > KEY_FREE_CHARS) s.charge(key.length >>> KEY_SHIFT)
}

/** Converts a computed key to a property name, rejecting blocked keys. */
const INDEX_KEY = /^-?\d{1,16}$/u
const INDEX_KEY_MAX_LENGTH = 17
/** Extra steps for an integer-like key, which the engine stores and hashes more slowly. */
const INDEX_KEY_COST = 3

/**
 * Maps past this many keys are held by the engine as dictionaries, and each key
 * costs several times more to list or copy (hashing, cache misses).
 */
const LARGE_MAP = 16_384

/** Steps per key for listing a small map's keys, and a large one's. */
const SMALL_KEY_LIST = 2
const LARGE_KEY_LIST = 4
/** Steps per key for writing a small map, and a large one, beyond listing its keys. */
const SMALL_MAP_BUILD = 2
const LARGE_MAP_BUILD = 6

/** Steps for listing the keys of a map with `count` keys (keys, spread, ==, isEmpty). */
export function keyListCost(count: number): number {
  return count * (count > LARGE_MAP ? LARGE_KEY_LIST : SMALL_KEY_LIST)
}

/** Steps for writing `count` keys into a new map (spread, groupBy), beyond listing them. */
export function mapBuildCost(count: number): number {
  return count * (count > LARGE_MAP ? LARGE_MAP_BUILD : SMALL_MAP_BUILD)
}

/** Charges storing `name` as a key when it is integer-like (see {@link INDEX_KEY_COST}). */
export function chargeIndexKey(s: State, name: string): void {
  if (name.length <= INDEX_KEY_MAX_LENGTH && INDEX_KEY.test(name)) s.charge(INDEX_KEY_COST)
}

/** A computed key as a property name (a string, or a finite number as text). */
function keyName(key: unknown, s: State, at: Span): string {
  if (typeof key === 'string') {
    chargeKey(s, key)
    return key
  }
  if (typeof key === 'number' && Number.isFinite(key)) return String(key)
  throw s.error('TYPE_ERROR', `A map key must be a string, not ${describeKind(key)}`, at)
}

/** A computed key to write into a map: a blocked name is an error, since it could never be read. */
export function mapKey(key: unknown, s: State, at: Span): string {
  const name = keyName(key, s, at)
  if (BLOCKED_NAMES.has(name))
    throw s.error('BLOCKED_PROPERTY', `Property "${name}" is not accessible`, at)
  chargeIndexKey(s, name)
  return name
}

export function hasKey(object: unknown, key: unknown, s: State, at: Span): boolean {
  if (Array.isArray(object))
    return typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < object.length
  if (isMap(object)) {
    const name = typeof key === 'number' ? String(key) : key
    if (typeof name !== 'string') return false
    chargeKey(s, name)
    return holdsKey(object, name)
  }
  // has() is a read: an opaque value is never read into (as with `in`).
  if (kindOf(object) === 'opaque') {
    throw s.error(
      'TYPE_ERROR',
      `Cannot read property ${shown(String(key))} of ${describeKind(object)}`,
      at,
    )
  }
  return false
}

/**
 * Charges a substring search of `needle` characters in `text` characters for
 * its worst case, before it runs.
 */
export function chargeSearch(s: State, text: number, needle: number): void {
  s.charge(
    1 + Math.ceil(text / SCAN_CHARS) + Math.floor((text * needle) / SEARCH_COMPARISONS_PER_STEP),
  )
}

/** Charges comparing two strings (linear in the shorter). */
function chargeCompare(s: State, a: string, b: string): void {
  const shorter = a.length < b.length ? a.length : b.length
  if (shorter > SCAN_CHARS) s.charge(shorter >>> SCAN_SHIFT)
}

// === Produced values ===

/*
 * Logical size (nodes, counting every reference) and nesting depth of
 * containers this evaluation built, packed as size * DEPTH_SLOTS + depth, are
 * kept per evaluation (State.shapes). A value from an earlier evaluation passed
 * back in counts like any host value, so steps never depend on its history.
 */
/** Depth never exceeds maxValueDepth, a small number; 1024 slots leave room. */
const DEPTH_SLOTS = 1024
/** Flat maps up to this many keys are not recorded; they count as one node. */
const SMALL_MAP = 8

/**
 * Host lists count their length; host maps count as one node (counting their
 * keys would cost work on every reference). A result can therefore repeat
 * host maps, but never grow beyond the budget by nesting its own values.
 */
function shapeOf(shapes: WeakMap<object, number>, value: object): number {
  return shapes.get(value) ?? (Array.isArray(value) ? 1 + value.length : 1) * DEPTH_SLOTS + 1
}

/**
 * Accounts for a list or map an expression just built. Its logical size is
 * what serializing it costs (a container referenced twice counts twice), so
 * building from containers charges their size: `[acc, acc]` doubles the
 * charge each time instead of doubling a result for free. Its depth is capped
 * by `maxValueDepth`. Lists and maps without nested containers need no record.
 */
export function track(
  out: readonly unknown[] | Readonly<Record<string, unknown>>,
  s: State,
  at: Span | undefined,
): void {
  let nested = 0
  let count = 0
  let depth = 0
  // Until this evaluation records a shape, every container has the default one.
  const shapes = s.shapes
  const values: readonly unknown[] = Array.isArray(out)
    ? out
    : ownValues(out as Readonly<Record<string, unknown>>)
  count = values.length
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value === null || typeof value !== 'object') continue
    let shape: number
    if (shapes !== undefined) shape = shapeOf(shapes, value)
    else shape = (Array.isArray(value) ? 1 + value.length : 1) * DEPTH_SLOTS + 1
    const inner = shape % DEPTH_SLOTS
    nested += (shape - inner) / DEPTH_SLOTS - 1
    if (inner > depth) depth = inner
  }
  if (depth === 0) {
    // Flat: a list's size follows from its length; a larger map's is recorded.
    if (!Array.isArray(out) && count > SMALL_MAP)
      (s.shapes ??= new WeakMap()).set(out, (1 + count) * DEPTH_SLOTS + 1)
    return
  }
  if (depth + 1 > s.limits.maxValueDepth) {
    throw s.limit('VALUE_DEPTH_LIMIT', `A value nests deeper than ${s.limits.maxValueDepth}`, at)
  }
  if (nested > 0) s.charge(nested)
  ;(s.shapes ??= new WeakMap()).set(out, (1 + count + nested) * DEPTH_SLOTS + depth + 1)
}

function ownValues(map: Readonly<Record<string, unknown>>): unknown[] {
  const values: unknown[] = []
  for (const key in map) if (hasOwn(map, key)) values.push(map[key])
  return values
}

// === Equality and ordering ===

/** `==`: identical values take the fast path, but equal strings still pay for comparing. */
export function isEqual(a: unknown, b: unknown, s: State): boolean {
  if (a === b) {
    if (typeof a === 'string' && a.length > SCAN_CHARS) s.charge(a.length >>> SCAN_SHIFT)
    return true
  }
  return equals(a, b, s)
}

export function equals(a: unknown, b: unknown, s: State, depth = 0, at?: Span): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    chargeCompare(s, a, b)
    return a === b
  }
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined)
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (depth > s.limits.maxValueDepth) {
    throw s.limit(
      'VALUE_DEPTH_LIMIT',
      `Values nest deeper than ${s.limits.maxValueDepth} (is the data cyclic?)`,
      at,
    )
  }
  s.charge(1)
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    s.charge(a.length)
    for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i], s, depth + 1, at)) return false
    return true
  }
  if (Array.isArray(b)) return false
  // An invalid Date is opaque: equal only to itself (handled above).
  if (a instanceof Date) {
    const time = dateTime(a)
    return b instanceof Date && time === dateTime(b) && !Number.isNaN(time)
  }
  if (a instanceof Duration) return b instanceof Duration && a.ms === b.ms
  if (b instanceof Date || b instanceof Duration) return false
  if (!isMap(a) || !isMap(b)) return false
  // Listing keys costs work per key, so each side is charged as it is listed,
  // before the counts can differ and end the comparison early.
  const keys = Object.keys(a)
  s.charge(1 + keyListCost(keys.length))
  const other = Object.keys(b)
  s.charge(1 + keyListCost(other.length))
  // Data keys only (see holdsKey); each value is read once.
  const values: unknown[] = []
  const names: string[] = []
  for (const key of keys) {
    if (BLOCKED_NAMES.has(key)) continue
    const value = a[key]
    if (value === undefined) continue
    names.push(key)
    values.push(value)
  }
  let count = 0
  for (const key of other) if (!BLOCKED_NAMES.has(key) && b[key] !== undefined) count++
  if (names.length !== count) return false
  for (let i = 0; i < names.length; i++) {
    const key = names[i]
    // An own enumerable key, as Object.keys(b) lists: a non-enumerable key is not data.
    if (!isEnumerable.call(b, key)) return false
    const value = b[key]
    // A key holding undefined is absent, so it never matches a key with data.
    if (value === undefined || !equals(values[i], value, s, depth + 1, at)) return false
  }
  return true
}

/** Epoch milliseconds of a valid timestamp; an invalid Date is an error. */
export function timeOf(date: Date, s: State, at?: Span): number {
  const time = dateTime(date)
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
    chargeCompare(s, a, b)
    if (a < b) return -1
    return a > b ? 1 : 0
  }
  if (a instanceof Date && b instanceof Date) return timeOf(a, s, at) - timeOf(b, s, at)
  if (a instanceof Duration && b instanceof Duration) return a.ms - b.ms
  throw s.error('TYPE_ERROR', `Cannot compare ${describeKind(a)} with ${describeKind(b)}`, at)
}

/** Total order used by sort functions: like `order`, with null sorting first. */
export function sortOrder(a: unknown, b: unknown, s: State, at: Span): number {
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b))
    return a - b
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) {
    if (aNull === bNull) return 0
    return aNull ? -1 : 1
  }
  if (
    (typeof a === 'number' && !Number.isFinite(a)) ||
    (typeof b === 'number' && !Number.isFinite(b))
  ) {
    throw s.error('NON_FINITE', 'Cannot order a non-finite number', at)
  }
  return order(a, b, s, at) as number
}

export function contains(container: unknown, item: unknown, s: State, at: Span): boolean {
  if (container === null || container === undefined) return false
  if (Array.isArray(container)) {
    // Comparing with a string element is linear in the shorter string.
    s.charge(
      container.length *
        (1 + (typeof item === 'string' ? Math.floor(item.length / SCAN_CHARS) : 0)),
    )
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
    for (let i = 0; i < container.length; i++) if (equals(item, container[i], s, 0, at)) return true
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
    chargeSearch(s, container.length, item.length)
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
    chargeKey(s, key)
    return holdsKey(container, key)
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
    const length = a.length + b.length
    s.stringLimit(length, at)
    s.charge(1 + (length >>> TEXT_SHIFT))
    return a + b
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    s.listLimit(a.length + b.length, at)
    s.charge(1 + a.length + b.length)
    const out = new Array<unknown>(a.length + b.length)
    // Host `undefined` (or a hole) is null in every produced list.
    for (let i = 0; i < a.length; i++) out[i] = a[i] ?? null
    for (let i = 0; i < b.length; i++) out[a.length + i] = b[i] ?? null
    track(out, s, at)
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

/** A dividend below this takes the remainder in constant time. */
const FAST_REMAINDER = 1_048_576
/** Bits of exponent difference per step (the engine divides one bit at a time). */
const REMAINDER_BITS_PER_STEP = 24

export function remainder(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') {
    if (b === 0) throw s.error('DIVISION_BY_ZERO', 'Remainder by zero', at)
    // The remainder of a large number by a small one is long division over the
    // difference of their exponents: 1e308 % 7 costs a thousand times 7 % 3.
    const magnitude = Math.abs(a)
    if (magnitude >= FAST_REMAINDER && Number.isFinite(magnitude)) {
      const gap = Math.log2(magnitude) - Math.log2(Math.abs(b))
      if (gap > REMAINDER_BITS_PER_STEP) s.charge(Math.ceil(gap / REMAINDER_BITS_PER_STEP))
    }
    return finite(a % b, s, at)
  }
  throw arithmeticError('%', a, b, s, at)
}

export function power(a: unknown, b: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number' && typeof b === 'number') return finite(a ** b, s, at)
  throw arithmeticError('**', a, b, s, at)
}

export function negate(a: unknown, s: State, at: Span): unknown {
  if (typeof a === 'number') return a === 0 ? 0 : finite(-a, s, at)
  if (a instanceof Duration) return new Duration(-a.ms)
  throw s.error(
    'TYPE_ERROR',
    `Cannot negate ${describeKind(a)}${a === null || a === undefined ? '; use ?? to supply a default' : ''}`,
    at,
  )
}

// === Text ===

const MAX_SHOWN = 40
/** Steps for rendering a timestamp or duration as text. */
const TIME_TEXT_COST = 2

/** Input text quoted in an error message, shortened so messages stay small. */
export function shown(text: string): string {
  return JSON.stringify(text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text)
}

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
      // Formatting a timestamp or duration costs far more than its short text.
      if (value instanceof Date) {
        s.charge(TIME_TEXT_COST)
        return new Date(timeOf(value, s, at)).toISOString()
      }
      if (value instanceof Duration) {
        s.charge(TIME_TEXT_COST)
        return value.toString()
      }
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
  // Fixed notation, trimmed: 1.500 -> 1.5.
  const seconds = (rest / MS_PER_SECOND).toFixed(DURATION_FRACTION_DIGITS).replace(/\.?0+$/u, '')
  let time = ''
  if (hours > 0) time += `${hours}H`
  if (minutes > 0) time += `${minutes}M`
  if (seconds !== '0') time += `${seconds}S`
  // Whole days can exceed 2^53 (and would print as 1e+300); BigInt prints every digit.
  const dayText = days > 0 ? `${days < Number.MAX_SAFE_INTEGER ? days : BigInt(days)}D` : ''
  // Only a length that is not a number (from host data) prints nothing above.
  if (dayText === '' && time === '') return 'PT0S'
  return `${sign}P${dayText}${time === '' ? '' : `T${time}`}`
}
