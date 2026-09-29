import { BLOCKED_NAMES } from '../syntax/lexer.js'
import { BonsaiLimitError } from '../errors.js'
import {
  RegexSyntaxError,
  compileRegex,
  searchRegex,
  type Program as RegexProgram,
} from '../runtime/regex.js'
import {
  checkDatePattern,
  addDays,
  addMonths,
  formatTimestamp,
  fromWallClock,
  isoWeekday,
  parseTimestamp,
  wallClock,
} from '../runtime/time.js'
import {
  Duration,
  chargeIndexKey,
  chargeKey,
  keyListCost,
  mapBuildCost,
  chargeSearch,
  isMap,
  shown,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MS_PER_WEEK,
  contains,
  dateTime,
  describeKind,
  equals,
  errorText,
  isTimestamp,
  kindOf,
  order,
  SCAN_SHIFT,
  sortOrder,
  timeOf,
  toText,
  track,
} from '../runtime/values.js'
import { isExact, t, unionOf, widen, type Type } from '../types.js'
import {
  K,
  T,
  U,
  define,
  fnType,
  overload,
  type CallSite,
  type FunctionDef,
  type Lambda,
} from './define.js'

const MAX_ROUND_DIGITS = 15
const MAX_FIXED_DIGITS = 100
const MONTHS_PER_YEAR = 12

const any = t.any()
const num = t.number()
const str = t.string()
const bool = t.boolean()
const ts = t.timestamp()
const dur = t.duration()
const listT = t.list(T)
const optT = t.optional(T)
const optStr = t.optional(str)
const predicate = fnType([T, num], bool)
const primitiveText = t.union(str, num, bool, t.null())

// === argument helpers ===

function integer(value: unknown, what: string, site: CallSite): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw site.state.error(
      'INVALID_ARGUMENT',
      `${what} must be an integer, not ${typeof value === 'number' ? String(value) : describeKind(value)}`,
      site.span,
    )
  }
  return value
}

function nonNegativeInteger(value: unknown, what: string, site: CallSite): number {
  const n = integer(value, what, site)
  if (n < 0) throw site.state.error('INVALID_ARGUMENT', `${what} must not be negative`, site.span)
  return n
}

function finite(value: number, site: CallSite): number {
  if (!Number.isFinite(value))
    throw site.state.error('NON_FINITE', 'Result is not a finite number', site.span)
  return value
}

/** Accounts for a list or map a built-in built (see `track`), and returns it. */
function made<V extends unknown[] | Record<string, unknown>>(out: V, site: CallSite): V {
  track(out, site.state, site.span)
  return out
}

function newList(length: number, site: CallSite): unknown[] {
  site.state.listLimit(length, site.span)
  return new Array<unknown>(length)
}

/** Appends to a growing list, enforcing the list limit as it grows. */
function push(out: unknown[], value: unknown, site: CallSite): void {
  if (out.length >= site.state.limits.maxListLength) site.state.listLimit(out.length + 1, site.span)
  out.push(value ?? null)
}

function numbersOf(items: readonly unknown[], what: string, site: CallSite): number[] {
  site.state.charge(items.length)
  const out: number[] = []
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < items.length; i++) {
    const value = items[i]
    if (value === null || value === undefined) continue
    if (typeof value !== 'number') {
      throw site.state.error(
        'TYPE_ERROR',
        `${what} expects numbers but found ${describeKind(value)}`,
        site.span,
      )
    }
    if (!Number.isFinite(value)) {
      throw site.state.error('NON_FINITE', `${what} found a non-finite number`, site.span)
    }
    out.push(value)
  }
  return out
}

/** Copies a list by index: never runs a host list's iterator, species, or methods. */
function copyOf(items: readonly unknown[], from = 0, to = items.length): unknown[] {
  const out = new Array<unknown>(Math.max(0, to - from))
  // Host `undefined` (or a hole) is null in every list a built-in produces.
  for (let i = from; i < to; i++) out[i - from] = items[i] ?? null
  return out
}

/** Array.prototype.slice position semantics, without calling the list's own slice. */
function slicePositions(length: number, start: number, end: number | undefined): [number, number] {
  const clamp = (n: number): number => (n < 0 ? Math.max(0, length + n) : Math.min(n, length))
  const from = clamp(start)
  const to = end === undefined ? length : clamp(end)
  return [from, Math.max(from, to)]
}

function textOf(value: unknown, site: CallSite): string {
  return toText(value, site.state, site.span)
}

function asLambda(value: unknown): Lambda {
  return value as Lambda
}

function truthy(value: unknown, site: CallSite): boolean {
  if (value === true) return true
  if (value === false || value === null || value === undefined) return false
  throw site.state.error(
    'TYPE_ERROR',
    `The lambda must return a boolean, not ${describeKind(value)}`,
    site.span,
  )
}

function list(value: unknown): readonly unknown[] {
  return value as readonly unknown[]
}

// === patterns and number formats ===

const MAX_CACHED = 256
const MAX_INTL_DIGITS = 20
/**
 * Total compiled size (instructions plus class ranges, about 50 bytes each)
 * of the patterns kept for reuse, shared by every environment.
 */
const REGEX_CACHE_BUDGET = 100_000
/** Steps charged for creating a number formatter (about 6 microseconds of work). */
const NUMBER_FORMAT_COST = 256
/** Steps charged for formatting one number with Intl (about half a microsecond). */
const FORMAT_COST = 16
/** Steps charged for parsing a timestamp (a pattern match and calendar arithmetic). */
const PARSE_COST = 16

/**
 * Compiled patterns shared by every environment, bounded by total size and
 * least recently used first out. Each evaluation still pays to compile a
 * pattern the first time it uses it (see State.resource), so the cache only
 * saves time: it never changes step counts, and evicting never costs a
 * running evaluation uncharged work.
 */
const regexCache = new Map<string, RegexProgram>()
let regexCacheSize = 0
/** Patterns that failed to compile, and why: a retry never compiles again. */
const regexFailures = new Map<string, string>()
/** Number formats that failed to build, and why. */
const numberFormatFailures = new Map<string, string>()

/** Remembers a failure in a bounded shared map (oldest first out). */
function rememberFailure(failures: Map<string, string>, key: string, message: string): void {
  if (failures.size >= MAX_CACHED) failures.delete(failures.keys().next().value as string)
  failures.set(key, message)
}

