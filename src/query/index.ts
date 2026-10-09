/**
 * Translate Bonsai predicates into database queries.
 *
 * A predicate is an expression over one record variable (the `row`), for
 * example `order.status == "paid" && order.total > limit`. Every other
 * variable is filled in from `known` by partial evaluation first. The query
 * selects exactly the records for which the predicate evaluates to `true`;
 * records for which it would fail (as `try(predicate, false)`) are excluded.
 *
 * Exactness depends on the declared columns: each column's type is part of
 * the contract, and only declared columns can be queried. The translator does
 * not see the environment's variable types, so a column must be declared with
 * the type the field really has.
 */
import type { AbortSignalLike } from '../environment.js'
import { BonsaiError, BonsaiLimitError, type Span } from '../errors.js'
import type { PartialOptions, PartialResult } from '../partial.js'
import { Duration, isMap, isValidDuration } from '../runtime/values.js'
import { declaredVariables } from '../declared.js'
import { closest, didYouMean } from '../suggest.js'
import { formatType, type Type } from '../types.js'
import {
  forEachChild,
  type BinaryNode,
  type CallNode,
  type Node,
  type SpreadNode,
} from '../syntax/ast.js'

/** A compiled program (from `env.compile`) whose predicate is translated. */
export interface Translatable {
  readonly source: string
  /** The checked syntax tree, read to find the known paths the predicate uses. */
  readonly ast: Node
  readonly references: { readonly variables: readonly string[] }
  partial: (known: never, options?: PartialOptions) => PartialResult
}

/** A duration column holds whole milliseconds (SQL integer, MongoDB number). */
export type ColumnType = 'text' | 'number' | 'boolean' | 'timestamp' | 'duration'

export interface Column {
  readonly type: ColumnType
  /** The column (SQL) or field path (MongoDB) name, when it differs from the key. */
  readonly name?: string | undefined
}

/** Declared record fields, keyed by the path after the row variable (`status`, `address.city`). */
export type Columns = Readonly<Record<string, ColumnType | Column>>

interface CommonOptions {
  /** The variable that names the record being filtered, e.g. `order`. */
  readonly row: string
  /**
   * Values for every other variable the predicate reads. An object typed by an
   * interface or a class instance is accepted, like an evaluation context.
   */
  // oxlint-disable-next-line typescript/no-explicit-any -- the only index signature interfaces and classes satisfy
  readonly known?: Readonly<Record<string, any>> | undefined
  /** The time `now()` returns. Required when the predicate calls now(). */
  readonly now?: Date | undefined
  /**
   * Step budget for the whole translation: checking the known values, the
   * partial evaluation it runs, and writing the query. Validated as for
   * partial(). When not given, the partial evaluation uses the environment's
   * limit and the rest of the work is bounded by 1,000,000 steps.
   */
  readonly maxSteps?: number | undefined
  /**
   * Wall-clock budget in milliseconds for the whole translation, as `maxSteps`
   * covers it. When not given, the partial evaluation uses the environment's timeout.
   */
  readonly timeout?: number | undefined
  /** Cancels the translation, including the partial evaluation it runs. */
  readonly signal?: AbortSignalLike | undefined
  /**
   * Call sync host functions whose inputs are all known before translating,
   * as for partial(). Default false: a host function call does not translate.
   */
  readonly callHostFunctions?: boolean | undefined
}

export interface SQLOptions extends CommonOptions {
  readonly dialect: 'postgres' | 'sqlite'
  /** The queryable columns. Anything else is rejected. */
  readonly columns: Columns
  /** Number of parameters already used before this fragment (`$n` / `?n` numbering). Default 0. */
  readonly paramOffset?: number | undefined
}

/** A value toSQL sends for a placeholder. */
type SQLParam = string | number | boolean | (string | number)[]

export interface SQLQuery<Param = SQLParam> {
  /**
   * A boolean SQL expression for a WHERE clause. It is true for exactly the
   * selected records, and may be NULL (not false) for others: negate a
   * filter by translating `!(filter)`, not by wrapping this in NOT.
   */
  readonly sql: string
  /**
   * The values for the placeholders, a new array on every call so a driver
   * may take it as is. SQLite gets numbers and text (booleans as 1 and 0,
   * timestamps as epoch milliseconds); Postgres also gets booleans, and an
   * array for each known list.
   */
  readonly params: Param[]
}

export interface MongoOptions extends CommonOptions {
  /** The queryable fields. Anything else is rejected. */
  readonly fields: Columns
}

export interface MongoQuery {
  readonly filter: Record<string, unknown>
  /** Pass to find(): binary string comparison, whatever the collection's default collation. */
  readonly options: { readonly collation: { readonly locale: 'simple' } }
}

/** The predicate (or part of it) has no exact equivalent in the target database. */
export class BonsaiTranslationError extends BonsaiError {
  constructor(message: string, source: string, span?: Span) {
    super('UNTRANSLATABLE', message, { source, span })
  }
}

// === a small predicate language both targets are generated from ===

type Primitive = string | number | boolean | Date | Duration | null

interface ColumnValue {
  readonly kind: 'column'
  readonly field: string
  readonly type: ColumnType
}

type Value =
  | ColumnValue
  | { readonly kind: 'const'; readonly value: Primitive }
  | {
      readonly kind: 'arith'
      readonly op: '+' | '-' | '*'
      readonly left: Value
      readonly right: Value
    }
  /** `column ?? fallback`: never null (SQL only; compared with a known value it is rewritten). */
  | {
      readonly kind: 'coalesce'
      readonly column: ColumnValue
      readonly fallback: Exclude<Primitive, null>
    }
  /** `inMilliseconds(column)` of a duration column: a number, failing on null (SQL only). */
  | { readonly kind: 'ms'; readonly column: ColumnValue }

type Pred =
  | { readonly kind: 'const'; readonly value: boolean }
  | { readonly kind: 'and' | 'or'; readonly items: readonly Pred[] }
  | { readonly kind: 'not'; readonly item: Pred }
  | { readonly kind: 'eq'; readonly left: Value; readonly right: Value }
  | {
      readonly kind: 'order'
      readonly op: '<' | '<=' | '>' | '>='
      readonly left: Value
      readonly right: Value
    }
  | { readonly kind: 'null'; readonly value: Value }
  | { readonly kind: 'in'; readonly value: Value; readonly list: readonly Primitive[] }
  | {
      readonly kind: 'text'
      readonly op: 'startsWith' | 'endsWith' | 'includes'
      readonly column: Value
      readonly text: string
      /** Method calls fail on a null column; `"x" in column` and `?.` calls are false instead. */
      readonly nullFails: boolean
    }
  | { readonly kind: 'within'; readonly column: Value; readonly text: string }
  | { readonly kind: 'truthy'; readonly column: Value }
  | {
      /**
       * A timestamp column compared with a bound, from a shifted or subtracted
       * timestamp: fails (selected by neither side) when the column is null, or
       * when `limit` does not hold (the shift would leave the Date range).
       */
      readonly kind: 'shifted'
      readonly column: Value
      readonly op: '<' | '<=' | '>' | '>='
      readonly bound: Date
      readonly limit?: { readonly op: '<=' | '>='; readonly ms: number } | undefined
    }

/** What a target database can express, so untranslatable parts fail with their span. */
interface Target {
  readonly name: string
  readonly arithmetic: boolean
  /** Comparing a column with another column (or arithmetic). */
  readonly columnPairs: boolean
  /** `column in "text"`. */
  readonly within: boolean
  /** Why a column or field name is invalid, if it is. */
  readonly checkName: (name: string) => string | undefined
  /** Why a constant cannot be sent, if it cannot. */
  readonly checkConstant: (value: Primitive) => string | undefined
  /** Why a text-function argument cannot be sent, if it cannot. */
  readonly checkPattern: (text: string) => string | undefined
}

const FLIP: Readonly<Record<'<' | '<=' | '>' | '>=', '<' | '<=' | '>' | '>='>> = {
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
}

const COLUMN_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'boolean',
  'timestamp',
  'duration',
])

/** Calendar functions: their answer depends on time zone rules databases do not apply as Bonsai does. */
const CALENDAR = new Set([
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'dayOfWeek',
  'startOfDay',
  'startOfMonth',
  'startOfYear',
  'addDays',
  'addMonths',
  'addYears',
  'formatDate',
])

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', '&&', '||'])

/** The largest distance from the epoch a Date can hold, in milliseconds. */
const MAX_TIME = 8.64e15

/** A host Date's time, read through the prototype so an overridden getTime never runs. */
function msOf(date: Date): number {
  return Date.prototype.getTime.call(date)
}

/** `; did you mean "x"?` for the closest candidate, or nothing. */
function hint(name: string, candidates: Iterable<string>): string {
  return didYouMean(closest(name, candidates))
}

/** What Bonsai's text function returns for known text. */
function textFunction(op: 'startsWith' | 'endsWith' | 'includes', text: string, needle: string) {
  if (op === 'startsWith') return text.startsWith(needle)
  if (op === 'endsWith') return text.endsWith(needle)
  return text.includes(needle)
}

function kindOf(value: Value): ColumnType | 'null' {
  if (value.kind === 'column') return value.type
  if (value.kind === 'arith' || value.kind === 'ms') return 'number'
  if (value.kind === 'coalesce') return value.column.type
  return constantKind(value.value)
}

function constantKind(v: Primitive): ColumnType | 'null' {
  if (v === null) return 'null'
  if (v instanceof Date) return 'timestamp'
  if (v instanceof Duration) return 'duration'
  if (typeof v === 'string') return 'text'
  if (typeof v === 'number') return 'number'
  return 'boolean'
}

/** Bonsai's `==` on two known primitives. */
function sameValue(a: Primitive, b: Primitive): boolean {
  if (constantKind(a) !== constantKind(b)) return false
  if (a instanceof Date && b instanceof Date) return msOf(a) === msOf(b)
  if (a instanceof Duration && b instanceof Duration) return a.ms === b.ms
  return a === b
}

/** Bonsai's ordering of two known primitives of the same orderable kind. */
function ordered(a: Primitive, op: '<' | '<=' | '>' | '>=', b: Primitive): boolean {
  const number = (v: Primitive): number => {
    if (v instanceof Date) return msOf(v)
    if (v instanceof Duration) return v.ms
    return v as number
  }
  const x = number(a)
  const y = number(b)
  if (op === '<') return x < y
  if (op === '<=') return x <= y
  if (op === '>') return x > y
  return x >= y
}

// A lone surrogate reaches the database as U+FFFD, a different string.
const LONE_SURROGATE = /\p{Cs}/u

/** A real, valid Date (an object that only inherits from Date.prototype is not one). */
function isValidDate(value: unknown): value is Date {
  if (!(value instanceof Date)) return false
  try {
    return !Number.isNaN(Date.prototype.getTime.call(value))
  } catch {
    return false
  }
}

/**
 * A known value as the constant it is, or undefined for anything else. A Date or
 * Duration is checked as evaluation checks it (a forged Duration is opaque) and
 * copied, so later steps never read host data again. Reads host data: call it
 * inside hostRead.
 */
function primitiveOf(value: unknown): Primitive | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (isValidDate(value)) return new Date(msOf(value))
  if (isValidDuration(value)) return new Duration(value.ms)
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface Declared {
  readonly field: string
  readonly type: ColumnType
}

/** Charges translation work (one step by default) against the translation's budget. */
type Charge = (steps?: number) => void

/** The step budget when `maxSteps` is not given: the default evaluation limit. */
const DEFAULT_MAX_STEPS = 1_000_000
/** Steps between two checks of the clock and the abort signal. */
const CLOCK_SAMPLE = 1024

