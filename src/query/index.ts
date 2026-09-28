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
import type { Node, SpreadNode } from '../syntax/ast.js'

/** A compiled program (from `env.compile`) whose predicate is translated. */
export interface Translatable {
  readonly source: string
  partial: (known: never, options?: PartialOptions) => PartialResult<unknown>
}

export type ColumnType = 'text' | 'number' | 'boolean' | 'timestamp'

export interface Column {
  readonly type: ColumnType
  /** The column (SQL) or field path (MongoDB) name, when it differs from the key. */
  readonly name?: string
}

/** Declared record fields, keyed by the path after the row variable (`status`, `address.city`). */
export type Columns = Readonly<Record<string, ColumnType | Column>>

interface CommonOptions {
  /** The variable that names the record being filtered, e.g. `order`. */
  readonly row: string
  /** Values for every other variable the predicate reads. */
  readonly known?: Readonly<Record<string, unknown>>
  /** The time `now()` returns. Required when the predicate calls now(). */
  readonly now?: Date
}

export interface SQLOptions extends CommonOptions {
  readonly dialect: 'postgres' | 'sqlite'
  /** The queryable columns. Anything else is rejected. */
  readonly columns: Columns
  /** Number of parameters already used before this fragment (`$n` / `?n` numbering). Default 0. */
  readonly paramOffset?: number
}

export interface SQLQuery {
  /** A boolean SQL expression for a WHERE clause. */
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

type Value =
  | { readonly kind: 'column'; readonly field: string; readonly type: ColumnType }
  | { readonly kind: 'const'; readonly value: string | number | boolean | Date | null }
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
  | {
      readonly kind: 'in'
      readonly value: Value
      readonly list: readonly (string | number | boolean | Date | null)[]
    }
  | {
      readonly kind: 'text'
      readonly op: 'startsWith' | 'endsWith' | 'includes'
      readonly column: Value
      readonly text: string
      /** Method calls fail on a null column; `"x" in column` is false instead. */
      readonly nullFails: boolean
    }
  | { readonly kind: 'within'; readonly column: Value; readonly text: string }
  | { readonly kind: 'truthy'; readonly column: Value }

type Primitive = string | number | boolean | Date | null

const FLIP: Readonly<Record<'<' | '<=' | '>' | '>=', '<' | '<=' | '>' | '>='>> = {
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
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

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (value instanceof Date && !Number.isNaN(value.getTime()))
  )
}

