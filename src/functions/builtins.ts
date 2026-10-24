import { BLOCKED_NAMES } from '../syntax/lexer.js'
import {
  RegexSyntaxError,
  compileRegex,
  searchRegex,
  type Program as RegexProgram,
} from '../runtime/regex.js'
import {
  checkDatePattern,
  addDays as addDaysIn,
  addMonths as addMonthsIn,
  formatTimestamp,
  fromWallClock,
  isoWeekday,
  parseTimestamp,
  checked,
  wallClock,
  type WallClock,
} from '../runtime/time.js'
import {
  Duration,
  durationOf,
  chargeIndexKey,
  chargeKey,
  keyListCost,
  mapBuildCost,
  chargeSearch,
  isMap,
  isValidDuration,
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
  holdsKey,
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
  Out,
  T,
  U,
  define,
  fnType,
  overload,
  type CallSite,
  type FunctionDef,
  type Lambda,
  type Overload,
} from './define.js'

/** What toNumber accepts: an optional sign, digits with an optional fraction, and an optional exponent. */
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u
const MAX_ROUND_DIGITS = 15
const MAX_FIXED_DIGITS = 100
/** 2^53: from here on every double is a whole number. */
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER + 1
/** Where Number#toFixed switches to exponential notation. */
const FIXED_NOTATION_LIMIT = 1e21
const MONTHS_PER_YEAR = 12

const any = /* @__PURE__ */ t.any()
const num = /* @__PURE__ */ t.number()
const str = /* @__PURE__ */ t.string()
const bool = /* @__PURE__ */ t.boolean()
const ts = /* @__PURE__ */ t.timestamp()
const dur = /* @__PURE__ */ t.duration()
const listT = /* @__PURE__ */ t.list(T)
const optT = /* @__PURE__ */ t.optional(T)
const optStr = /* @__PURE__ */ t.optional(str)
const predicate = /* @__PURE__ */ fnType([T, num], bool)
const primitiveText = /* @__PURE__ */ t.union(str, num, bool, t.null())

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

/** The first item that is not null, or null. */
function firstPresent(items: readonly unknown[]): unknown {
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item !== null && item !== undefined) return item
  }
  return null
}

/**
 * The total milliseconds and count of a list of durations (nulls are
 * skipped); anything else is a TYPE_ERROR naming `name`.
 */
function durationTotal(
  items: readonly unknown[],
  name: string,
  site: CallSite,
): { total: number; count: number } {
  site.state.charge(items.length)
  let total = 0
  let count = 0
  // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
  for (let i = 0; i < items.length; i++) {
    const d = items[i]
    if (d === null || d === undefined) continue
    if (!isValidDuration(d)) {
      throw site.state.error(
        'TYPE_ERROR',
        `${name} expects durations but found ${describeKind(d)}`,
        site.span,
      )
    }
    total += d.ms
    // Checked at each step, as a + b + c is: past 2^53 the total stops being exact.
    if (!Number.isSafeInteger(total)) durationOf(total, site.state, site.span)
    count++
  }
  return { total, count }
}

/** The total of a list of durations (nulls are skipped). */
function sumDurations(items: readonly unknown[], site: CallSite): Duration {
  return durationOf(durationTotal(items, 'sum', site).total, site.state, site.span)
}

