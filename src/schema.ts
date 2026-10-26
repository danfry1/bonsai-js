import { assertType, isRecord } from './functions/define.js'
import { BLOCKED_NAMES } from './syntax/lexer.js'
import { isAssignable, t, unionMembers, type MapType, type SchemaType, type Type } from './types.js'

// The Standard JSON Schema interface (https://standardschema.dev), copied as
// the spec allows, so there is no dependency on it.
interface StandardJSONSchemaOptions {
  readonly target: string
  readonly libraryOptions?: Record<string, unknown> | undefined
}

/** A schema that describes itself as JSON Schema: Zod 4, Valibot, ArkType. */
export interface StandardJSONSchema<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly jsonSchema: {
      readonly output: (options: StandardJSONSchemaOptions) => Record<string, unknown>
    }
    readonly types?: { readonly output: Output } | undefined
  }
}

/** A JSON Schema document: draft-07, draft 2020-12, or an OpenAPI 3.0 schema object. */
export type JSONSchema = boolean | Readonly<Record<string, unknown>>

type OutputOf<S> = S extends { readonly '~standard': { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly output: infer O }
    ? O
    : unknown
  : unknown

export interface FromSchemaOptions {
  /**
   * Types for parts of the schema, by JSON pointer into its JSON Schema
   * (`'/properties/createdAt'`). They replace what those parts would convert
   * to, and give a type to parts that cannot be converted, such as a Zod
   * `.transform()`.
   */
  readonly types?: Readonly<Record<string, Type>> | undefined
  /** Options passed to the schema library when it writes its JSON Schema. */
  readonly libraryOptions?: Record<string, unknown> | undefined
}

/**
 * Converts a schema the app already has into a Bonsai type: a Zod, Valibot,
 * or ArkType schema (any Standard JSON Schema), or a plain JSON Schema.
 *
 * ```ts
 * const User = z.object({ age: z.number(), plan: z.enum(['free', 'pro']) })
 * const env = bonsai({ variables: { user: fromSchema(User) } })
 * ```
 *
 * The type describes the schema's output: the data `parse` returns. Parts
 * with no shape a Bonsai type can state throw a TypeError naming their JSON
 * pointer; give those parts a type with `options.types`.
 */
export function fromSchema<S extends StandardJSONSchema>(
  schema: S,
  options?: FromSchemaOptions,
): SchemaType<OutputOf<S>>
export function fromSchema<Output = unknown>(
  schema: JSONSchema,
  options?: FromSchemaOptions,
): SchemaType<Output>
export function fromSchema(schema: unknown, options: FromSchemaOptions = {}): Type {
  const overrides = options.types ?? {}
  for (const [pointer, type] of Object.entries(overrides))
    assertType(type, `fromSchema option types["${pointer}"]`)
  const root = standardJSON(schema, options.libraryOptions) ?? schema
  if (typeof root !== 'boolean' && !isRecord(root))
    throw new TypeError('fromSchema expects a schema object or a JSON Schema')
  if (isRecord(root) && typeof root.kind === 'string' && !('type' in root))
    throw new TypeError('fromSchema was given a Bonsai type, which needs no converting')
  budgetLeft = BUDGET
  const type = new Converter(root, overrides).convert(root, '')
  assertType(type, 'fromSchema result')
  return type
}

/** The JSON Schema a Standard JSON Schema writes, or undefined for a plain JSON Schema. */
function standardJSON(
  schema: unknown,
  libraryOptions: FromSchemaOptions['libraryOptions'],
): Record<string, unknown> | undefined {
  if ((typeof schema !== 'object' && typeof schema !== 'function') || schema === null)
    return undefined
  if (!('~standard' in schema)) return undefined
  const standard = (schema as StandardJSONSchema)['~standard']
  const { vendor } = standard
  if (typeof standard.jsonSchema?.output !== 'function')
    throw new TypeError(
      `This ${vendor} schema cannot describe itself as JSON Schema (Standard JSON Schema), so fromSchema cannot read it${
        vendor === 'valibot'
          ? '; wrap it with toStandardJsonSchema from @valibot/to-json-schema'
          : ''
      }`,
    )
  const own = Object.hasOwn(VENDORS, vendor)
    ? VENDORS[vendor](libraryOptions ?? {})
    : libraryOptions
  let first: unknown
  for (const target of ['draft-2020-12', 'draft-07']) {
    try {
      return standard.jsonSchema.output({ target, libraryOptions: own })
    } catch (error) {
      first ??= error
    }
  }
  throw new TypeError(
    `The ${vendor} schema could not be written as JSON Schema: ${first instanceof Error ? first.message : String(first)}`,
  )
}

/** Kinds of value Bonsai holds but cannot look inside. */
const OPAQUE = new Set([
  'map',
  'set',
  'bigint',
  'symbol',
  'function',
  'promise',
  'blob',
  'file',
  'instance',
])

/** The mark for a schema library's kind JSON Schema cannot state, or undefined for any other. */
function markOf(kind: string): string | undefined {
  if (kind === 'date') return 'timestamp'
  if (OPAQUE.has(kind)) return `opaque:${kind}`
  if (kind === 'transform' || kind === 'custom') return `unsupported:${kind}`
  return undefined
}

type Hook = (ctx: never) => unknown

/**
 * Each library writes `{}` for, or throws on, the kinds JSON Schema cannot
 * state (dates, maps, transforms). Its own hook marks them instead, so a date
 * becomes a timestamp and a transform is reported rather than read as any
 * value. A hook the caller passes runs too.
 */
const VENDORS: Readonly<
  Record<string, (options: Record<string, unknown>) => Record<string, unknown>>
> = {
  zod: (options) => ({
    unrepresentable: 'any',
    ...options,
    override: (ctx: {
      zodSchema: { _zod: { def: { type: string } } }
      jsonSchema: Record<string, unknown>
    }) => {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Zod's own name for a schema's internals
      const mark = markOf(ctx.zodSchema._zod.def.type)
      if (mark !== undefined) ctx.jsonSchema[MARK] = mark
      if (typeof options.override === 'function') (options.override as Hook)(ctx as never)
    },
  }),
  valibot: (options) => ({
    errorMode: 'ignore',
    ...options,
    overrideSchema: (ctx: { valibotSchema: { type: string } }) => {
      const theirs =
        typeof options.overrideSchema === 'function'
          ? (options.overrideSchema as Hook)(ctx as never)
          : undefined
      const mark = markOf(ctx.valibotSchema.type)
      return theirs ?? (mark === undefined ? undefined : { [MARK]: mark })
    },
    overrideAction: (ctx: { valibotAction: { type: string } }) => {
      const theirs =
        typeof options.overrideAction === 'function'
          ? (options.overrideAction as Hook)(ctx as never)
          : undefined
      return (
        theirs ??
        (ctx.valibotAction.type === 'transform' ? { [MARK]: 'unsupported:transform' } : undefined)
      )
    },
  }),
  arktype: (options) => ({
    ...options,
    fallback: {
      date: () => ({ [MARK]: 'timestamp' }),
      morph: () => ({ [MARK]: 'unsupported:transform' }),
      domain: (ctx: { domain: string }) => ({ [MARK]: `opaque:${ctx.domain}` }),
      proto: (ctx: { proto: { name?: string } }) => ({
        [MARK]: `opaque:${ctx.proto.name ?? 'instance'}`,
      }),
      // A narrowing (`.narrow()`) only refines its base.
      default: (ctx: { base: unknown }) => ctx.base,
      ...(isRecord(options.fallback) ? options.fallback : {}),
    },
  }),
}

/** The keyword that states a Bonsai type JSON Schema has no word for. */
const MARK = 'x-bonsai-type'
const OPAQUE_MARK = 'opaque:'
const UNSUPPORTED_MARK = 'unsupported:'

/**
 * Parts one conversion may build: schema nodes expanded (each `$ref` use
 * counts again), enum members, and pairs an intersection compares.
 */
const BUDGET = 20_000
/** What the conversion in progress has left; conversions are synchronous, so one at a time. */
let budgetLeft = 0

function spend(parts: number, at: string): void {
  budgetLeft -= parts
  if (budgetLeft < 0)
    throw new TypeError(`The schema expands to more than ${BUDGET} parts (at "${at}")`)
}

/** How deep schemas may nest, counting combinators. */
const DEPTH_LIMIT = 256

const OBJECT_KEYWORDS = [
  'properties',
  'additionalProperties',
  'patternProperties',
  'required',
  'propertyNames',
]
const ARRAY_KEYWORDS = ['items', 'prefixItems', 'additionalItems']

class Converter {
  /** Refs being expanded: a ref back to one of them is a cycle. */
  private readonly active = new Set<string>()
  private readonly legacy: boolean
  private readonly root: JSONSchema
  private readonly overrides: Readonly<Record<string, Type>>

  constructor(root: JSONSchema, overrides: Readonly<Record<string, Type>>) {
    this.root = root
    this.overrides = overrides
    const draft = isRecord(root) ? root.$schema : undefined
    // Before 2019-09, keywords beside $ref are ignored and `items` may be a tuple.
    this.legacy = typeof draft === 'string' && /draft-0[4-7]/u.test(draft)
    // The root is being expanded, so `{ $ref: '#' }` (a Zod z.lazy) is a cycle.
    this.active.add('#')
  }

  convert(node: unknown, at: string, depth = 0): Type {
    if (Object.hasOwn(this.overrides, at)) return this.overrides[at]
    spend(1, at)
    if (depth > DEPTH_LIMIT)
      throw new TypeError(`The schema nests deeper than ${DEPTH_LIMIT} (at "${at}")`)
    if (node === true) return t.any()
    if (node === false) return t.never()
    if (!isRecord(node)) throw new TypeError(`The schema at "${at}" is not a schema object`)
    const type = this.shape(node, at, depth)
    return node.nullable === true && !(Array.isArray(node.enum) && !node.enum.includes(null))
      ? maybe(type)
      : type
  }

  private shape(node: Record<string, unknown>, at: string, depth: number): Type {
    const mark = node[MARK]
    if (mark !== undefined) return marked(mark, at)
    if (typeof node.$ref === 'string') {
      const target = this.ref(node.$ref, at, depth)
      return this.legacy
        ? target
        : intersect(target, this.shape(without(node, ['$ref']), at, depth), at)
    }
    let type = this.base(node, at, depth)
    if (Array.isArray(node.allOf))
      for (const [i, member] of node.allOf.entries())
        type = intersect(type, this.convert(member, `${at}/allOf/${i}`, depth + 1), at)
    for (const key of ['anyOf', 'oneOf'] as const) {
      const members = node[key]
      if (!Array.isArray(members)) continue
      // Keywords beside anyOf apply to every member: `{ properties, oneOf: [{ required }] }`.
      const branches = members.map((member, i) =>
        this.convert(member, `${at}/${key}/${i}`, depth + 1),
      )
      type = intersect(type, union(branches), at)
    }
    return type
  }

  /** The node's own type, before allOf, anyOf, and oneOf narrow it. */
  private base(node: Record<string, unknown>, at: string, depth: number): Type {
    if ('const' in node) return literal(node.const, `${at}/const`)
    if (Array.isArray(node.enum)) {
      spend(node.enum.length, at)
      return union(node.enum.map((value, i) => literal(value, `${at}/enum/${i}`)))
    }
    const kinds = kindsOf(node)
    if (kinds === undefined) return t.any()
    return union(kinds.map((kind) => this.ofKind(node, kind, at, depth)))
  }

  private ofKind(node: Record<string, unknown>, kind: unknown, at: string, depth: number): Type {
    switch (kind) {
      case 'string':
        return t.string()
      case 'number':
      case 'integer':
        return t.number()
      case 'boolean':
        return t.boolean()
      case 'null':
        return t.null()
      case 'array':
        return this.array(node, at, depth)
      case 'object':
        return this.object(node, at, depth)
      default:
        throw new TypeError(`The schema at "${at}" has an unknown type ${JSON.stringify(kind)}`)
    }
  }

  private array(node: Record<string, unknown>, at: string, depth: number): Type {
    // A tuple is a list of any of its members: Bonsai lists have one element type.
    const tuple = this.legacy && Array.isArray(node.items) ? 'items' : 'prefixItems'
    const rest = tuple === 'items' ? 'additionalItems' : 'items'
    const members: Type[] = []
    const prefix = node[tuple]
    if (Array.isArray(prefix))
      for (const [i, member] of prefix.entries())
        members.push(this.convert(member, `${at}/${tuple}/${i}`, depth + 1))
    // Elements past the tuple, or every element: `items: false` allows none.
    const extra = node[rest]
    members.push(extra === undefined ? t.any() : this.convert(extra, `${at}/${rest}`, depth + 1))
    return t.list(union(members))
  }

  private object(node: Record<string, unknown>, at: string, depth: number): Type {
    const required = new Set(Array.isArray(node.required) ? node.required : [])
    const fields: Record<string, Type> = {}
    const field = (key: string, type: Type, optional: boolean): void => {
      // A field named __proto__ cannot be read in an expression, so it is left out.
      if (BLOCKED_NAMES.has(key)) return
      Object.defineProperty(fields, key, {
        value: optional ? maybe(type) : type,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    const properties = isRecord(node.properties) ? node.properties : {}
    for (const key of Object.keys(properties))
      field(
        key,
        this.convert(properties[key], `${at}/properties/${pointerKey(key)}`, depth + 1),
        !required.has(key),
      )

    // Every value type a key outside `properties` may have.
    const rest: Type[] = []
    const extra = node.additionalProperties ?? node.unevaluatedProperties
    if (extra !== undefined && extra !== false)
      rest.push(this.convert(extra, `${at}/additionalProperties`, depth + 1))
    if (isRecord(node.patternProperties))
      for (const [pattern, schema] of Object.entries(node.patternProperties))
        rest.push(this.convert(schema, `${at}/patternProperties/${pointerKey(pattern)}`, depth + 1))

    // A record keyed by an enum (`z.record(z.enum(['a', 'b']), V)`) has exactly those keys.
    const names = isRecord(node.propertyNames) ? node.propertyNames.enum : undefined
    if (Array.isArray(names) && rest.length > 0) {
      for (const key of names)
        if (typeof key === 'string') field(key, union(rest), !required.has(key))
      return t.object(fields)
    }

    // Properties that a condition adds are optional fields.
    const conditional: [string, unknown][] = []
    for (const key of ['then', 'else'] as const)
      if (node[key] !== undefined) conditional.push([key, node[key]])
    if (isRecord(node.dependentSchemas))
      for (const [key, schema] of Object.entries(node.dependentSchemas))
        conditional.push([`dependentSchemas/${pointerKey(key)}`, schema])
    for (const [path, schema] of conditional) {
      const type = this.convert(schema, `${at}/${path}`, depth + 1)
      for (const member of unionMembers(type)) {
        if (member.kind !== 'map') continue
        for (const [key, value] of Object.entries(member.fields))
          field(key, Object.hasOwn(fields, key) ? union([fields[key], value]) : value, true)
      }
    }

    if (Object.keys(fields).length === 0 && rest.length === 0 && extra !== false)
      // A free-form object (`{ type: 'object' }`): its keys are not known.
      return t.any()
    return rest.length === 0 ? t.object(fields) : withRest(t.object(fields), union(rest))
  }

  /** A local `$ref`, followed through the root by JSON pointer. */
  private ref(ref: string, at: string, depth: number): Type {
    if (ref !== '#' && !ref.startsWith('#/'))
      throw new TypeError(
        `The schema at "${at}" refers to "${ref}"; only refs inside the schema ("#/...") are followed`,
      )
    // A ref back into itself (a tree, a recursive Zod schema) stops there as any value.
    if (this.active.has(ref)) return t.any()
    let node: unknown = this.root
    for (const raw of ref === '#' ? [] : ref.slice(2).split('/')) {
      const key = decodePointer(raw)
      if (
        key === undefined ||
        !(isRecord(node) || Array.isArray(node)) ||
        !Object.hasOwn(node, key)
      )
        throw new TypeError(`The schema at "${at}" refers to "${ref}", which it does not contain`)
      node = (node as Record<string, unknown>)[key]
    }
    this.active.add(ref)
    try {
      return this.convert(node, ref.slice(1), depth + 1)
    } finally {
      this.active.delete(ref)
    }
  }
}

/** The kinds a node's `type` names; without one, the kind its keywords imply, if any. */
function kindsOf(node: Record<string, unknown>): readonly unknown[] | undefined {
  if (typeof node.type === 'string') return [node.type]
  if (Array.isArray(node.type)) return node.type
  if (OBJECT_KEYWORDS.some((key) => key in node)) return ['object']
  if (ARRAY_KEYWORDS.some((key) => key in node)) return ['array']
  return undefined
}

function marked(mark: unknown, at: string): Type {
  if (mark === 'timestamp') return t.timestamp()
  if (mark === 'duration') return t.duration()
  if (mark === 'any') return t.any()
  if (typeof mark === 'string' && mark.startsWith(OPAQUE_MARK))
    return t.opaque(mark.slice(OPAQUE_MARK.length))
  if (typeof mark === 'string' && mark.startsWith(UNSUPPORTED_MARK))
    throw new TypeError(
      `The schema at "${at}" is a ${mark.slice(UNSUPPORTED_MARK.length)}, which has no shape Bonsai can read; give it a type with fromSchema's types option`,
    )
  throw new TypeError(
    `The schema at "${at}" has ${MARK} ${JSON.stringify(mark)}; it must be "timestamp", "duration", "any", or "opaque:<name>"`,
  )
}

function literal(value: unknown, at: string): Type {
  if (value === null) return t.null()
  if (typeof value === 'string' || typeof value === 'boolean') return t.literal(value)
  if (typeof value === 'number' && Number.isFinite(value)) return t.literal(value)
  throw new TypeError(
    `The schema at "${at}" allows a value that is not a string, number, boolean, or null`,
  )
}

function union(types: readonly Type[]): Type {
  const members = types.filter((type) => type.kind !== 'never')
  if (members.some((type) => type.kind === 'any')) return t.any()
  if (members.length === 0) return t.never()
  return members.length === 1 ? members[0] : t.union(...members)
}

function withRest(type: MapType, rest: Type): Type {
  return Object.freeze({ kind: 'map', fields: type.fields, rest })
}

function without(node: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(node))
    if (!keys.includes(key))
      Object.defineProperty(out, key, {
        value: node[key],
        enumerable: true,
        writable: true,
        configurable: true,
      })
  return out
}

/** `T | null`; any value already includes null. */
function maybe(type: Type): Type {
  return type.kind === 'any' ? type : t.optional(type)
}

/** One segment of a `$ref` pointer as a key, or undefined when it is malformed. */
function decodePointer(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~')
  } catch {
    return undefined
  }
}

/** A key as one JSON pointer segment. */
function pointerKey(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * The values both types allow, for allOf and keywords beside anyOf. Members
 * that only refine (a description, a `required` list) are any, and drop out.
 */
function intersect(a: Type, b: Type, at: string): Type {
  const type = meetOrNever(a, b, at)
  if (type.kind === 'never' && a.kind !== 'never' && b.kind !== 'never')
    throw new TypeError(`The schema at "${at}" combines parts no value can match`)
  return type
}

/** The intersection of two types: of each pair of their members, or never. */
function meetOrNever(a: Type, b: Type, at: string): Type {
  if (a.kind === 'any') return b
  if (b.kind === 'any') return a
  const xs = unionMembers(a)
  const ys = unionMembers(b)
  spend(xs.length * ys.length, at)
  const out: Type[] = []
  for (const x of xs) for (const y of ys) out.push(meet(x, y, at))
  return union(out)
}

/** The intersection of two types that are not unions, or never. */
function meet(a: Type, b: Type, at: string): Type {
  if (a.kind === 'any') return b
  if (b.kind === 'any') return a
  if (a.kind === 'map' && b.kind === 'map') {
    const fields: Record<string, Type> = {}
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
    for (const key of keys) {
      // A key only one side declares keeps that side's type.
      let value: Type
      if (!Object.hasOwn(a.fields, key)) value = b.fields[key]
      else if (!Object.hasOwn(b.fields, key)) value = a.fields[key]
      else value = meetOrNever(a.fields[key], b.fields[key], at)
      if (value.kind === 'never') return t.never()
      Object.defineProperty(fields, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    const rest = a.rest && b.rest ? meetOrNever(a.rest, b.rest, at) : (a.rest ?? b.rest)
    return rest === undefined ? t.object(fields) : withRest(t.object(fields), rest)
  }
  if (a.kind === 'list' && b.kind === 'list') return t.list(meetOrNever(a.element, b.element, at))
  if (isAssignable(a, b)) return a
  if (isAssignable(b, a)) return b
  return t.never()
}
