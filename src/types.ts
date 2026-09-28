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

/**
 * The checker's work budget. Type operations charge it so a small source that
 * builds huge types (unions of thousands of literals, maps nested by `let`)
 * fails with a limit error instead of running long. Installed per analysis.
 */
let meter: { remaining: number } | undefined

/** Raised when the installed type-work budget runs out. */
export class TypeBudgetExceeded extends Error {}

/** Runs `run` with a type-work budget; nested calls share the outer budget. */
export function withTypeBudget<T>(budget: number, run: () => T): T {
  if (meter !== undefined) return run()
  meter = { remaining: budget }
  try {
    return run()
  } finally {
    meter = undefined
  }
}

/** Charges `units` of type work against the installed budget. */
export function chargeTypeWork(units: number): void {
  if (meter !== undefined && (meter.remaining -= units) < 0) throw new TypeBudgetExceeded()
}

// Map literals are exact: they hold only the keys they list. Declared object
// types are not: a record from a database carries columns the schema omits.
const EXACT = new WeakSet<Type>()

/** A closed map type known to hold no keys beyond `fields` (a map literal). */
export function exactObject(fields: Readonly<Record<string, Type>>): MapType {
  const type: MapType = Object.freeze({ kind: 'map', fields: Object.freeze({ ...fields }) })
  EXACT.add(type)
  return type
}

/** Whether a map type is known to hold no keys beyond its fields. */
export function isExact(type: Type): boolean {
  return EXACT.has(type)
}

/** A copy of a map type with new fields, keeping its exactness. */
export function withFields(type: MapType, fields: Readonly<Record<string, Type>>): MapType {
  if (isExact(type) && type.rest === undefined) return exactObject(fields)
  return type.rest === undefined
    ? { kind: 'map', fields }
    : { kind: 'map', fields, rest: type.rest }
}

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

const nonNullMemo = new WeakMap<Type, Type>()

/** Removes `null` from a type. */
export function nonNull(type: Type): Type {
  if (type.kind === 'null') return NEVER
  if (type.kind !== 'union') return type
  let result = nonNullMemo.get(type)
  if (result === undefined) {
    // Keeps every literal: narrowing an optional enum must not lose its values.
    result = type.types.some((member) => member.kind === 'null' || member.kind === 'union')
      ? unionOf(type.types.map(nonNull), false)
      : type
    nonNullMemo.set(type, result)
  }
  return result
}

const widenMemo = new WeakMap<Type, Type>()

/** The base kind a literal widens to. */
export function widen(type: Type): Type {
  if (type.kind === 'literal') {
    if (typeof type.value === 'string') return STRING
    return typeof type.value === 'number' ? NUMBER : BOOLEAN
  }
  if (type.kind !== 'union') return type
  let result = widenMemo.get(type)
  if (result === undefined) {
    result = type.types.some((member) => member.kind === 'literal' || member.kind === 'union')
      ? unionOf(type.types.map(widen))
      : type
    widenMemo.set(type, result)
  }
  return result
}

// === structural identity ===

const hashMemo = new WeakMap<Type, number>()

/** FNV-1a parameters. */
const FNV_PRIME = 0x01_00_01_93
const FNV_OFFSET = 0x81_1c_9d_c5
/** Separates a map's `rest` from its fields in a hash. */
const REST_MARK = 0x2a

function mix(h: number, value: number): number {
  return Math.imul(h ^ value, FNV_PRIME) >>> 0
}

function hashText(text: string): number {
  let h = FNV_OFFSET
  for (let i = 0; i < text.length; i++) h = mix(h, text.charCodeAt(i))
  return h
}

/** A structural hash: equal types hash equally. Shared sub-types are hashed once. */
function typeHash(type: Type): number {
  const cached = hashMemo.get(type)
  if (cached !== undefined) return cached
  chargeTypeWork(1)
  let h: number
  switch (type.kind) {
    case 'literal':
      h = hashText(`lit:${typeof type.value}:${String(type.value)}`)
      break
    case 'list':
      h = mix(hashText('list'), typeHash(type.element))
      break
    case 'map': {
      h = hashText(isExact(type) ? 'map!' : 'map')
      for (const key of Object.keys(type.fields).sort())
        h = mix(mix(h, hashText(key)), typeHash(type.fields[key]))
      if (type.rest !== undefined) h = mix(mix(h, REST_MARK), typeHash(type.rest))
      break
    }
    case 'union': {
      // Order-independent: members are compared as a set.
      const members = type.types.map(typeHash).sort((a, b) => a - b)
      h = hashText('union')
      for (const member of members) h = mix(h, member)
      break
    }
    case 'opaque':
      h = hashText(`opaque:${type.name}`)
      break
    case 'function':
      h = mix(
        type.params.reduce((acc, param) => mix(acc, typeHash(param)), hashText('fn')),
        typeHash(type.result),
      )
      break
    case 'var':
      h = hashText(`var:${type.name}`)
      break
    case 'any':
    case 'boolean':
    case 'duration':
    case 'never':
    case 'null':
    case 'number':
    case 'string':
    case 'timestamp':
    default:
      h = hashText(type.kind)
  }
  hashMemo.set(type, h)
  return h
}