/** The mean of a list of durations (nulls are skipped), or null for none. */
function averageDuration(items: readonly unknown[], site: CallSite): Duration | null {
  const { total, count } = durationTotal(items, 'avg', site)
  // The total is checked as sum checks it, so avg fails where sum would.
  const sum = durationOf(total, site.state, site.span)
  return count === 0 ? null : durationOf(sum.ms / count, site.state, site.span)
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

/** The value an async lambda's run resolved to (see {@link Out}). */
function ran(out: unknown): unknown {
  return (out as Out).v
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
/** Steps charged for creating a number formatter (about 18 microseconds for a new locale, measured). */
const NUMBER_FORMAT_COST = 1024
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
const regexCache = /* @__PURE__ */ new Map<string, RegexProgram>()
let regexCacheSize = 0
/**
 * Why a pattern does not compile, remembered so a repeated bad pattern is
 * parsed once. Bounded by count and by total characters (pattern and message),
 * as the compiled cache is by size.
 */
const badPatterns = /* @__PURE__ */ new Map<string, string>()
let badPatternChars = 0
/** Characters of bad patterns and their messages kept at most. */
const BAD_PATTERN_BUDGET = 100_000

/** The compiled pattern, from the cache when it is there; throws RegexSyntaxError. */
function cachedRegex(pattern: string): RegexProgram {
  const cached = regexCache.get(pattern)
  if (cached !== undefined) {
    regexCache.delete(pattern)
    regexCache.set(pattern, cached)
    return cached
  }
  const bad = badPatterns.get(pattern)
  if (bad !== undefined) throw new RegexSyntaxError(bad)
  let program: RegexProgram
  try {
    program = compileRegex(pattern)
  } catch (error) {
    if (error instanceof RegexSyntaxError) {
      // Starts over when full, so at most one pattern past the budget is kept.
      const chars = pattern.length + error.message.length
      if (badPatterns.size >= MAX_CACHED || (badPatternChars += chars) > BAD_PATTERN_BUDGET) {
        badPatterns.clear()
        badPatternChars = chars
      }
      badPatterns.set(pattern, error.message)
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

function compiledPattern(pattern: string, site: CallSite): RegexProgram {
  try {
    return cachedRegex(pattern)
  } catch (error) {
    if (error instanceof RegexSyntaxError)
      throw site.state.error('INVALID_ARGUMENT', error.message, site.span)
    throw error
  }
}

function regexFor(pattern: string, site: CallSite): RegexProgram {
  const s = site.state
  if (pattern.length > s.limits.maxPatternLength) {
    throw s.limit(
      'PATTERN_LIMIT',
      `Pattern of length ${pattern.length} exceeds the limit of ${s.limits.maxPatternLength}`,
      site.span,
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
const numberFormats = /* @__PURE__ */ new Map<string, Intl.NumberFormat>()

/**
 * Longest locale tag accepted. Real tags, even with Unicode extensions
 * (en-US-u-ca-gregory-nu-latn-hc-h23-cu-usd is 41 characters), are far
 * shorter; Intl's work on a tag grows faster than its length, so a longer one
 * is rejected before Intl sees it.
 */
const MAX_LOCALE_LENGTH = 64
/** An ISO 4217 currency code. */
const CURRENCY_CODE = /^[A-Za-z]{3}$/u

/**
 * Why a currency code is not one formatCurrency can use. Any three letters
 * are accepted: Intl prints a code it has no symbol for as the code itself,
 * and the list of codes it knows differs between runtimes.
 */
function currencyProblem(code: string): string | undefined {
  return CURRENCY_CODE.test(code)
    ? undefined
    : `Currency codes are three letters (ISO 4217), not ${shown(code)}`
}

/** What checking found for each literal locale and currency (bounded like the format cache). */
const formatProblems = /* @__PURE__ */ new Map<string, string | null>()

/**
 * Why a literal locale or currency would fail formatNumber or formatCurrency
 * at run time, so the checker reports it (INVALID_ARGUMENT) before anything
 * runs. Non-literal arguments are left to run time.
 */
function formatProblem(locale: unknown, currency: unknown): string | undefined {
  const tag = typeof locale === 'string' ? locale : undefined
  const code = typeof currency === 'string' ? currency : undefined
  if (tag === undefined && code === undefined) return undefined
  const key = `${tag ?? ''}\u0000${code ?? ''}`
  const known = formatProblems.get(key)
  if (known !== undefined) return known ?? undefined
  let problem: string | undefined
  if (tag !== undefined && tag.length > MAX_LOCALE_LENGTH) {
    problem = `Locale tags are at most ${MAX_LOCALE_LENGTH} characters long`
  } else if (code !== undefined && !CURRENCY_CODE.test(code)) {
    problem = currencyProblem(code)
  } else {
    try {
      const options: Intl.NumberFormatOptions =
        code === undefined ? {} : { style: 'currency', currency: code }
      // A currency alone is checked against the default locale, as it runs.
      new Intl.NumberFormat(tag ?? 'en-US', options).format(0)
      if (tag !== undefined && Intl.NumberFormat.supportedLocalesOf(tag).length === 0)
        problem = `Unsupported locale ${shown(tag)}`
    } catch (error) {
      problem = `Invalid number format: ${errorText(error)}`
    }
  }
  if (formatProblems.size >= MAX_CACHED)
    formatProblems.delete(formatProblems.keys().next().value as string)
  formatProblems.set(key, problem ?? null)
  return problem
}

/** `signDisplay: 'negative'` (ES2023, Node 20+); the ES2022 lib types do not list it yet. */
const NEGATIVE_ONLY = 'negative' as Intl.NumberFormatOptions['signDisplay']

function numberFormat(
  locale: string,
  options: Intl.NumberFormatOptions,
  site: CallSite,
): Intl.NumberFormat {
  if (locale.length > MAX_LOCALE_LENGTH) {
    throw site.state.error(
      'INVALID_ARGUMENT',
      `Locale tags are at most ${MAX_LOCALE_LENGTH} characters long`,
      site.span,
    )
  }
  const problem = options.currency === undefined ? undefined : currencyProblem(options.currency)
  if (problem !== undefined) throw site.state.error('INVALID_ARGUMENT', problem, site.span)
  const key = `${locale}\u0000${JSON.stringify(options)}`
  const format = site.state.resource(`n${key}`, NUMBER_FORMAT_COST, () => {
    let created = numberFormats.get(key)
    if (created !== undefined) return created
    let supported: string[]
    try {
      supported = Intl.NumberFormat.supportedLocalesOf(locale)
      // A sign only for a negative amount that does not show as zero: nothing
      // else in the language shows -0, so neither does "-$0.00".
      created = new Intl.NumberFormat(locale, { ...options, signDisplay: NEGATIVE_ONLY })
    } catch (error) {
      throw site.state.error(
        'INVALID_ARGUMENT',
        `Invalid number format: ${errorText(error)}`,
        site.span,
      )
    }
    // Intl falls back to the host's default locale for a tag it has no data
    // for, so the same expression would format differently on each server.
    if (supported.length === 0) {
      throw site.state.error('INVALID_ARGUMENT', `Unsupported locale ${shown(locale)}`, site.span)
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
  // At 2^53 and beyond every double is a whole number, so there is nothing to
  // round to at zero or more digits (and shifting could overflow).
  if (digits >= 0 && Math.abs(value) >= MAX_EXACT_INTEGER) return value
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
  // The sorted list is as long as the input: checked before anything is allocated.
  s.listLimit(n, site.span)
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
  // Counted as building counts (see track): the outermost container is level 1.
  if (depth + 1 > s.limits.maxValueDepth) {
    throw s.limit(
      'VALUE_DEPTH_LIMIT',
      `Values nest deeper than ${s.limits.maxValueDepth} (is the data cyclic?)`,
      site.span,
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
  if (isValidDuration(value)) return `u${value.ms}`
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
      if (!holdsKey(value, name)) continue
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
    // An item is one level inside the list, as building counts it.
    const key = canonicalKey(value, site, 1, identities)
    if (seen.has(key)) continue
    seen.add(key)
    push(out, value, site)
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
      !isValidDuration(item)
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
  if (isValidDuration(value)) return
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

/**
 * The overloads of min and max: of a list, then of their arguments, one
 * overload per kind a list can order, so `max(a, b)` takes what `[a, b].max()`
 * does (and, unlike the list, no nulls). Built in one call, not spread into a
 * literal, so an unused min or max stays a pure call that bundlers drop.
 */
function extremes(sign: 1 | -1): Overload[] {
  return [
    overload([listT], optT, ([l], site) => extreme(list(l), sign, site), { ordered: ['T'] }),
    ...[num, str, ts, dur].map((kind) =>
      overload([kind], kind, (args, site) => extreme(args, sign, site), { rest: kind }),
    ),
  ]
}

function entryList(map: Record<string, unknown>, site: CallSite): string[] {
  const listed = Object.keys(map)
  site.state.charge(keyListCost(listed.length))
  const keys = listed.filter((key) => holdsKey(map, key))
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

export const toUpperCase: FunctionDef = /* @__PURE__ */ define('toUpperCase', [
  /* @__PURE__ */ overload([str], str, ([s]) => (s as string).toUpperCase()),
])

export const toLowerCase: FunctionDef = /* @__PURE__ */ define('toLowerCase', [
  /* @__PURE__ */ overload([str], str, ([s]) => (s as string).toLowerCase()),
])

export const trim: FunctionDef = /* @__PURE__ */ define('trim', [
  /* @__PURE__ */ overload([str], str, ([s]) => (s as string).trim()),
])

export const trimStart: FunctionDef = /* @__PURE__ */ define('trimStart', [
  /* @__PURE__ */ overload([str], str, ([s]) => (s as string).trimStart()),
])

export const trimEnd: FunctionDef = /* @__PURE__ */ define('trimEnd', [
  /* @__PURE__ */ overload([str], str, ([s]) => (s as string).trimEnd()),
])

export const startsWith: FunctionDef = /* @__PURE__ */ define('startsWith', [
  /* @__PURE__ */ overload([str, str], bool, ([s, p]) => (s as string).startsWith(p as string)),
])

export const endsWith: FunctionDef = /* @__PURE__ */ define('endsWith', [
  /* @__PURE__ */ overload([str, str], bool, ([s, p]) => (s as string).endsWith(p as string)),
])

export const includes: FunctionDef = /* @__PURE__ */ define('includes', [
  /* @__PURE__ */ overload([str, str], bool, ([s, p], site) => {
    chargeSearch(site.state, (s as string).length, (p as string).length)
    return (s as string).includes(p as string)
  }),
  /* @__PURE__ */ overload([listT, any], bool, ([l, v], site) =>
    contains(l, v, site.state, site.span),
  ),
])

export const indexOf: FunctionDef = /* @__PURE__ */ define('indexOf', [
  /* @__PURE__ */ overload([str, str], num, ([s, p], site) => {
    chargeSearch(site.state, (s as string).length, (p as string).length)
    return (s as string).indexOf(p as string)
  }),
  /* @__PURE__ */ overload([listT, any], num, ([l, v], site) => {
    const items = list(l)
    site.state.charge(items.length)
    for (let i = 0; i < items.length; i++)
      if (equals(items[i], v, site.state, 0, site.span)) return i
    return -1
  }),
])

export const lastIndexOf: FunctionDef = /* @__PURE__ */ define('lastIndexOf', [
  /* @__PURE__ */ overload([str, str], num, ([s, p], site) => {
    chargeSearch(site.state, (s as string).length, (p as string).length)
    return (s as string).lastIndexOf(p as string)
  }),
  /* @__PURE__ */ overload([listT, any], num, ([l, v], site) => {
    const items = list(l)
    site.state.charge(items.length)
    for (let i = items.length - 1; i >= 0; i--)
      if (equals(items[i], v, site.state, 0, site.span)) return i
    return -1
  }),
])

export const slice: FunctionDef = /* @__PURE__ */ define('slice', [
  /* @__PURE__ */ overload(
    [str, num, num],
    str,
    ([s, a, b], site) =>
      (s as string).slice(
        integer(a, 'Start', site),
        b === undefined || b === null ? undefined : integer(b, 'End', site),
      ),
    { required: 2 },
  ),
  /* @__PURE__ */ overload(
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
      site.state.listLimit(to - from, site.span)
      return made(copyOf(items, from, to), site)
    },
    { required: 2 },
  ),
])

export const split: FunctionDef = /* @__PURE__ */ define('split', [
  /* @__PURE__ */ overload(
    [str, str, num],
    /* @__PURE__ */ t.list(str),
    ([s, sep, limit], site) => {
      const text = s as string
      site.state.charge(1 + (text.length >>> 4))
      chargeSearch(site.state, text.length, (sep as string).length)
      const max =
        limit === undefined || limit === null ? undefined : nonNegativeInteger(limit, 'Limit', site)
      // Never materialize more parts than the list limit allows.
      const cap = site.state.limits.maxListLength + 1
      const parts = text.split(sep as string, max === undefined ? cap : Math.min(max, cap))
      site.state.listLimit(parts.length, site.span)
      site.state.charge(parts.length)
      return parts
    },
    { required: 2 },
  ),
])

export const replace: FunctionDef = /* @__PURE__ */ define('replace', [
  /* @__PURE__ */ overload([str, str, str], str, ([s, f, r], site) =>
    replaceText(s as string, f as string, r as string, false, site),
  ),
])

export const replaceAll: FunctionDef = /* @__PURE__ */ define('replaceAll', [
  /* @__PURE__ */ overload([str, str, str], str, ([s, f, r], site) =>
    replaceText(s as string, f as string, r as string, true, site),
  ),
])

export const padStart: FunctionDef = /* @__PURE__ */ define('padStart', [
  /* @__PURE__ */ overload(
    [str, num, str],
    str,
    ([s, n, f], site) => pad(s as string, n, f, true, site),
    {
      required: 2,
    },
  ),
])

export const padEnd: FunctionDef = /* @__PURE__ */ define('padEnd', [
  /* @__PURE__ */ overload(
    [str, num, str],
    str,
    ([s, n, f], site) => pad(s as string, n, f, false, site),
    {
      required: 2,
    },
  ),
])

export const repeat: FunctionDef = /* @__PURE__ */ define('repeat', [
  /* @__PURE__ */ overload([str, num], str, ([s, n], site) => {
    const count = nonNegativeInteger(n, 'Count', site)
    const text = s as string
    site.state.stringLimit(text.length * count, site.span)
    site.state.charge(1 + ((text.length * count) >>> SCAN_SHIFT))
    return text.repeat(count)
  }),
])

export const at: FunctionDef = /* @__PURE__ */ define('at', [
  /* @__PURE__ */ overload(
    [str, num],
    optStr,
    ([s, i], site) => (s as string).at(integer(i, 'Index', site)) ?? null,
  ),
  /* @__PURE__ */ overload([listT, num], optT, ([l, i], site) => {
    const items = list(l)
    const index = integer(i, 'Index', site)
    const position = index < 0 ? items.length + index : index
    return position < 0 || position >= items.length ? null : (items[position] ?? null)
  }),
])

export const matches: FunctionDef = /* @__PURE__ */ define('matches', [
  /* @__PURE__ */ overload(
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
          cachedRegex(pattern)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    },
  ),
])

export const toString: FunctionDef = /* @__PURE__ */ define('toString', [
  /* @__PURE__ */ overload([/* @__PURE__ */ t.union(primitiveText, ts, dur)], str, ([v], site) =>
    textOf(v, site),
  ),
])

export const toNumber: FunctionDef = /* @__PURE__ */ define('toNumber', [
  /* @__PURE__ */ overload([/* @__PURE__ */ t.union(str, num)], num, ([v], site) => {
    if (typeof v === 'number') return v
    const text = (v as string).trim()
    // Decimal only: user data such as "0x10" is not read as hexadecimal.
    const value = DECIMAL_TEXT.test(text) ? Number(text) : Number.NaN
    if (!Number.isFinite(value)) {
      throw site.state.error(
        'INVALID_ARGUMENT',
        `Cannot convert ${shown(v as string)} to a number`,
        site.span,
      )
    }
    return value
  }),
])

/** A built-in applying a number function whose result must be finite. */
function math(name: string, apply: (n: number) => number): FunctionDef {
  return define(name, [overload([num], num, ([n], site) => finite(apply(n as number), site))])
}

export const round: FunctionDef = /* @__PURE__ */ define('round', [
  /* @__PURE__ */ overload(
    [num, num],
    num,
    ([n, d], site) => roundTo(n as number, d === undefined || d === null ? 0 : (d as number), site),
    { required: 1 },
  ),
])

export const floor: FunctionDef = /* @__PURE__ */ math('floor', Math.floor)

export const ceil: FunctionDef = /* @__PURE__ */ math('ceil', Math.ceil)

export const trunc: FunctionDef = /* @__PURE__ */ math('trunc', Math.trunc)

export const abs: FunctionDef = /* @__PURE__ */ define('abs', [
  /* @__PURE__ */ overload([num], num, ([n], site) => finite(Math.abs(n as number), site)),
  /* @__PURE__ */ overload([dur], dur, ([d]) => new Duration(Math.abs((d as Duration).ms))),
])

export const sqrt: FunctionDef = /* @__PURE__ */ math('sqrt', Math.sqrt)

export const clamp: FunctionDef = /* @__PURE__ */ define('clamp', [
  /* @__PURE__ */ overload([num, num, num], num, ([n, lo, hi], site) => {
    if ((lo as number) > (hi as number))
      throw site.state.error('INVALID_ARGUMENT', 'clamp: min is greater than max', site.span)
    finite(n as number, site)
    finite(lo as number, site)
    finite(hi as number, site)
    return finite(Math.min(Math.max(n as number, lo as number), hi as number), site)
  }),
])

export const toFixed: FunctionDef = /* @__PURE__ */ define('toFixed', [
  /* @__PURE__ */ overload([num, num], str, ([n, d], site) => {
    const digits = nonNegativeInteger(d, 'Digits', site)
    if (digits > MAX_FIXED_DIGITS)
      throw site.state.error('INVALID_ARGUMENT', 'Digits must be at most 100', site.span)
    site.state.charge(digits >>> 2)
    // Round half away from zero first, so toFixed(1.005, 2) agrees with round(1.005, 2).
    finite(n as number, site)
    const value = digits <= MAX_ROUND_DIGITS ? roundTo(n as number, digits, site) : (n as number)
    // JavaScript writes 1e21 and beyond in exponent form; such a number is
    // whole, so write its exact digits instead.
    if (Math.abs(value) >= FIXED_NOTATION_LIMIT)
      return `${BigInt(value).toString()}${digits > 0 ? `.${'0'.repeat(digits)}` : ''}`
    return value.toFixed(digits)
  }),
])

export const formatNumber: FunctionDef = /* @__PURE__ */ define('formatNumber', [
  /* @__PURE__ */ overload(
    [num, /* @__PURE__ */ t.optional(num), /* @__PURE__ */ t.optional(str)],
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
    { required: 1, literals: ([, , locale]) => formatProblem(locale, undefined) },
  ),
])

export const formatCurrency: FunctionDef = /* @__PURE__ */ define('formatCurrency', [
  /* @__PURE__ */ overload(
    [num, str, /* @__PURE__ */ t.optional(str)],
    str,
    ([n, currency, locale], site) =>
      numberFormat(
        typeof locale === 'string' ? locale : 'en-US',
        { style: 'currency', currency: currency as string },
        site,
      ).format(finite(n as number, site)),
    { required: 2, literals: ([, currency, locale]) => formatProblem(locale, currency) },
  ),
])

export const min: FunctionDef = /* @__PURE__ */ define('min', /* @__PURE__ */ extremes(-1))

export const max: FunctionDef = /* @__PURE__ */ define('max', /* @__PURE__ */ extremes(1))

export const sum: FunctionDef = /* @__PURE__ */ define('sum', [
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.list(/* @__PURE__ */ t.optional(num))],
    num,
    ([l], site) => {
      const items = list(l)
      // A list whose type is unknown statically reaches this overload; its
      // items decide (a list of durations sums as durations).
      if (isValidDuration(firstPresent(items))) return sumDurations(items, site)
      let total = 0
      for (const n of numbersOf(items, 'sum', site)) total += n
      return finite(total, site)
    },
  ),
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.list(/* @__PURE__ */ t.optional(dur))],
    dur,
    ([l], site) => sumDurations(list(l), site),
  ),
])

export const avg: FunctionDef = /* @__PURE__ */ define('avg', [
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.list(/* @__PURE__ */ t.optional(num))],
    /* @__PURE__ */ t.optional(num),
    ([l], site) => {
      const items = list(l)
      // As in sum, a list whose type is unknown statically is decided by its items.
      if (isValidDuration(firstPresent(items))) return averageDuration(items, site)
      const values = numbersOf(items, 'avg', site)
      if (values.length === 0) return null
      let total = 0
      for (const n of values) total += n
      return finite(total / values.length, site)
    },
  ),
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.list(/* @__PURE__ */ t.optional(dur))],
    /* @__PURE__ */ t.optional(dur),
    ([l], site) => averageDuration(list(l), site),
  ),
])

function hof(
  name: string,
  result: Type,
  run: (items: readonly unknown[], fn: Lambda, site: CallSite, extra: unknown[]) => unknown,
  runAsync: (
    items: readonly unknown[],
    fn: Lambda,
    site: CallSite,
    extra: unknown[],
  ) => Promise<Out>,
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
  return define(name, [
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

export const map: FunctionDef = /* @__PURE__ */ hof(
  'map',
  /* @__PURE__ */ t.list(U),
  (items, fn, site) => {
    const out = newList(items.length, site)
    for (let i = 0; i < items.length; i++) out[i] = fn(items[i], i)
    return made(out, site)
  },
  async (items, fn, site) => {
    const out = newList(items.length, site)
    for (let i = 0; i < items.length; i++) out[i] = ran(await fn(items[i], i))
    return new Out(made(out, site))
  },
  { lambda: /* @__PURE__ */ fnType([T, num], U) },
)

export const filter: FunctionDef = /* @__PURE__ */ hof(
  'filter',
  listT,
  (items, fn, site) => {
    const out: unknown[] = []
    for (let i = 0; i < items.length; i++)
      if (truthy(fn(items[i], i), site)) push(out, items[i], site)
    return made(out, site)
  },
  async (items, fn, site) => {
    const out: unknown[] = []
    for (let i = 0; i < items.length; i++)
      if (truthy(ran(await fn(items[i], i)), site)) push(out, items[i], site)
    return new Out(made(out, site))
  },
)

export const find: FunctionDef = /* @__PURE__ */ hof(
  'find',
  optT,
  (items, fn, site) => {
    for (let i = 0; i < items.length; i++)
      if (truthy(fn(items[i], i), site)) return items[i] ?? null
    return null
  },
  async (items, fn, site) => {
    for (let i = 0; i < items.length; i++)
      if (truthy(ran(await fn(items[i], i)), site)) return new Out(items[i] ?? null)
    return new Out(null)
  },
)

export const findIndex: FunctionDef = /* @__PURE__ */ hof(
  'findIndex',
  num,
  (items, fn, site) => {
    for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) return i
    return -1
  },
  async (items, fn, site) => {
    for (let i = 0; i < items.length; i++)
      if (truthy(ran(await fn(items[i], i)), site)) return new Out(i)
    return new Out(-1)
  },
)

export const some: FunctionDef = /* @__PURE__ */ hof(
  'some',
  bool,
  (items, fn, site) => {
    for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) return true
    return false
  },
  async (items, fn, site) => {
    for (let i = 0; i < items.length; i++)
      if (truthy(ran(await fn(items[i], i)), site)) return new Out(true)
    return new Out(false)
  },
)

export const every: FunctionDef = /* @__PURE__ */ hof(
  'every',
  bool,
  (items, fn, site) => {
    for (let i = 0; i < items.length; i++) if (!truthy(fn(items[i], i), site)) return false
    return true
  },
  async (items, fn, site) => {
    for (let i = 0; i < items.length; i++)
      if (!truthy(ran(await fn(items[i], i)), site)) return new Out(false)
    return new Out(true)
  },
)

export const none: FunctionDef = /* @__PURE__ */ hof(
  'none',
  bool,
  (items, fn, site) => {
    for (let i = 0; i < items.length; i++) if (truthy(fn(items[i], i), site)) return false
    return true
  },
  async (items, fn, site) => {
    for (let i = 0; i < items.length; i++)
      if (truthy(ran(await fn(items[i], i)), site)) return new Out(false)
    return new Out(true)
  },
)

export const flatMap: FunctionDef = /* @__PURE__ */ hof(
  'flatMap',
  /* @__PURE__ */ t.list(U),
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
      appendFlat(out, ran(await fn(items[i], i)), site)
    }
    return new Out(made(out, site))
  },
  {
    lambda: /* @__PURE__ */ fnType([T, num], /* @__PURE__ */ t.union(/* @__PURE__ */ t.list(U), U)),
  },
)

export const sortBy: FunctionDef = /* @__PURE__ */ hof(
  'sortBy',
  listT,
  (items, fn, site, [direction]) => {
    const keys = newList(items.length, site)
    for (let i = 0; i < items.length; i++) keys[i] = fn(items[i], i)
    return sortKeyed(items, keys, direction, site)
  },
  async (items, fn, site, [direction]) => {
    const keys = newList(items.length, site)
    for (let i = 0; i < items.length; i++) keys[i] = ran(await fn(items[i], i))
    return new Out(sortKeyed(items, keys, direction, site))
  },
  {
    lambda: /* @__PURE__ */ fnType([T, num], K),
    extraParams: [/* @__PURE__ */ t.enum('asc', 'desc')],
    ordered: ['K'],
  },
)

export const groupBy: FunctionDef = /* @__PURE__ */ hof(
  'groupBy',
  /* @__PURE__ */ t.record(listT),
  (items, fn, site) => {
    const out: Record<string, unknown[]> = {}
    for (let i = 0; i < items.length; i++)
      push(bucket(out, groupKey(fn(items[i], i), site)), items[i], site)
    return madeGroups(out, site)
  },
  async (items, fn, site) => {
    const out: Record<string, unknown[]> = {}
    for (let i = 0; i < items.length; i++)
      push(bucket(out, groupKey(ran(await fn(items[i], i)), site)), items[i], site)
    return new Out(madeGroups(out, site))
  },
  { lambda: /* @__PURE__ */ fnType([T, num], /* @__PURE__ */ t.union(str, num, bool)) },
)

export const count: FunctionDef = /* @__PURE__ */ define('count', [
  /* @__PURE__ */ overload([listT], num, ([l]) => list(l).length),
  /* @__PURE__ */ overload(
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
        for (let i = 0; i < items.length; i++) if (truthy(ran(await fn(items[i], i)), site)) n++
        return new Out(n)
      },
    },
  ),
])

export const reduce: FunctionDef = /* @__PURE__ */ define('reduce', [
  /* @__PURE__ */ overload(
    [listT, /* @__PURE__ */ fnType([U, T], U), U],
    U,
    ([l, f, initial]) => {
      const items = list(l)
      const fn = f as (acc: unknown, item: unknown, index: number) => unknown
      let acc = initial
      // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
      for (let i = 0; i < items.length; i++) acc = fn(acc, items[i], i)
      return acc
    },
    {
      runAsync: async ([l, f, initial]) => {
        const items = list(l)
        const fn = f as (acc: unknown, item: unknown, index: number) => unknown
        let acc = initial
        // oxlint-disable-next-line typescript/prefer-for-of -- indexing never runs a host list's iterator
        for (let i = 0; i < items.length; i++) acc = ran(await fn(acc, items[i], i))
        return new Out(acc)
      },
    },
  ),
])

export const sort: FunctionDef = /* @__PURE__ */ define('sort', [
  /* @__PURE__ */ overload(
    [listT, /* @__PURE__ */ t.enum('asc', 'desc')],
    listT,
    ([l, d], site) => sortKeyed(list(l), list(l), d, site),
    {
      required: 1,
      ordered: ['T'],
    },
  ),
])

export const reverse: FunctionDef = /* @__PURE__ */ define('reverse', [
  /* @__PURE__ */ overload([listT], listT, ([l], site) => {
    const items = list(l)
    site.state.charge(items.length)
    const out = newList(items.length, site)
    for (let i = 0; i < items.length; i++) out[i] = items[items.length - 1 - i] ?? null
    return made(out, site)
  }),
])

export const unique: FunctionDef = /* @__PURE__ */ define('unique', [
  /* @__PURE__ */ overload([listT], listT, ([l], site) => uniqueOf(list(l), site)),
])

export const flat: FunctionDef = /* @__PURE__ */ define('flat', [
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.list(any)],
    /* @__PURE__ */ t.list(any),
    ([l], site) => flatten(list(l), site),
  ),
])

