import type { Duration } from './runtime/values.js'

/**
 * The static type vocabulary. Types are plain JSON-serializable objects so a
 * schema can be stored, sent to an editor, or generated from another schema
 * language.
 */
export type Type =
  | AnyType
  | NeverType
  | NullType
  | BooleanType
  | NumberType
  | StringType
  | TimestampType
  | DurationType
  | LiteralType
  | ListType
  | MapType
  | UnionType
  | OpaqueType
  | FunctionType
  | TypeVar

export interface AnyType {
  readonly kind: 'any'
}
export interface NeverType {
  readonly kind: 'never'
}
export interface NullType {
  readonly kind: 'null'
}
export interface BooleanType {
  readonly kind: 'boolean'
}
export interface NumberType {
  readonly kind: 'number'
}
export interface StringType {
  readonly kind: 'string'
}
export interface TimestampType {
  readonly kind: 'timestamp'
}
export interface DurationType {
  readonly kind: 'duration'
}
export interface LiteralType<V extends string | number | boolean = string | number | boolean> {
  readonly kind: 'literal'
  readonly value: V
}
export interface ListType<E extends Type = Type> {
  readonly kind: 'list'
  readonly element: E
}
/**
 * A string-keyed record. `fields` are the known keys; `rest` types any other
 * key (an open record). Without `rest`, reading an unknown key is a check error.
 */
export interface MapType<
  F extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
  R extends Type | undefined = Type | undefined,
> {
  readonly kind: 'map'
  readonly fields: F
  readonly rest?: R
}
export interface UnionType<M extends readonly Type[] = readonly Type[]> {
  readonly kind: 'union'
  readonly types: M
}
/**
 * A value the host declares as not navigable. The checker rejects property
 * access on it; at run time objects are read through their own properties.
 */
export interface OpaqueType<N extends string = string> {
  readonly kind: 'opaque'
  readonly name: N
}
/** Only lambdas have function types; they cannot be stored in values. */
export interface FunctionType {
  readonly kind: 'function'
  readonly params: readonly Type[]
  readonly result: Type
}
/** A type variable in a built-in signature, e.g. `T` in `first(list<T>): T?`. */
export interface TypeVar {
  readonly kind: 'var'
  readonly name: string
}

const ANY: AnyType = Object.freeze({ kind: 'any' })
const NEVER: NeverType = Object.freeze({ kind: 'never' })
const NULL: NullType = Object.freeze({ kind: 'null' })
const BOOLEAN: BooleanType = Object.freeze({ kind: 'boolean' })
const NUMBER: NumberType = Object.freeze({ kind: 'number' })
const STRING: StringType = Object.freeze({ kind: 'string' })
const TIMESTAMP: TimestampType = Object.freeze({ kind: 'timestamp' })
const DURATION: DurationType = Object.freeze({ kind: 'duration' })

/** Type builders. */
export const t = Object.freeze({
  any: (): AnyType => ANY,
  never: (): NeverType => NEVER,
  null: (): NullType => NULL,
  boolean: (): BooleanType => BOOLEAN,
  number: (): NumberType => NUMBER,
  string: (): StringType => STRING,
  timestamp: (): TimestampType => TIMESTAMP,
  duration: (): DurationType => DURATION,
  literal: <const V extends string | number | boolean>(value: V): LiteralType<V> =>
    Object.freeze({ kind: 'literal', value }),
  /** A union of literals: `t.enum('free', 'pro')`. */
  enum: <const V extends readonly (string | number | boolean)[]>(
    ...values: V
  ): UnionType<{ [K in keyof V]: LiteralType<V[K]> }> =>
    Object.freeze({
      kind: 'union',
      types: Object.freeze(values.map((value) => Object.freeze({ kind: 'literal', value }))),
    }) as unknown as UnionType<{ [K in keyof V]: LiteralType<V[K]> }>,
  list: <E extends Type>(element: E): ListType<E> => Object.freeze({ kind: 'list', element }),
  /** A closed record with known fields. */
  object: <const F extends Readonly<Record<string, Type>>>(fields: F): MapType<F, undefined> =>
    Object.freeze({ kind: 'map', fields: Object.freeze({ ...fields }) }),
  /** An open record: every key has type `value`. */
  record: <V extends Type>(value: V): MapType<Record<never, never>, V> =>
    Object.freeze({ kind: 'map', fields: Object.freeze({}), rest: value }),
  union: <const M extends readonly Type[]>(...types: M): UnionType<M> =>
    Object.freeze({ kind: 'union', types: Object.freeze([...types]) as unknown as M }),
  /** `T | null`. Absent keys read as null, so this also marks a field optional. */
  optional: <T extends Type>(type: T): UnionType<readonly [T, NullType]> =>
    Object.freeze({ kind: 'union', types: Object.freeze([type, NULL] as const) }),
  opaque: <const N extends string>(name: N): OpaqueType<N> =>
    Object.freeze({ kind: 'opaque', name }),
})