/** Partially evaluates the program and lowers the residual to a predicate. */
function lower(program: Translatable, options: CommonOptions, columns: Columns): Pred {
  const source = program.source
  const fail = (message: string, at?: Span): never => {
    throw new BonsaiTranslationError(
      message,
      source,
      at === undefined ? undefined : { start: at.start, end: at.end },
    )
  }
  const result = program.partial((options.known ?? {}) as never, {
    unknown: [options.row],
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (result.status === 'error') throw result.error
  if (result.status === 'value') {
    if (typeof result.value !== 'boolean' && result.value !== null)
      fail('The predicate does not produce a boolean')
    return { kind: 'const', value: result.value === true }
  }
  const bindings = result.bindings

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
    if (!Object.hasOwn(columns, key)) {
      return fail(`${options.row}.${key} is not a declared column`, node)
    }
    const column = columns[key]
    const declared = typeof column === 'string' ? { type: column } : column
    const field = declared.name ?? key
    if (field === '' || field.includes('\0')) return fail(`The column name for ${key} is not valid`)
    return { kind: 'column', field, type: declared.type }
  }

  /** Checks a constant the database must see exactly as Bonsai does. */
  const exact = (constant: Primitive, at: Node): Primitive => {
    if (typeof constant === 'string' && LONE_SURROGATE.test(constant))
      return fail('Text containing a lone surrogate cannot be sent to the database', at)
    // Read Date subclasses the way Bonsai compares them: by time.
    return constant instanceof Date ? new Date(Date.prototype.getTime.call(constant)) : constant
  }

  const knownValue = (name: string): unknown => {
    if (Object.hasOwn(bindings, name)) return bindings[name]
    const knownData = options.known ?? {}
    return name !== options.row && Object.hasOwn(knownData, name) ? knownData[name] : undefined
  }
  const constOf = (node: Node): Primitive | undefined => {
    if (node.type === 'Literal') return exact(node.value, node)
    if (node.type === 'Variable') {
      const bound = knownValue(node.name)
      if (isPrimitive(bound)) return exact(bound, node)
    }
    return undefined
  }

  const listOf = (node: Node): readonly Primitive[] | undefined => {
    let items: unknown
    if (node.type === 'List') {
      const out: Primitive[] = []
      for (const item of node.items) {
        const value = item.type === 'Spread' ? undefined : constOf(item)
        if (value === undefined) return undefined
        out.push(value)
      }
      return out
    }
    if (node.type === 'Variable') items = knownValue(node.name)
    if (!Array.isArray(items) || !items.every(isPrimitive)) return undefined
    return items.map((item) => exact(item, node))
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
      const left = value(node.left)
      const right = value(node.right)
      if (kindOf(left) !== 'number' || kindOf(right) !== 'number') {
        return fail(`"${node.operator}" is translated for numbers only`, node)
      }
      return { kind: 'arith', op: node.operator, left, right }
    }
    return fail('This expression has no exact database equivalent', node)
  }

  const textArgument = (args: readonly (Node | SpreadNode)[], at: Node): string => {
    const arg = args[1]
    const text = arg === undefined || arg.type === 'Spread' ? undefined : constOf(arg)
    if (typeof text !== 'string' || args.length !== 2)
      return fail('Expected a known string argument', at)
    return text
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
            const eq = equality(value(node.left), value(node.right))
            return node.operator === '==' ? eq : { kind: 'not', item: eq }
          }
          case '<':
          case '<=':
          case '>':
          case '>=': {
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
            return left.kind === 'const'
              ? { kind: 'order', op: FLIP[node.operator], left: right, right: left }
              : { kind: 'order', op: node.operator, left, right }
          }
          case 'in':
          case 'not in': {
            const membership = contains(node.left, node.right, node)
            return node.operator === 'in' ? membership : { kind: 'not', item: membership }
          }
          case '%':
          case '*':
          case '**':
          case '+':
          case '-':
          case '/':
          case '??':
          default:
            return fail(`"${node.operator}" is not translated in a condition`, node)
        }
      case 'Member': {
        const column = columnOf(node)
        if (column?.kind === 'column' && column.type === 'boolean')
          return { kind: 'truthy', column }
        return fail('Only boolean columns can be used as conditions', node)
      }
      case 'Call': {
        const receiver = node.args[0]
        const column =
          receiver === undefined || receiver.type === 'Spread' ? undefined : columnOf(receiver)
        if (
          column?.kind === 'column' &&
          column.type === 'text' &&
          (node.name === 'startsWith' || node.name === 'endsWith' || node.name === 'includes')
        ) {
          return {
            kind: 'text',
            op: node.name,
            column,
            text: textArgument(node.args, node),
            // `?.` gives null on a null receiver, which a condition reads as false.
            nullFails: !node.optional,
          }
        }
        return fail(`${node.name}() is not translated`, node)
      }
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

  const equality = (left: Value, right: Value): Pred => {
    const [a, b] = left.kind === 'const' && right.kind !== 'const' ? [right, left] : [left, right]
    const ka = kindOf(a)
    const kb = kindOf(b)
    if (kb === 'null')
      return ka === 'null' ? { kind: 'const', value: true } : { kind: 'null', value: a }
    if (ka === 'null') return { kind: 'null', value: b }
    if (ka !== kb) {
      // Different kinds are equal only when both are null.
      return {
        kind: 'and',
        items: [
          { kind: 'null', value: a },
          { kind: 'null', value: b },
        ],
      }
    }
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
      return { kind: 'within', column: item, text: container }
    }
    const containerColumn = columnOf(containerNode)
    if (
      containerColumn?.kind === 'column' &&
      containerColumn.type === 'text' &&
      item.kind === 'const' &&
      typeof item.value === 'string'
    ) {
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
 * A predicate as two queries: `t` selects records where it is true, `f` where
 * it is false. Records where evaluation would fail match neither. `safe`
 * predicates cannot fail, so `f` is simply the negation of `t`.
 */
interface Dual<S> {
  readonly t: S
  readonly f: S
  readonly safe: boolean
}

interface Algebra<S> {
  readonly TRUE: S
  readonly FALSE: S
  readonly and: (items: readonly S[]) => S
  readonly or: (items: readonly S[]) => S
  readonly not: (item: S) => S
  /** Rejects a query that has grown too large (a failing `&&` or `||` repeats its left side). */
  readonly guard: (item: S) => S
  readonly leaf: (p: Exclude<Pred, { kind: 'const' | 'and' | 'or' | 'not' }>) => {
    t: S
    safe: boolean
    f?: S
  }
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
    case 'text':
    case 'truthy':
    case 'within':
    default: {
      const leaf = algebra.leaf(p)
      return { t: leaf.t, f: leaf.f ?? algebra.not(leaf.t), safe: leaf.safe }
    }
  }
}