export const first: FunctionDef = /* @__PURE__ */ define('first', [
  /* @__PURE__ */ overload([listT], optT, ([l]) => list(l)[0] ?? null),
])

export const last: FunctionDef = /* @__PURE__ */ define('last', [
  /* @__PURE__ */ overload([listT], optT, ([l]) => {
    const items = list(l)
    return items.length === 0 ? null : (items[items.length - 1] ?? null)
  }),
])

export const join: FunctionDef = /* @__PURE__ */ define('join', [
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.list(/* @__PURE__ */ t.union(primitiveText, ts, dur)), str],
    str,
    ([l, sep], site) => joinText(list(l), sep, site),
    {
      required: 1,
    },
  ),
])

export const isEmpty: FunctionDef = /* @__PURE__ */ define('isEmpty', [
  /* @__PURE__ */ overload(
    [
      /* @__PURE__ */ t.union(
        /* @__PURE__ */ t.list(any),
        str,
        /* @__PURE__ */ t.record(any),
        /* @__PURE__ */ t.null(),
      ),
    ],
    bool,
    ([v], site) => {
      if (v === null || v === undefined) return true
      if (Array.isArray(v) || typeof v === 'string') return v.length === 0
      // Listing a map's keys is linear in how many it has.
      const record = v as Record<string, unknown>
      const names = Object.keys(record)
      site.state.charge(keyListCost(names.length))
      return !names.some((key) => holdsKey(record, key))
    },
  ),
])

