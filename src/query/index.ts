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
 * the contract, and only declared columns can be queried.
 */
import { BonsaiError, type Span } from '../errors.js'
import type { PartialOptions, PartialResult } from '../partial.js'
import { Duration } from '../runtime/values.js'
import type { BinaryNode, CallNode, Node, SpreadNode } from '../syntax/ast.js'

/** A compiled program (from `env.compile`) whose predicate is translated. */
export interface Translatable {
  readonly source: string
  readonly references: { readonly variables: readonly string[] }
  partial: (known: never, options?: PartialOptions) => PartialResult<unknown>
}

export type ColumnType = 'text' | 'number' | 'boolean' | 'timestamp'

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
  /** Values for every other variable the predicate reads. */
  readonly known?: Readonly<Record<string, unknown>> | undefined
  /** The time `now()` returns. Required when the predicate calls now(). */
  readonly now?: Date | undefined
}

export interface SQLOptions extends CommonOptions {
  readonly dialect: 'postgres' | 'sqlite'
  /** The queryable columns. Anything else is rejected. */
  readonly columns: Columns
  /** Number of parameters already used before this fragment (`$n` / `?n` numbering). Default 0. */
  readonly paramOffset?: number | undefined
}

export interface SQLQuery {
  /**
   * A boolean SQL expression for a WHERE clause. It is true for exactly the
   * selected records, and may be NULL (not false) for others: negate a
   * filter by translating `!(filter)`, not by wrapping this in NOT.
   */
  readonly sql: string
  readonly params: readonly unknown[]
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

type Primitive = string | number | boolean | Date | null

type Value =
  | { readonly kind: 'column'; readonly field: string; readonly type: ColumnType }
  | { readonly kind: 'const'; readonly value: Primitive }
  | {
      readonly kind: 'arith'
      readonly op: '+' | '-' | '*'
      readonly left: Value
      readonly right: Value
    }

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

const COLUMN_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'boolean', 'timestamp'])

/** The largest distance from the epoch a Date can hold, in milliseconds. */
const MAX_TIME = 8.64e15

