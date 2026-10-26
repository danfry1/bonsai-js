// The playground's Query view: a true-or-false rule over one record, as a
// SQL WHERE clause or a MongoDB filter. The record is a variable holding an
// object; its fields (nested ones as `address.city`) become the columns, and
// every other variable is known, so its value folds into the query.
import { toMongo, toSQL, type Columns, type ColumnType, type Translatable } from '../../../../../src/query/index.ts'
import type { Type } from '../../../../../src/index.ts'

const COLUMN: Partial<Record<Type['kind'], ColumnType>> = {
  string: 'text',
  number: 'number',
  boolean: 'boolean',
  timestamp: 'timestamp',
  duration: 'duration',
}

/** An optional type's value type: `string | null` is `string`. */
function present(type: Type): Type {
  if (type.kind !== 'union') return type
  const rest = type.types.filter((member) => member.kind !== 'null')
  return rest.length === 1 ? rest[0]! : type
}

/** The columns of a record type: each scalar field, nested objects flattened to dotted paths. */
export function columnsOf(type: Type, prefix = ''): Record<string, ColumnType> {
  const record = present(type)
  if (record.kind !== 'map') return {}
  const out: Record<string, ColumnType> = {}
  for (const [name, field] of Object.entries(record.fields)) {
    const inner = present(field)
    const column = COLUMN[inner.kind]
    if (column) out[`${prefix}${name}`] = column
    else Object.assign(out, columnsOf(inner, `${prefix}${name}.`))
  }
  return out
}

/** The variables a rule reads that could be the record it filters: those holding an object with fields. */
export function recordsOf(program: Translatable, variables: Readonly<Record<string, Type>>): string[] {
  return program.references.variables.filter((name) => {
    const type = variables[name]
    return type !== undefined && Object.keys(columnsOf(type)).length > 0
  })
}

export type Dialect = 'sqlite' | 'postgres' | 'mongodb'

export type Query =
  | { ok: true; text: string; values: unknown[]; columns: Columns }
  | { ok: false; message: string }

export function translate(
  program: Translatable,
  row: string,
  dialect: Dialect,
  variables: Readonly<Record<string, Type>>,
  context: Readonly<Record<string, unknown>>,
  now: Date,
): Query {
  const columns = columnsOf(variables[row]!)
  const known = Object.fromEntries(Object.entries(context).filter(([name]) => name !== row))
  try {
    if (dialect === 'mongodb') {
      const { filter } = toMongo(program, { row, fields: columns, known, now })
      return { ok: true, text: JSON.stringify(filter, null, 2), values: [], columns }
    }
    const { sql, params } = toSQL(program, { row, columns, known, now, dialect })
    return { ok: true, text: sql, values: params, columns }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}
