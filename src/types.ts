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

/**
 * Union members with nested unions flattened (and repeats of one object
 * dropped), so `t.optional(t.enum('a', 'b'))` lists "a", "b", and null.
 */
function flattenMembers(types: readonly Type[]): Type[] {
  const out = new Set<Type>()
  const visit = (type: Type): void => {
    if (type.kind === 'union') type.types.forEach(visit)
    else out.add(type)
  }
  types.forEach(visit)
  return [...out]
}

/** The members of a type as a flat list: its union members, or the type itself. */
export function unionMembers(type: Type): readonly Type[] {
  if (type.kind !== 'union') return [type]
  return type.types.some((member) => member.kind === 'union')
    ? flattenMembers(type.types)
    : type.types
}

/** Type builders. */
/** A literal type's value: a string, a boolean, or a finite number (NaN and infinities are never values). */
function literalValue<V extends string | number | boolean>(value: V): V {
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError(`A literal type must be a finite number, not ${String(value)}`)
  return value
}

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
    Object.freeze({ kind: 'literal', value: literalValue(value) }),
  /** A union of literals: `t.enum('free', 'pro')`. */
  enum: <const V extends readonly (string | number | boolean)[]>(
    ...values: V
  ): UnionType<{ [K in keyof V]: LiteralType<V[K]> }> =>
    Object.freeze({
      kind: 'union',
      types: Object.freeze(
        values.map((value) => Object.freeze({ kind: 'literal', value: literalValue(value) })),
      ),
    }) as unknown as UnionType<{ [K in keyof V]: LiteralType<V[K]> }>,
  list: <E extends Type>(element: E): ListType<E> => Object.freeze({ kind: 'list', element }),
  /** A closed record with known fields. */
  object: <const F extends Readonly<Record<string, Type>>>(fields: F): MapType<F, undefined> =>
    Object.freeze({ kind: 'map', fields: Object.freeze({ ...fields }) }),
  /** An open record: every key has type `value`. */
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- no declared fields
  record: <V extends Type>(value: V): MapType<Record<never, never>, V> =>
    Object.freeze({ kind: 'map', fields: Object.freeze({}), rest: value }),
  union: <const M extends readonly Type[]>(...types: M): UnionType<M> =>
    Object.freeze({
      kind: 'union',
      types: Object.freeze(flattenMembers(types)),
    }) as unknown as UnionType<M>,
  /** `T | null`. Absent keys read as null, so this also marks a field optional. */
  optional: <T extends Type>(type: T): UnionType<readonly [T, NullType]> =>
    Object.freeze({
      kind: 'union',
      types: Object.freeze(flattenMembers([type, NULL])),
    }) as unknown as UnionType<readonly [T, NullType]>,
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

/**
 * Large unions built during one analysis, by structural hash: the same union
 * rebuilt (a join repeated in every clause of a rule) becomes the same object,
 * so its index and comparisons are computed once.
 */
let interned: Map<number, UnionType[]> | undefined
/** Unions at least this large are interned. */
const INTERN_MIN_MEMBERS = 32

let lastWork = 0

/** Type work the last completed budget used: a machine-independent measure of checking cost. */
export function lastTypeWork(): number {
  return lastWork
}

/** Raised when the installed type-work budget runs out. */
export class TypeBudgetExceeded extends Error {}

/** Runs `run` with a type-work budget; nested calls share the outer budget. */
export function withTypeBudget<T>(budget: number, run: () => T): T {
  if (meter !== undefined) return run()
  meter = { remaining: budget }
  interned = new Map()
  try {
    return run()
  } finally {
    lastWork = budget - meter.remaining
    meter = undefined
    interned = undefined
  }
}

/** Charges `units` of type work against the installed budget. */
export function chargeTypeWork(units: number): void {
  if (meter !== undefined && (meter.remaining -= units) < 0) throw new TypeBudgetExceeded()
}

// Literals written in the source are fresh: a union of thousands of them (a
// long conditional ladder) may widen to their kind. Declared literal unions
// (enums) never do.
const FRESH = new WeakSet<Type>()

/** A literal type for a literal written in the source. */
export function freshLiteral(value: string | number | boolean): LiteralType {
  const type: LiteralType = Object.freeze({ kind: 'literal', value })
  FRESH.add(type)
  return type
}

const widenFreshMemo = new WeakMap<Type, Type>()