export const keys: FunctionDef = /* @__PURE__ */ define('keys', [
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.record(any)],
    /* @__PURE__ */ t.list(str),
    ([m], site) => entryList(m as Record<string, unknown>, site),
  ),
])

export const values: FunctionDef = /* @__PURE__ */ define('values', [
  /* @__PURE__ */ overload([/* @__PURE__ */ t.record(T)], listT, ([m], site) => {
    const record = m as Record<string, unknown>
    return made(
      entryList(record, site).map((key) => record[key] ?? null),
      site,
    )
  }),
])

export const entries: FunctionDef = /* @__PURE__ */ define('entries', [
  /* @__PURE__ */ overload(
    [/* @__PURE__ */ t.record(T)],
    /* @__PURE__ */ t.list(/* @__PURE__ */ t.object({ key: str, value: T })),
    ([m], site) => {
      const record = m as Record<string, unknown>
      const names = entryList(record, site)
      site.state.charge(names.length)
      return made(
        names.map((key) => made({ key, value: record[key] ?? null }, site)),
        site,
      )
    },
  ),
])

export const type: FunctionDef = /* @__PURE__ */ define('type', [
  /* @__PURE__ */ overload([any], str, ([v]) => kindOf(v)),
])

const optZone = /* @__PURE__ */ t.optional(str)

