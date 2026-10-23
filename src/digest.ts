import type { FunctionDef } from './functions/define.js'
import { isExact, type Type } from './types.js'

// The canonical encoding behind an artifact's digest. Equal encodings mean the
// checker sees the same thing, so the encoding is part of the artifact format:
// changing it changes every digest, which needs a new format version. Golden
// digests in the tests pin it.

/** Text with its length first, so no two sequences of texts encode alike. */
function text(value: string): string {
  return `${value.length}:${value}`
}

const typeCodes = new WeakMap<Type, string>()

/**
 * A type's canonical encoding: object fields sorted by key, nested unions
 * flattened and their members sorted and deduplicated, literals tagged by kind.
 * Two types the checker treats alike encode alike, whatever order they were
 * written in.
 */
export function encodeType(type: Type): string {
  let code = typeCodes.get(type)
  if (code === undefined) typeCodes.set(type, (code = encode(type)))
  return code
}

function encode(type: Type): string {
  switch (type.kind) {
    case 'any':
    case 'never':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'timestamp':
    case 'duration':
      return type.kind
    case 'literal': {
      const value = type.value
      if (typeof value === 'string') return `s${text(value)}`
      if (typeof value === 'number') return `n${text(String(value))}`
      return value ? 'true' : 'false'
    }
    case 'list':
      return `[${encodeType(type.element)}]`
    case 'map': {
      const fields = Object.keys(type.fields)
        .sort()
        .map((key) => `${text(key)}=${encodeType(type.fields[key])}`)
      const rest = type.rest === undefined ? '' : `...${encodeType(type.rest)}`
      return `${isExact(type) ? '!' : ''}{${fields.join(',')}${rest}}`
    }
    case 'union': {
      const members = new Set<string>()
      const add = (member: Type): void => {
        if (member.kind === 'union') member.types.forEach(add)
        else members.add(encodeType(member))
      }
      type.types.forEach(add)
      return `(${[...members].sort().join('|')})`
    }
    case 'opaque':
      return `opaque${text(type.name)}`
    case 'function':
      return `fn(${type.params.map(encodeType).join(',')})${encodeType(type.result)}`
    case 'var':
    default:
      return `var${text(type.name)}`
  }
}

/**
 * Everything about a function the checker's decisions depend on: whether it is
 * a host function (the checker refines some built-ins' results, and a host
 * function of the same name replaces the built-in), its flags, and each
 * overload in order. Flags are normalized, since built-ins leave them unset
 * where host functions set them to false.
 */
export function encodeFunction(def: FunctionDef): string {
  const overloads = def.overloads.map((overload) => {
    const required = overload.required ?? overload.params.length
    const params = overload.params.map(encodeType).join(',')
    const rest = overload.rest === undefined ? '' : `...${encodeType(overload.rest)}`
    return `${required}(${params}${rest})${encodeType(overload.result)}`
  })
  const flags = `${def.host === true ? 'h' : 'b'}${def.async === true ? 'a' : ''}${def.call === true ? 'c' : ''}`
  return `${text(def.name)}${flags}${text(overloads.join(';'))}`
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const BYTE_BITS = 8
const LOW_BYTE = 0xff
/** A 32-bit lane in base 36 is at most 7 digits; padded, two lanes are always 14 characters. */
const LANE_RADIX = 36
const LANE_DIGITS = 7

/**
 * A 64-bit hash of text, base-36: two FNV-1a 32-bit lanes, one over the text
 * and one over it in reverse, each over both bytes of every UTF-16 code unit.
 * It detects accidental drift between a compiled artifact and an environment,
 * not tampering.
 */
export function hash64(value: string): string {
  let forward = FNV_OFFSET
  let backward = FNV_OFFSET
  const n = value.length
  for (let i = 0; i < n; i++) {
    forward = mixUnit(forward, value.charCodeAt(i))
    backward = mixUnit(backward, value.charCodeAt(n - 1 - i))
  }
  const lane = (h: number): string => (h >>> 0).toString(LANE_RADIX).padStart(LANE_DIGITS, '0')
  return lane(forward) + lane(backward)
}

/** One FNV-1a step per byte of a UTF-16 code unit, low byte first. */
function mixUnit(hash: number, unit: number): number {
  const low = Math.imul(hash ^ (unit & LOW_BYTE), FNV_PRIME)
  return Math.imul(low ^ (unit >>> BYTE_BITS), FNV_PRIME)
}