/**
 * Widens the source literals in a type, deeply: a call's result mentions the
 * literals it was given only as their kinds (`max(1, 2)` is a number), while
 * declared literal types (enums) pass through.
 */
export function widenFresh(type: Type): Type {
  if (type.kind === 'literal') return FRESH.has(type) ? widen(type) : type
  if (type.kind !== 'union' && type.kind !== 'list' && type.kind !== 'map') return type
  let result = widenFreshMemo.get(type)
  if (result === undefined) {
    chargeTypeWork(1)
    if (type.kind === 'union') {
      const members = type.types.map(widenFresh)
      result = members.every((m, i) => m === type.types[i]) ? type : unionOf(members)
    } else if (type.kind === 'list') {
      const element = widenFresh(type.element)
      result = element === type.element ? type : { kind: 'list', element }
    } else {
      const fields: Record<string, Type> = {}
      let changed = false
      for (const [key, field] of Object.entries(type.fields)) {
        fields[key] = widenFresh(field)
        changed ||= fields[key] !== field
      }
      const rest = type.rest === undefined ? undefined : widenFresh(type.rest)
      changed ||= rest !== type.rest
      if (!changed) result = type
      else if (rest === undefined) result = withFields(type, fields)
      else result = { kind: 'map', fields, rest }
    }
    widenFreshMemo.set(type, result)
  }
  return result
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
  chargeTypeWork(type.kind === 'union' ? 1 + (type.types.length >>> 2) : 1)
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
      if (a.types.length !== other.types.length) {
        same = false
        break
      }
      // Members are distinct, so equal sizes and every member found means equal sets.
      // Hashed lookups are cheap next to other checking work: charged per 8 members.
      chargeTypeWork(1 + ((a.types.length + other.types.length) >>> 3))
      const buckets = new Map<number, Type[]>()
      for (const candidate of other.types) {
        const h = typeHash(candidate)
        const bucket = buckets.get(h)
        if (bucket === undefined) buckets.set(h, [candidate])
        else bucket.push(candidate)
      }
      same = a.types.every(
        (member) =>
          buckets.get(typeHash(member))?.some((candidate) => sameType(member, candidate)) === true,
      )
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
 * Unions with more source literals of one kind than this (a thousand-branch
 * `c ? "a" : c2 ? "b" : ...` ladder) widen them to the kind: always sound, and
 * it keeps building such unions linear. Declared enums are never widened.
 */
const MAX_UNION_LITERALS = 256

/**
 * Flattens, de-duplicates, and simplifies a union, in time linear in its
 * members. `collapse` widens very wide literal unions (see MAX_UNION_LITERALS).
 */
export function unionOf(types: readonly Type[], collapse = true): Type {
  // One type is already its own union (unions are built flat).
  if (types.length === 1 && types[0].kind !== 'never') return types[0]
  if (collapse && types.length === 2) return unionOfTwo(types[0], types[1])
  return unionOfAll(types, collapse)
}

const pairMemo = new WeakMap<Type, WeakMap<Type, Type>>()

/**
 * The common join of two types, fast when one already holds the other (`c ? tz
 * : "Z1"` over a timezone enum is the enum) and remembered per pair, so a rule
 * that repeats a join of two large enums builds it once.
 */
function unionOfTwo(a: Type, b: Type): Type {
  if (a === b && a.kind !== 'union') return a
  if (a.kind === 'union' && contains(a, b)) return a
  if (b.kind === 'union' && contains(b, a)) return b
  if (a.kind === 'union' && b.kind === 'union') {
    if (holdsAll(a, b)) return a
    if (holdsAll(b, a)) return b
  }
  let memo = pairMemo.get(a)
  const cached = memo?.get(b)
  if (cached !== undefined) {
    chargeTypeWork(1)
    return cached
  }
  const result = unionOfAll([a, b], true)
  if (memo === undefined) pairMemo.set(a, (memo = new WeakMap()))
  memo.set(b, result)
  return result
}

/** Whether `outer` certainly holds every member of `inner` (`Zone | null` holds `Zone`). */
function holdsAll(outer: UnionType, inner: UnionType): boolean {
  if (inner.types.length > outer.types.length) return false
  chargeTypeWork(1 + (inner.types.length >>> 1))
  return inner.types.every((member) => contains(outer, member))
}

/** Whether a union certainly holds a literal or base kind already. */
function contains(union: UnionType, type: Type): boolean {
  if (type.kind !== 'literal' && !PRIMITIVE_KINDS.has(type.kind)) return false
  const index = unionIndex(union)
  if (index.open) return false
  if (type.kind === 'literal')
    return index.literals.has(keyOf(type)) || index.kinds.has(widen(type).kind)
  return type.kind !== 'never' && index.kinds.has(type.kind)
}

function unionOfAll(types: readonly Type[], collapse: boolean): Type {
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
      if (type.kind !== 'literal' || !FRESH.has(type)) continue
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
  // Not frozen: freezing a large member array costs more than building it, and
  // checker types are only read (a program's result type is frozen when exposed).
  const union: UnionType = { kind: 'union', types: out }
  if (interned === undefined || out.length < INTERN_MIN_MEMBERS) return union
  const h = typeHash(union)
  const bucket = interned.get(h)
  const existing = bucket?.find((candidate) => sameType(candidate, union))
  if (existing !== undefined) return existing
  if (bucket === undefined) interned.set(h, [union])
  else bucket.push(union)
  return union
}

const assignableMemo = [
  new WeakMap<Type, WeakMap<Type, boolean>>(),
  new WeakMap<Type, WeakMap<Type, boolean>>(),
]

/**
 * Whether every value of `source` is a valid `target` (gradual: `any` both ways).
 * Declared object types are open: a value may carry keys its type does not list.
 */
export function isAssignable(source: Type, target: Type): boolean {
  return assignableIn(source, target, false)
}

/**
 * Like isAssignable, but only what the types prove: an open object that does
 * not list an optional key of the target may hold that key with any value, so
 * it is accepted gradually (checked at run time) but not proven.
 */
export function isProvenAssignable(source: Type, target: Type): boolean {
  return assignableIn(source, target, true)
}

function assignableIn(source: Type, target: Type, proven: boolean): boolean {
  if (source === target) return true
  if (source.kind === 'any' || target.kind === 'any' || source.kind === 'never') return true
  if (target.kind === 'var' || source.kind === 'var') return true
  // Charged even when memoized: a loop over union members pays for every step.
  chargeTypeWork(1)
  const memos = assignableMemo[proven ? 1 : 0]
  let memo = memos.get(source)
  const cached = memo?.get(target)
  if (cached !== undefined) return cached
  const result = assignable(source, target, proven)
  if (memo === undefined) memos.set(source, (memo = new WeakMap()))
  memo.set(target, result)
  return result
}

/** A type's members indexed for membership and overlap tests. */
interface UnionIndex {
  /** Literal members, by literalKey. */
  readonly literals: ReadonlySet<string>
  /** Base kinds of the literal members. */
  readonly literalKinds: ReadonlySet<string>
  /** Kinds of the other members (base kinds such as string, and list, map, ...). */
  readonly kinds: ReadonlySet<string>
  /** Members that are neither literals nor base kinds (lists, maps, opaques, functions). */
  readonly others: readonly Type[]
  /** A member admits every value (`any` or a type variable). */
  readonly open: boolean
}

const PRIMITIVE_KINDS: ReadonlySet<string> = new Set([
  'null',
  'boolean',
  'number',
  'string',
  'timestamp',
  'duration',
  'never',
])

const unionIndexMemo = new WeakMap<Type, UnionIndex>()

function literalKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`
}

const literalKeyMemo = new WeakMap<Type, string>()

/** literalKey for a literal type, remembered per type (enum members recur in many unions). */
function keyOf(literal: LiteralType): string {
  let key = literalKeyMemo.get(literal)
  if (key === undefined) literalKeyMemo.set(literal, (key = literalKey(literal.value)))
  return key
}

function unionIndex(type: Type): UnionIndex {
  let index = unionIndexMemo.get(type)
  if (index === undefined) {
    const members = unionMembers(type)
    // Twice the member count: building the sets costs more than most type work.
    chargeTypeWork(2 * members.length)
    const literals = new Set<string>()
    const literalKinds = new Set<string>()
    const kinds = new Set<string>()
    const others: Type[] = []
    let open = false
    for (const member of members) {
      if (member.kind === 'literal') {
        literals.add(keyOf(member))
        literalKinds.add(typeof member.value)
      } else if (member.kind === 'any' || member.kind === 'var') open = true
      else {
        kinds.add(member.kind)
        if (!PRIMITIVE_KINDS.has(member.kind)) others.push(member)
      }
    }
    index = { literals, literalKinds, kinds, others, open }
    unionIndexMemo.set(type, index)
  }
  return index
}

function assignable(source: Type, target: Type, proven: boolean): boolean {
  if (source.kind === 'union') {
    chargeTypeWork(source.types.length)
    return source.types.every((member) => assignableIn(member, target, proven))
  }
  if (target.kind === 'union') {
    const index = unionIndex(target)
    if (index.open) return true
    if (source.kind === 'literal')
      return index.literals.has(keyOf(source)) || index.kinds.has(widen(source).kind)
    if (PRIMITIVE_KINDS.has(source.kind)) return index.kinds.has(source.kind)
    chargeTypeWork(index.others.length)
    return index.others.some((member) => assignableIn(source, member, proven))
  }
  switch (target.kind) {
    case 'literal':
      return source.kind === 'literal' && source.value === target.value
    case 'list':
      return source.kind === 'list' && assignableIn(source.element, target.element, proven)
    case 'map': {
      if (source.kind !== 'map') return false
      const targetKeys = Object.keys(target.fields)
      chargeTypeWork(targetKeys.length)
      // A map literal type holds only its keys: so must anything assigned to it.
      if (isExact(target) && target.rest === undefined) {
        if (!isExact(source) || source.rest !== undefined) return false
        for (const key of Object.keys(source.fields))
          if (!Object.hasOwn(target.fields, key)) return false
      }
      for (const key of targetKeys) {
        const fieldType = target.fields[key]
        const sourceField = fieldOf(source, key)
        if (sourceField !== undefined) {
          if (!assignableIn(sourceField, fieldType, proven)) return false
        } else if (!isNullable(fieldType)) {
          // An absent key reads as null.
          return false
        } else if (source.rest !== undefined) {
          if (!assignableIn(source.rest, fieldType, proven)) return false
        } else if (proven && !isExact(source)) {
          // A declared object may hold this key with a value of any type.
          return false
        }
      }
      if (target.rest !== undefined) {
        const rest = target.rest
        const sourceFields = Object.values(source.fields)
        chargeTypeWork(sourceFields.length)
        for (const fieldType of sourceFields) {
          if (!assignableIn(fieldType, rest, proven)) return false
        }
        if (source.rest !== undefined) return assignableIn(source.rest, rest, proven)
        // A declared object may hold keys it does not list, of any type.
        return isExact(source) || rest.kind === 'any'
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
const overlapMemo = new WeakMap<Type, WeakMap<Type, boolean>>()

export function overlaps(a: Type, b: Type): boolean {
  chargeTypeWork(1)
  let memo = overlapMemo.get(a)
  const cached = memo?.get(b)
  if (cached !== undefined) return cached
  const result = computeOverlaps(unionIndex(a), unionIndex(b))
  if (memo === undefined) overlapMemo.set(a, (memo = new WeakMap()))
  memo.set(b, result)
  return result
}

function computeOverlaps(left: UnionIndex, right: UnionIndex): boolean {
  if (left.open || right.open) return true
  // Literals overlap equal literals or their base kind; other kinds overlap by kind.
  const [small, large] = left.literals.size <= right.literals.size ? [left, right] : [right, left]
  for (const kind of small.kinds) {
    if (large.kinds.has(kind) || large.literalKinds.has(kind)) return true
  }
  let visited = 0
  try {
    for (const literal of small.literals) {
      visited++
      if (large.literals.has(literal) || large.kinds.has(literalBase(literal))) return true
    }
    return false
  } finally {
    chargeTypeWork(visited)
  }
}

/** The base kind of a literal key from literalKey. */
function literalBase(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

/** Longest type text shown in messages and hovers; longer text ends in an ellipsis. */
const MAX_TYPE_TEXT = 1000

/** Human-readable type text, e.g. `{ name: string, tags: string[] } | null`. */
const formatMemo = new WeakMap<Type, string>()

export function formatType(type: Type, maxLength = MAX_TYPE_TEXT): string {
  // Messages repeat a type's text (every unknown field of one large object).
  if (maxLength === MAX_TYPE_TEXT) {
    let text = formatMemo.get(type)
    if (text === undefined) formatMemo.set(type, (text = formatTypeText(type, maxLength)))
    return text
  }
  return formatTypeText(type, maxLength)
}

function formatTypeText(type: Type, maxLength: number): string {
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