interface Budget {
  readonly charge: Charge
  /**
   * Runs partial evaluation on what is left of the budget: the steps not yet
   * charged and the time to the deadline, when the caller gave them.
   */
  readonly partial: (
    run: (limits: { maxSteps?: unknown; timeout?: unknown }) => PartialResult,
  ) => PartialResult
}

/**
 * The translation's budget: `maxSteps` (1,000,000 when not given), and a
 * deadline and signal that run from the start of the translation. Work outside
 * partial evaluation is charged here; with `maxSteps` or `timeout` given,
 * partial evaluation runs on what is left of them, and otherwise on the
 * environment's own limits.
 */
function budget(options: CommonOptions, source: string): Budget {
  const { maxSteps, timeout, signal } = options
  // Invalid values are passed on to partial(), which rejects them as it always does.
  const validSteps = typeof maxSteps === 'number' && Number.isInteger(maxSteps) && maxSteps >= 0
  const validTimeout = typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0
  const max = validSteps ? maxSteps : DEFAULT_MAX_STEPS
  const deadline = validTimeout && timeout > 0 ? performance.now() + timeout : 0
  let steps = 0
  let nextSample = 0
  const overSteps = (): BonsaiLimitError =>
    new BonsaiLimitError('STEP_LIMIT', `Translation exceeded the step limit of ${max}`, { source })
  const overTime = (): BonsaiLimitError =>
    new BonsaiLimitError('TIMEOUT', 'Translation timed out', { source })
  const check = (): void => {
    if (max > 0 && steps > max) throw overSteps()
    if (deadline !== 0 && performance.now() > deadline) throw overTime()
    let aborted: boolean
    let cause: unknown
    try {
      aborted = signal?.aborted === true
      if (aborted) cause = signal?.reason
    } catch (error) {
      aborted = true
      cause = error
    }
    if (aborted) throw new BonsaiLimitError('ABORTED', 'Translation was aborted', { source, cause })
  }
  const charge: Charge = (n = 1) => {
    steps += n
    if (steps < nextSample) return
    check()
    nextSample = max > 0 ? Math.min(steps + CLOCK_SAMPLE, max + 1) : steps + CLOCK_SAMPLE
  }
  const partial: Budget['partial'] = (run) => {
    check()
    const limits: { maxSteps?: unknown; timeout?: unknown } = {}
    if (maxSteps !== undefined) {
      // 0 turns the limit off, so a budget used up exactly is over, not off.
      if (validSteps && max > 0 && steps >= max) throw overSteps()
      limits.maxSteps = validSteps && max > 0 ? max - steps : maxSteps
    }
    if (timeout !== undefined) {
      if (deadline === 0) limits.timeout = timeout
      else {
        const left = deadline - performance.now()
        if (left <= 0) throw overTime()
        limits.timeout = left
      }
    }
    try {
      return run(limits)
    } catch (error) {
      // Partial evaluation ran on part of the translation's budget: name the whole one.
      if (error instanceof BonsaiLimitError && error.code === 'STEP_LIMIT' && validSteps && max > 0)
        throw overSteps()
      if (error instanceof BonsaiLimitError && error.code === 'TIMEOUT' && deadline !== 0)
        throw overTime()
      throw error
    }
  }
  return { charge, partial }
}

/** Characters of known text a translation reads or sends per step. */
const TEXT_PER_STEP = 32
/** Steps charged for known text a translation reads or sends. */
const textCost = (text: string): number => 1 + Math.floor(text.length / TEXT_PER_STEP)

/** What `make` derives from known text, computed (and charged) once per text. */
function once<T>(cache: Map<string, T>, text: string, make: () => T, charge: Charge): T {
  charge()
  if (cache.has(text)) return cache.get(text) as T
  charge(textCost(text))
  const made = make()
  cache.set(text, made)
  return made
}

/** Options both translators read; the budget options are passed to partial(), which validates them. */
const COMMON_OPTION_KEYS: readonly string[] = [
  'row',
  'known',
  'now',
  'maxSteps',
  'timeout',
  'signal',
  'callHostFunctions',
]
const SQL_OPTION_KEYS: readonly string[] = [
  ...COMMON_OPTION_KEYS,
  'dialect',
  'columns',
  'paramOffset',
]
const MONGO_OPTION_KEYS: readonly string[] = [...COMMON_OPTION_KEYS, 'fields']

/** Rejects anything but a compiled program, such as a partial-evaluation residual. */
function checkProgram(program: unknown, translator: string): void {
  const isProgram =
    isRecord(program) &&
    typeof program.source === 'string' &&
    typeof program.partial === 'function' &&
    isRecord(program.ast) &&
    isRecord(program.references) &&
    Array.isArray(program.references.variables)
  if (!isProgram) {
    throw new TypeError(
      `${translator} takes a compiled program (from env.compile); to translate after partial evaluation, pass the original program and the values in known`,
    )
  }
}

/** Rejects option keys a translator does not read, so a misspelled one is never ignored. */
function checkKeys(options: unknown, allowed: readonly string[], translator: string): void {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key))
      throw new TypeError(
        `Unknown ${translator} option key "${key}" (expected one of: ${allowed.join(', ')})`,
      )
  }
}

/** Validates options that come from configuration; mistakes there are programming errors. */
function declare(
  options: CommonOptions,
  columns: unknown,
  what: string,
  target: Target,
): ReadonlyMap<string, Declared> {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  if (typeof options.row !== 'string' || options.row === '')
    throw new TypeError('row must name the record variable')
  if (options.known !== undefined && !isRecord(options.known))
    throw new TypeError('known must be an object')
  if (options.now !== undefined && !isValidDate(options.now))
    throw new TypeError('now must be a valid Date')
  if (!isRecord(columns)) throw new TypeError(`${what} must be an object`)
  const declared = new Map<string, Declared>()
  for (const [key, column] of Object.entries(columns)) {
    const spec: unknown = typeof column === 'string' ? { type: column } : column
    if (!isRecord(spec) || typeof spec.type !== 'string' || !COLUMN_TYPES.has(spec.type))
      throw new TypeError(
        `${what}.${key} must be one of text, number, boolean, timestamp, duration`,
      )
    if (spec.name !== undefined && typeof spec.name !== 'string')
      throw new TypeError(`${what}.${key}.name must be a string`)
    const field = spec.name ?? key
    const problem = field === '' ? 'is empty' : target.checkName(field)
    if (problem !== undefined)
      throw new TypeError(`The ${target.name} name for ${key} (${field}) ${problem}`)
    declared.set(key, { field, type: spec.type as ColumnType })
  }
  return declared
}

/** Whether every value of a declared type fits a column type (null, any, and never always do). */
function fitsColumn(type: Type, column: ColumnType): boolean {
  if (type.kind === 'any' || type.kind === 'never' || type.kind === 'null') return true
  if (type.kind === 'union') return type.types.every((member) => fitsColumn(member, column))
  if (type.kind === 'literal') {
    return column === (typeof type.value === 'string' ? 'text' : typeof type.value)
  }
  if (type.kind === 'string') return column === 'text'
  return column === type.kind
}

/** The declared type at a field path below a variable's type, if the declaration names it. */
function typeAt(type: Type, path: readonly string[]): Type | undefined {
  let current = type
  for (const key of path) {
    if (current.kind === 'union') {
      const present = current.types.filter((member) => member.kind !== 'null')
      if (present.length !== 1) return undefined
      current = present[0] as Type
    }
    if (current.kind !== 'map') return undefined
    const field = Object.hasOwn(current.fields, key) ? current.fields[key] : current.rest
    if (field === undefined) return undefined
    current = field
  }
  return current
}

/**
 * Checks declared columns against the types the program's environment
 * declares for the row, so a list field declared as a text column (which would
 * turn `"a" in tags` into a substring test) is a configuration error.
 */
function checkDeclaredTypes(
  program: Translatable,
  row: string,
  columns: ReadonlyMap<string, Declared>,
  what: string,
): void {
  const rowType = declaredVariables(program)?.[row]
  if (rowType === undefined) return
  for (const [key, column] of columns) {
    const type = typeAt(rowType, key.split('.'))
    if (type !== undefined && !fitsColumn(type, column.type)) {
      throw new TypeError(
        `${what}.${key} is declared ${column.type}, but the environment declares ${row}.${key} as ${formatType(type)}`,
      )
    }
  }
}

/**
 * A static member path from a variable: `limits.max`, `cfg["a.b"]`, or `l.max`
 * after `let l = limits`. A path links to the one a key shorter, so a let name
 * shares the path it stands for instead of copying it.
 */
interface Chain {
  readonly root: string
  /** The path one key shorter; undefined for the variable itself. */
  readonly parent: Chain | undefined
  readonly key: string
  /** The number of keys after the variable. */
  readonly length: number
  /** Equal for paths with the same keys, however the predicate reaches them. */
  readonly id: number
}

/** What each `let` name stands for: the chain it aliases, or undefined (shadowing). */
type Scope = ReadonlyMap<string, Chain | undefined>

const NO_SCOPE: Scope = new Map()
const NO_FLOW: ReadonlySet<number> = new Set()

/** A chain's keys after the variable, in order. */
function keysOf(chain: Chain): string[] {
  const keys: string[] = []
  for (let at: Chain | undefined = chain; at?.parent !== undefined; at = at.parent)
    keys.push(at.key)
  return keys.reverse()
}

/** A chain's dotted name, for messages. */
const pathName = (chain: Chain): string => [chain.root, ...keysOf(chain)].join('.')

/** The non-null member of `T | null`, or the type itself. */
function withoutNull(type: Type): Type {
  if (type.kind !== 'union') return type
  const members = type.types.filter((member) => member.kind !== 'null')
  return members.length === 1 ? members[0] : type
}

/**
 * Refuses a predicate that reads data the known values do not give. With the
 * row as the only unknown variable, partial evaluation reads a missing path as
 * null and can decide the condition silently; a missing field is far more
 * often an incomplete `known` than a meant null. Each read is checked on its
 * own: a read the predicate guards itself (`has(p)`, `p ?? x`, `p == null`,
 * `p != null`, or a read reached only after `has(p) &&`) is allowed, and a let
 * name is followed to the path it stands for. In a typed environment, a known
 * object read whole (spread, keys(), ==, passed on) must also have every field
 * its declared type lists.
 */