// === TypeScript inference from schemas ===

type Simplify<T> = { [K in keyof T]: T[K] }

type NullableKeys<F> = {
  [K in keyof F]: null extends Infer<F[K]> ? K : never
}[keyof F]

interface PrimitiveTypes {
  any: unknown
  never: never
  null: null
  boolean: boolean
  number: number
  string: string
  timestamp: Date
  duration: Duration
  opaque: unknown
  function: unknown
  var: unknown
}

type InferMap<F, R> = Simplify<
  { readonly [K in Exclude<keyof F, NullableKeys<F>>]: Infer<F[K]> } & {
    readonly [K in NullableKeys<F>]?: Infer<F[K]> | undefined
  } & (R extends Type ? { readonly [key: string]: Infer<R> } : unknown)
>

/** The TypeScript type of values described by a Bonsai type. */
export type Infer<T> = [Type] extends [T]
  ? unknown
  : T extends { readonly kind: 'literal'; readonly value: infer V }
    ? V
    : T extends { readonly kind: 'list'; readonly element: infer E }
      ? readonly Infer<E>[]
      : T extends { readonly kind: 'map'; readonly fields: infer F; readonly rest?: infer R }
        ? InferMap<F, R>
        : T extends { readonly kind: 'union'; readonly types: infer M extends readonly unknown[] }
          ? Infer<M[number]>
          : T extends { readonly kind: infer K extends keyof PrimitiveTypes }
            ? PrimitiveTypes[K]
            : unknown

/** The context type of a variable declaration record. */
export type InferVariables<V> = Simplify<
  { readonly [K in Exclude<keyof V, NullableKeys<V>>]: Infer<V[K]> } & {
    readonly [K in NullableKeys<V>]?: Infer<V[K]> | undefined
  }
>

// === Type operations ===

export function isNullable(type: Type): boolean {
  switch (type.kind) {
    case 'any':
    case 'null':
      return true
    case 'union':
      return type.types.some(isNullable)
    case 'boolean':
    case 'duration':
    case 'function':
    case 'list':
    case 'literal':
    case 'map':
    case 'never':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    case 'var':
    default:
      return false
  }
}

/** The declared type of `key` in a map type (own fields only, never prototype names). */
export function fieldOf(type: MapType, key: string): Type | undefined {
  return Object.hasOwn(type.fields, key) ? type.fields[key] : undefined
}

/** Removes `null` from a type. */
export function nonNull(type: Type): Type {
  if (type.kind === 'null') return NEVER
  if (type.kind === 'union') return unionOf(type.types.map(nonNull))
  return type
}

/** The base kind a literal widens to. */
export function widen(type: Type): Type {
  if (type.kind === 'literal') {
    if (typeof type.value === 'string') return STRING
    return typeof type.value === 'number' ? NUMBER : BOOLEAN
  }
  if (type.kind === 'union') return unionOf(type.types.map(widen))
  return type
}

function sameType(a: Type, b: Type): boolean {
  return a === b || typeKey(a) === typeKey(b)
}

/** A canonical string for de-duplication. */
export function typeKey(type: Type): string {
  switch (type.kind) {
    case 'literal':
      return `lit:${typeof type.value}:${String(type.value)}`
    case 'list':
      return `list<${typeKey(type.element)}>`
    case 'map':
      return `map{${Object.keys(type.fields)
        .sort()
        .map((k) => `${k}:${typeKey(type.fields[k])}`)
        .join(',')}}${type.rest ? `[${typeKey(type.rest)}]` : ''}`
    case 'union':
      return `(${type.types.map(typeKey).sort().join('|')})`
    case 'opaque':
      return `opaque:${type.name}`
    case 'function':
      return `fn(${type.params.map(typeKey).join(',')})=>${typeKey(type.result)}`
    case 'var':
      return `var:${type.name}`
    case 'any':
    case 'boolean':
    case 'duration':
    case 'never':
    case 'null':
    case 'number':
    case 'string':
    case 'timestamp':
    default:
      return type.kind
  }
}

