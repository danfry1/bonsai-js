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
// `object`, not a record, so a schema typed by an interface (JSONSchema7, an OpenAPI SchemaObject) fits.
export type JSONSchema = boolean | object

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
  if (isBonsaiType(root))
    throw new TypeError('fromSchema was given a Bonsai type, which needs no converting')
  budgetLeft = BUDGET
  const converter = new Converter(root, overrides)
  const type = converter.convert(root, '')
  const unused = Object.keys(overrides).filter((pointer) => !converter.used.has(pointer))
  if (unused.length > 0)
    throw new TypeError(
      `fromSchema option types names ${unused.map((pointer) => `"${pointer}"`).join(', ')}, which the schema does not have (inside a $ref, use the definition's path)`,
    )
  try {
    assertType(type, 'fromSchema result')
  } catch {
    throw new TypeError('The schema nests deeper than a Bonsai type can')
  }
  return type
}

const BONSAI_KINDS = new Set(['any', 'never', 'literal', 'list', 'map', 'union', 'opaque'])

/** Whether a value is a Bonsai type rather than a JSON Schema: a `kind` and no schema keywords. */
function isBonsaiType(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (!BONSAI_KINDS.has(value.kind) && !PRIMITIVE_KINDS.has(value.kind)) return false
  return ![...SCHEMA_KEYWORDS, ...OBJECT_KEYWORDS, ...ARRAY_KEYWORDS].some((key) => key in value)
}

const PRIMITIVE_KINDS = new Set(['null', 'boolean', 'number', 'string', 'timestamp', 'duration'])
const SCHEMA_KEYWORDS = ['type', 'properties', '$ref', 'anyOf', 'oneOf', 'allOf', 'enum', 'const']

/** The JSON Schema a Standard JSON Schema writes, or undefined for a plain JSON Schema. */
function standardJSON(
  schema: unknown,
  libraryOptions: FromSchemaOptions['libraryOptions'],
): Record<string, unknown> | undefined {
  if ((typeof schema !== 'object' && typeof schema !== 'function') || schema === null)
    return undefined
  if (!('~standard' in schema)) return undefined
  // `z.toJSONSchema` returns plain JSON with a hidden `~standard`: read the JSON as given.
  const hidden = Object.getOwnPropertyDescriptor(schema, '~standard')
  if (
    Object.getPrototypeOf(schema) === Object.prototype &&
    hidden?.enumerable === false &&
    isRecord(hidden.value) &&
    hidden.value.vendor === 'zod'
  )
    return undefined
  const standard: unknown = schema['~standard']
  if (!isRecord(standard))
    throw new TypeError('fromSchema was given a malformed ~standard property')
  const vendor = String(standard.vendor)
  const jsonSchema = standard.jsonSchema as
    | StandardJSONSchema['~standard']['jsonSchema']
    | undefined
  if (typeof jsonSchema?.output !== 'function')
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
    let json: unknown
    try {
      json = jsonSchema.output({ target, libraryOptions: own })
    } catch (error) {
      first ??= error
      continue
    }
    if (!isRecord(json))
      throw new TypeError(`The ${vendor} schema wrote JSON Schema that is not an object`)
    return json
  }
  throw new TypeError(
    `The ${vendor} schema could not be written as JSON Schema: ${first instanceof Error ? first.message : String(first)}`,
  )
}

/** Kinds of value Bonsai holds but cannot look inside, by one name whichever library names them. */
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
  if (OPAQUE.has(kind)) return `${OPAQUE_MARK}${kind}`
  if (kind === 'transform' || kind === 'custom') return `${UNSUPPORTED_MARK}${kind}`
  return undefined
}

/** An opaque mark for a class (ArkType names `Map`, Zod and Valibot `map`). */
function opaqueMark(name: string | undefined): string {
  const lower = name?.toLowerCase()
  if (lower !== undefined && OPAQUE.has(lower)) return `${OPAQUE_MARK}${lower}`
  return `${OPAQUE_MARK}${name === undefined || name === '' ? 'instance' : name}`
}

/** Valibot schema kinds whose value may be undefined, which JSON Schema states only for object keys. */
const VALIBOT_OPTIONAL = new Set(['optional', 'undefinedable', 'nullish', 'exact_optional'])

interface ValibotSchema {
  readonly type: string
  readonly default?: unknown
  readonly entries?: Readonly<Record<string, ValibotSchema>>
}

const VALIBOT_OBJECTS = new Set(['object', 'loose_object', 'strict_object', 'object_with_rest'])

/**
 * Whether parsing always replaces undefined with a default. A default function
 * may itself return undefined, so only a default value counts.
 */