function checkKnownPaths(
  ast: Node,
  {
    row,
    known,
    declared,
    hostRead,
    fail,
    charge,
  }: {
    readonly row: string
    readonly known: Readonly<Record<string, unknown>>
    /** The variable types the program's environment declares, if any. */
    readonly declared: Readonly<Record<string, Type>> | undefined
    readonly hostRead: <T>(read: () => T, what: string) => T
    readonly fail: (message: string, at?: Span) => never
    readonly charge: Charge
  },
): void {
  /** Reads where a missing path is null on purpose. */
  const guardedUses = new Set<Node>()
  const guard = (node: Node): void => {
    let current = node
    while (current.type === 'Member' || current.type === 'Index') {
      guardedUses.add(current)
      current = current.object
    }
  }
  const read = <T>(get: () => T): T => hostRead(get, 'the known values')
  const isPresent = (map: Record<string, unknown>, key: string): boolean =>
    read(() => Object.hasOwn(map, key) && map[key] !== undefined)

  // Paths are numbered as a tree of keys, so naming one costs a step however long it is.
  const roots = new Map<string, number>()
  const children = new Map<number, Map<string, number>>()
  let paths = 0
  const number = (table: Map<string, number>, key: string): number => {
    let id = table.get(key)
    if (id === undefined) {
      id = paths++
      table.set(key, id)
    }
    return id
  }
  const childOf = (parent: Chain, key: string): Chain => {
    let table = children.get(parent.id)
    if (table === undefined) {
      table = new Map()
      children.set(parent.id, table)
    }
    return { root: parent.root, parent, key, length: parent.length + 1, id: number(table, key) }
  }
  // A node is always seen in the same scope, so its chain is worked out once.
  const chains = new WeakMap<Node, Chain | null>()
  /** The key a member read takes, or undefined for a computed read. */
  const keyOf = (node: Node): string | undefined => {
    if (node.type === 'Member') return node.name
    if (node.type === 'Index' && node.index.type === 'Literal')
      return typeof node.index.value === 'string' ? node.index.value : undefined
    return undefined
  }
  const chainOf = (node: Node, scope: Scope): Chain | undefined => {
    // Down to the variable (or a read already worked out), then back up: no recursion.
    const reads: Node[] = []
    let current = node
    let chain: Chain | undefined
    for (;;) {
      const done = chains.get(current)
      if (done !== undefined) {
        chain = done ?? undefined
        break
      }
      if (current.type === 'Variable') {
        const root = current.name
        chain = { root, parent: undefined, key: root, length: 0, id: number(roots, root) }
      } else if (current.type === 'Local') {
        chain = scope.get(current.name)
      } else if (
        (current.type === 'Member' || current.type === 'Index') &&
        keyOf(current) !== undefined
      ) {
        reads.push(current)
        current = current.object
        continue
      }
      chains.set(current, chain ?? null)
      break
    }
    for (let i = reads.length - 1; i >= 0; i--) {
      const at = reads[i]
      const key = keyOf(at)
      if (chain !== undefined && key !== undefined) chain = childOf(chain, key)
      chains.set(at, chain ?? null)
    }
    return chain
  }

  /** Whether every path in `small` is in `big`, charging for the test. */
  const within = (small: ReadonlySet<number>, big: ReadonlySet<number>): boolean => {
    charge(small.size)
    for (const id of small) if (!big.has(id)) return false
    return true
  }
  const union = (a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> => {
    // The same paths proven again (`has(p) && has(p) && ...`) cost no copy.
    if (a === b || b.size === 0) return a
    if (a.size === 0) return b
    if (b.size <= a.size && within(b, a)) return a
    if (a.size < b.size && within(a, b)) return b
    charge(a.size + b.size)
    return new Set([...a, ...b])
  }
  // Each path's prefixes are listed once, however many conditions prove it.
  const prefixes = new Map<number, ReadonlySet<number>>()
  const prefixesOf = (chain: Chain): ReadonlySet<number> => {
    let ids = prefixes.get(chain.id)
    if (ids === undefined) {
      charge(chain.length)
      const all = new Set<number>()
      for (let at: Chain | undefined = chain; at?.parent !== undefined; at = at.parent)
        all.add(at.id)
      ids = all
      prefixes.set(chain.id, ids)
    }
    return ids
  }
  // A node is always seen in the same scope, so what it proves is worked out once:
  // a long chain of `||` would otherwise be walked again for every operand.
  const provenWhen = { true: new WeakMap<Node, ReadonlySet<number>>(), false: new WeakMap() }
  /** The paths a condition proves present when it is `when`. */
  const proven = (node: Node, scope: Scope, when: boolean): ReadonlySet<number> => {
    const memo = provenWhen[`${when}`]
    const done = memo.get(node)
    if (done !== undefined) return done
    charge()
    let out = NO_FLOW
    if (node.type === 'Unary' && node.operator === '!') out = proven(node.operand, scope, !when)
    else if (node.type === 'Binary' && node.operator === (when ? '&&' : '||'))
      out = union(proven(node.left, scope, when), proven(node.right, scope, when))
    else {
      let target: Node | undefined
      if (when && node.type === 'Has') target = node.target
      else if (node.type === 'Binary' && node.operator === (when ? '!=' : '==')) {
        if (node.right.type === 'Literal' && node.right.value === null) target = node.left
        else if (node.left.type === 'Literal' && node.left.value === null) target = node.right
      }
      const chain = target === undefined ? undefined : chainOf(target, scope)
      // Proving a path proves every path on the way to it.
      if (chain !== undefined) out = prefixesOf(chain)
    }
    memo.set(node, out)
    return out
  }
  const extend = (
    flow: ReadonlySet<number>,
    node: Node,
    scope: Scope,
    when: boolean,
  ): ReadonlySet<number> => union(flow, proven(node, scope, when))

  /**
   * What reading a path from the known values gives: its value, the shortest
   * path on the way that is missing, or undefined where a value on the way is
   * not an object (null, lists, and other values are left to evaluation).
   */
  type Resolved = { readonly value: unknown } | { readonly missing: Chain } | undefined
  // Each path is read once, however many reads share it.
  const resolved = new Map<number, Resolved>()
  const resolve = (chain: Chain): Resolved => {
    const pending: Chain[] = []
    let result: Resolved
    let at: Chain = chain
    for (;;) {
      if (resolved.has(at.id)) {
        result = resolved.get(at.id)
        break
      }
      if (at.parent === undefined) {
        const { root } = at
        charge()
        result = { value: read(() => known[root]) }
        resolved.set(at.id, result)
        break
      }
      pending.push(at)
      at = at.parent
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const step = pending[i]
      charge()
      if (result !== undefined && 'value' in result) {
        const current = result.value
        if (!read(() => isMap(current))) result = undefined
        else if (!isPresent(current as Record<string, unknown>, step.key))
          result = { missing: step }
        else result = { value: read(() => (current as Record<string, unknown>)[step.key]) }
      }
      resolved.set(step.id, result)
    }
    return result
  }

  /** Checks a known value read whole against its declared type: every declared field is there. */
  const checkWhole = (value: unknown, type: Type, name: string, node: Node): void => {
    charge()
    const expected = withoutNull(type)
    if (expected.kind === 'list') {
      if (!read(() => Array.isArray(value))) return
      const list = value as unknown[]
      const length = read(() => list.length)
      for (let i = 0; i < length; i++) {
        const item = read(() => list[i])
        checkWhole(item, expected.element, `${name}[${i}]`, node)
      }
      return
    }
    if (expected.kind !== 'map' || !read(() => isMap(value))) return
    const map = value as Record<string, unknown>
    for (const [key, field] of Object.entries(expected.fields)) {
      if (!isPresent(map, key)) {
        fail(
          `${name}.${key} is missing from the known values: ${name} is read whole, so pass every field its type declares (null when it has no value)`,
          node,
        )
      }
      const item = read(() => map[key])
      checkWhole(item, field, `${name}.${key}`, node)
    }
  }

  const reads: {
    readonly chain: Chain
    readonly node: Node
    readonly flow: ReadonlySet<number>
  }[] = []
  const wholes: { readonly chain: Chain; readonly node: Node }[] = []

  /** `whole`: the value is used as it is, not only to read a member of it or test it for null. */
  const visit = (node: Node, scope: Scope, flow: ReadonlySet<number>, whole: boolean): void => {
    charge()
    const chain = chainOf(node, scope)
    if (chain !== undefined && chain.root !== row) {
      if (chain.length > 0) reads.push({ chain, node, flow })
      if (whole && declared?.[chain.root] !== undefined) wholes.push({ chain, node })
    }
    switch (node.type) {
      case 'Member':
        visit(node.object, scope, flow, false)
        return
      case 'Index':
        visit(node.object, scope, flow, false)
        visit(node.index, scope, flow, true)
        return
      case 'Has':
        guard(node.target)
        visit(node.target, scope, flow, false)
        return
      case 'Let': {
        // A let name that stands for a path is followed at each use instead.
        const alias = chainOf(node.value, scope)
        visit(node.value, scope, flow, alias === undefined)
        visit(node.body, new Map(scope).set(node.name, alias), flow, true)
        return
      }
      case 'Lambda': {
        const inner = new Map(scope)
        for (const param of node.params) inner.set(param, undefined)
        visit(node.body, inner, flow, true)
        return
      }
      case 'Conditional':
        visit(node.test, scope, flow, true)
        visit(node.then, scope, extend(flow, node.test, scope, true), true)
        visit(node.otherwise, scope, extend(flow, node.test, scope, false), true)
        return
      case 'Binary': {
        const { operator, left, right } = node
        if (operator === '&&' || operator === '||') {
          visit(left, scope, flow, true)
          visit(right, scope, extend(flow, left, scope, operator === '&&'), true)
          return
        }
        if (operator === '??') guard(left)
        const nullCheck = operator === '==' || operator === '!='
        const leftNull = nullCheck && left.type === 'Literal' && left.value === null
        const rightNull = nullCheck && right.type === 'Literal' && right.value === null
        if (rightNull) guard(left)
        if (leftNull) guard(right)
        visit(left, scope, flow, !rightNull)
        visit(right, scope, flow, !leftNull)
        return
      }
      case 'Call':
      case 'It':
      case 'List':
      case 'Literal':
      case 'Local':
      case 'Map':
      case 'Template':
      case 'Try':
      case 'Unary':
      case 'Variable':
      default:
        forEachChild(node, (child) => {
          visit(child, scope, flow, true)
        })
    }
  }
  visit(ast, NO_SCOPE, NO_FLOW, true)
  for (const { chain, node, flow } of reads) {
    const result = resolve(chain)
    if (result === undefined || !('missing' in result)) continue
    if (guardedUses.has(node) || flow.has(result.missing.id)) continue
    fail(
      `${pathName(result.missing)} is missing from the known values: pass it (null when it has no value), or guard it with has() or ??`,
      node,
    )
  }
  for (const { chain, node } of wholes) {
    charge(chain.length)
    const type = typeAt(declared?.[chain.root] as Type, keysOf(chain))
    if (type === undefined) continue
    const result = resolve(chain)
    if (result !== undefined && 'value' in result && result.value !== undefined)
      checkWhole(result.value, type, pathName(chain), node)
  }
}

/** Partially evaluates the program and lowers the residual to a predicate. */
function lower(
  program: Translatable,
  options: CommonOptions,
  columns: ReadonlyMap<string, Declared>,
  target: Target,
  translation: Budget,
): Pred {
  const { charge } = translation
  const source = program.source
  const fail = (message: string, at?: Span): never => {
    throw new BonsaiTranslationError(
      message,
      source,
      at === undefined ? undefined : { start: at.start, end: at.end },
    )
  }
  const knownData = options.known ?? {}
  /** Known data is host data: a Proxy or getter that throws is an untranslatable value. */
  const hostRead = <T>(read: () => T, what: string): T => {
    try {
      return read()
    } catch {
      return fail(`Reading ${what} failed`)
    }
  }
  // A key holding undefined is absent, as it is everywhere else.
  const isKnown = (name: string): boolean =>
    hostRead(
      () => Object.hasOwn(knownData, name) && knownData[name] !== undefined,
      'the known values',
    )
  if (isKnown(options.row))
    throw new TypeError(`known must not contain the row variable (${options.row})`)
  // A misspelled row (or a missing known value) would otherwise read as null.
  for (const name of program.references.variables) {
    if (name !== options.row && !isKnown(name)) {
      if (hostRead(() => Object.hasOwn(knownData, name), 'the known values'))
        fail(`${name} is undefined in the known values: pass null when it has no value`)
      // Known names first: a name close to both is more likely a misspelled known value.
      const names = hostRead(() => Object.keys(knownData), 'the known values')
      fail(
        `${name} is neither the row (${options.row}) nor a known value${hint(name, [...names, options.row])}`,
      )
    }
  }
  checkKnownPaths(program.ast, {
    row: options.row,
    known: knownData,
    declared: declaredVariables(program),
    hostRead,
    fail,
    charge,
  })
  const result = translation.partial((limits) =>
    program.partial(knownData as never, {
      unknown: [options.row],
      ...(options.callHostFunctions === undefined
        ? {}
        : { callHostFunctions: options.callHostFunctions }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(limits as Pick<PartialOptions, 'maxSteps' | 'timeout'>),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  )
  if (result.status === 'error') throw result.error
  if (result.status === 'value') {
    if (typeof result.value !== 'boolean' && result.value !== null)
      fail('The predicate does not produce a boolean')
    return { kind: 'const', value: result.value === true }
  }
  const { bindings, hostFunctions } = result
  /** Why a node does not translate, as specifically as the node allows. */
  const untranslatable = (node: Node): never => {
    switch (node.type) {
      case 'Call':
        if (hostFunctions.includes(node.name))
          return fail(`${node.name}() is a host function, which has no database equivalent`, node)
        if (node.name === 'now')
          return fail('now() is translated only with the `now` option, which fixes its time', node)
        if (CALENDAR.has(node.name)) {
          return fail(
            `${node.name}() depends on time zone calendar rules, which databases do not apply as Bonsai does; compare the timestamp with known bounds instead`,
            node,
          )
        }
        return fail(`${node.name}() is not translated`, node)
      case 'Let':
        return fail('let is not translated; write the value in place', node)
      case 'Conditional':
        return fail('?: is not translated; write the condition with && and ||', node)
      case 'Try':
        return fail('try() is not translated', node)
      case 'Template':
        return fail('Templates are not translated', node)
      case 'Index':
        return fail('Computed reads ([...]) are not translated', node)
      case 'Has':
        return fail('has() is not translated', node)
      case 'Binary':
        return COMPARISONS.has(node.operator)
          ? fail('A comparison is translated as a condition, not as a value', node)
          : fail(`"${node.operator}" is not translated`, node)
      case 'Unary':
        return fail(`"${node.operator}" is not translated here`, node)
      case 'It':
      case 'Lambda':
      case 'List':
      case 'Literal':
      case 'Local':
      case 'Map':
      case 'Member':
      case 'Variable':
      default:
        return fail('This expression has no exact database equivalent', node)
    }
  }

  const columnOf = (node: Node): ColumnValue | undefined => {
    const path: string[] = []
    let current: Node = node
    while (current.type === 'Member') {
      path.unshift(current.name)
      current = current.object
    }
    if (current.type !== 'Variable' || current.name !== options.row) return undefined
    if (path.length === 0)
      return fail(
        `Only declared fields of ${options.row} can be queried, not ${options.row} itself`,
        node,
      )
    const key = path.join('.')
    const declared = columns.get(key)
    // `.length` of a declared text column: Bonsai counts UTF-16 units, databases characters.
    const parent = path.length > 1 ? columns.get(path.slice(0, -1).join('.')) : undefined
    if (declared === undefined && parent?.type === 'text' && path.at(-1) === 'length') {
      return fail(
        'The length of text is not translated (databases count characters, Bonsai UTF-16 units)',
        node,
      )
    }
    if (declared === undefined) {
      return fail(
        `${options.row}.${key} is not a declared column${hint(key, columns.keys())}`,
        node,
      )
    }
    return { kind: 'column', field: declared.field, type: declared.type }
  }

  /** Checks a constant the database must see exactly as Bonsai does. */
  const exact = (constant: Primitive, at: Node): Primitive => {
    if (typeof constant === 'string' && LONE_SURROGATE.test(constant))
      return fail('Text containing a lone surrogate cannot be sent to the database', at)
    // Read Date subclasses the way Bonsai compares them: by time.
    const value =
      constant instanceof Date ? new Date(Date.prototype.getTime.call(constant)) : constant
    const problem = target.checkConstant(value)
    return problem === undefined ? value : fail(problem, at)
  }

  // Partial evaluation turned every known value it could read into a literal or a
  // binding; a known variable still in the residual is one whose read failed.
  const knownValue = (name: string): unknown =>
    Object.hasOwn(bindings, name) ? bindings[name] : undefined
  /** Checks a constant, charging for the text it holds. */
  const charged = (constant: Primitive, at: Node): Primitive => {
    charge(typeof constant === 'string' ? textCost(constant) : 1)
    return exact(constant, at)
  }
  // Each binding is read and checked once, however often the predicate uses it.
  const constants = new Map<string, Primitive | undefined>()
  const constOf = (node: Node): Primitive | undefined => {
    if (node.type === 'Literal') return charged(node.value, node)
    if (node.type !== 'Variable') return undefined
    charge()
    if (constants.has(node.name)) return constants.get(node.name)
    const bound = knownValue(node.name)
    const primitive = hostRead(() => primitiveOf(bound), 'the known values')
    const constant = primitive === undefined ? undefined : charged(primitive, node)
    constants.set(node.name, constant)
    return constant
  }

  const lists = new Map<string, readonly Primitive[] | undefined>()
  const listOf = (node: Node): readonly Primitive[] | undefined => {
    charge()
    if (node.type === 'List') {
      const out: Primitive[] = []
      for (const item of node.items) {
        const value = item.type === 'Spread' ? undefined : constOf(item)
        if (value === undefined) return undefined
        out.push(value)
      }
      return out
    }
    if (node.type !== 'Variable') return undefined
    if (lists.has(node.name)) return lists.get(node.name)
    const list = knownList(knownValue(node.name), node)
    lists.set(node.name, list)
    return list
  }
  const knownList = (items: unknown, at: Node): Primitive[] | undefined => {
    // A residual names known values by internal bindings, so the message does not.
    const what = 'the known values'
    if (!hostRead(() => Array.isArray(items), what)) return undefined
    const list = items as unknown[]
    const out: Primitive[] = []
    // Read by index, as Bonsai reads a list: never through the list's own iterator.
    // A hole, or undefined, reads as null.
    const length = hostRead(() => list.length, what)
    for (let i = 0; i < length; i++) {
      const item = hostRead(() => primitiveOf(list[i] ?? null), what)
      if (item === undefined) return undefined
      out.push(charged(item, at))
    }
    return out
  }

  /** The entries of a list that `keep` accepts, computed once per list and `kind`. */
  const filtered = new WeakMap<readonly Primitive[], Map<string, readonly Primitive[]>>()
  const entries = (
    list: readonly Primitive[],
    kind: string,
    keep: (entry: Primitive) => boolean,
  ): readonly Primitive[] => {
    charge()
    let byKind = filtered.get(list)
    if (byKind === undefined) {
      byKind = new Map()
      filtered.set(list, byKind)
    }
    let out = byKind.get(kind)
    if (out === undefined) {
      charge(list.length)
      out = list.filter(keep)
      byKind.set(kind, out)
    }
    return out
  }

  /**
   * `column ?? fallback` with a known fallback of the column's kind; the
   * column itself for a null fallback; undefined when the node is not `??`.
   */
  const defaultOf = (
    node: Node,
  ): Extract<Value, { kind: 'coalesce' }> | ColumnValue | undefined => {
    if (node.type !== 'Binary' || node.operator !== '??') return undefined
    const column = columnOf(node.left)
    if (column === undefined)
      return fail('"??" is translated for a field with a known default', node)
    const fallback = constOf(node.right)
    if (fallback === undefined)
      return fail('"??" is translated for a field with a known default', node)
    if (fallback === null) return column
    if (constantKind(fallback) !== column.type)
      return fail(`The default of a ${column.type} field must be a ${column.type}`, node)
    return { kind: 'coalesce', column, fallback }
  }
  /** A `??` default that is not the field itself (a non-null fallback). */
  const coalesced = (node: Node): Extract<Value, { kind: 'coalesce' }> | undefined => {
    const found = defaultOf(node)
    return found?.kind === 'coalesce' ? found : undefined
  }

  /** `inMilliseconds(column)` of a duration column. */
  const millisecondsOf = (node: CallNode): Value | undefined => {
    if (node.name !== 'inMilliseconds' || hostFunctions.includes(node.name)) return undefined
    const arg = node.args[0]
    if (node.args.length !== 1 || arg === undefined || arg.type === 'Spread') return undefined
    const column = columnOf(arg)
    if (column?.type !== 'duration') return undefined
    // `?.` gives null on a null duration, which compares as null does: the stored number.
    if (node.optional) return { kind: 'column', field: column.field, type: 'number' }
    // Without `?.` a null duration fails, which SQL detects; MongoDB cannot.
    if (!target.arithmetic)
      return fail(`inMilliseconds() is translated for ${target.name} only with ?.`, node)
    return { kind: 'ms', column }
  }

  const value = (node: Node): Value => {
    const column = columnOf(node)
    if (column !== undefined) return column
    const constant = constOf(node)
    if (constant !== undefined) return { kind: 'const', value: constant }
    const fallback = defaultOf(node)
    if (fallback !== undefined) {
      if (fallback.kind === 'coalesce' && !target.columnPairs) {
        return fail(
          `A "??" default is translated for ${target.name} only when compared with a known value`,
          node,
        )
      }
      return fallback
    }
    if (node.type === 'Call') {
      const ms = millisecondsOf(node)
      if (ms !== undefined) return ms
    }
    if (
      node.type === 'Binary' &&
      (node.operator === '+' || node.operator === '-' || node.operator === '*')
    ) {
      if (!target.arithmetic) return fail(`Arithmetic is not translated for ${target.name}`, node)
      const left = value(node.left)
      const right = value(node.right)
      const kinds = [kindOf(left), kindOf(right)]
      if (kinds.includes('timestamp')) {
        return fail(
          `"${node.operator}" on a timestamp is translated only for a timestamp column itself, ` +
            'shifted by a known duration or measured from a known time; for an optional column, ' +
            'test it first (x != null && now() - x < days(14))',
          node,
        )
      }
      if (kinds.some((kind) => kind !== 'number')) {
        return fail(`"${node.operator}" is translated for numbers only`, node)
      }
      return { kind: 'arith', op: node.operator, left, right }
    }
    if (node.type === 'Unary' && node.operator === '-') {
      if (!target.arithmetic) return fail(`Arithmetic is not translated for ${target.name}`, node)
      const operand = value(node.operand)
      if (kindOf(operand) !== 'number') return fail('"-" is translated for numbers only', node)
      // Multiplying by -1 is exact, and fails on null as negation does.
      return { kind: 'arith', op: '*', left: { kind: 'const', value: -1 }, right: operand }
    }
    return untranslatable(node)
  }

  const pair = (left: Value, right: Value, at: Node): void => {
    if (!target.columnPairs && left.kind !== 'const' && right.kind !== 'const')
      fail(`${target.name} queries compare a field with a known value`, at)
  }

  const patterns = new Map<string, string | undefined>()
  const checkPattern = (text: string): string | undefined =>
    once(patterns, text, () => target.checkPattern(text), charge)

  const textArgument = (args: readonly (Node | SpreadNode)[], at: Node): string => {
    const arg = args[1]
    const text = arg === undefined || arg.type === 'Spread' ? undefined : constOf(arg)
    if (typeof text !== 'string' || args.length !== 2)
      return fail('Expected a known string argument', at)
    const problem = checkPattern(text)
    return problem === undefined ? text : fail(problem, at)
  }

  /**
   * A text function on a text column, or on a column with a known text
   * default (`(order.email ?? "").endsWith(x)`); undefined for anything else.
   */
  const textCall = (node: CallNode): Pred | undefined => {
    if (hostFunctions.includes(node.name)) return untranslatable(node)
    const op = node.name
    if (op !== 'startsWith' && op !== 'endsWith' && op !== 'includes') return undefined
    const receiver = node.args[0]
    if (receiver === undefined || receiver.type === 'Spread') return undefined
    if (receiver.type === 'Binary' && receiver.operator === '??') {
      const column = columnOf(receiver.left)
      const fallback = constOf(receiver.right)
      if (column?.kind !== 'column' || column.type !== 'text' || typeof fallback !== 'string')
        return undefined
      const text = textArgument(node.args, node)
      const matches: Pred = { kind: 'text', op, column, text, nullFails: false }
      // A null column calls the function on the default, whose answer is known.
      return textFunction(op, fallback, text)
        ? { kind: 'or', items: [matches, { kind: 'null', value: column }] }
        : matches
    }
    const column = columnOf(receiver)
    if (column?.kind !== 'column' || column.type !== 'text') return undefined
    return {
      kind: 'text',
      op,
      column,
      text: textArgument(node.args, node),
      // `?.` gives null on a null receiver, which a condition reads as false.
      nullFails: !node.optional,
    }
  }

  /**
   * The part of an untranslated call to name: the call that computes a text
   * function's receiver (`title.toLowerCase()` in `title.toLowerCase().includes(x)`),
   * since the text function itself translates on a text field.
   */
  const blamed = (node: CallNode): Node => {
    const receiver = node.args[0]
    const isTextFunction =
      node.name === 'startsWith' || node.name === 'endsWith' || node.name === 'includes'
    return isTextFunction && receiver?.type === 'Call' ? receiver : node
  }

  /**
   * A condition that may be null: a `?.` text call (null when its column is)
   * or a boolean column. `whenNull` holds exactly when it is null; a condition
   * without one is never null (it is a boolean, or it fails).
   */
  const nullable = (node: Node): { pred: Pred; whenNull?: Pred } | undefined => {
    if (node.type === 'Call') {
      const call = textCall(node)
      if (call === undefined) return undefined
      if (call.kind !== 'text' || call.nullFails) return { pred: call }
      return { pred: call, whenNull: { kind: 'null', value: call.column } }
    }
    const column = columnOf(node)
    if (column?.kind === 'column' && column.type === 'boolean')
      return { pred: { kind: 'truthy', column }, whenNull: { kind: 'null', value: column } }
    return undefined
  }

  /** `call == true`, `call != false`, `call == null` for a text call, which value() cannot read. */
  const conditionEquality = (node: BinaryNode): Pred | undefined => {
    let side: Node
    let other: Node
    if (node.left.type === 'Call') {
      side = node.left
      other = node.right
    } else if (node.right.type === 'Call') {
      side = node.right
      other = node.left
    } else {
      return undefined
    }
    const known = constOf(other)
    if (known !== null && typeof known !== 'boolean') return undefined
    const condition = nullable(side)
    if (condition === undefined) return undefined
    const { pred: call, whenNull } = condition
    // Both sides are evaluated: a call that fails on a null column fails the comparison.
    if (known === null)
      return whenNull ?? { kind: 'and', items: [call, { kind: 'const', value: false }] }
    if (known) return call
    const negated: Pred = { kind: 'not', item: call }
    return whenNull === undefined
      ? negated
      : { kind: 'and', items: [{ kind: 'not', item: whenNull }, negated] }
  }

  /** A known timestamp or duration, in milliseconds. */
  const knownTime = (node: Node): { kind: 'timestamp' | 'duration'; ms: number } | undefined => {
    const constant = constOf(node)
    if (constant instanceof Date) return { kind: 'timestamp', ms: msOf(constant) }
    return constant instanceof Duration ? { kind: 'duration', ms: constant.ms } : undefined
  }

  /**
   * `sign * column + offset` (milliseconds): a timestamp column shifted by a
   * known duration (a timestamp), or its distance from a known time (a duration).
   */
  interface Shift {
    readonly column: Value
    readonly sign: 1 | -1
    readonly offset: number
    readonly kind: 'timestamp' | 'duration'
  }
  const shiftOf = (node: Node): Shift | undefined => {
    if (node.type !== 'Binary' || (node.operator !== '+' && node.operator !== '-')) return undefined
    const timestampColumn = (side: Node): Value | undefined => {
      const column = columnOf(side)
      return column?.kind === 'column' && column.type === 'timestamp' ? column : undefined
    }
    const leftColumn = timestampColumn(node.left)
    const rightColumn = timestampColumn(node.right)
    if (leftColumn !== undefined) {
      const known = knownTime(node.right)
      if (known?.kind === 'duration') {
        const offset = node.operator === '+' ? known.ms : -known.ms
        return { column: leftColumn, sign: 1, offset, kind: 'timestamp' }
      }
      if (known?.kind === 'timestamp' && node.operator === '-')
        return { column: leftColumn, sign: 1, offset: -known.ms, kind: 'duration' }
      return undefined
    }
    if (rightColumn === undefined) return undefined
    const known = knownTime(node.left)
    if (known?.kind === 'duration' && node.operator === '+')
      return { column: rightColumn, sign: 1, offset: known.ms, kind: 'timestamp' }
    if (known?.kind === 'timestamp' && node.operator === '-')
      return { column: rightColumn, sign: -1, offset: known.ms, kind: 'duration' }
    return undefined
  }

  /** An ordering of a shifted timestamp, rewritten as the column against a known bound. */
  const timeOrder = (node: BinaryNode, op: '<' | '<=' | '>' | '>='): Pred | undefined => {
    let shift = shiftOf(node.left)
    let other = node.right
    let relation = op
    if (shift === undefined) {
      shift = shiftOf(node.right)
      other = node.left
      relation = FLIP[op]
    }
    if (shift === undefined) return undefined
    const known = knownTime(other)
    if (known?.kind !== shift.kind) {
      return fail(
        shift.kind === 'timestamp'
          ? 'A shifted timestamp is translated against a known timestamp'
          : 'A distance between timestamps is translated against a known duration',
        node,
      )
    }
    // sign * column + offset <op> known, solved for the column.
    const boundMs = shift.sign === 1 ? known.ms - shift.offset : shift.offset - known.ms
    if (Math.abs(boundMs) > MAX_TIME)
      return fail('The comparison reaches past the range of dates', node)
    const bound = exact(new Date(boundMs), node) as Date
    const columnOp = shift.sign === 1 ? relation : FLIP[relation]
    // Shifting a timestamp past the Date range is an error, so those rows fail.
    let limit: { op: '<=' | '>='; ms: number } | undefined
    if (shift.kind === 'timestamp' && shift.offset > 0)
      limit = { op: '<=', ms: MAX_TIME - shift.offset }
    if (shift.kind === 'timestamp' && shift.offset < 0)
      limit = { op: '>=', ms: -MAX_TIME - shift.offset }
    if (limit !== undefined && Math.abs(limit.ms) > MAX_TIME)
      return fail('The shift reaches past the range of dates', node)
    return { kind: 'shifted', column: shift.column, op: columnOp, bound, limit }
  }

  const pred = (node: Node): Pred => {
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'boolean' || node.value === null)
          return { kind: 'const', value: node.value === true }
        return fail('A condition must be a boolean', node)
      case 'Unary':
        if (node.operator === '!') return { kind: 'not', item: pred(node.operand) }
        return fail('A condition must be a boolean', node)
      case 'Binary':
        switch (node.operator) {
          case '&&':
          case '||':
            return {
              kind: node.operator === '&&' ? 'and' : 'or',
              items: [pred(node.left), pred(node.right)],
            }
          case '==':
          case '!=': {
            const eq =
              conditionEquality(node) ??
              defaultEquality(node) ??
              equality(value(node.left), value(node.right), node)
            return node.operator === '==' ? eq : { kind: 'not', item: eq }
          }
          case '<':
          case '<=':
          case '>':
          case '>=': {
            const shifted = timeOrder(node, node.operator)
            if (shifted !== undefined) return shifted
            const defaulted = defaultOrdering(node, node.operator)
            if (defaulted !== undefined) return defaulted
            return ordering(value(node.left), node.operator, value(node.right), node)
          }
          case 'in':
          case 'not in': {
            const membership = contains(node.left, node.right, node)
            return node.operator === 'in' ? membership : { kind: 'not', item: membership }
          }
          case '??': {
            const left = nullable(node.left)
            if (left === undefined) {
              // A call that does not translate says why, rather than blaming the "??".
              if (node.left.type === 'Call') return untranslatable(blamed(node.left))
              return fail('"??" is translated after a ?. text call or a boolean field', node)
            }
            if (left.whenNull === undefined) return left.pred
            // The right side runs only when the left is null; the left is false then.
            return {
              kind: 'or',
              items: [left.pred, { kind: 'and', items: [left.whenNull, pred(node.right)] }],
            }
          }
          case '%':
          case '*':
          case '**':
          case '+':
          case '-':
          case '/':
          default:
            return fail(`"${node.operator}" is not translated in a condition`, node)
        }
      case 'Member': {
        const column = columnOf(node)
        if (column?.kind === 'column' && column.type === 'boolean')
          return { kind: 'truthy', column }
        return fail('Only boolean columns can be used as conditions', node)
      }
      case 'Call':
        return textCall(node) ?? untranslatable(blamed(node))
      case 'Conditional':
      case 'Has':
      case 'Index':
      case 'It':
      case 'Lambda':
      case 'Let':
      case 'List':
      case 'Local':
      case 'Map':
      case 'Template':
      case 'Try':
      case 'Variable':
      default:
        return untranslatable(node)
    }
  }

  const ordering = (left: Value, op: '<' | '<=' | '>' | '>=', right: Value, node: Node): Pred => {
    const kinds = [kindOf(left), kindOf(right)]
    if (!kinds.includes('null') && kinds[0] !== kinds[1]) {
      let message = `Cannot order ${kinds[0]} with ${kinds[1]}`
      if (left.kind === 'const') message += `: the known value on the left is ${kinds[0]}`
      else if (right.kind === 'const') message += `: the known value on the right is ${kinds[1]}`
      return fail(message, node)
    }
    if (kinds.includes('text')) {
      return fail(
        'Ordering text is not translated (databases order by code point, Bonsai by UTF-16 unit)',
        node,
      )
    }
    if (kinds.includes('boolean')) return fail('Booleans cannot be ordered', node)
    // Ordering with null is false, unless the other side fails first.
    if (kinds.includes('null'))
      return { kind: 'in', value: kinds[0] === 'null' ? right : left, list: [] }
    pair(left, right, node)
    return left.kind === 'const'
      ? { kind: 'order', op: FLIP[op], left: right, right: left }
      : { kind: 'order', op, left, right }
  }

  /** One side a `field ?? default`, the other a known value: the default's side and that value. */
  const defaultAgainstKnown = (
    node: BinaryNode,
  ):
    | {
        readonly fallback: Extract<Value, { kind: 'coalesce' }>
        readonly known: Primitive
        readonly flipped: boolean
      }
    | undefined => {
    const left = coalesced(node.left)
    if (left !== undefined) {
      const known = constOf(node.right)
      return known === undefined ? undefined : { fallback: left, known, flipped: false }
    }
    const right = coalesced(node.right)
    if (right === undefined) return undefined
    const known = constOf(node.left)
    return known === undefined ? undefined : { fallback: right, known, flipped: true }
  }

  /**
   * `(field ?? d) op k`: where the field is null the answer is `d op k`, known
   * now; elsewhere it is `field op k`. Exact for every target, and indexable.
   */
  const defaultOrdering = (node: BinaryNode, op: '<' | '<=' | '>' | '>='): Pred | undefined => {
    const found = defaultAgainstKnown(node)
    if (found === undefined) return undefined
    const relation = found.flipped ? FLIP[op] : op
    const { column, fallback } = found.fallback
    const onField = ordering(column, relation, { kind: 'const', value: found.known }, node)
    const onDefault =
      found.known !== null &&
      constantKind(found.known) === column.type &&
      ordered(fallback, relation, found.known)
    return onDefault ? { kind: 'or', items: [{ kind: 'null', value: column }, onField] } : onField
  }

  /** `(field ?? d) == k`, rewritten as for an ordering. */
  const defaultEquality = (node: BinaryNode): Pred | undefined => {
    const found = defaultAgainstKnown(node)
    if (found === undefined) return undefined
    const { column, fallback } = found.fallback
    // The default is never null, so neither is the left side.
    if (found.known === null) return { kind: 'const', value: false }
    const onField = equality(column, { kind: 'const', value: found.known }, node)
    return sameValue(fallback, found.known)
      ? { kind: 'or', items: [{ kind: 'null', value: column }, onField] }
      : onField
  }

  const equality = (left: Value, right: Value, at: Node): Pred => {
    const [a, b] = left.kind === 'const' && right.kind !== 'const' ? [right, left] : [left, right]
    const ka = kindOf(a)
    const kb = kindOf(b)
    if (kb === 'null')
      return ka === 'null' ? { kind: 'const', value: true } : { kind: 'null', value: a }
    if (ka === 'null') return { kind: 'null', value: b }
    if (ka !== kb) {
      // Arithmetic is never null when it succeeds, so the answer is false unless it fails;
      // Bonsai evaluates both sides of == first.
      const failing = [a, b].find(failable)
      if (failing !== undefined) return { kind: 'in', value: failing, list: [] }
      // Different kinds are equal only when both are null (b is non-null if constant,
      // and a field with a default never is).
      const isNull = (v: Value): Pred =>
        v.kind === 'const' || v.kind === 'coalesce'
          ? { kind: 'const', value: false }
          : { kind: 'null', value: v }
      return { kind: 'and', items: [isNull(a), isNull(b)] }
    }
    pair(a, b, at)
    return { kind: 'eq', left: a, right: b }
  }

  const contains = (itemNode: Node, containerNode: Node, at: Node): Pred => {
    const fallback = coalesced(itemNode)
    if (fallback !== undefined) {
      const known = listOf(containerNode)
      if (known !== undefined) {
        // The field with its default is never null: it matches the entries of its kind,
        // and a null field matches when the default is in the list.
        const { column } = fallback
        const onField: Pred = {
          kind: 'in',
          value: column,
          list: entries(
            known,
            `only ${column.type}`,
            (entry) => constantKind(entry) === column.type,
          ),
        }
        charge(known.length)
        return known.some((entry) => sameValue(entry, fallback.fallback))
          ? { kind: 'or', items: [{ kind: 'null', value: column }, onField] }
          : onField
      }
    }
    const item = value(itemNode)
    const list = listOf(containerNode)
    if (list !== undefined) {
      const kind = kindOf(item)
      const matching = entries(list, `${kind} or null`, (entry) => {
        const entryKind = constantKind(entry)
        return entryKind === kind || entryKind === 'null'
      })
      return { kind: 'in', value: item, list: matching }
    }
    const container = constOf(containerNode)
    if (typeof container === 'string' && item.kind === 'column' && item.type === 'text') {
      if (!target.within) return fail(`"field in text" is not translated for ${target.name}`, at)
      return { kind: 'within', column: item, text: container }
    }
    const containerColumn = columnOf(containerNode)
    if (
      containerColumn?.kind === 'column' &&
      containerColumn.type === 'text' &&
      item.kind === 'const' &&
      typeof item.value === 'string'
    ) {
      const problem = checkPattern(item.value)
      if (problem !== undefined) return fail(problem, at)
      return {
        kind: 'text',
        op: 'includes',
        column: containerColumn,
        text: item.value,
        nullFails: false,
      }
    }
    return fail('"in" is translated for known lists and text only', at)
  }

  return pred(result.residual)
}

// === three-valued lowering ===

/**
 * A predicate as two conditions: `t` holds for records where it is true, `f`
 * where it is false. Records where evaluation would fail match neither.
 * `safe` predicates cannot fail, so `f` is exactly the complement of `t`.
 *
 * Both are only ever combined with AND and OR, never negated, so a leaf may
 * leave NULL for "not selected": this keeps plain comparisons that can use an index.
 */
interface Dual<S> {
  readonly t: S
  readonly f: S
  readonly safe: boolean
}

type Leaf = Exclude<Pred, { kind: 'const' | 'and' | 'or' | 'not' }>

interface Algebra<S> {
  readonly TRUE: S
  readonly FALSE: S
  readonly and: (items: readonly S[]) => S
  readonly or: (items: readonly S[]) => S
  /** Rejects a query that has grown too large (a failing `&&` or `||` repeats its left side). */
  readonly guard: (item: S) => S
  readonly leaf: (p: Leaf) => Dual<S>
}

function dual<S>(p: Pred, algebra: Algebra<S>): Dual<S> {
  switch (p.kind) {
    case 'const':
      return p.value
        ? { t: algebra.TRUE, f: algebra.FALSE, safe: true }
        : { t: algebra.FALSE, f: algebra.TRUE, safe: true }
    case 'not': {
      const inner = dual(p.item, algebra)
      return { t: inner.f, f: inner.t, safe: inner.safe }
    }
    case 'and':
    case 'or': {
      const [first, ...rest] = p.items.map((item) => dual(item, algebra))
      let acc = first
      for (const next of rest) {
        const safe = acc.safe && next.safe
        if (p.kind === 'and') {
          // Bonsai evaluates left first: a failing left fails the whole.
          acc = {
            t: algebra.guard(algebra.and([acc.t, next.t])),
            f: algebra.guard(
              safe
                ? algebra.or([acc.f, next.f])
                : algebra.or([acc.f, algebra.and([acc.t, next.f])]),
            ),
            safe,
          }
        } else {
          acc = {
            t: algebra.guard(
              safe
                ? algebra.or([acc.t, next.t])
                : algebra.or([acc.t, algebra.and([acc.f, next.t])]),
            ),
            f: algebra.guard(algebra.and([acc.f, next.f])),
            safe,
          }
        }
      }
      return acc
    }
    case 'eq':
    case 'in':
    case 'null':
    case 'order':
    case 'shifted':
    case 'text':
    case 'truthy':
    case 'within':
    default:
      return algebra.leaf(p)
  }
}

/**
 * Whether evaluating the value can fail: arithmetic on null or with a
 * non-finite result, and `inMilliseconds()` of a null duration.
 */
function failable(value: Value): boolean {
  return value.kind === 'arith' || value.kind === 'ms'
}

/** A product by 0, 1, or -1, which can neither overflow nor underflow. */
function plainProduct(value: Extract<Value, { kind: 'arith' }>): boolean {
  if (value.op !== '*') return false
  const constant = value.left.kind === 'const' ? value.left : value.right
  return (
    constant.kind === 'const' &&
    typeof constant.value === 'number' &&
    (constant.value === 0 || Math.abs(constant.value) === 1)
  )
}

/** An exact float8 literal: JavaScript writes the shortest text that reads back as the same double. */
const float8 = (value: number): string => `${String(value)}::float8`
const PG_INFINITY = `'Infinity'::float8`
// Powers of two, each written as the shortest decimal that reads back as exactly that power.
/** 2^1023, half of the overflow bound: `a/2 ± b/2` reaching it means `a ± b` overflows. */
const HALF_OVERFLOW = 8.98846567431158e307
/** 2^-512: scales two operands above 1 so their product stays finite and rounds as theirs would. */
const SCALE_DOWN = 7.458340731200207e-155
/** 2^-500: both operands of a product at least this large keep it far from rounding to zero. */
const NO_UNDERFLOW = 3.054936363499605e-151
/** 2^537 and 2^538: scale the smaller and larger operand so their product is 1 exactly at 2^-1075. */
const SCALE_SMALL = 4.4989137945431964e161
const SCALE_LARGE = 8.997827589086393e161
/** Veltkamp's splitting constant for doubles, 2^27 + 1. */
const SPLITTER = 134_217_729

/**
 * Postgres arithmetic that gives the double Bonsai computes, or NULL where
 * Bonsai's fails (a null or non-finite operand, or an overflowing result),
 * without ever running an operation Postgres rejects: float8 `+`, `-`, and
 * `*` raise "value out of range" on overflow, and `*` also on a nonzero
 * product that rounds to zero, where JavaScript gives Infinity and 0.
 *
 * The operands are bound once in a subquery (`OFFSET 0` keeps the planner
 * from copying them into every use, and from folding a constant operand into
 * an expression it would evaluate while planning), and each test is exact:
 * - `a ± b` overflows only when both are at least 1, and then halving both is
 *   exact, so it overflows exactly when `a/2 ± b/2` reaches 2^1023.
 * - `a * b` overflows only when both exceed 1, and then
 *   `(a·2^-512)(b·2^-512)` rounds as `ab` does, scaled, so it overflows
 *   exactly when that reaches 1 (2^1024 - 2^970 rounds up to Infinity).
 * - `a * b` rounds to zero only when both are below 1 and one is below
 *   2^-500, exactly when `ab ≤ 2^-1075`, that is when `xp·yp ≤ 1` for
 *   `xp = min·2^537` and `yp = max·2^538` (both exact). Their rounded product
 *   decides unless it is exactly 1; then Dekker's exact product error does.
 */
function pgArithmetic(op: '+' | '-' | '*', left: string, right: string): string {
  const a = '_bonsai_a'
  const b = '_bonsai_b'
  const finite = `(abs(${a}) < ${PG_INFINITY} AND abs(${b}) < ${PG_INFINITY})`
  let body: string
  if (op === '*') {
    const product = `(${a} * ${b})`
    const xp = `least(abs(${a}), abs(${b})) * ${float8(SCALE_SMALL)}`
    const yp = `greatest(abs(${a}), abs(${b})) * ${float8(SCALE_LARGE)}`
    const split = (x: string, high: string): string =>
      `${x} * ${float8(SPLITTER)} - (${x} * ${float8(SPLITTER)} - ${x}) AS ${high}`
    // The exact error of p = xp * yp: Dekker's product with Veltkamp's split.
    const error =
      '(((_bonsai_xh * _bonsai_yh - _bonsai_p) + _bonsai_xh * _bonsai_yl) + _bonsai_xl * _bonsai_yh) + _bonsai_xl * _bonsai_yl'
    const underflow =
      `(SELECT CASE WHEN _bonsai_p < 1 THEN 0::float8 WHEN _bonsai_p > 1 THEN ${product}` +
      ` WHEN ${error} <= 0 THEN 0::float8 ELSE ${product} END` +
      ' FROM (SELECT _bonsai_xh, _bonsai_xp - _bonsai_xh AS _bonsai_xl, _bonsai_yh,' +
      ' _bonsai_yp - _bonsai_yh AS _bonsai_yl, _bonsai_xp * _bonsai_yp AS _bonsai_p' +
      ` FROM (SELECT _bonsai_xp, _bonsai_yp, ${split('_bonsai_xp', '_bonsai_xh')},` +
      ` ${split('_bonsai_yp', '_bonsai_yh')}` +
      ` FROM (SELECT ${xp} AS _bonsai_xp, ${yp} AS _bonsai_yp OFFSET 0) AS _bonsai_s` +
      ' OFFSET 0) AS _bonsai_h OFFSET 0) AS _bonsai_e)'
    body =
      `CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL` +
      ` WHEN NOT ${finite} THEN NULL` +
      ` WHEN ${a} = 0 OR ${b} = 0 THEN ${product}` +
      ` WHEN abs(${a}) > 1 AND abs(${b}) > 1 THEN CASE WHEN` +
      ` (abs(${a}) * ${float8(SCALE_DOWN)}) * (abs(${b}) * ${float8(SCALE_DOWN)}) < 1 THEN ${product} END` +
      ` WHEN abs(${a}) >= 1 OR abs(${b}) >= 1 OR least(abs(${a}), abs(${b})) >= ${float8(NO_UNDERFLOW)}` +
      ` THEN ${product} ELSE ${underflow} END`
  } else {
    body =
      `CASE WHEN NOT ${finite} THEN NULL` +
      ` WHEN abs(${a}) < 1 OR abs(${b}) < 1 THEN (${a} ${op} ${b})` +
      ` WHEN abs(${a} * 0.5::float8 ${op} ${b} * 0.5::float8) < ${float8(HALF_OVERFLOW)} THEN (${a} ${op} ${b}) END`
  }
  return `(SELECT ${body} FROM (SELECT ${left} AS ${a}, ${right} AS ${b} OFFSET 0) AS _bonsai_o)`
}

const tooLarge = (source: string): BonsaiTranslationError =>
  new BonsaiTranslationError('The translated query is too large', source, {
    start: 0,
    end: source.length,
  })

/** SQL text length, and MongoDB filter nodes, above which a translation is rejected. */
const MAX_SQL_LENGTH = 1_000_000
const MAX_MONGO_NODES = 100_000
/** Characters of text counted as one MongoDB filter node: the node limit then bounds a filter near 16 MB. */
const MONGO_TEXT_PER_NODE = 160
/** MongoDB rejects longer patterns; this leaves room for the anchors. */
const MAX_MONGO_PATTERN_BYTES = 32_000
/** Most parameters a statement can bind. */
const MAX_PARAMS = { postgres: 65_535, sqlite: 32_766 } as const
/** Most entries all of a query's Postgres array parameters hold together. */
const MAX_LIST_ENTRIES = 1_000_000
/** Most characters of text a SQL query's parameters hold together. */
const MAX_PARAM_TEXT = 16_000_000
/** The last year Postgres reads from an ISO timestamp (years with more digits use `+YYYYYY`). */
const MAX_PG_YEAR = 9999
/** Postgres truncates longer identifiers, which could name a different column. */
const MAX_PG_IDENTIFIER_BYTES = 63
const MAX_CODE_POINT = 0x10_ff_ff
const LAST_BEFORE_SURROGATES = 0xd7_ff
const FIRST_AFTER_SURROGATES = 0xe0_00

const utf8Length = (text: string): number => new TextEncoder().encode(text).length

/** The least string greater than every string that starts with `prefix`, by code point. */
function prefixEnd(prefix: string): string | undefined {
  // By code point: the prefix is well-formed, so no surrogate is split.
  const chars = Array.from(prefix)
  while (chars.length > 0) {
    const cp = chars.pop()?.codePointAt(0) ?? MAX_CODE_POINT
    if (cp !== MAX_CODE_POINT) {
      const next = cp === LAST_BEFORE_SURROGATES ? FIRST_AFTER_SURROGATES : cp + 1
      return chars.join('') + String.fromCodePoint(next)
    }
  }
  return undefined
}

// === SQL ===

const LIKE_SPECIAL = /[\\%_]/gu

const PG_CASTS: Readonly<Record<ColumnType, string>> = {
  text: 'text',
  number: 'float8',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  // Whole milliseconds: exact in a double up to 2^53.
  duration: 'float8',
}

/**
 * Translates a predicate to a SQL WHERE expression.
 *
 * Postgres: columns hold `text`, a numeric type, `boolean`, or `timestamptz`,
 * and durations as a numeric type of milliseconds; text comparisons use the C
 * collation. SQLite (UTF-8 databases): columns hold TEXT, REAL or INTEGER
 * numbers, booleans as 0/1, timestamps as epoch milliseconds, and durations as
 * milliseconds, and should be declared STRICT so they cannot hold other types.
 */
export function toSQL<Dialect extends SQLOptions['dialect']>(
  program: Translatable,
  options: SQLOptions & { readonly dialect: Dialect },
): SQLQuery<Dialect extends 'sqlite' ? string | number : SQLParam> {
  checkProgram(program, 'toSQL')
  checkKeys(options, SQL_OPTION_KEYS, 'toSQL')
  const dialect = options.dialect
  if (dialect !== 'postgres' && dialect !== 'sqlite')
    throw new TypeError(`dialect must be 'postgres' or 'sqlite'`)
  const pg = dialect === 'postgres'
  if (options.paramOffset !== undefined && typeof options.paramOffset !== 'number')
    throw new TypeError('paramOffset must be a number')
  const offset = options.paramOffset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError('paramOffset must be a non-negative integer')
  const target: Target = {
    name: pg ? 'Postgres' : 'SQLite',
    arithmetic: true,
    columnPairs: true,
    within: true,
    checkName: (name) => {
      if (name.includes('\0')) return 'contains a NUL character'
      if (pg && utf8Length(name) > MAX_PG_IDENTIFIER_BYTES) return 'is longer than 63 bytes'
      return undefined
    },
    checkConstant: (value) => {
      if (typeof value === 'string' && value.includes('\0'))
        return 'Text containing a NUL character cannot be sent to the database'
      if (pg && value instanceof Date) {
        const year = value.getUTCFullYear()
        if (year < 1 || year > MAX_PG_YEAR)
          return 'Postgres timestamps are translated for the years 0001 to 9999'
      }
      return undefined
    },
    checkPattern: () => undefined,
  }
  const translation = budget(options, program.source)
  const { charge } = translation
  const declaredColumns = declare(options, options.columns, 'columns', target)
  checkDeclaredTypes(program, options.row, declaredColumns, 'columns')
  const predicate = lower(program, options, declaredColumns, target, translation)
  const params: SQLParam[] = []
  const tooManyParams = (): BonsaiTranslationError =>
    new BonsaiTranslationError(
      `The translated query needs more than ${MAX_PARAMS[dialect]} parameters`,
      program.source,
      { start: 0, end: program.source.length },
    )

  const quote = (name: string): string =>
    pg ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll('`', '``')}\``
  const encode = (value: Exclude<Primitive, null>): string | number | boolean => {
    if (value instanceof Date) return pg ? new Date(msOf(value)).toISOString() : msOf(value)
    if (value instanceof Duration) return value.ms
    if (typeof value === 'boolean' && !pg) return value ? 1 : 0
    return value
  }
  // Numbered placeholders, so a value used again (with the same cast) reuses its
  // parameter: known text or a known list is sent once however often it is used.
  const numbered = new Map<string, Map<SQLParam, string>>()
  let paramText = 0
  const placeholder = (encoded: SQLParam, cast: string): string => {
    charge()
    let byValue = numbered.get(cast)
    if (byValue === undefined) {
      byValue = new Map()
      numbered.set(cast, byValue)
    }
    const reused = byValue.get(encoded)
    if (reused !== undefined) return reused
    if (typeof encoded === 'string') {
      charge(textCost(encoded))
      paramText += encoded.length
      if (paramText > MAX_PARAM_TEXT) throw tooLarge(program.source)
    }
    if (offset + params.length >= MAX_PARAMS[dialect]) throw tooManyParams()
    params.push(encoded)
    const sql = pg ? `$${offset + params.length}::${cast}` : `?${offset + params.length}`
    byValue.set(encoded, sql)
    return sql
  }
  /** A known list's non-null entries, and whether it holds null, worked out once per list. */
  const lists = new WeakMap<readonly Primitive[], { entries: Primitive[]; hasNull: boolean }>()
  const nonNullOf = (list: readonly Primitive[]): { entries: Primitive[]; hasNull: boolean } => {
    charge()
    let found = lists.get(list)
    if (found === undefined) {
      charge(list.length)
      const entries = [...new Set(list.filter((entry) => entry !== null))]
      found = { entries, hasNull: entries.length !== list.length }
      lists.set(list, found)
    }
    return found
  }
  /** A Postgres array parameter for a known list, sent once per list and cast. */
  const arrays = new WeakMap<readonly Primitive[], Map<string, string>>()
  let arrayEntries = 0
  const arrayParam = (list: readonly Primitive[], cast: string): string => {
    let byCast = arrays.get(list)
    if (byCast === undefined) {
      byCast = new Map()
      arrays.set(list, byCast)
    }
    let sql = byCast.get(cast)
    if (sql === undefined) {
      arrayEntries += list.length
      // Checked before the array is built.
      if (arrayEntries > MAX_LIST_ENTRIES) throw tooLarge(program.source)
      charge(list.length)
      sql = placeholder(
        // Never booleans: a boolean list is written out entry by entry.
        list.map((entry) => encode(entry as Exclude<Primitive, null>) as string | number),
        cast,
      )
      byCast.set(cast, sql)
    }
    return sql
  }
  const param = (value: Exclude<Primitive, null>, type: ColumnType): string =>
    placeholder(encode(value), PG_CASTS[type])
  const text = (sql: string): string => (pg ? `(${sql} COLLATE "C")` : sql)
  const TRUE = pg ? 'TRUE' : '1'
  const FALSE = pg ? 'FALSE' : '0'
  /** True when the condition is false or NULL. */
  const negate = (condition: string): string => `(NOT COALESCE(${condition}, ${FALSE}))`

  const rendered = new Map<Value, string>()
  const val = (value: Value): string => {
    let sql = rendered.get(value)
    if (sql !== undefined) return sql
    switch (value.kind) {
      case 'column':
        sql =
          pg && (value.type === 'number' || value.type === 'duration')
            ? `${quote(value.field)}::float8`
            : quote(value.field)
        break
      case 'const': {
        const kind = kindOf(value)
        sql = value.value === null ? 'NULL' : param(value.value, kind === 'null' ? 'text' : kind)
        break
      }
      case 'coalesce':
        sql = `COALESCE(${val(value.column)}, ${param(value.fallback, value.column.type)})`
        break
      case 'ms':
        sql = val(value.column)
        break
      case 'arith':
      default:
        sql =
          pg && !plainProduct(value)
            ? pgArithmetic(value.op, val(value.left), val(value.right))
            : `(${operand(value.left)} ${value.op} ${operand(value.right)})`
        charge(textCost(sql))
        if (sql.length > MAX_SQL_LENGTH) throw tooLarge(program.source)
    }
    rendered.set(value, sql)
    return sql
  }
  // SQLite INTEGER arithmetic is exact past 2^53; Bonsai's (and REAL's) is double.
  const operand = (value: Value): string =>
    !pg && (value.kind === 'column' || value.kind === 'coalesce' || value.kind === 'ms')
      ? `CAST(${val(value)} AS REAL)`
      : val(value)
  const typed = (value: Value): string => (kindOf(value) === 'text' ? text(val(value)) : val(value))
  // Column against column: a text-like type (citext) would otherwise pick its own operator.
  const plain = (value: Value): string =>
    pg && kindOf(value) === 'text' ? text(`${val(value)}::text`) : typed(value)
  /** Byte-wise SQLite text, so text holding NUL is read whole. UTF-8 matches by code point. */
  const bytes = (sql: string): string => `CAST(${sql} AS BLOB)`
  const INFINITY = pg ? `'Infinity'::float8` : '9e999'

  /**
   * SQL that is true when evaluating arithmetic in the values would fail: a
   * null operand makes the result null, and a non-finite result stays
   * non-finite (or NaN, which SQLite reads as null) through later operations.
   */
  const fails = (values: readonly Value[]): string | undefined => {
    const parts = values
      .filter(failable)
      .map((value) => `COALESCE(NOT (abs(${val(value)}) < ${INFINITY}), ${TRUE})`)
    return parts.length === 0 ? undefined : `(${parts.join(' OR ')})`
  }
  /** A comparison leaf: false when a plain operand is null, failing when arithmetic would fail. */
  const compare = (condition: string, ...values: Value[]): Dual<string> => {
    const failure = fails(values)
    if (failure === undefined) return { t: condition, f: negate(condition), safe: true }
    const ok = `(NOT ${failure})`
    return { t: `(${ok} AND ${condition})`, f: `(${ok} AND ${negate(condition)})`, safe: false }
  }

  const likePrefixes = new Map<string, string>()
  const prefixEnds = new Map<string, string | undefined>()
  const derived = <T>(cache: Map<string, T>, needle: string, make: () => T): T =>
    once(cache, needle, make, charge)
  const textCondition = (
    op: 'startsWith' | 'endsWith' | 'includes',
    column: string,
    needle: string,
  ): string => {
    if (pg) {
      if (op === 'startsWith') {
        // A prefix LIKE, whose index range Postgres derives in the database's own encoding.
        const like = placeholder(
          derived(
            likePrefixes,
            needle,
            () => `${needle.replace(LIKE_SPECIAL, (ch) => `\\${ch}`)}%`,
          ),
          'text',
        )
        return `(${text(column)} LIKE ${like} ESCAPE '\\')`
      }
      const pattern = placeholder(needle, 'text')
      if (op === 'includes') return `(strpos(${text(column)}, ${pattern}) > 0)`
      return `(right(${column}, char_length(${pattern})) = ${text(pattern)})`
    }
    const pattern = placeholder(needle, 'text')
    const blob = bytes(pattern)
    if (op === 'includes') return `(instr(${bytes(column)}, ${blob}) > 0)`
    if (op === 'endsWith') return `(substr(${bytes(column)}, -length(${blob})) = ${blob})`
    const end = derived(prefixEnds, needle, () => prefixEnd(needle))
    const range = `${column} >= ${pattern}${end === undefined ? '' : ` AND ${column} < ${placeholder(end, 'text')}`}`
    return `(${range} AND substr(${bytes(column)}, 1, length(${blob})) = ${blob})`
  }

  const algebra: Algebra<string> = {
    TRUE,
    FALSE,
    and: (items) => `(${items.join(' AND ')})`,
    or: (items) => `(${items.join(' OR ')})`,
    guard: (item) => {
      if (item.length > MAX_SQL_LENGTH) throw tooLarge(program.source)
      return item
    },
    leaf: (p) => {
      switch (p.kind) {
        case 'null':
          return compare(`(${val(p.value)} IS NULL)`, p.value)
        case 'eq':
          if (p.right.kind === 'const' || p.left.kind === 'const') {
            return compare(`(${typed(p.left)} = ${typed(p.right)})`, p.left, p.right)
          }
          return compare(
            pg
              ? `(${plain(p.left)} IS NOT DISTINCT FROM ${plain(p.right)})`
              : `(${typed(p.left)} IS ${typed(p.right)})`,
            p.left,
            p.right,
          )
        case 'order':
          return compare(`(${val(p.left)} ${p.op} ${val(p.right)})`, p.left, p.right)
        case 'in': {
          const kind = kindOf(p.value)
          const { entries: nonNull, hasNull } = nonNullOf(p.list)
          const parts: string[] = []
          if (nonNull.length > 0) {
            const type = kind === 'null' ? 'text' : kind
            // One array parameter in Postgres, whatever the list's length. Not for booleans:
            // there are only two, and postgres.js cannot send a boolean array.
            if (pg && type !== 'boolean') {
              const array = arrayParam(nonNull, `${PG_CASTS[type]}[]`)
              parts.push(`${typed(p.value)} = ANY(${array})`)
            } else {
              // Each use writes every entry: checked before the text is built.
              if (nonNull.length > MAX_PARAMS[dialect]) throw tooManyParams()
              charge(nonNull.length)
              const entries = nonNull.map((entry) => param(entry as Exclude<Primitive, null>, type))
              parts.push(`${typed(p.value)} IN (${entries.join(', ')})`)
            }
          }
          if (hasNull) parts.push(`${val(p.value)} IS NULL`)
          return compare(parts.length === 0 ? FALSE : `(${parts.join(' OR ')})`, p.value)
        }
        case 'truthy': {
          const condition = pg ? val(p.column) : `(${val(p.column)} = 1)`
          return { t: condition, f: negate(condition), safe: true }
        }
        case 'shifted': {
          const column = val(p.column)
          // The column is not null, and within the range the shift allows (SQLite stores epoch milliseconds).
          const ok = [`(${column} IS NOT NULL)`]
          if (p.limit !== undefined) {
            const ms = placeholder(p.limit.ms, 'numeric')
            ok.push(
              pg
                ? `(extract(epoch from ${column}) * 1000 ${p.limit.op} ${ms})`
                : `(${column} ${p.limit.op} ${ms})`,
            )
          }
          const condition = `(${column} ${p.op} ${param(p.bound, 'timestamp')})`
          const valid = ok.join(' AND ')
          return {
            t: `(${valid} AND ${condition})`,
            f: `(${valid} AND NOT ${condition})`,
            safe: false,
          }
        }
        case 'text': {
          const column = val(p.column)
          const condition =
            p.text === '' ? `(${column} IS NOT NULL)` : textCondition(p.op, column, p.text)
          // Calling a text function on null fails, so null matches neither side.
          return p.nullFails
            ? { t: condition, f: `((${column} IS NOT NULL) AND ${negate(condition)})`, safe: false }
            : { t: condition, f: negate(condition), safe: true }
        }
        case 'within':
        default: {
          const column = val(p.column)
          const haystack = placeholder(p.text, 'text')
          const condition = pg
            ? `(strpos(${text(haystack)}, ${text(column)}) > 0)`
            : `(instr(${bytes(haystack)}, ${bytes(column)}) > 0)`
          return {
            t: condition,
            f: `((${column} IS NOT NULL) AND ${negate(condition)})`,
            safe: false,
          }
        }
      }
    },
  }

  // SQLite parameters are only numbers and text: encode() writes booleans as 1 and 0, and lists
  // become one parameter per entry.
  return { sql: algebra.guard(dual(predicate, algebra).t), params: params as never }
}

// === MongoDB ===

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/gu

const MONGO_ORDER = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' } as const

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, (ch) => `\\${ch}`)
}