/** Flattens, de-duplicates, and simplifies a union. */
export function unionOf(types: readonly Type[]): Type {
  const flat: Type[] = []
  const visit = (type: Type): void => {
    if (type.kind === 'union') type.types.forEach(visit)
    else if (type.kind !== 'never') flat.push(type)
  }
  types.forEach(visit)
  if (flat.some((type) => type.kind === 'any')) return ANY
  const out: Type[] = []
  for (const type of flat) {
    if (out.some((existing) => sameType(existing, type))) continue
    // A literal next to its own base kind is redundant.
    if (type.kind === 'literal' && flat.some((other) => other.kind === widen(type).kind)) continue
    out.push(type)
  }
  if (out.length === 0) return NEVER
  if (out.length === 1) return out[0]
  return Object.freeze({ kind: 'union', types: Object.freeze(out) })
}

/** Whether every value of `source` is a valid `target` (gradual: `any` both ways). */
export function isAssignable(source: Type, target: Type): boolean {
  if (source.kind === 'any' || target.kind === 'any' || source.kind === 'never') return true
  if (target.kind === 'var' || source.kind === 'var') return true
  if (source.kind === 'union') return source.types.every((member) => isAssignable(member, target))
  if (target.kind === 'union') return target.types.some((member) => isAssignable(source, member))
  switch (target.kind) {
    case 'literal':
      return source.kind === 'literal' && source.value === target.value
    case 'list':
      return source.kind === 'list' && isAssignable(source.element, target.element)
    case 'map': {
      if (source.kind !== 'map') return false
      for (const [key, fieldType] of Object.entries(target.fields)) {
        const sourceField = fieldOf(source, key) ?? source.rest
        if (sourceField === undefined) {
          if (!isNullable(fieldType)) return false
        } else if (!isAssignable(sourceField, fieldType)) return false
      }
      if (target.rest !== undefined) {
        for (const fieldType of Object.values(source.fields)) {
          if (!isAssignable(fieldType, target.rest)) return false
        }
        if (source.rest !== undefined && !isAssignable(source.rest, target.rest)) return false
      }
      return true
    }
    case 'opaque':
      return source.kind === 'opaque' && source.name === target.name
    case 'function':
      return source.kind === 'function'
    case 'boolean':
    case 'duration':
    case 'never':
    case 'null':
    case 'number':
    case 'string':
    case 'timestamp':
    default:
      return (
        source.kind === target.kind ||
        (source.kind === 'literal' && widen(source).kind === target.kind)
      )
  }
}

/** Whether two types can hold a common value (used for always-false comparisons). */
export function overlaps(a: Type, b: Type): boolean {
  if (a.kind === 'any' || b.kind === 'any' || a.kind === 'var' || b.kind === 'var') return true
  if (a.kind === 'union') return a.types.some((member) => overlaps(member, b))
  if (b.kind === 'union') return b.types.some((member) => overlaps(a, member))
  if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value
  return widen(a).kind === widen(b).kind
}

/** Human-readable type text, e.g. `{ name: string, tags: string[] } | null`. */
export function formatType(type: Type): string {
  switch (type.kind) {
    case 'literal':
      return JSON.stringify(type.value)
    case 'list': {
      const inner = formatType(type.element)
      return type.element.kind === 'union' || type.element.kind === 'function'
        ? `(${inner})[]`
        : `${inner}[]`
    }
    case 'map': {
      const entries = Object.entries(type.fields).map(
        ([k, v]) => `${/^[A-Za-z_$][\w$]*$/u.test(k) ? k : JSON.stringify(k)}: ${formatType(v)}`,
      )
      if (type.rest !== undefined) entries.push(`[key: string]: ${formatType(type.rest)}`)
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
    }
    case 'union':
      return type.types.map(formatType).join(' | ')
    case 'opaque':
      return type.name
    case 'function':
      return `(${type.params.map(formatType).join(', ')}) => ${formatType(type.result)}`
    case 'var':
      return type.name
    case 'any':
    case 'boolean':
    case 'duration':
    case 'never':
    case 'null':
    case 'number':
    case 'string':
    case 'timestamp':
    default:
      return type.kind
  }
}
