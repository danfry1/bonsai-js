import type { BonsaiObjectType, BonsaiType, InferredTypeName } from './types.js'

/**
 * The JSON `BonsaiType` vocabulary: the `t` builder plus pure helpers shared by
 * the core registry (metadata validation), autocomplete, and the checker.
 * Everything here is side-effect free and tree-shakeable, so the core bundle
 * only pays for what an application imports.
 */

export type LiteralValue = string | number | boolean
export type PrimitiveKind = 'string' | 'number' | 'boolean'

const UNKNOWN = Object.freeze({ kind: 'unknown' } as const)
const STRING = Object.freeze({ kind: 'string' } as const)
const NUMBER = Object.freeze({ kind: 'number' } as const)
const BOOLEAN = Object.freeze({ kind: 'boolean' } as const)
const NULL = Object.freeze({ kind: 'null' } as const)
const UNDEFINED = Object.freeze({ kind: 'undefined' } as const)

/** The primitive kind a literal type widens to. */
export function literalBaseKind(value: LiteralValue): PrimitiveKind {
  return typeof value as PrimitiveKind
}

function typeKey(type: BonsaiType): string {
  switch (type.kind) {
    case 'literal':
      return `literal:${typeof type.value}:${String(type.value)}`
    case 'array':
      return `array<${typeKey(type.element)}>`
    case 'object': {
      const properties = Object.entries(type.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}:${typeKey(value)}`)
        .join(',')
      let additional = ''
      if (type.additionalProperties === false) additional = ';closed'
      else if (type.additionalProperties !== undefined) {
        additional = `;+${typeKey(type.additionalProperties)}`
      }
      return `object{${properties}${additional}}`
    }
    case 'union':
      return type.members.map(typeKey).sort().join('|')
    case 'unknown':
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'undefined':
      return type.kind
  }
  throw new TypeError('Unknown static type')
}

/** Normalize a union: flatten, dedupe, collapse to `unknown`, drop literals beside their base kind. */
export function unionOf(types: readonly BonsaiType[]): BonsaiType {
  const members = new Map<string, BonsaiType>()
  const add = (type: BonsaiType): void => {
    if (type.kind === 'union') {
      for (const member of type.members) add(member)
      return
    }
    if (type.kind === 'unknown') {
      members.clear()
      members.set('unknown', UNKNOWN)
      return
    }
    if (!members.has('unknown')) members.set(typeKey(type), type)
  }
  for (const type of types) add(type)
  let normalized = [...members.values()]
  // A literal alongside its own base kind adds nothing: "pro" | string is string.
  const baseKinds = new Set(
    normalized.filter((type) => type.kind !== 'literal').map((type) => type.kind),
  )
  normalized = normalized.filter(
    (type) => type.kind !== 'literal' || !baseKinds.has(literalBaseKind(type.value)),
  )
  if (normalized.length === 0) return UNKNOWN
  if (normalized.length === 1) return normalized[0]
  return Object.freeze({ kind: 'union', members: Object.freeze(normalized) })
}

/** Lift a coarse runtime type name into the static vocabulary. */
export function fromInferredTypeName(name: InferredTypeName | undefined): BonsaiType {
  switch (name) {
    case 'string':
      return STRING
    case 'number':
      return NUMBER
    case 'boolean':
      return BOOLEAN
    case 'array':
      return t.array(UNKNOWN)
    case 'object':
      return t.object({}, { additionalProperties: UNKNOWN })
    case 'null':
      return NULL
    case 'undefined':
      return UNDEFINED
    case undefined:
      return UNKNOWN
  }
  throw new TypeError('Unknown inferred type')
}

/** Collapse a static type to the coarse runtime name used by autocomplete. */
export function toInferredTypeName(type: BonsaiType): InferredTypeName | undefined {
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'undefined':
    case 'array':
    case 'object':
      return type.kind
    case 'literal':
      return literalBaseKind(type.value)
    case 'union': {
      const names = new Set<InferredTypeName | undefined>(type.members.map(toInferredTypeName))
      return names.size === 1 ? [...names][0] : undefined
    }
    case 'unknown':
      return undefined
  }
  throw new TypeError('Unknown static type')
}

/** Every coarse name a static type may take at runtime (for type-filtered suggestions). */
export function inferredTypeNames(type: BonsaiType): InferredTypeName[] {
  if (type.kind === 'union') {
    return [...new Set(type.members.flatMap(inferredTypeNames))]
  }
  const name = toInferredTypeName(type)
  return name === undefined ? [] : [name]
}

/** Human-readable rendering of a static type for diagnostics and editor detail text. */
export function formatType(type: BonsaiType): string {
  switch (type.kind) {
    case 'literal':
      return typeof type.value === 'string' ? JSON.stringify(type.value) : String(type.value)
    case 'array': {
      const element = formatType(type.element)
      return type.element.kind === 'union' ? `(${element})[]` : `${element}[]`
    }
    case 'object': {
      const entries = Object.entries(type.properties).map(
        ([name, value]) => `${name}: ${formatType(value)}`,
      )
      if (type.additionalProperties !== undefined && type.additionalProperties !== false) {
        entries.push(`[key: string]: ${formatType(type.additionalProperties)}`)
      }
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
    }
    case 'union':
      return type.members.map(formatType).join(' | ')
    case 'unknown':
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'undefined':
      return type.kind
  }
  throw new TypeError('Unknown static type')
}

/** Structural compatibility: may a value of type `actual` be used where `expected` is required. */
export function isAssignable(actual: BonsaiType, expected: BonsaiType): boolean {
  if (actual.kind === 'unknown' || expected.kind === 'unknown') return true
  if (actual.kind === 'union')
    return actual.members.every((member) => isAssignable(member, expected))
  if (expected.kind === 'union') {
    return expected.members.some((member) => isAssignable(actual, member))
  }
  if (actual.kind === 'literal') {
    if (expected.kind === 'literal') return actual.value === expected.value
    return expected.kind === literalBaseKind(actual.value)
  }
  if (actual.kind !== expected.kind) return false
  if (actual.kind === 'array' && expected.kind === 'array') {
    return isAssignable(actual.element, expected.element)
  }
  if (actual.kind === 'object' && expected.kind === 'object') {
    const expectedEntries = Object.entries(expected.properties)
    const namedPropertiesMatch = expectedEntries.every(([name, expectedProperty]) => {
      const actualProperty = Object.hasOwn(actual.properties, name)
        ? actual.properties[name]
        : undefined
      return actualProperty === undefined
        ? isAssignable(UNDEFINED, expectedProperty)
        : isAssignable(actualProperty, expectedProperty)
    })
    if (!namedPropertiesMatch) return false

    const additional = expected.additionalProperties
    if (additional === undefined) return true
    const expectedNames = new Set(Object.keys(expected.properties))
    for (const [name, actualProperty] of Object.entries(actual.properties)) {
      if (expectedNames.has(name)) continue
      if (additional === false || !isAssignable(actualProperty, additional)) return false
    }
    if (actual.additionalProperties !== undefined && actual.additionalProperties !== false) {
      return additional !== false && isAssignable(actual.additionalProperties, additional)
    }
    return true
  }
  return true
}

/**
 * Builders for the JSON-serializable static type vocabulary. Used to declare
 * extension signatures (`defineTransform({ inputType: t.string(), ... })`),
 * context schemas for the checker and autocomplete, and expected result types.
 */
export const t = Object.freeze({
  unknown: (): Extract<BonsaiType, { kind: 'unknown' }> => UNKNOWN,
  string: (): Extract<BonsaiType, { kind: 'string' }> => STRING,
  number: (): Extract<BonsaiType, { kind: 'number' }> => NUMBER,
  boolean: (): Extract<BonsaiType, { kind: 'boolean' }> => BOOLEAN,
  null: (): Extract<BonsaiType, { kind: 'null' }> => NULL,
  undefined: (): Extract<BonsaiType, { kind: 'undefined' }> => UNDEFINED,
  /** Exactly one string, number, or boolean value. Combine with `t.union` for enums. */
  literal: (value: LiteralValue): Extract<BonsaiType, { kind: 'literal' }> => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('bonsai: literal type values must be finite numbers')
    }
    return Object.freeze({ kind: 'literal', value })
  },
  /** Shorthand for a union of string/number/boolean literals. */
  enum: (...values: readonly LiteralValue[]): BonsaiType =>
    unionOf(values.map((value) => t.literal(value))),
  array: (element: BonsaiType): Extract<BonsaiType, { kind: 'array' }> =>
    Object.freeze({ kind: 'array', element }),
  object: (
    properties: Readonly<Record<string, BonsaiType>>,
    options: { readonly additionalProperties?: BonsaiType | false } = {},
  ): BonsaiObjectType => {
    const ownProperties: Record<string, BonsaiType> = Object.create(null)
    for (const [name, type] of Object.entries(properties)) ownProperties[name] = type
    return Object.freeze({
      kind: 'object',
      properties: Object.freeze(ownProperties),
      ...(options.additionalProperties === undefined
        ? {}
        : { additionalProperties: options.additionalProperties }),
    })
  },
  /** An object with no fixed keys whose every property has the given type. */
  record: (value: BonsaiType): BonsaiObjectType => t.object({}, { additionalProperties: value }),
  union: (...members: readonly BonsaiType[]): BonsaiType => unionOf(members),
  optional: (type: BonsaiType): BonsaiType => unionOf([type, UNDEFINED]),
  nullable: (type: BonsaiType): BonsaiType => unionOf([type, NULL]),
})