/** The position of a built-in's time zone parameter, if it takes one. */
export function zoneParameter(def: FunctionDef): number | undefined {
  for (const candidate of def.overloads) {
    const index = candidate.params.indexOf(optZone)
    if (index >= 0) return index
  }
  return undefined
}

function zoneArg(value: unknown): string | null {
  return value === undefined || value === null ? null : (value as string)
}

function field(name: string, pick: (clock: WallClock) => number): FunctionDef {
  return define(name, [
    overload([ts, optZone], num, ([d, z], site) => pick(wallClock(d as Date, zoneArg(z), site)), {
      required: 1,
    }),
  ])
}

/** Midnight at the start of the day, with `reset` fields of the wall clock set too. */
function startOf(name: string, reset: Partial<WallClock>): FunctionDef {
  return define(name, [
    overload(
      [ts, optZone],
      ts,
      ([d, z], site) => {
        const clock = wallClock(d as Date, zoneArg(z), site)
        const midnight = { ...clock, ...reset, hour: 0, minute: 0, second: 0, millisecond: 0 }
        return fromWallClock(midnight, zoneArg(z), site)
      },
      { required: 1 },
    ),
  ])
}

/** Longest duration text duration() reads; longer text is never a valid duration in range. */
const MAX_DURATION_TEXT = 64
/** Weeks, days, hours, minutes, seconds (to the millisecond); every part bounded, so no backtracking blowup. */
const ISO_DURATION =
  /^(?<sign>[+-])?P(?:(?<weeks>\d{1,15})W)?(?:(?<days>\d{1,15})D)?(?:T(?:(?<hours>\d{1,15})H)?(?:(?<minutes>\d{1,15})M)?(?:(?<seconds>\d{1,15})(?:[.,](?<fraction>\d{1,3}))?S)?)?$/u