const sameMemo = new WeakMap<Type, WeakSet<Type>>()

/** Structural equality, linear in the size of the (shared) type graphs. */
export function sameType(a: Type, b: Type): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || typeHash(a) !== typeHash(b)) return false
  if (sameMemo.get(a)?.has(b) === true) return true
  chargeTypeWork(1)
  let same: boolean
  switch (a.kind) {
    case 'literal':
      same = a.value === (b as LiteralType).value
      break
    case 'list':
      same = sameType(a.element, (b as ListType).element)
      break
    case 'map': {
      const other = b as MapType
      const keys = Object.keys(a.fields)
      same =
        isExact(a) === isExact(other) &&
        keys.length === Object.keys(other.fields).length &&
        keys.every((key) => {
          const field = fieldOf(other, key)
          return field !== undefined && sameType(a.fields[key], field)
        }) &&
        (a.rest === undefined
          ? other.rest === undefined
          : other.rest !== undefined && sameType(a.rest, other.rest))
      break
    }
    case 'union': {
      const other = b as UnionType
      same =
        a.types.length === other.types.length &&
        a.types.every((member) => other.types.some((candidate) => sameType(member, candidate)))
      break
    }
    case 'opaque':
      same = a.name === (b as OpaqueType).name
      break
    case 'function': {
      const other = b as FunctionType
      same =
        a.params.length === other.params.length &&
        a.params.every((param, i) => sameType(param, other.params[i])) &&
        sameType(a.result, other.result)
      break
    }
    case 'var':
      same = a.name === (b as TypeVar).name
      break
    case 'any':
    case 'boolean':
    case 'duration':
    case 'never':
    case 'null':
    case 'number':
    case 'string':
    case 'timestamp':
    default:
      same = true
  }
  if (same) {
    let set = sameMemo.get(a)
    if (set === undefined) sameMemo.set(a, (set = new WeakSet()))
    set.add(b)
  }
  return same
}

/**
 * Unions with more literals of one kind than this (a thousand-branch
 * `c ? "a" : c2 ? "b" : ...` ladder) widen them to the kind: always sound, and
 * it keeps building such unions linear.
 */
const MAX_UNION_LITERALS = 256

/**
 * Flattens, de-duplicates, and simplifies a union, in time linear in its
 * members. `collapse` widens very wide literal unions (see MAX_UNION_LITERALS).
 */
export function unionOf(types: readonly Type[], collapse = true): Type {
  const flat: Type[] = []
  const visit = (type: Type): void => {
    if (type.kind === 'union') type.types.forEach(visit)
    else if (type.kind !== 'never') flat.push(type)
  }
  types.forEach(visit)
  chargeTypeWork(flat.length)
  if (flat.some((type) => type.kind === 'any')) return ANY
  // A literal next to its own base kind is redundant.
  const baseKinds = new Set<string>()
  for (const type of flat) if (type.kind !== 'literal') baseKinds.add(type.kind)
  if (collapse && flat.length > MAX_UNION_LITERALS) {
    const counts = new Map<string, number>()
    for (const type of flat) {
      if (type.kind !== 'literal') continue
      const kind = widen(type).kind
      const count = (counts.get(kind) ?? 0) + 1
      counts.set(kind, count)
      if (count > MAX_UNION_LITERALS) baseKinds.add(kind)
    }
    const bases: Readonly<Record<string, Type>> = {
      string: STRING,
      number: NUMBER,
      boolean: BOOLEAN,
    }
    for (const kind of counts.keys()) {
      const base = bases[kind]
      if (base !== undefined && baseKinds.has(kind) && !flat.some((type) => type.kind === kind))
        flat.push(base)
    }
  }
  const out: Type[] = []
  const seen = new Map<number, Type[]>()
  for (const type of flat) {
    if (type.kind === 'literal' && baseKinds.has(widen(type).kind)) continue
    const h = typeHash(type)
    const bucket = seen.get(h)
    if (bucket?.some((existing) => sameType(existing, type)) === true) continue
    if (bucket === undefined) seen.set(h, [type])
    else bucket.push(type)
    out.push(type)
  }
  if (out.length === 0) return NEVER
  if (out.length === 1) return out[0]
  return Object.freeze({ kind: 'union', types: Object.freeze(out) })
}

const assignableMemo = new WeakMap<Type, WeakMap<Type, boolean>>()

/**
 * Whether every value of `source` is a valid `target` (gradual: `any` both ways).
 * Declared object types are open: a value may carry keys its type does not list.
 */