/** Whether evaluating the value can fail (arithmetic on null, or a non-finite result). */
function failable(value: Value): boolean {
  return value.kind === 'arith'
}

const tooLarge = (source: string): BonsaiTranslationError =>
  new BonsaiTranslationError('The translated query is too large', source)

/** SQL text length, and MongoDB filter nodes, above which a translation is rejected. */
const MAX_SQL_LENGTH = 1_000_000
const MAX_MONGO_NODES = 100_000
/** Most parameters a statement can bind. */
const MAX_PARAMS = { postgres: 65_535, sqlite: 32_766 } as const
/** The last year Postgres reads from an ISO timestamp (years with more digits use `+YYYYYY`). */
const MAX_PG_YEAR = 9999

// === SQL ===

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
 * text comparisons use the C collation. SQLite: columns hold TEXT, REAL or
 * INTEGER numbers, booleans as 0/1, and timestamps as epoch milliseconds, and
 * should be declared STRICT so they cannot hold other types.
 */
export function toSQL(program: Translatable, options: SQLOptions): SQLQuery {
  const predicate = lower(program, options, options.columns)
  const pg = options.dialect === 'postgres'
  const params: unknown[] = []
  const offset = options.paramOffset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError('paramOffset must be a non-negative integer')

  const quote = (name: string): string =>
    pg ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll('`', '``')}\``
  const param = (value: Primitive, type: ColumnType): string => {
    if (typeof value === 'string' && value.includes('\0')) {
      throw new BonsaiTranslationError(
        'Text containing a NUL character cannot be sent to the database',
        program.source,
      )
    }
    let encoded: unknown = value
    if (value instanceof Date) {
      const year = value.getUTCFullYear()
      if (pg && (year < 1 || year > MAX_PG_YEAR)) {
        throw new BonsaiTranslationError(
          'Postgres timestamps are translated for the years 0001 to 9999',
          program.source,
        )
      }
      encoded = pg ? value.toISOString() : value.getTime()
    } else if (typeof value === 'boolean' && !pg) encoded = value ? 1 : 0
    params.push(encoded)
    // Numbered placeholders: a translated condition may repeat a sub-expression.
    return pg ? `$${offset + params.length}::${PG_CASTS[type]}` : `?${offset + params.length}`
  }
  const text = (sql: string): string => (pg ? `(${sql} COLLATE "C")` : sql)
  const TRUE = pg ? 'TRUE' : '1'
  const FALSE = pg ? 'FALSE' : '0'
  const two = (sql: string): string => `COALESCE(${sql}, ${FALSE})`

  const val = (value: Value): string => {
    switch (value.kind) {
      case 'column':
        return pg && value.type === 'number' ? `${quote(value.field)}::float8` : quote(value.field)
      case 'const': {
        const kind = kindOf(value)
        return value.value === null ? 'NULL' : param(value.value, kind === 'null' ? 'text' : kind)
      }
      case 'arith':
      default:
        return `(${operand(value.left)} ${value.op} ${operand(value.right)})`
    }
  }
  // SQLite INTEGER arithmetic is exact past 2^53; Bonsai's (and REAL's) is double.
  const operand = (value: Value): string =>
    !pg && value.kind === 'column' ? `CAST(${val(value)} AS REAL)` : val(value)
  /** Byte-wise SQLite text, so text holding NUL is read whole. UTF-8 matches by code point. */
  const bytes = (sql: string): string => `CAST(${sql} AS BLOB)`
  const INFINITY = pg ? `'Infinity'::float8` : '9e999'
  const typed = (value: Value): string => (kindOf(value) === 'text' ? text(val(value)) : val(value))

  /**
   * SQL that is true when evaluating arithmetic in the values would fail: a
   * null operand makes the result null, and a non-finite result stays
   * non-finite (or NaN, which SQLite reads as null) through later operations.
   */
  const fails = (...values: Value[]): string | undefined => {
    const parts = values
      .filter(failable)
      .map((value) => `COALESCE(NOT (abs(${val(value)}) < ${INFINITY}), ${TRUE})`)
    return parts.length === 0 ? undefined : `(${parts.join(' OR ')})`
  }
  /** A comparison leaf: false when a plain operand is null, failing when arithmetic would fail. */
  const compare = (
    condition: string,
    ...values: Value[]
  ): { t: string; f: string; safe: boolean } => {
    const failure = values.some(failable) ? fails(...values) : undefined
    if (failure === undefined)
      return { t: two(condition), f: `(NOT ${two(condition)})`, safe: true }
    return {
      t: `((NOT ${failure}) AND ${two(condition)})`,
      f: `((NOT ${failure}) AND NOT ${two(condition)})`,
      safe: false,
    }
  }

  const algebra: Algebra<string> = {
    TRUE,
    FALSE,
    and: (items) => `(${items.join(' AND ')})`,
    or: (items) => `(${items.join(' OR ')})`,
    not: (item) => `(NOT ${item})`,
    guard: (item) => {
      if (item.length > MAX_SQL_LENGTH) throw tooLarge(program.source)
      return item
    },
    leaf: (p) => {
      switch (p.kind) {
        case 'null':
          return compare(`${val(p.value)} IS NULL`, p.value)
        case 'eq':
          if (p.right.kind === 'const' || p.left.kind === 'const') {
            return compare(`${typed(p.left)} = ${typed(p.right)}`, p.left, p.right)
          }
          return compare(
            pg
              ? `${typed(p.left)} IS NOT DISTINCT FROM ${typed(p.right)}`
              : `${typed(p.left)} IS ${typed(p.right)}`,
            p.left,
            p.right,
          )
        case 'order':
          return compare(`${val(p.left)} ${p.op} ${val(p.right)}`, p.left, p.right)
        case 'in': {
          const kind = kindOf(p.value)
          const nonNull = p.list.filter((entry) => entry !== null)
          const parts: string[] = []
          if (nonNull.length > 0) {
            const entries = nonNull.map((entry) => {
              const placeholder = param(entry, kind === 'null' ? 'text' : kind)
              return kind === 'text' ? text(placeholder) : placeholder
            })
            parts.push(`${typed(p.value)} IN (${entries.join(', ')})`)
          }
          if (nonNull.length !== p.list.length) parts.push(`${val(p.value)} IS NULL`)
          return compare(parts.length === 0 ? FALSE : `(${parts.join(' OR ')})`, p.value)
        }
        case 'truthy':
          return { t: two(pg ? val(p.column) : `${val(p.column)} = 1`), safe: true }
        case 'text': {
          // Calling a text function on null fails, so null matches neither side.
          const column = val(p.column)
          let condition: string
          if (p.text === '') condition = TRUE
          else if (pg) {
            const needle = param(p.text, 'text')
            if (p.op === 'includes') condition = `strpos(${text(column)}, ${needle}) > 0`
            else {
              const cut = p.op === 'startsWith' ? 'left' : 'right'
              condition = `${cut}(${column}, char_length(${needle})) = ${text(needle)}`
            }
          } else {
            const needle = bytes(param(p.text, 'text'))
            if (p.op === 'includes') condition = `instr(${bytes(column)}, ${needle}) > 0`
            else {
              condition =
                p.op === 'startsWith'
                  ? `substr(${bytes(column)}, 1, length(${needle})) = ${needle}`
                  : `substr(${bytes(column)}, -length(${needle})) = ${needle}`
            }
          }
          const t = `((${column} IS NOT NULL) AND ${two(condition)})`
          if (!p.nullFails) return { t, safe: true }
          return { t, f: `((${column} IS NOT NULL) AND NOT ${two(condition)})`, safe: false }
        }
        case 'within':
        default: {
          const column = val(p.column)
          const haystack = param(p.text, 'text')
          const condition = pg
            ? `strpos(${text(haystack)}, ${text(column)}) > 0`
            : `instr(${bytes(haystack)}, ${bytes(column)}) > 0`
          return {
            t: `((${column} IS NOT NULL) AND ${two(condition)})`,
            f: `((${column} IS NOT NULL) AND NOT ${two(condition)})`,
            safe: false,
          }
        }
      }
    },
  }

  const sql = dual(predicate, algebra).t
  if (offset + params.length > MAX_PARAMS[options.dialect]) {
    throw new BonsaiTranslationError(
      `The translated query needs more than ${MAX_PARAMS[options.dialect]} parameters`,
      program.source,
    )
  }
  return { sql, params }
}