/** At most this many names are compared for a "did you mean" hint. */
const MAX_HINT_CANDIDATES = 1000
/** A distance larger than any hint threshold. */
const FAR_APART = 99

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return FAR_APART
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/** `; did you mean "x"?` for the closest candidate, or nothing. */
function hint(name: string, candidates: Iterable<string>): string {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1
  let examined = 0
  for (const candidate of candidates) {
    if (++examined > MAX_HINT_CANDIDATES) break
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best === undefined ? '' : `; did you mean "${best}"?`
}

/** What Bonsai's text function returns for known text. */
function textFunction(op: 'startsWith' | 'endsWith' | 'includes', text: string, needle: string) {
  if (op === 'startsWith') return text.startsWith(needle)
  if (op === 'endsWith') return text.endsWith(needle)
  return text.includes(needle)
}

function kindOf(value: Value): ColumnType | 'null' {
  if (value.kind === 'column') return value.type
  if (value.kind === 'arith') return 'number'
  const v = value.value
  if (v === null) return 'null'
  if (v instanceof Date) return 'timestamp'
  if (typeof v === 'string') return 'text'
  if (typeof v === 'number') return 'number'
  return 'boolean'
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

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    isValidDate(value)
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface Declared {
  readonly field: string
  readonly type: ColumnType
}

const SQL_OPTION_KEYS: readonly string[] = [
  'row',
  'known',
  'now',
  'dialect',
  'columns',
  'paramOffset',
]
const MONGO_OPTION_KEYS: readonly string[] = ['row', 'known', 'now', 'fields']

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
      throw new TypeError(`${what}.${key} must be one of text, number, boolean, timestamp`)
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

/** Partially evaluates the program and lowers the residual to a predicate. */
function lower(
  program: Translatable,
  options: CommonOptions,
  columns: ReadonlyMap<string, Declared>,
  target: Target,
): Pred {
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
      const names = hostRead(() => Object.keys(knownData), 'the known values')
      fail(
        `${name} is neither the row (${options.row}) nor a known value${hint(name, [options.row, ...names])}`,
      )
    }
  }
  const result = program.partial(knownData as never, {
    unknown: [options.row],
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (result.status === 'error') throw result.error
  if (result.status === 'value') {
    if (typeof result.value !== 'boolean' && result.value !== null)
      fail('The predicate does not produce a boolean')
    return { kind: 'const', value: result.value === true }
  }
  const { bindings, hostFunctions } = result
  /** The reason a node does not translate: specific for a host function call. */
  const untranslatable = (node: Node): never =>
    node.type === 'Call' && hostFunctions.includes(node.name)
      ? fail(`${node.name}() is a host function, which has no database equivalent`, node)
      : fail('This expression has no exact database equivalent', node)

  const columnOf = (node: Node): Value | undefined => {
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
  const constOf = (node: Node): Primitive | undefined => {
    if (node.type === 'Literal') return exact(node.value, node)
    if (node.type === 'Variable') {
      const bound = knownValue(node.name)
      if (isPrimitive(bound)) return exact(bound, node)
    }
    return undefined
  }

  const describeName = (node: Node): string => (node.type === 'Variable' ? node.name : 'value')

  const listOf = (node: Node): readonly Primitive[] | undefined => {
    if (node.type === 'List') {
      const out: Primitive[] = []
      for (const item of node.items) {
        const value = item.type === 'Spread' ? undefined : constOf(item)
        if (value === undefined) return undefined
        out.push(value)
      }
      return out
    }
    const items = node.type === 'Variable' ? knownValue(node.name) : undefined
    if (!hostRead(() => Array.isArray(items), `the known list ${describeName(node)}`))
      return undefined
    const list = items as unknown[]
    const out: Primitive[] = []
    // Read by index, as Bonsai reads a list: never through the list's own iterator.
    // A hole, or undefined, reads as null.
    const length = hostRead(() => list.length, `the known list ${describeName(node)}`)
    for (let i = 0; i < length; i++) {
      const item: unknown = hostRead(() => list[i], `the known list ${describeName(node)}`) ?? null
      if (!isPrimitive(item)) return undefined
      out.push(exact(item, node))
    }
    return out
  }

  const value = (node: Node): Value => {
    const column = columnOf(node)
    if (column !== undefined) return column
    const constant = constOf(node)
    if (constant !== undefined) return { kind: 'const', value: constant }
    if (
      node.type === 'Binary' &&
      (node.operator === '+' || node.operator === '-' || node.operator === '*')
    ) {
      if (!target.arithmetic) return fail(`Arithmetic is not translated for ${target.name}`, node)
      const left = value(node.left)
      const right = value(node.right)
      if (kindOf(left) !== 'number' || kindOf(right) !== 'number') {
        return fail(`"${node.operator}" is translated for numbers only`, node)
      }
      return { kind: 'arith', op: node.operator, left, right }
    }
    return untranslatable(node)
  }

  const pair = (left: Value, right: Value, at: Node): void => {
    if (!target.columnPairs && left.kind !== 'const' && right.kind !== 'const')
      fail(`${target.name} queries compare a field with a known value`, at)
  }

  const textArgument = (args: readonly (Node | SpreadNode)[], at: Node): string => {
    const arg = args[1]
    const text = arg === undefined || arg.type === 'Spread' ? undefined : constOf(arg)
    if (typeof text !== 'string' || args.length !== 2)
      return fail('Expected a known string argument', at)
    const problem = target.checkPattern(text)
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
    if (constant instanceof Date) return { kind: 'timestamp', ms: constant.getTime() }
    const bound = node.type === 'Variable' ? knownValue(node.name) : undefined
    return bound instanceof Duration ? { kind: 'duration', ms: bound.ms } : undefined
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
              conditionEquality(node) ?? equality(value(node.left), value(node.right), node)
            return node.operator === '==' ? eq : { kind: 'not', item: eq }
          }
          case '<':
          case '<=':
          case '>':
          case '>=': {
            const shifted = timeOrder(node, node.operator)
            if (shifted !== undefined) return shifted
            const left = value(node.left)
            const right = value(node.right)
            const kinds = [kindOf(left), kindOf(right)]
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
            if (kinds[0] !== kinds[1])
              return fail('Both sides of an ordering must be numbers or both timestamps', node)
            pair(left, right, node)
            return left.kind === 'const'
              ? { kind: 'order', op: FLIP[node.operator], left: right, right: left }
              : { kind: 'order', op: node.operator, left, right }
          }
          case 'in':
          case 'not in': {
            const membership = contains(node.left, node.right, node)
            return node.operator === 'in' ? membership : { kind: 'not', item: membership }
          }
          case '??': {
            const left = nullable(node.left)
            if (left === undefined)
              return fail('"??" is translated after a ?. text call or a boolean field', node)
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
        return textCall(node) ?? fail(`${node.name}() is not translated`, node)
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
        return fail('This expression has no exact database equivalent', node)
    }
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
      // Different kinds are equal only when both are null (b is non-null if constant).
      const isNull = (v: Value): Pred =>
        v.kind === 'const' ? { kind: 'const', value: false } : { kind: 'null', value: v }
      return { kind: 'and', items: [isNull(a), isNull(b)] }
    }
    pair(a, b, at)
    return { kind: 'eq', left: a, right: b }
  }

  const contains = (itemNode: Node, containerNode: Node, at: Node): Pred => {
    const item = value(itemNode)
    const list = listOf(containerNode)
    if (list !== undefined) {
      const kind = kindOf(item)
      const matching = list.filter((entry) => {
        const entryKind = kindOf({ kind: 'const', value: entry })
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
      const problem = target.checkPattern(item.value)
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

/** Whether evaluating the value can fail (arithmetic on null, or a non-finite result). */
function failable(value: Value): boolean {
  return value.kind === 'arith'
}

const tooLarge = (source: string): BonsaiTranslationError =>
  new BonsaiTranslationError('The translated query is too large', source, {
    start: 0,
    end: source.length,
  })

/** SQL text length, and MongoDB filter nodes, above which a translation is rejected. */
const MAX_SQL_LENGTH = 1_000_000
const MAX_MONGO_NODES = 100_000
/** MongoDB rejects longer patterns; this leaves room for the anchors. */
const MAX_MONGO_PATTERN_BYTES = 32_000
/** Most parameters a statement can bind. */
const MAX_PARAMS = { postgres: 65_535, sqlite: 32_766 } as const
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
}

/**
 * Translates a predicate to a SQL WHERE expression.
 *
 * Postgres: columns hold `text`, a numeric type, `boolean`, or `timestamptz`;
 * text comparisons use the C collation. SQLite (UTF-8 databases): columns
 * hold TEXT, REAL or INTEGER numbers, booleans as 0/1, and timestamps as
 * epoch milliseconds, and should be declared STRICT so they cannot hold
 * other types.
 */
export function toSQL(program: Translatable, options: SQLOptions): SQLQuery {
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
  const predicate = lower(
    program,
    options,
    declare(options, options.columns, 'columns', target),
    target,
  )
  const params: unknown[] = []

  const quote = (name: string): string =>
    pg ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll('`', '``')}\``
  const encode = (value: Exclude<Primitive, null>): unknown => {
    if (value instanceof Date) return pg ? value.toISOString() : value.getTime()
    if (typeof value === 'boolean' && !pg) return value ? 1 : 0
    return value
  }
  // Numbered placeholders, so a repeated sub-expression reuses its parameter.
  const placeholder = (encoded: unknown, cast: string): string => {
    params.push(encoded)
    return pg ? `$${offset + params.length}::${cast}` : `?${offset + params.length}`
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
        sql = pg && value.type === 'number' ? `${quote(value.field)}::float8` : quote(value.field)
        break
      case 'const': {
        const kind = kindOf(value)
        sql = value.value === null ? 'NULL' : param(value.value, kind === 'null' ? 'text' : kind)
        break
      }
      case 'arith':
      default:
        sql = `(${operand(value.left)} ${value.op} ${operand(value.right)})`
    }
    rendered.set(value, sql)
    return sql
  }
  // SQLite INTEGER arithmetic is exact past 2^53; Bonsai's (and REAL's) is double.
  const operand = (value: Value): string =>
    !pg && value.kind === 'column' ? `CAST(${val(value)} AS REAL)` : val(value)
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

  const textCondition = (
    op: 'startsWith' | 'endsWith' | 'includes',
    column: string,
    needle: string,
  ): string => {
    if (pg) {
      if (op === 'startsWith') {
        // A prefix LIKE, whose index range Postgres derives in the database's own encoding.
        const like = placeholder(`${needle.replace(LIKE_SPECIAL, (ch) => `\\${ch}`)}%`, 'text')
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
    const end = prefixEnd(needle)
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
          const nonNull = p.list.filter((entry) => entry !== null)
          const parts: string[] = []
          if (nonNull.length > 0) {
            const type = kind === 'null' ? 'text' : kind
            // One array parameter in Postgres, whatever the list's length. Not for booleans:
            // there are only two, and postgres.js cannot send a boolean array.
            if (pg && type !== 'boolean') {
              const array = placeholder(nonNull.map(encode), `${PG_CASTS[type]}[]`)
              parts.push(`${typed(p.value)} = ANY(${array})`)
            } else {
              const entries = [...new Set(nonNull)].map((entry) => param(entry, type))
              parts.push(`${typed(p.value)} IN (${entries.join(', ')})`)
            }
          }
          if (nonNull.length !== p.list.length) parts.push(`${val(p.value)} IS NULL`)
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

  const sql = algebra.guard(dual(predicate, algebra).t)
  if (offset + params.length > MAX_PARAMS[dialect]) {
    throw new BonsaiTranslationError(
      `The translated query needs more than ${MAX_PARAMS[dialect]} parameters`,
      program.source,
      { start: 0, end: program.source.length },
    )
  }
  return { sql, params }
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
  checkKeys(options, MONGO_OPTION_KEYS, 'toMongo')
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
  const predicate = lower(
    program,
    options,
    declare(options, isRecord(options) ? options.fields : undefined, 'fields', target),
    target,
  )
  type Filter = Record<string, unknown>
  // lower() only leaves field-versus-constant comparisons for MongoDB.
  const field = (value: Value): string => (value as { field: string }).field
  const constant = (value: Value): Primitive => (value as { value: Primitive }).value

  const sizes = new WeakMap<object, number>()
  /** Filter nodes counted with repeats: what the driver serializes. */
  const size = (item: unknown): number => {
    if (typeof item !== 'object' || item === null || item instanceof Date) return 1
    let total = sizes.get(item)
    if (total === undefined) {
      total = 1
      for (const child of Object.values(item)) total += size(child)
      sizes.set(item, total)
    }
    return total
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
          return safe(
            p.list.length === 0 ? { $expr: false } : { [field(p.value)]: { $in: [...p.list] } },
          )
        case 'truthy':
          return safe({ [field(p.column)]: { $eq: true } })
        case 'text':
        case 'within':
        default: {
          const { op, text, nullFails } = p as Extract<Leaf, { kind: 'text' }>
          const body = escapeRegex(text)
          // `$` alone also matches before a final newline; the lookahead does not.
          let pattern = body
          if (op === 'startsWith') pattern = `^${body}`
          else if (op === 'endsWith') pattern = `${body}$(?![\\s\\S])`
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