/**
 * The milliseconds in ISO-8601 duration text, or why it is not one. Years and
 * months have no fixed length, so they are refused rather than guessed.
 */
function isoDurationMs(text: string): number | string {
  const bad = `Invalid duration ${shown(text)}: expected ISO-8601 text such as "PT1H30M"`
  if (text.length > MAX_DURATION_TEXT) return bad
  const match = ISO_DURATION.exec(text)
  if (match === null) {
    return /^[+-]?P[^T]*[YM]/u.test(text)
      ? `Invalid duration ${shown(text)}: years and months have no fixed length; use days`
      : bad
  }
  const { sign, weeks, days, hours, minutes, seconds, fraction } = match.groups ?? {}
  // "P" and "PT" alone name no length.
  if (text.endsWith('P') || text.endsWith('T')) return bad
  const part = (digits: string | undefined): number => (digits === undefined ? 0 : Number(digits))
  const ms =
    part(weeks) * MS_PER_WEEK +
    part(days) * MS_PER_DAY +
    part(hours) * MS_PER_HOUR +
    part(minutes) * MS_PER_MINUTE +
    part(seconds) * MS_PER_SECOND +
    (fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')))
  return sign === '-' ? -ms : ms
}

function durationUnit(name: string, unitMs: number): FunctionDef {
  return define(name, [
    overload([num], dur, ([n], site) => durationOf((n as number) * unitMs, site.state, site.span)),
  ])
}

function durationIn(name: string, unitMs: number): FunctionDef {
  return define(name, [overload([dur], num, ([d]) => (d as Duration).ms / unitMs)])
}

export const now: FunctionDef = /* @__PURE__ */ define('now', [
  /* @__PURE__ */ overload([], ts, (_, site) => site.state.now()),
])

export const timestamp: FunctionDef = /* @__PURE__ */ define('timestamp', [
  /* @__PURE__ */ overload([str], ts, ([s], site) => {
    site.state.charge(PARSE_COST)
    return parseTimestamp(s as string, site)
  }),
  /* @__PURE__ */ overload([num], ts, ([n], site) => checked(n as number, site)),
  /* @__PURE__ */ overload([ts], ts, ([d], site) => {
    timeOf(d as Date, site.state, site.span)
    return d
  }),
])

export const duration: FunctionDef = /* @__PURE__ */ define('duration', [
  /* @__PURE__ */ overload(
    [str],
    dur,
    ([s], site) => {
      site.state.charge(PARSE_COST)
      const ms = isoDurationMs(s as string)
      if (typeof ms === 'string') throw site.state.error('INVALID_ARGUMENT', ms, site.span)
      return durationOf(ms, site.state, site.span)
    },
    {
      literals: ([text]) => {
        if (typeof text !== 'string') return undefined
        const ms = isoDurationMs(text)
        return typeof ms === 'string' ? ms : undefined
      },
    },
  ),
  /* @__PURE__ */ overload([dur], dur, ([d]) => d),
])

export const weeks: FunctionDef = /* @__PURE__ */ durationUnit('weeks', MS_PER_WEEK)

export const days: FunctionDef = /* @__PURE__ */ durationUnit('days', MS_PER_DAY)

export const hours: FunctionDef = /* @__PURE__ */ durationUnit('hours', MS_PER_HOUR)

export const minutes: FunctionDef = /* @__PURE__ */ durationUnit('minutes', MS_PER_MINUTE)

export const seconds: FunctionDef = /* @__PURE__ */ durationUnit('seconds', MS_PER_SECOND)

export const milliseconds: FunctionDef = /* @__PURE__ */ durationUnit('milliseconds', 1)

export const inDays: FunctionDef = /* @__PURE__ */ durationIn('inDays', MS_PER_DAY)

export const inHours: FunctionDef = /* @__PURE__ */ durationIn('inHours', MS_PER_HOUR)

export const inMinutes: FunctionDef = /* @__PURE__ */ durationIn('inMinutes', MS_PER_MINUTE)

export const inSeconds: FunctionDef = /* @__PURE__ */ durationIn('inSeconds', MS_PER_SECOND)

export const inMilliseconds: FunctionDef = /* @__PURE__ */ durationIn('inMilliseconds', 1)

export const year: FunctionDef = /* @__PURE__ */ field('year', (c) => c.year)

export const month: FunctionDef = /* @__PURE__ */ field('month', (c) => c.month)

export const day: FunctionDef = /* @__PURE__ */ field('day', (c) => c.day)

export const hour: FunctionDef = /* @__PURE__ */ field('hour', (c) => c.hour)

export const minute: FunctionDef = /* @__PURE__ */ field('minute', (c) => c.minute)

export const second: FunctionDef = /* @__PURE__ */ field('second', (c) => c.second)

export const dayOfWeek: FunctionDef = /* @__PURE__ */ field('dayOfWeek', isoWeekday)

export const startOfDay: FunctionDef = /* @__PURE__ */ startOf('startOfDay', {})

export const startOfMonth: FunctionDef = /* @__PURE__ */ startOf('startOfMonth', { day: 1 })

export const startOfYear: FunctionDef = /* @__PURE__ */ startOf('startOfYear', { month: 1, day: 1 })

export const addDays: FunctionDef = /* @__PURE__ */ define('addDays', [
  /* @__PURE__ */ overload(
    [ts, num, optZone],
    ts,
    ([d, n, z], site) => addDaysIn(d as Date, n as number, zoneArg(z), site),
    { required: 2 },
  ),
])

export const addMonths: FunctionDef = /* @__PURE__ */ define('addMonths', [
  /* @__PURE__ */ overload(
    [ts, num, optZone],
    ts,
    ([d, n, z], site) => addMonthsIn(d as Date, n as number, zoneArg(z), site),
    { required: 2 },
  ),
])

export const addYears: FunctionDef = /* @__PURE__ */ define('addYears', [
  /* @__PURE__ */ overload(
    [ts, num, optZone],
    ts,
    ([d, n, z], site) =>
      addMonthsIn(d as Date, integer(n, 'Years', site) * MONTHS_PER_YEAR, zoneArg(z), site),
    { required: 2 },
  ),
])

export const formatDate: FunctionDef = /* @__PURE__ */ define('formatDate', [
  /* @__PURE__ */ overload(
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
])

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

/**
 * Every built-in by name, in the order descriptions.ts lists them. Each
 * built-in is also its own export, so a bundle that never reads this map
 * keeps only the built-ins it imports.
 */
export const BUILTINS: ReadonlyMap<string, FunctionDef> = /* @__PURE__ */ (() =>
  new Map(
    [
      toUpperCase,
      toLowerCase,
      trim,
      trimStart,
      trimEnd,
      startsWith,
      endsWith,
      includes,
      indexOf,
      lastIndexOf,
      slice,
      split,
      replace,
      replaceAll,
      padStart,
      padEnd,
      repeat,
      at,
      matches,
      toString,
      toNumber,
      round,
      floor,
      ceil,
      trunc,
      abs,
      sqrt,
      clamp,
      toFixed,
      formatNumber,
      formatCurrency,
      min,
      max,
      sum,
      avg,
      map,
      filter,
      find,
      findIndex,
      some,
      every,
      none,
      flatMap,
      sortBy,
      groupBy,
      count,
      reduce,
      sort,
      reverse,
      unique,
      flat,
      first,
      last,
      join,
      isEmpty,
      keys,
      values,
      entries,
      type,
      now,
      timestamp,
      duration,
      weeks,
      days,
      hours,
      minutes,
      seconds,
      milliseconds,
      inDays,
      inHours,
      inMinutes,
      inSeconds,
      inMilliseconds,
      year,
      month,
      day,
      hour,
      minute,
      second,
      dayOfWeek,
      startOfDay,
      startOfMonth,
      startOfYear,
      addDays,
      addMonths,
      addYears,
      formatDate,
    ].map((def) => [def.name, def]),
  ))()