/**
 * Translates a predicate to a MongoDB filter. Fields must hold the declared
 * scalar types (not arrays); pass `options` to find() so string comparison
 * is binary whatever the collection's default collation.
 */
export function toMongo(program: Translatable, options: MongoOptions): MongoQuery {
  checkProgram(program, 'toMongo')
  checkKeys(options, MONGO_OPTION_KEYS, 'toMongo')
  const translation = budget(options, program.source)
  const { charge } = translation
  const target: Target = {
    name: 'MongoDB',
    arithmetic: false,
    columnPairs: false,
    within: false,
    checkName: (name) => {
      if (name.includes('\0')) return 'contains a NUL character'
      if (name.split('.').some((segment) => segment === '' || segment.startsWith('$')))
        return 'is not a valid field path'
      return undefined
    },
    checkConstant: () => undefined,
    checkPattern: (text) => {
      if (text.includes('\0')) return 'MongoDB patterns cannot contain a NUL character'
      if (utf8Length(escapeRegex(text)) > MAX_MONGO_PATTERN_BYTES)
        return 'The text is too long for a MongoDB pattern'
      return undefined
    },
  }
  const declaredFields = declare(
    options,
    isRecord(options) ? options.fields : undefined,
    'fields',
    target,
  )
  checkDeclaredTypes(program, options.row, declaredFields, 'fields')
  const predicate = lower(program, options, declaredFields, target, translation)
  type Filter = Record<string, unknown>
  // lower() only leaves field-versus-constant comparisons for MongoDB.
  const field = (value: Value): string => (value as { field: string }).field
  // MongoDB stores a duration as its milliseconds.
  const stored = (item: Primitive): unknown => (item instanceof Duration ? item.ms : item)
  const constant = (value: Value): unknown => stored((value as { value: Primitive }).value)

  const sizes = new WeakMap<object, number>()
  /**
   * Filter nodes counted with repeats: what the driver serializes. Long text
   * counts as one node per MONGO_TEXT_PER_NODE characters, so a text repeated
   * in many places is bounded too.
   */
  const size = (item: unknown): number => {
    if (typeof item === 'string') return 1 + Math.floor(item.length / MONGO_TEXT_PER_NODE)
    if (typeof item !== 'object' || item === null || item instanceof Date) return 1
    let total = sizes.get(item)
    if (total === undefined) {
      total = 1
      for (const child of Object.values(item)) total += size(child)
      sizes.set(item, total)
    }
    return total
  }
  // Each pattern is escaped once per text function, however often it is used.
  const regexes = {
    startsWith: new Map<string, string>(),
    endsWith: new Map<string, string>(),
    includes: new Map<string, string>(),
  }
  const not = (item: Filter): Filter => ({ $nor: [item] })
  const safe = (t: Filter): Dual<Filter> => ({ t, f: not(t), safe: true })

  const algebra: Algebra<Filter> = {
    TRUE: {},
    FALSE: { $expr: false },
    and: (items) => ({ $and: [...items] }),
    or: (items) => ({ $or: [...items] }),
    guard: (item) => {
      if (size(item) > MAX_MONGO_NODES) throw tooLarge(program.source)
      return item
    },
    leaf: (p) => {
      switch (p.kind) {
        case 'null':
          return safe({ [field(p.value)]: { $eq: null } })
        case 'eq':
          return safe({ [field(p.left)]: { $eq: constant(p.right) } })
        case 'order': {
          const op = MONGO_ORDER[p.op]
          return safe({ [field(p.left)]: { [op]: constant(p.right) } })
        }
        case 'shifted': {
          const name = field(p.column)
          const ok: Filter[] = [{ [name]: { $ne: null } }]
          if (p.limit !== undefined)
            ok.push({ [name]: { [MONGO_ORDER[p.limit.op]]: new Date(p.limit.ms) } })
          const condition = { [name]: { [MONGO_ORDER[p.op]]: p.bound } }
          return {
            t: { $and: [...ok, condition] },
            f: { $and: [...ok, not(condition)] },
            safe: false,
          }
        }
        case 'in':
          if (p.list.length === 0) return safe({ $expr: false })
          // Each use holds every entry: checked before the copy is made.
          if (p.list.length > MAX_MONGO_NODES) throw tooLarge(program.source)
          charge(p.list.length)
          return safe({ [field(p.value)]: { $in: p.list.map(stored) } })
        case 'truthy':
          return safe({ [field(p.column)]: { $eq: true } })
        case 'text':
        case 'within':
        default: {
          const { op, text, nullFails } = p as Extract<Leaf, { kind: 'text' }>
          const pattern = once(
            regexes[op],
            text,
            () => {
              const body = escapeRegex(text)
              // `$` alone also matches before a final newline; the lookahead does not.
              if (op === 'startsWith') return `^${body}`
              if (op === 'endsWith') return `${body}$(?![\\s\\S])`
              return body
            },
            charge,
          )
          const name = field((p as Extract<Leaf, { kind: 'text' }>).column)
          // Calling a text function on null fails, so null matches neither side.
          const t = { [name]: { $regex: pattern } }
          if (!nullFails) return safe(t)
          return {
            t,
            f: {
              $and: [{ [name]: { $type: 'string' } }, { [name]: { $not: { $regex: pattern } } }],
            },
            safe: false,
          }
        }
      }
    },
  }

  return {
    filter: algebra.guard(dual(predicate, algebra).t),
    options: { collation: { locale: 'simple' } },
  }
}