function compiledPattern(pattern: string, site: CallSite): RegexProgram {
  const cached = regexCache.get(pattern)
  if (cached !== undefined) {
    regexCache.delete(pattern)
    regexCache.set(pattern, cached)
    return cached
  }
  const failed = regexFailures.get(pattern)
  if (failed !== undefined) throw site.state.error('INVALID_ARGUMENT', failed, site.span)
  let program: RegexProgram
  try {
    program = compileRegex(pattern)
  } catch (error) {
    if (error instanceof RegexSyntaxError) {
      rememberFailure(regexFailures, pattern, error.message)
      throw site.state.error('INVALID_ARGUMENT', error.message, site.span)
    }
    throw error
  }
  if (program.size > REGEX_CACHE_BUDGET) return program
  for (const [key, old] of regexCache) {
    if (regexCache.size < MAX_CACHED && regexCacheSize + program.size <= REGEX_CACHE_BUDGET) break
    regexCache.delete(key)
    regexCacheSize -= old.size
  }
  regexCache.set(pattern, program)
  regexCacheSize += program.size
  return program
}

function regexFor(pattern: string, site: CallSite): RegexProgram {
  const s = site.state
  if (pattern.length > s.limits.maxPatternLength) {
    throw new BonsaiLimitError(
      'PATTERN_LIMIT',
      `Pattern of length ${pattern.length} exceeds the limit of ${s.limits.maxPatternLength}`,
      { source: s.source, span: { start: site.span.start, end: site.span.end } },
    )
  }
  // Compiling reads the pattern (charged first, so a failing pattern pays too)
  // and builds the program.
  return s.resource(
    `r${pattern}`,
    1 + pattern.length,
    () => compiledPattern(pattern, site),
    (program) => program.size,
  )
}

/** Number formatters shared by every environment (charged per evaluation, as patterns are). */
const numberFormats = new Map<string, Intl.NumberFormat>()