function defaulted(schema: ValibotSchema): boolean {
  return (
    schema.default !== undefined && schema.default !== null && typeof schema.default !== 'function'
  )
}

/** Valibot's `{ anyOf: [T, { type: 'null' }] }` for a nullable as T; anything else as it is. */
function withoutNull(json: Record<string, unknown>): Record<string, unknown> {
  const members = json.anyOf
  if (!Array.isArray(members)) return json
  const rest = members.filter((member) => !(isRecord(member) && member.type === 'null'))
  if (rest.length !== 1 || !isRecord(rest[0])) return json
  const { anyOf: _, ...keywords } = json
  return { ...keywords, ...rest[0] }
}

/** Valibot transformations that keep the type of the value they change. */
const VALIBOT_SAME_TYPE = new Set([
  'brand',
  'flavor',
  'readonly',
  'guard',
  'args',
  'returns',
  'trim',
  'trim_start',
  'trim_end',
  'normalize',
  'to_lower_case',
  'to_upper_case',
  'to_camel_case',
  'to_kebab_case',
  'to_pascal_case',
  'to_snake_case',
  'to_min_value',
  'to_max_value',
  'filter_items',
  'sort_items',
])

/** Valibot transformations to a type Bonsai can state. */
const VALIBOT_TO: Readonly<Record<string, Record<string, unknown>>> = {
  to_number: { type: 'number' },
  to_string: { type: 'string' },
  to_boolean: { type: 'boolean' },
  parse_boolean: { type: 'boolean' },
  to_date: { 'x-bonsai-type': 'timestamp' },
  to_bigint: { 'x-bonsai-type': 'opaque:bigint' },
}

type Hook = (ctx: never) => unknown

/**
 * Each library writes `{}` for, or throws on, the kinds JSON Schema cannot
 * state (dates, maps, transforms, a value that may be undefined). Its own hook
 * marks them instead, so a date becomes a timestamp and a transform is
 * reported rather than read as the type before it. A hook the caller passes
 * runs too.
 */
const VENDORS: Readonly<
  Record<string, (options: Record<string, unknown>) => Record<string, unknown>>
> = {
  zod: (options) => ({
    unrepresentable: 'any',
    ...options,
    override: (ctx: {
      zodSchema: { _zod: { def: { type: string; values?: unknown[] }; optout?: string } }
      jsonSchema: Record<string, unknown>
    }) => {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Zod's own name for a schema's internals
      const { def, optout } = ctx.zodSchema._zod
      let mark = markOf(def.type)
      // `z.literal(1n)` writes `{ const: 1 }`.
      if (def.type === 'literal' && def.values?.some((value) => typeof value === 'bigint') === true)
        mark = def.values.every((value) => typeof value === 'bigint') ? 'opaque:bigint' : 'any'
      if (mark !== undefined) ctx.jsonSchema[MARK] = mark
      // Zod writes `{}` for undefined, which reads as null.
      if (def.type === 'undefined' || def.type === 'void') ctx.jsonSchema.type = 'null'
      // Zod copies a child's JSON into wrappers like `.default()`, which take undefined away.
      if (
        def.type === 'optional' ||
        (def.type === 'literal' && def.values?.includes(undefined) === true)
      )
        ctx.jsonSchema[OPTIONAL] = true
      else if (optout !== 'optional') delete ctx.jsonSchema[OPTIONAL]
      if (typeof options.override === 'function') (options.override as Hook)(ctx as never)
    },
  }),
  valibot: (options) => ({
    errorMode: 'ignore',
    ...options,
    overrideSchema: (ctx: {
      valibotSchema: ValibotSchema
      jsonSchema: Record<string, unknown>
    }) => {
      const theirs =
        typeof options.overrideSchema === 'function'
          ? (options.overrideSchema as Hook)(ctx as never)
          : undefined
      if (theirs !== undefined) return theirs
      const { type } = ctx.valibotSchema
      // A default value replaces null too, for nullable and nullish.
      if ((type === 'nullable' || type === 'nullish') && defaulted(ctx.valibotSchema))
        return withoutNull(ctx.jsonSchema)
      if (VALIBOT_OPTIONAL.has(type))
        return defaulted(ctx.valibotSchema) ? undefined : { ...ctx.jsonSchema, [OPTIONAL]: true }
      if (type === 'undefined' || type === 'void') return { type: 'null' }
      if (VALIBOT_OBJECTS.has(type) && ctx.valibotSchema.entries !== undefined) {
        // A key with a default is always there after parsing, though Valibot leaves it out of `required`.
        const required = Array.isArray(ctx.jsonSchema.required) ? [...ctx.jsonSchema.required] : []
        for (const [key, entry] of Object.entries(ctx.valibotSchema.entries))
          if (VALIBOT_OPTIONAL.has(entry.type) && defaulted(entry) && !required.includes(key))
            required.push(key)
        return {
          ...ctx.jsonSchema,
          required,
          ...(type === 'loose_object' ? { additionalProperties: true } : {}),
        }
      }
      const mark = markOf(type)
      return mark === undefined ? undefined : { [MARK]: mark }
    },
    overrideAction: (ctx: { valibotAction: { kind: string; type: string } }) => {
      const theirs =
        typeof options.overrideAction === 'function'
          ? (options.overrideAction as Hook)(ctx as never)
          : undefined
      if (theirs !== undefined) return theirs
      const { kind, type } = ctx.valibotAction
      if (kind !== 'transformation' || VALIBOT_SAME_TYPE.has(type)) return undefined
      return Object.hasOwn(VALIBOT_TO, type)
        ? VALIBOT_TO[type]
        : { [MARK]: `${UNSUPPORTED_MARK}transform` }
    },
  }),
  arktype: (options) => ({
    ...options,
    fallback: {
      date: () => ({ [MARK]: 'timestamp' }),
      morph: () => ({ [MARK]: `${UNSUPPORTED_MARK}transform` }),
      domain: (ctx: { domain: string }) => ({ [MARK]: opaqueMark(ctx.domain) }),
      proto: (ctx: { proto: { name?: string } }) => ({ [MARK]: opaqueMark(ctx.proto.name) }),
      // These only refine their base, or add what an expression cannot read (symbol keys).
      predicate: (ctx: { base: unknown }) => ctx.base,
      patternIntersection: (ctx: { base: unknown }) => ctx.base,
      defaultValue: (ctx: { base: unknown }) => ctx.base,
      symbolKey: (ctx: { base: unknown }) => ctx.base,
      // `'string | undefined'`: undefined reads as null.
      unit: (ctx: { unit: unknown }) => (ctx.unit === undefined ? { type: 'null' } : {}),
      // Anything else (a postfix tuple, a unit like undefined) is any value.
      default: () => ({}),
      ...(typeof options.fallback === 'function' ? { default: options.fallback } : {}),
      ...(isRecord(options.fallback) ? options.fallback : {}),
    },
  }),
}