export function isAssignable(source: Type, target: Type): boolean {
  if (source === target) return true
  if (source.kind === 'any' || target.kind === 'any' || source.kind === 'never') return true
  if (target.kind === 'var' || source.kind === 'var') return true
  let memo = assignableMemo.get(source)
  const cached = memo?.get(target)
  if (cached !== undefined) return cached
  chargeTypeWork(1)
  const result = assignable(source, target)
  if (memo === undefined) assignableMemo.set(source, (memo = new WeakMap()))
  memo.set(target, result)
  return result
}

function assignable(source: Type, target: Type): boolean {
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
        const sourceField = fieldOf(source, key)
        if (sourceField !== undefined) {
          if (!isAssignable(sourceField, fieldType)) return false
        } else if (!isNullable(fieldType)) {
          // An absent key reads as null.
          return false
        } else if (source.rest !== undefined && !isAssignable(source.rest, fieldType)) {
          return false
        }
      }
      if (target.rest !== undefined) {
        for (const fieldType of Object.values(source.fields)) {
          if (!isAssignable(fieldType, target.rest)) return false
        }
        if (source.rest !== undefined) return isAssignable(source.rest, target.rest)
        // A declared object may hold keys it does not list, of any type.
        return isExact(source) || target.rest.kind === 'any'
      }
      return true
    }
    case 'opaque':
      return source.kind === 'opaque' && source.name === target.name
    case 'function':
      return source.kind === 'function'
    case 'any':
    case 'var':
      return true
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
  const left = a.kind === 'union' ? a.types : [a]
  const right = b.kind === 'union' ? b.types : [b]
  chargeTypeWork(left.length + right.length)
  const open = (type: Type): boolean => type.kind === 'any' || type.kind === 'var'
  if (left.some(open) || right.some(open)) return true
  // Literals overlap equal literals or their base kind; other kinds overlap by kind.
  const kinds = (members: readonly Type[]): Set<string> =>
    new Set(members.filter((m) => m.kind !== 'literal').map((m) => m.kind))
  const literals = (members: readonly Type[]): Set<string> =>
    new Set(
      members.flatMap((m) =>
        m.kind === 'literal' ? [`${typeof m.value}:${String(m.value)}`] : [],
      ),
    )
  const leftKinds = kinds(left)
  const rightKinds = kinds(right)
  for (const kind of leftKinds) if (rightKinds.has(kind)) return true
  for (const member of left)
    if (member.kind === 'literal' && rightKinds.has(widen(member).kind)) return true
  for (const member of right)
    if (member.kind === 'literal' && leftKinds.has(widen(member).kind)) return true
  const rightLiterals = literals(right)
  for (const literal of literals(left)) if (rightLiterals.has(literal)) return true
  return false
}

/** Longest type text shown in messages and hovers; longer text ends in an ellipsis. */
const MAX_TYPE_TEXT = 1000

/** Human-readable type text, e.g. `{ name: string, tags: string[] } | null`. */
export function formatType(type: Type, maxLength = MAX_TYPE_TEXT): string {
  let out = ''
  let full = false
  const emit = (text: string): boolean => {
    if (full) return false
    if (out.length + text.length > maxLength) {
      out += `${text.slice(0, Math.max(0, maxLength - out.length))}…`
      full = true
      return false
    }
    out += text
    return true
  }
  const write = (node: Type): void => {
    if (full) return
    switch (node.kind) {
      case 'literal':
        emit(JSON.stringify(node.value))
        return
      case 'list': {
        const wrap = node.element.kind === 'union' || node.element.kind === 'function'
        if (wrap) emit('(')
        write(node.element)
        emit(wrap ? ')[]' : '[]')
        return
      }
      case 'map': {
        const keys = Object.keys(node.fields)
        if (keys.length === 0 && node.rest === undefined) {
          emit('{}')
          return
        }
        emit('{ ')
        keys.forEach((k, i) => {
          if (full) return
          if (i > 0) emit(', ')
          emit(`${/^[A-Za-z_$][\w$]*$/u.test(k) ? k : JSON.stringify(k)}: `)
          write(node.fields[k])
        })
        if (node.rest !== undefined) {
          if (keys.length > 0) emit(', ')
          emit('[key: string]: ')
          write(node.rest)
        }
        emit(' }')
        return
      }
      case 'union':
        node.types.forEach((member, i) => {
          if (full) return
          if (i > 0) emit(' | ')
          write(member)
        })
        return
      case 'opaque':
        emit(node.name)
        return
      case 'function':
        emit('(')
        node.params.forEach((param, i) => {
          if (full) return
          if (i > 0) emit(', ')
          write(param)
        })
        emit(') => ')
        write(node.result)
        return
      case 'var':
        emit(node.name)
        return
      case 'any':
      case 'boolean':
      case 'duration':
      case 'never':
      case 'null':
      case 'number':
      case 'string':
      case 'timestamp':
      default:
        emit(node.kind)
    }
  }
  write(type)
  return out
}