function numberFormat(
  locale: string,
  options: Intl.NumberFormatOptions,
  site: CallSite,
): Intl.NumberFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`
  const format = site.state.resource(`n${key}`, NUMBER_FORMAT_COST, () => {
    let created = numberFormats.get(key)
    if (created !== undefined) return created
    const failed = numberFormatFailures.get(key)
    if (failed !== undefined) throw site.state.error('INVALID_ARGUMENT', failed, site.span)
    try {
      created = new Intl.NumberFormat(locale, options)
    } catch (error) {
      const message = `Invalid number format: ${errorText(error)}`
      rememberFailure(numberFormatFailures, key, message)
      throw site.state.error('INVALID_ARGUMENT', message, site.span)
    }
    if (numberFormats.size >= MAX_CACHED)
      numberFormats.delete(numberFormats.keys().next().value as string)
    numberFormats.set(key, created)
    return created
  })
  site.state.charge(FORMAT_COST)
  return format
}

// === strings ===

function replaceText(
  text: string,
  find: string,
  replacement: string,
  all: boolean,
  site: CallSite,
): string {
  if (find === '') {
    if (!all) {
      site.state.stringLimit(text.length + replacement.length, site.span)
      return replacement + text
    }
    site.state.stringLimit(text.length + replacement.length * (text.length + 1), site.span)
    site.state.charge(text.length)
    return text === '' ? replacement : replacement + text.split('').join(replacement) + replacement
  }
  chargeSearch(site.state, text.length, find.length)
  let out = ''
  let from = 0
  for (;;) {
    const at = text.indexOf(find, from)
    if (at === -1) break
    site.state.charge(1)
    out += text.slice(from, at) + replacement
    site.state.stringLimit(out.length + text.length - at - find.length, site.span)
    from = at + find.length
    if (!all) break
  }
  site.state.charge(1 + (text.length >>> SCAN_SHIFT))
  return out + text.slice(from)
}

function pad(
  text: string,
  length: unknown,
  fill: unknown,
  atStart: boolean,
  site: CallSite,
): string {
  const target = nonNegativeInteger(length, 'Target length', site)
  // Overload dispatch guarantees `fill` is a string, or null/undefined when omitted.
  const filler = typeof fill === 'string' ? fill : ' '
  if (target <= text.length || filler === '') return text
  site.state.stringLimit(target, site.span)
  site.state.charge(1 + (target >>> SCAN_SHIFT))
  return atStart ? text.padStart(target, filler) : text.padEnd(target, filler)
}

function roundTo(value: number, digits: number, site: CallSite): number {
  if (!Number.isInteger(digits) || digits < -MAX_ROUND_DIGITS || digits > MAX_ROUND_DIGITS) {
    throw site.state.error(
      'INVALID_ARGUMENT',
      'Digits must be an integer between -15 and 15',
      site.span,
    )
  }
  if (value === 0 || !Number.isFinite(value)) return finite(value, site)
  // Shift the decimal exponent textually so 1.005 rounds to 1.01, then round
  // half away from zero and shift back.
  const shift = (n: number, by: number): number => {
    const [mantissa, exponent] = n.toExponential().split('e') as [string, string]
    return Number(`${mantissa}e${Number(exponent) + by}`)
  }
  const shifted = Math.round(Math.abs(shift(value, digits)))
  const result = shifted === 0 ? 0 : Math.sign(value) * shift(shifted, -digits)
  return finite(result === 0 ? 0 : result, site)
}

// === lists ===

function sortKeyed(
  items: readonly unknown[],
  keys: readonly unknown[],
  direction: unknown,
  site: CallSite,
): unknown[] {
  const descending = direction === 'desc'
  if (
    direction !== undefined &&
    direction !== null &&
    direction !== 'asc' &&
    direction !== 'desc'
  ) {
    throw site.state.error('INVALID_ARGUMENT', 'Sort direction must be "asc" or "desc"', site.span)
  }
  const n = items.length
  const s = site.state
  s.charge(n === 0 ? 1 : Math.ceil(n * Math.log2(n + 1)))
  // Every key is checked, not only those a comparison happens to reach (a
  // list with one key makes no comparison at all).
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < keys.length; i++) checkOrderable(keys[i], site)
  // Each comparison charges for string length (sortOrder), so a long sort is
  // accounted, and interrupted by the step limit or timeout, as it runs. The
  // merge sort makes the same comparisons on every engine, so steps agree too.
  const indices = mergeSort(n, (a, b) => {
    const result = sortOrder(keys[a], keys[b], s, site.span)
    return descending ? -result : result
  })
  const out = new Array<unknown>(n)
  for (let i = 0; i < n; i++) out[i] = items[indices[i]] ?? null
  return made(out, site)
}

/** A stable bottom-up merge sort of the indices 0..n-1. */
function mergeSort(n: number, compare: (a: number, b: number) => number): number[] {
  let from = Array.from({ length: n }, (_, i) => i)
  let to = new Array<number>(n)
  for (let width = 1; width < n; width *= 2) {
    for (let low = 0; low < n; low += 2 * width) {
      const middle = Math.min(low + width, n)
      const high = Math.min(low + 2 * width, n)
      let i = low
      let j = middle
      let k = low
      // Take from the right run only when it is strictly smaller: stable.
      while (i < middle && j < high) to[k++] = compare(from[j], from[i]) < 0 ? from[j++] : from[i++]
      while (i < middle) to[k++] = from[i++]
      while (j < high) to[k++] = from[j++]
    }
    ;[from, to] = [to, from]
  }
  return from
}

function groupKey(key: unknown, site: CallSite): string {
  let name: string
  if (typeof key === 'string') {
    chargeKey(site.state, key)
    name = key
  } else if (typeof key === 'number' || typeof key === 'boolean') name = String(key)
  else
    throw site.state.error(
      'TYPE_ERROR',
      `A group key must be a string, number, or boolean, not ${describeKind(key)}`,
      site.span,
    )
  if (BLOCKED_NAMES.has(name))
    throw site.state.error('BLOCKED_PROPERTY', `"${name}" cannot be used as a key`, site.span)
  chargeIndexKey(site.state, name)
  return name
}

/** The list for `key`, created on first use. Own keys only: "toString" is a valid group. */
function bucket(groups: Record<string, unknown[]>, key: string): unknown[] {
  if (Object.hasOwn(groups, key)) return groups[key]
  const created: unknown[] = []
  groups[key] = created
  return created
}

function madeGroups(groups: Record<string, unknown[]>, site: CallSite): Record<string, unknown[]> {
  const keys = Object.keys(groups)
  // Building a map costs per key, and much more once it is large (see mapBuildCost).
  site.state.charge(keyListCost(keys.length) + mapBuildCost(keys.length))
  for (const key of keys) made(groups[key], site)
  return made(groups, site)
}

/** Identities of the values one canonical-key pass has seen that compare by identity. */
interface Identities {
  readonly ids: Map<unknown, number>
  next: number
}

/**
 * A string that is equal for two values exactly when `equals` says they are:
 * maps by sorted keys, timestamps by time, opaque values (symbols, host
 * objects) by identity, and NaN never. Charged by the size of the value.
 */
function canonicalKey(value: unknown, site: CallSite, depth: number, seen: Identities): string {
  const s = site.state
  if (value === null || value === undefined) return 'n'
  switch (typeof value) {
    case 'boolean':
      return value ? 'T' : 'F'
    case 'number':
      // NaN equals nothing, not even NaN: a key no other value shares.
      if (Number.isNaN(value)) return `N${seen.next++}`
      return `d${value === 0 ? 0 : value}`
    case 'string':
      s.charge(value.length >>> SCAN_SHIFT)
      return `s${value.length}:${value}`
    case 'bigint':
      // Bigints compare by value (1n == 1n).
      return `b${value}`
    case 'function':
    case 'object':
    case 'symbol':
    case 'undefined':
    default:
      break
  }
  if (depth > s.limits.maxValueDepth) {
    throw new BonsaiLimitError(
      'TOO_DEEP',
      `Values nest deeper than ${s.limits.maxValueDepth} (is the data cyclic?)`,
      { source: s.source, span: { start: site.span.start, end: site.span.end } },
    )
  }
  s.charge(1)
  if (Array.isArray(value)) {
    s.charge(value.length)
    let key = '['
    for (let i = 0; i < value.length; i++)
      key += (i === 0 ? '' : ',') + canonicalKey(value[i], site, depth + 1, seen)
    return charged(`${key}]`, site)
  }
  if (isTimestamp(value)) return `t${dateTime(value)}`
  if (value instanceof Duration) return `u${value.ms}`
  if (isMap(value)) {
    const keys = Object.keys(value)
    // Sorting compares keys: about log2(k) comparisons each, linear in the key length.
    let text = 0
    for (const name of keys) text += name.length
    s.charge(keys.length + Math.ceil(Math.log2(keys.length + 1)) * (text >>> SCAN_SHIFT))
    if (keys.length > 1) keys.sort()
    let key = '{'
    let first = true
    for (const name of keys) {
      if (BLOCKED_NAMES.has(name)) continue
      key += `${first ? '' : ','}${name.length}:${name}=${canonicalKey(value[name], site, depth + 1, seen)}`
      first = false
    }
    return charged(`${key}}`, site)
  }
  let id = seen.ids.get(value)
  if (id === undefined) {
    id = seen.next++
    seen.ids.set(value, id)
  }
  return `o${id}`
}

/** A key built at each nesting level copies its children's keys: charge the copy. */
function charged(key: string, site: CallSite): string {
  site.state.charge(key.length >>> SCAN_SHIFT)
  return key
}

/**
 * Steps per item for unique(): building each item's canonical key and hashing
 * it into a set costs about as much as eight ordinary steps even for a number.
 */
const UNIQUE_ITEM_COST = 8

function uniqueOf(items: readonly unknown[], site: CallSite): unknown[] {
  site.state.charge(items.length * UNIQUE_ITEM_COST)
  const seen = new Set<string>()
  const identities: Identities = { ids: new Map(), next: 0 }
  const out: unknown[] = []
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < items.length; i++) {
    const value = items[i] ?? null
    const key = canonicalKey(value, site, 0, identities)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return made(out, site)
}

function flatten(items: readonly unknown[], site: CallSite): unknown[] {
  site.state.charge(items.length)
  const out: unknown[] = []
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < items.length; i++) appendFlat(out, items[i], site)
  return made(out, site)
}

/** Appends a list's items (or a single value) to `out`, by index. */
function appendFlat(out: unknown[], value: unknown, site: CallSite): void {
  if (Array.isArray(value)) {
    site.state.listLimit(out.length + value.length, site.span)
    site.state.charge(value.length)
    // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
    for (let i = 0; i < value.length; i++) out.push(value[i] ?? null)
  } else push(out, value, site)
}

function joinText(items: readonly unknown[], separator: unknown, site: CallSite): string {
  const sep = separator === undefined || separator === null ? ',' : (separator as string)
  site.state.charge(items.length)
  let out = ''
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (
      item !== null &&
      item !== undefined &&
      typeof item === 'object' &&
      !(item instanceof Date) &&
      !(item instanceof Duration)
    ) {
      throw site.state.error(
        'TYPE_ERROR',
        `join needs text-like items but found ${describeKind(item)}`,
        site.span,
      )
    }
    const piece = (i === 0 ? '' : sep) + textOf(item, site)
    site.state.stringLimit(out.length + piece.length, site.span)
    out += piece
  }
  return out
}

/**
 * A value sort, min, and max can order: a finite number, a string, a valid
 * timestamp, a duration, or null. Checked for every item, so a single item is
 * held to the same rule as many.
 */
function checkOrderable(value: unknown, site: CallSite): void {
  if (value === null || value === undefined || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw site.state.error('NON_FINITE', 'Cannot order a non-finite number', site.span)
    return
  }
  if (value instanceof Duration) return
  if (value instanceof Date) {
    timeOf(value, site.state, site.span)
    return
  }
  throw site.state.error('TYPE_ERROR', `Cannot order ${describeKind(value)}`, site.span)
}

function extreme(items: readonly unknown[], sign: 1 | -1, site: CallSite): unknown {
  site.state.charge(items.length)
  let best: unknown = null
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === null || item === undefined) continue
    checkOrderable(item, site)
    if (best === null) {
      best = item
      continue
    }
    const result = order(item, best, site.state, site.span) as number
    if (result * sign > 0) best = item
  }
  return best
}

function entryList(map: Record<string, unknown>, site: CallSite): string[] {
  const listed = Object.keys(map)
  site.state.charge(keyListCost(listed.length))
  const keys = listed.filter((key) => !BLOCKED_NAMES.has(key))
  site.state.listLimit(keys.length, site.span)
  return keys
}

/** Result type of reading values out of a map type. */
function valueTypeOf(type: Type | undefined): Type {
  if (type === undefined || type.kind !== 'map') return any
  // A declared object may hold keys it does not list, of any type.
  if (type.rest === undefined && !isExact(type)) return any
  const members = Object.values(type.fields)
  if (type.rest !== undefined) members.push(type.rest)
  return members.length === 0 ? any : unionOf(members.map(widen))
}

// === definitions ===

const STRING_FUNCTIONS: FunctionDef[] = [
  define('toUpperCase', 'Upper-cases text.', [
    overload([str], str, ([s]) => (s as string).toUpperCase()),
  ]),
  define('toLowerCase', 'Lower-cases text.', [
    overload([str], str, ([s]) => (s as string).toLowerCase()),
  ]),
  define('trim', 'Removes leading and trailing whitespace.', [
    overload([str], str, ([s]) => (s as string).trim()),
  ]),
  define('trimStart', 'Removes leading whitespace.', [
    overload([str], str, ([s]) => (s as string).trimStart()),
  ]),
  define('trimEnd', 'Removes trailing whitespace.', [
    overload([str], str, ([s]) => (s as string).trimEnd()),
  ]),
  define('startsWith', 'Whether text starts with a prefix.', [
    overload([str, str], bool, ([s, p]) => (s as string).startsWith(p as string)),
  ]),
  define('endsWith', 'Whether text ends with a suffix.', [
    overload([str, str], bool, ([s, p]) => (s as string).endsWith(p as string)),
  ]),
  define('includes', 'Whether text contains a substring, or a list contains a value.', [
    overload([str, str], bool, ([s, p], site) => {
      chargeSearch(site.state, (s as string).length, (p as string).length)
      return (s as string).includes(p as string)
    }),
    overload([listT, any], bool, ([l, v], site) => contains(l, v, site.state, site.span)),
  ]),
  define('indexOf', 'Position of the first match, or -1.', [
    overload([str, str], num, ([s, p], site) => {
      chargeSearch(site.state, (s as string).length, (p as string).length)
      return (s as string).indexOf(p as string)
    }),
    overload([listT, any], num, ([l, v], site) => {
      const items = list(l)
      site.state.charge(items.length)
      for (let i = 0; i < items.length; i++)
        if (equals(items[i], v, site.state, 0, site.span)) return i
      return -1
    }),
  ]),
  define('lastIndexOf', 'Position of the last match, or -1.', [
    overload([str, str], num, ([s, p], site) => {
      chargeSearch(site.state, (s as string).length, (p as string).length)
      return (s as string).lastIndexOf(p as string)
    }),
    overload([listT, any], num, ([l, v], site) => {
      const items = list(l)
      site.state.charge(items.length)
      for (let i = items.length - 1; i >= 0; i--)
        if (equals(items[i], v, site.state, 0, site.span)) return i
      return -1
    }),
  ]),
  define('slice', 'A section of text or a list; negative positions count from the end.', [
    overload(
      [str, num, num],
      str,
      ([s, a, b], site) =>
        (s as string).slice(
          integer(a, 'Start', site),
          b === undefined || b === null ? undefined : integer(b, 'End', site),
        ),
      { required: 2 },
    ),
    overload(
      [listT, num, num],
      listT,
      ([l, a, b], site) => {
        const items = list(l)
        const [from, to] = slicePositions(
          items.length,
          integer(a, 'Start', site),
          b === undefined || b === null ? undefined : integer(b, 'End', site),
        )
        site.state.charge(to - from)
        return made(copyOf(items, from, to), site)
      },
      { required: 2 },
    ),
  ]),
  define('split', 'Splits text on a separator.', [
    overload(
      [str, str, num],
      t.list(str),
      ([s, sep, limit], site) => {
        const text = s as string
        site.state.charge(1 + (text.length >>> 4))
        chargeSearch(site.state, text.length, (sep as string).length)
        const max =
          limit === undefined || limit === null
            ? undefined
            : nonNegativeInteger(limit, 'Limit', site)
        // Never materialize more parts than the list limit allows.
        const cap = site.state.limits.maxListLength + 1
        const parts = text.split(sep as string, max === undefined ? cap : Math.min(max, cap))
        site.state.listLimit(parts.length, site.span)
        site.state.charge(parts.length)
        return parts
      },
      { required: 2 },
    ),
  ]),
  define('replace', 'Replaces the first occurrence of some text (no patterns).', [
    overload([str, str, str], str, ([s, f, r], site) =>
      replaceText(s as string, f as string, r as string, false, site),
    ),
  ]),
  define('replaceAll', 'Replaces every occurrence of some text (no patterns).', [
    overload([str, str, str], str, ([s, f, r], site) =>
      replaceText(s as string, f as string, r as string, true, site),
    ),
  ]),
  define('padStart', 'Pads text at the start to a length.', [
    overload([str, num, str], str, ([s, n, f], site) => pad(s as string, n, f, true, site), {
      required: 2,
    }),
  ]),
  define('padEnd', 'Pads text at the end to a length.', [
    overload([str, num, str], str, ([s, n, f], site) => pad(s as string, n, f, false, site), {
      required: 2,
    }),
  ]),
  define('repeat', 'Repeats text a number of times.', [
    overload([str, num], str, ([s, n], site) => {
      const count = nonNegativeInteger(n, 'Count', site)
      const text = s as string
      site.state.stringLimit(text.length * count, site.span)
      site.state.charge(1 + ((text.length * count) >>> SCAN_SHIFT))
      return text.repeat(count)
    }),
  ]),
  define('at', 'The item or character at a position; negative positions count from the end.', [
    overload(
      [str, num],
      optStr,
      ([s, i], site) => (s as string).at(integer(i, 'Index', site)) ?? null,
    ),
    overload([listT, num], optT, ([l, i], site) => {
      const items = list(l)
      const index = integer(i, 'Index', site)
      const position = index < 0 ? items.length + index : index
      return position < 0 || position >= items.length ? null : (items[position] ?? null)
    }),
  ]),
  define(
    'matches',
    'Whether text contains a match for a regular expression (JavaScript syntax without backreferences or lookaround, linear time; anchor with ^ and $; prefix (?i) to ignore case).',
    [
      overload(
        [str, str],
        bool,
        ([s, p], site) => {
          const program = regexFor(p as string, site)
          return searchRegex(program, s as string, (n) => {
            site.state.charge(n)
          })
        },
        {
          literals: ([, pattern]) => {
            if (typeof pattern !== 'string') return undefined
            try {
              compileRegex(pattern)
              return undefined
            } catch (error) {
              return error instanceof Error ? error.message : String(error)
            }
          },
        },
      ),
    ],
  ),
  define('toString', 'Renders a value as text, as a template would.', [
    overload([t.union(primitiveText, ts, dur)], str, ([v], site) => textOf(v, site)),
  ]),
  define('toNumber', 'Parses text as a number.', [
    overload([t.union(str, num)], num, ([v], site) => {
      if (typeof v === 'number') return v
      const text = (v as string).trim()
      const value = text === '' ? Number.NaN : Number(text)
      if (!Number.isFinite(value)) {
        throw site.state.error(
          'INVALID_ARGUMENT',
          `Cannot convert ${shown(v as string)} to a number`,
          site.span,
        )
      }
      return value
    }),
  ]),
]

const NUMBER_FUNCTIONS: FunctionDef[] = [
  define('round', 'Rounds half away from zero, optionally to a number of decimal digits.', [
    overload(
      [num, num],
      num,
      ([n, d], site) =>
        roundTo(n as number, d === undefined || d === null ? 0 : (d as number), site),
      { required: 1 },
    ),
  ]),
  define('floor', 'Rounds down.', [
    overload([num], num, ([n], site) => finite(Math.floor(n as number), site)),
  ]),
  define('ceil', 'Rounds up.', [
    overload([num], num, ([n], site) => finite(Math.ceil(n as number), site)),
  ]),
  define('trunc', 'Drops the fractional part.', [
    overload([num], num, ([n], site) => finite(Math.trunc(n as number), site)),
  ]),
  define('abs', 'Absolute value.', [
    overload([num], num, ([n], site) => finite(Math.abs(n as number), site)),
    overload([dur], dur, ([d]) => new Duration(Math.abs((d as Duration).ms))),
  ]),
  define('sqrt', 'Square root.', [
    overload([num], num, ([n], site) => finite(Math.sqrt(n as number), site)),
  ]),
  define('clamp', 'Limits a number to a range.', [
    overload([num, num, num], num, ([n, lo, hi], site) => {
      if ((lo as number) > (hi as number))
        throw site.state.error('INVALID_ARGUMENT', 'clamp: min is greater than max', site.span)
      finite(n as number, site)
      finite(lo as number, site)
      finite(hi as number, site)
      return finite(Math.min(Math.max(n as number, lo as number), hi as number), site)
    }),
  ]),
  define('toFixed', 'Formats a number with a fixed number of decimals.', [
    overload([num, num], str, ([n, d], site) => {
      const digits = nonNegativeInteger(d, 'Digits', site)
      if (digits > MAX_FIXED_DIGITS)
        throw site.state.error('INVALID_ARGUMENT', 'Digits must be at most 100', site.span)
      site.state.charge(digits >>> 2)
      // Round half away from zero first, so toFixed(1.005, 2) agrees with round(1.005, 2).
      finite(n as number, site)
      const value = digits <= MAX_ROUND_DIGITS ? roundTo(n as number, digits, site) : (n as number)
      return value.toFixed(digits)
    }),
  ]),
  define(
    'formatNumber',
    'Formats a number with grouping, e.g. 1,234.5, with optional decimals and locale (default "en-US").',
    [
      overload(
        [num, t.optional(num), t.optional(str)],
        str,
        ([n, d, locale], site) => {
          const digits =
            d === undefined || d === null ? undefined : nonNegativeInteger(d, 'Decimals', site)
          if (digits !== undefined && digits > MAX_INTL_DIGITS) {
            throw site.state.error(
              'INVALID_ARGUMENT',
              `Decimals must be at most ${MAX_INTL_DIGITS}`,
              site.span,
            )
          }
          const options: Intl.NumberFormatOptions =
            digits === undefined
              ? { maximumFractionDigits: MAX_INTL_DIGITS }
              : { minimumFractionDigits: digits, maximumFractionDigits: digits }
          finite(n as number, site)
          const value =
            digits === undefined || digits > MAX_ROUND_DIGITS
              ? (n as number)
              : roundTo(n as number, digits, site)
          return numberFormat(typeof locale === 'string' ? locale : 'en-US', options, site).format(
            value,
          )
        },
        { required: 1 },
      ),
    ],
  ),
  define(
    'formatCurrency',
    'Formats an amount in a currency (ISO 4217 code such as "EUR"), with an optional locale (default "en-US").',
    [
      overload(
        [num, str, t.optional(str)],
        str,
        ([n, currency, locale], site) =>
          numberFormat(
            typeof locale === 'string' ? locale : 'en-US',
            { style: 'currency', currency: currency as string },
            site,
          ).format(finite(n as number, site)),
        { required: 2 },
      ),
    ],
  ),
  define('min', 'The smallest value (nulls are skipped); null for an empty list.', [
    overload([listT], optT, ([l], site) => extreme(list(l), -1, site), { ordered: ['T'] }),
    overload([num], num, (args, site) => extreme(args, -1, site), { rest: num }),
  ]),
  define('max', 'The largest value (nulls are skipped); null for an empty list.', [
    overload([listT], optT, ([l], site) => extreme(list(l), 1, site), { ordered: ['T'] }),
    overload([num], num, (args, site) => extreme(args, 1, site), { rest: num }),
  ]),
  define('sum', 'The sum of the numbers in a list (nulls are skipped).', [
    overload([t.list(t.optional(num))], num, ([l], site) => {
      let total = 0
      for (const n of numbersOf(list(l), 'sum', site)) total += n
      return finite(total, site)
    }),
    overload([t.list(t.optional(dur))], dur, ([l], site) => {
      const items = list(l)
      site.state.charge(items.length)
      let total = 0
      // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
      for (let i = 0; i < items.length; i++) {
        const d = items[i]
        if (d instanceof Duration) total += d.ms
      }
      return new Duration(finite(total, site))
    }),
  ]),
  define('avg', 'The mean of the numbers in a list (nulls are skipped); null for no numbers.', [
    overload([t.list(t.optional(num))], t.optional(num), ([l], site) => {
      const values = numbersOf(list(l), 'avg', site)
      if (values.length === 0) return null
      let total = 0
      for (const n of values) total += n
      return finite(total / values.length, site)
    }),
  ]),
]

function hof(
  name: string,
  description: string,
  result: Type,
  run: (items: readonly unknown[], fn: Lambda, site: CallSite, extra: unknown[]) => unknown,
  runAsync: (
    items: readonly unknown[],
    fn: Lambda,
    site: CallSite,
    extra: unknown[],
  ) => Promise<unknown>,
  {
    lambda = predicate,
    extraParams = [],
    ordered = [],
  }: {
    readonly lambda?: Type
    readonly extraParams?: readonly Type[]
    readonly ordered?: readonly string[]
  } = {},
): FunctionDef {
  return define(name, description, [
    overload(
      [listT, lambda, ...extraParams],
      result,
      ([l, f, ...extra], site) => run(list(l), asLambda(f), site, extra),
      {
        required: 2,
        runAsync: ([l, f, ...extra], site) => runAsync(list(l), asLambda(f), site, extra),
        ...(ordered.length === 0 ? {} : { ordered }),
      },
    ),
  ])
}

const LIST_FUNCTIONS: FunctionDef[] = [
  hof(
    'map',
    'Transforms each item.',
    t.list(U),
    (items, fn, site) => {
      const out = newList(items.length, site)
      for (let i = 0; i < items.length; i++) out[i] = fn(items[i], i)
      return made(out, site)
    },
    async (items, fn, site) => {
      const out = newList(items.length, site)
      for (let i = 0; i < items.length; i++) out[i] = await fn(items[i], i)
      return made(out, site)
    },
    { lambda: fnType([T, num], U) },
  ),
  hof(
    'filter',
    'Keeps the items for which the lambda is true.',
    listT,
    (items, fn, site) => {
      const out: unknown[] = []
      for (let i = 0; i < items.length; i++)
        if (truthy(fn(items[i], i), site)) out.push(items[i] ?? null)
      return made(out, site)
    },
    async (items, fn, site) => {
      const out: unknown[] = []
      for (let i = 0; i < items.length; i++)
        if (truthy(await fn(items[i], i), site)) out.push(items[i] ?? null)
      return made(out, site)
    },
  ),
  hof(
    'find',
    'The first item for which the lambda is true, or null.',
    optT,
    (items, fn, site) => {
      for (let i = 0; i < items.length; i++)
        if (truthy(fn(items[i], i), site)) return items[i] ?? null
      return null
    },
    async (items, fn, site) => {
      for (let i = 0; i < items.length; i++)
        if (truthy(await fn(items[i], i), site)) return items[i] ?? null
      return null
    },
  ),
  hof(
    'findIndex',
    'The position of the first item for which the lambda is true, or -1.',
    num,
    (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) return i
      return -1
    },
    async (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (truthy(await fn(items[i], i), site)) return i
      return -1
    },
  ),
  hof(
    'some',
    'Whether the lambda is true for at least one item.',
    bool,
    (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) return true
      return false
    },
    async (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (truthy(await fn(items[i], i), site)) return true
      return false
    },
  ),
  hof(
    'every',
    'Whether the lambda is true for every item.',
    bool,
    (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (!truthy(fn(items[i], i), site)) return false
      return true
    },
    async (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (!truthy(await fn(items[i], i), site)) return false
      return true
    },
  ),
  hof(
    'none',
    'Whether the lambda is false for every item.',
    bool,
    (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) return false
      return true
    },
    async (items, fn, site) => {
      for (let i = 0; i < items.length; i++) if (truthy(await fn(items[i], i), site)) return false
      return true
    },
  ),
  hof(
    'flatMap',
    'Transforms each item and flattens list results one level.',
    t.list(U),
    (items, fn, site) => {
      const out: unknown[] = []
      for (let i = 0; i < items.length; i++) {
        appendFlat(out, fn(items[i], i), site)
      }
      return made(out, site)
    },
    async (items, fn, site) => {
      const out: unknown[] = []
      for (let i = 0; i < items.length; i++) {
        appendFlat(out, await fn(items[i], i), site)
      }
      return made(out, site)
    },
    { lambda: fnType([T, num], t.union(t.list(U), U)) },
  ),
  hof(
    'sortBy',
    'Sorts by a key; pass "desc" to reverse. Nulls sort first ("asc") or last ("desc").',
    listT,
    (items, fn, site, [direction]) => {
      const keys = newList(items.length, site)
      for (let i = 0; i < items.length; i++) keys[i] = fn(items[i], i)
      return sortKeyed(items, keys, direction, site)
    },
    async (items, fn, site, [direction]) => {
      const keys: unknown[] = []
      for (let i = 0; i < items.length; i++) keys.push(await fn(items[i], i))
      return sortKeyed(items, keys, direction, site)
    },
    { lambda: fnType([T, num], K), extraParams: [t.enum('asc', 'desc')], ordered: ['K'] },
  ),
  hof(
    'groupBy',
    'Groups items into a map of lists by a key.',
    t.record(listT),
    (items, fn, site) => {
      const out: Record<string, unknown[]> = {}
      for (let i = 0; i < items.length; i++)
        bucket(out, groupKey(fn(items[i], i), site)).push(items[i] ?? null)
      return madeGroups(out, site)
    },
    async (items, fn, site) => {
      const out: Record<string, unknown[]> = {}
      for (let i = 0; i < items.length; i++)
        bucket(out, groupKey(await fn(items[i], i), site)).push(items[i] ?? null)
      return madeGroups(out, site)
    },
    { lambda: fnType([T, num], t.union(str, num, bool)) },
  ),
  define('count', 'The number of items, or of items for which the lambda is true.', [
    overload([listT], num, ([l]) => list(l).length),
    overload(
      [listT, predicate],
      num,
      ([l, f], site) => {
        const items = list(l)
        const fn = asLambda(f)
        let n = 0
        for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) n++
        return n
      },
      {
        runAsync: async ([l, f], site) => {
          const items = list(l)
          const fn = asLambda(f)
          let n = 0
          for (let i = 0; i < items.length; i++) if (truthy(await fn(items[i], i), site)) n++
          return n
        },
      },
    ),
  ]),
  define('reduce', 'Folds a list into one value: reduce(list, (acc, item) => ..., initial).', [
    overload(
      [listT, fnType([U, T], U), U],
      U,
      ([l, f, initial]) => {
        const items = list(l)
        const fn = f as (acc: unknown, item: unknown) => unknown
        let acc = initial
        // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
        for (let i = 0; i < items.length; i++) acc = fn(acc, items[i])
        return acc
      },
      {
        runAsync: async ([l, f, initial]) => {
          const items = list(l)
          const fn = f as (acc: unknown, item: unknown) => unknown
          let acc = initial
          // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
          for (let i = 0; i < items.length; i++) acc = await fn(acc, items[i])
          return acc
        },
      },
    ),
  ]),
  define('sort', 'Sorts numbers, text, timestamps, or durations; pass "desc" to reverse.', [
    overload(
      [listT, t.enum('asc', 'desc')],
      listT,
      ([l, d], site) => sortKeyed(list(l), list(l), d, site),
      {
        required: 1,
        ordered: ['T'],
      },
    ),
  ]),
  define('reverse', 'The items in reverse order.', [
    overload([listT], listT, ([l], site) => {
      const items = list(l)
      site.state.charge(items.length)
      const out = newList(items.length, site)
      for (let i = 0; i < items.length; i++) out[i] = items[items.length - 1 - i] ?? null
      return made(out, site)
    }),
  ]),
  define('unique', 'The items without duplicates (by value), in first-seen order.', [
    overload([listT], listT, ([l], site) => uniqueOf(list(l), site)),
  ]),
  define('flat', 'Flattens nested lists one level.', [
    overload([t.list(any)], t.list(any), ([l], site) => flatten(list(l), site)),
  ]),
  define('first', 'The first item, or null.', [
    overload([listT], optT, ([l]) => list(l)[0] ?? null),
  ]),
  define('last', 'The last item, or null.', [
    overload([listT], optT, ([l]) => {
      const items = list(l)
      return items.length === 0 ? null : (items[items.length - 1] ?? null)
    }),
  ]),
  define('join', 'Joins items into text with a separator (default ",").', [
    overload(
      [t.list(t.union(primitiveText, ts, dur)), str],
      str,
      ([l, sep], site) => joinText(list(l), sep, site),
      {
        required: 1,
      },
    ),
  ]),
  define('isEmpty', 'Whether a list, text, or map has no items; null is empty.', [
    overload([t.union(t.list(any), str, t.record(any), t.null())], bool, ([v], site) => {
      if (v === null || v === undefined) return true
      if (Array.isArray(v) || typeof v === 'string') return v.length === 0
      // Listing a map's keys is linear in how many it has.
      const keys = Object.keys(v)
      site.state.charge(keyListCost(keys.length))
      return keys.length === 0
    }),
  ]),
]

const MAP_FUNCTIONS: FunctionDef[] = [
  define('keys', 'The keys of a map.', [
    overload([t.record(any)], t.list(str), ([m], site) =>
      entryList(m as Record<string, unknown>, site),
    ),
  ]),
  define('values', 'The values of a map.', [
    overload([t.record(T)], listT, ([m], site) => {
      const map = m as Record<string, unknown>
      return made(
        entryList(map, site).map((key) => map[key] ?? null),
        site,
      )
    }),
  ]),
  define('entries', 'The { key, value } pairs of a map.', [
    overload([t.record(T)], t.list(t.object({ key: str, value: T })), ([m], site) => {
      const map = m as Record<string, unknown>
      const keys = entryList(map, site)
      site.state.charge(keys.length)
      return made(
        keys.map((key) => made({ key, value: map[key] ?? null }, site)),
        site,
      )
    }),
  ]),
  define(
    'type',
    'The kind of a value: "null", "boolean", "number", "string", "list", "map", "timestamp", "duration", or "opaque".',
    [overload([any], str, ([v]) => kindOf(v))],
  ),
]

const optZone = t.optional(str)

function zoneArg(value: unknown): string | null {
  return value === undefined || value === null ? null : (value as string)
}

function field(
  name: string,
  description: string,
  pick: (clock: ReturnType<typeof wallClock>) => number,
): FunctionDef {
  return define(name, description, [
    overload([ts, optZone], num, ([d, z], site) => pick(wallClock(d as Date, zoneArg(z), site)), {
      required: 1,
    }),
  ])
}

function durationUnit(name: string, unitMs: number, description: string): FunctionDef {
  return define(name, description, [
    overload([num], dur, ([n], site) => new Duration(finite((n as number) * unitMs, site))),
  ])
}

function durationIn(name: string, unitMs: number, description: string): FunctionDef {
  return define(name, description, [overload([dur], num, ([d]) => (d as Duration).ms / unitMs)])
}

const TIME_FUNCTIONS: FunctionDef[] = [
  define('now', 'The current time, fixed for one evaluation.', [
    overload([], ts, (_, site) => site.state.now()),
  ]),
  define('timestamp', 'Parses ISO-8601 text or epoch milliseconds into a timestamp.', [
    overload([str], ts, ([s], site) => {
      site.state.charge(PARSE_COST)
      return parseTimestamp(s as string, site)
    }),
    overload([num], ts, ([n], site) => {
      const date = new Date(n as number)
      if (Number.isNaN(date.getTime()))
        throw site.state.error('INVALID_ARGUMENT', 'Timestamp out of range', site.span)
      return date
    }),
    overload([ts], ts, ([d], site) => {
      timeOf(d as Date, site.state, site.span)
      return d
    }),
  ]),
  durationUnit('weeks', MS_PER_WEEK, 'A duration of n weeks.'),
  durationUnit('days', MS_PER_DAY, 'A duration of n days (24 hours each).'),
  durationUnit('hours', MS_PER_HOUR, 'A duration of n hours.'),
  durationUnit('minutes', MS_PER_MINUTE, 'A duration of n minutes.'),
  durationUnit('seconds', MS_PER_SECOND, 'A duration of n seconds.'),
  durationUnit('milliseconds', 1, 'A duration of n milliseconds.'),
  durationIn('inDays', MS_PER_DAY, 'A duration as a (fractional) number of days.'),
  durationIn('inHours', MS_PER_HOUR, 'A duration as a number of hours.'),
  durationIn('inMinutes', MS_PER_MINUTE, 'A duration as a number of minutes.'),
  durationIn('inSeconds', MS_PER_SECOND, 'A duration as a number of seconds.'),
  durationIn('inMilliseconds', 1, 'A duration as a number of milliseconds.'),
  field('year', 'The calendar year, in a time zone (default UTC).', (c) => c.year),
  field('month', 'The month 1-12, in a time zone (default UTC).', (c) => c.month),
  field('day', 'The day of the month, in a time zone (default UTC).', (c) => c.day),
  field('hour', 'The hour 0-23, in a time zone (default UTC).', (c) => c.hour),
  field('minute', 'The minute, in a time zone (default UTC).', (c) => c.minute),
  field('second', 'The second, in a time zone (default UTC).', (c) => c.second),
  field(
    'dayOfWeek',
    'The ISO weekday (Monday 1 to Sunday 7), in a time zone (default UTC).',
    isoWeekday,
  ),
  define('startOfDay', 'Midnight at the start of the day, in a time zone (default UTC).', [
    overload(
      [ts, optZone],
      ts,
      ([d, z], site) => {
        const clock = wallClock(d as Date, zoneArg(z), site)
        return fromWallClock(
          { ...clock, hour: 0, minute: 0, second: 0, millisecond: 0 },
          zoneArg(z),
          site,
        )
      },
      { required: 1 },
    ),
  ]),
  define('startOfMonth', 'Midnight on the first of the month, in a time zone (default UTC).', [
    overload(
      [ts, optZone],
      ts,
      ([d, z], site) => {
        const clock = wallClock(d as Date, zoneArg(z), site)
        return fromWallClock(
          { ...clock, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
          zoneArg(z),
          site,
        )
      },
      { required: 1 },
    ),
  ]),
  define('startOfYear', 'Midnight on January 1, in a time zone (default UTC).', [
    overload(
      [ts, optZone],
      ts,
      ([d, z], site) => {
        const clock = wallClock(d as Date, zoneArg(z), site)
        return fromWallClock(
          { ...clock, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
          zoneArg(z),
          site,
        )
      },
      { required: 1 },
    ),
  ]),
  define('addDays', 'Adds calendar days (keeps the wall-clock time across DST), in a time zone.', [
    overload(
      [ts, num, optZone],
      ts,
      ([d, n, z], site) => addDays(d as Date, n as number, zoneArg(z), site),
      { required: 2 },
    ),
  ]),
  define('addMonths', 'Adds calendar months, clamping the day to the month length.', [
    overload(
      [ts, num, optZone],
      ts,
      ([d, n, z], site) => addMonths(d as Date, n as number, zoneArg(z), site),
      { required: 2 },
    ),
  ]),
  define('addYears', 'Adds calendar years (Feb 29 becomes Feb 28).', [
    overload(
      [ts, num, optZone],
      ts,
      ([d, n, z], site) =>
        addMonths(d as Date, integer(n, 'Years', site) * MONTHS_PER_YEAR, zoneArg(z), site),
      { required: 2 },
    ),
  ]),
  define(
    'formatDate',
    'Formats a timestamp in a time zone (default UTC). Tokens: yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h a mm m ss s SSS; quote literal text.',
    [
      overload(
        [ts, str, optZone],
        str,
        ([d, p, z], site) => {
          const text = formatTimestamp(d as Date, p as string, zoneArg(z), site)
          site.state.stringLimit(text.length, site.span)
          return text
        },
        {
          required: 2,
          literals: ([, pattern]) =>
            typeof pattern === 'string' ? checkDatePattern(pattern) : undefined,
        },
      ),
    ],
  ),
]

/** Result types that depend on argument types beyond simple type variables. */
export const RESULT_REFINERS: Readonly<
  Record<string, (args: readonly Type[]) => Type | undefined>
> = {
  values: (args) => t.list(valueTypeOf(args[0])),
  entries: (args) => t.list(t.object({ key: str, value: valueTypeOf(args[0]) })),
  flat: (args) => {
    const list0 = args[0]
    if (list0?.kind !== 'list') return undefined
    const element = list0.element
    const members = element.kind === 'union' ? element.types : [element]
    return t.list(
      unionOf(members.map((member) => (member.kind === 'list' ? member.element : member))),
    )
  },
}

export const BUILTINS: ReadonlyMap<string, FunctionDef> = new Map(
  [
    ...STRING_FUNCTIONS,
    ...NUMBER_FUNCTIONS,
    ...LIST_FUNCTIONS,
    ...MAP_FUNCTIONS,
    ...TIME_FUNCTIONS,
  ].map((def) => [def.name, def]),
)