/** The keyword that states a Bonsai type JSON Schema has no word for. */
const MARK = 'x-bonsai-type'
const OPAQUE_MARK = 'opaque:'
const UNSUPPORTED_MARK = 'unsupported:'
/**
 * Marks a value that may be undefined (read as null): JSON Schema can say so
 * only for an object key, through `required`. Written by the library hooks.
 */
const OPTIONAL = 'x-bonsai-optional'

/**
 * Parts one conversion may build: schema nodes expanded (each `$ref` use
 * counts again), enum members, and pairs an intersection compares.
 */
const BUDGET = 100_000
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
  private readonly modern: boolean
  private readonly root: JSONSchema
  private readonly overrides: Readonly<Record<string, Type>>
  /** The `types` pointers the schema has. */
  readonly used = new Set<string>()
  /** Refs already converted, outside any cycle. */
  private readonly refs = new Map<string, Type>()
  /** Cycles cut so far, to tell whether a ref's type depends on the refs around it. */
  private cuts = 0

  constructor(root: JSONSchema, overrides: Readonly<Record<string, Type>>) {
    this.root = root
    this.overrides = overrides
    const draft = isRecord(root) ? root.$schema : undefined
    // Before 2019-09, keywords beside $ref are ignored.
    this.legacy = typeof draft === 'string' && /draft-0[4-7]/u.test(draft)
    // A schema that names 2019-09 or later; one that names no draft may be either.
    this.modern = typeof draft === 'string' && !this.legacy
    // The root is being expanded, so `{ $ref: '#' }` (a Zod z.lazy) is a cycle.
    this.active.add('#')
  }

  convert(node: unknown, at: string, depth = 0): Type {
    if (Object.hasOwn(this.overrides, at)) {
      this.used.add(at)
      return this.overrides[at]
    }
    spend(1, at)
    if (depth > DEPTH_LIMIT)
      throw new TypeError(`The schema nests deeper than ${DEPTH_LIMIT} (at "${at}")`)
    if (node === true) return t.any()
    if (node === false) return t.never()
    if (!isRecord(node)) throw new TypeError(`The schema at "${at}" is not a schema object`)
    const type = this.shape(node, at, depth)
    // OpenAPI 3.0 `nullable` (Swagger 2 `x-nullable`) adds null, even beside an enum
    // without null, which generators write for a nullable enum.
    const nullable = node.nullable === true || node['x-nullable'] === true
    return nullable || node[OPTIONAL] === true ? maybe(type) : type
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
    // An array of `items` is a draft-07 tuple, which 2020-12 never writes.
    const tuple = Array.isArray(node.items) ? 'items' : 'prefixItems'
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
        // OpenAPI requires a readOnly key only in responses, a writeOnly key only in requests.
        !required.has(key) || oneWay(properties[key]),
      )

    // Every value type a key outside `properties` may have.
    const rest: Type[] = []
    const restKey =
      node.additionalProperties === undefined ? 'unevaluatedProperties' : 'additionalProperties'
    const extra = node[restKey]
    if (extra !== undefined && extra !== false)
      rest.push(this.convert(extra, `${at}/${restKey}`, depth + 1))
    if (isRecord(node.patternProperties))
      for (const [pattern, schema] of Object.entries(node.patternProperties))
        rest.push(this.convert(schema, `${at}/patternProperties/${pointerKey(pattern)}`, depth + 1))
    // Keys no pattern matches may hold anything unless the schema says otherwise (`^x-` extensions).
    if (isRecord(node.patternProperties) && extra === undefined) rest.push(t.any())

    // A record keyed by an enum (`z.record(z.enum(['a', 'b']), V)`) has exactly those keys.
    const names = isRecord(node.propertyNames) ? node.propertyNames.enum : undefined
    if (Array.isArray(names) && rest.length > 0) {
      for (const key of names)
        if (typeof key === 'string' && !Object.hasOwn(fields, key))
          field(key, union(rest), !required.has(key))
      return t.object(fields)
    }

    // Properties that a condition adds are optional fields; the condition only
    // narrows properties the object already has, so those keep their types.
    // When the condition does not hold, such a key is like any other key: it
    // holds what other keys may (anything, unless additionalProperties says).
    const own = new Set(Object.keys(fields))
    const otherwise = rest.length > 0 ? rest : [extra === false ? t.never() : t.any()]
    const conditional: [string, unknown][] = []
    for (const key of ['then', 'else'] as const)
      if (node[key] !== undefined) conditional.push([key, node[key]])
    // draft-07 `dependencies` holds both required lists and schemas; only schemas add keys.
    // 2019-09 and later split it into dependentSchemas and dependentRequired.
    for (const keyword of this.modern
      ? ['dependentSchemas']
      : ['dependentSchemas', 'dependencies']) {
      const entries = node[keyword]
      if (!isRecord(entries)) continue
      for (const [key, schema] of Object.entries(entries))
        if (!Array.isArray(schema)) conditional.push([`${keyword}/${pointerKey(key)}`, schema])
    }
    for (const [path, schema] of conditional) {
      const type = this.convert(schema, `${at}/${path}`, depth + 1)
      for (const member of unionMembers(type)) {
        if (member.kind !== 'map') continue
        for (const [key, value] of Object.entries(member.fields)) {
          if (own.has(key)) continue
          const before = Object.hasOwn(fields, key) ? [fields[key]] : otherwise
          field(key, union([...before, value]), true)
        }
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
        `The schema at "${at}" refers to "${ref}"; only JSON pointer refs inside the schema ("#/...") are followed`,
      )
    // A ref back into itself (a tree, a recursive Zod schema) stops there as any value.
    if (this.active.has(ref)) {
      this.cuts++
      return t.any()
    }
    const known = this.refs.get(ref)
    if (known !== undefined) {
      // Reused, the type is still walked as a tree by everything that reads it.
      spend(treeSize(known), at)
      return known
    }
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
    const cuts = this.cuts
    try {
      const type = this.convert(node, ref.slice(1), depth + 1)
      // Without a cycle cut inside, the type does not depend on where the ref is used.
      if (this.cuts === cuts) this.refs.set(ref, type)
      return type
    } finally {
      this.active.delete(ref)
    }
  }
}

function oneWay(schema: unknown): boolean {
  return isRecord(schema) && (schema.readOnly === true || schema.writeOnly === true)
}

const sizes = new WeakMap<Type, number>()

/** How many parts a type has, counting a shared part each time it appears. */
function treeSize(type: Type): number {
  const known = sizes.get(type)
  if (known !== undefined) return known
  let size = 1
  if (type.kind === 'list') size += treeSize(type.element)
  else if (type.kind === 'union') for (const member of type.types) size += treeSize(member)
  else if (type.kind === 'map') {
    for (const key of Object.keys(type.fields)) size += treeSize(type.fields[key])
    if (type.rest !== undefined) size += treeSize(type.rest)
  }
  sizes.set(type, size)
  return size
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
  if (typeof mark === 'string' && mark.startsWith(OPAQUE_MARK) && mark.length > OPAQUE_MARK.length)
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