// === MongoDB ===

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/gu

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, (ch) => `\\${ch}`)
}

/**
 * Translates a predicate to a MongoDB filter. Fields must hold the declared
 * scalar types (not arrays); pass `options` to find() so string comparison
 * is binary whatever the collection's default collation.
 */
export function toMongo(program: Translatable, options: MongoOptions): MongoQuery {
  const predicate = lower(program, options, options.fields)
  const fail = (message: string): never => {
    throw new BonsaiTranslationError(message, program.source)
  }
  const field = (value: Value): string => {
    if (value.kind !== 'column') return fail('MongoDB queries compare a field with a known value')
    if (value.field.startsWith('$') || value.field.split('.').includes(''))
      return fail(`${value.field} is not a valid MongoDB field path`)
    return value.field
  }
  const constant = (value: Value): Primitive =>
    value.kind === 'const'
      ? value.value
      : fail('MongoDB queries compare a field with a known value')
  type Filter = Record<string, unknown>
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

  const algebra: Algebra<Filter> = {
    TRUE: {},
    FALSE: { $expr: false },
    and: (items) => ({ $and: [...items] }),
    or: (items) => ({ $or: [...items] }),
    not: (item) => ({ $nor: [item] }),
    guard: (item) => {
      if (size(item) > MAX_MONGO_NODES) throw tooLarge(program.source)
      return item
    },
    leaf: (p) => {
      const values =
        p.kind === 'eq' || p.kind === 'order'
          ? [p.left, p.right]
          : [p.kind === 'null' || p.kind === 'in' ? p.value : p.column]
      if (values.some(failable)) return fail('Arithmetic is not translated for MongoDB')
      switch (p.kind) {
        case 'null':
          return { t: { [field(p.value)]: { $eq: null } }, safe: true }
        case 'eq':
          return { t: { [field(p.left)]: { $eq: constant(p.right) } }, safe: true }
        case 'order': {
          const op = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' }[p.op]
          return { t: { [field(p.left)]: { [op]: constant(p.right) } }, safe: true }
        }
        case 'in':
          return p.list.length === 0
            ? { t: { $expr: false }, safe: true }
            : { t: { [field(p.value)]: { $in: [...p.list] } }, safe: true }
        case 'truthy':
          return { t: { [field(p.column)]: { $eq: true } }, safe: true }
        case 'text': {
          if (p.text.includes('\0')) return fail('MongoDB patterns cannot contain a NUL character')
          const body = escapeRegex(p.text)
          // `$` alone also matches before a final newline; the lookahead does not.
          let pattern = body
          if (p.op === 'startsWith') pattern = `^${body}`
          else if (p.op === 'endsWith') pattern = `${body}$(?![\\s\\S])`
          const name = field(p.column)
          // Calling a text function on null fails, so null matches neither side.
          const t = { [name]: { $regex: pattern } }
          if (!p.nullFails) return { t, safe: true }
          return {
            t,
            f: {
              $and: [{ [name]: { $type: 'string' } }, { [name]: { $not: { $regex: pattern } } }],
            },
            safe: false,
          }
        }
        case 'within':
        default:
          return fail('"field in text" is not translated for MongoDB')
      }
    },
  }

  return { filter: dual(predicate, algebra).t, options: { collation: { locale: 'simple' } } }
}
