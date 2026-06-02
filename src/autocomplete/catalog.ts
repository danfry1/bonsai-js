import { BLOCKED_PROPERTIES } from '../execution-context.js'
import { methodsForReceiverType, type MethodReceiverType } from '../safe-methods.js'
import type { InferredTypeName } from '../types.js'

/** Types that have method catalogs. Re-exported from the shared allowlist. */
export type { MethodReceiverType }

/** Key format for the return type map: "receiverType.methodName". */
type ReturnTypeKey = `${MethodReceiverType}.${string}`

/** Return type values include InferredTypeName plus 'unknown' for unresolvable cases. */
type ReturnTypeValue = InferredTypeName | 'unknown'

/**
 * Methods offered per receiver type, derived from the shared SAFE_METHODS
 * allowlist (src/safe-methods.ts) so autocomplete and the evaluator can never
 * disagree about what is callable.
 */
export const METHODS_BY_TYPE: Record<MethodReceiverType, readonly string[]> = {
  string: methodsForReceiverType('string'),
  array: methodsForReceiverType('array'),
  number: methodsForReceiverType('number'),
}

/** Return type keyed by "receiverType.method" to disambiguate shared method names. */
const RETURN_TYPES: Record<ReturnTypeKey, ReturnTypeValue> = {
  // String methods
  'string.trim': 'string', 'string.trimStart': 'string', 'string.trimEnd': 'string',
  'string.toLowerCase': 'string', 'string.toUpperCase': 'string',
  'string.slice': 'string', 'string.substring': 'string',
  'string.replace': 'string', 'string.replaceAll': 'string',
  'string.padStart': 'string', 'string.padEnd': 'string',
  'string.charAt': 'string', 'string.repeat': 'string', 'string.concat': 'string',
  'string.split': 'array',
  'string.indexOf': 'number', 'string.lastIndexOf': 'number', 'string.charCodeAt': 'number',
  'string.startsWith': 'boolean', 'string.endsWith': 'boolean', 'string.includes': 'boolean',
  'string.at': 'string', 'string.toString': 'string',

  // Array methods
  'array.filter': 'array', 'array.map': 'array', 'array.flat': 'array',
  'array.flatMap': 'array', 'array.concat': 'array', 'array.slice': 'array',
  'array.toReversed': 'array', 'array.toSorted': 'array', 'array.toSpliced': 'array',
  'array.find': 'unknown', 'array.findIndex': 'number',
  'array.some': 'boolean', 'array.every': 'boolean',
  'array.join': 'string', 'array.indexOf': 'number', 'array.lastIndexOf': 'number',
  'array.includes': 'boolean', 'array.at': 'unknown', 'array.with': 'array',

  // Number methods
  'number.toFixed': 'string', 'number.toString': 'string',
}

/** Look up the return type for a method call on a given receiver type. */
export function getMethodReturnType(receiverType: MethodReceiverType, method: string): ReturnTypeValue | undefined {
  const key: ReturnTypeKey = `${receiverType}.${method}`
  return key in RETURN_TYPES ? RETURN_TYPES[key] : undefined
}

/** Type guard: narrows an InferredTypeName to MethodReceiverType (types that have method catalogs). */
export function isMethodReceiverType(t: string): t is MethodReceiverType {
  return t in METHODS_BY_TYPE
}

/** Re-export shared blocked names for use in completion filtering. */
export const BLOCKED_NAMES: ReadonlySet<string> = BLOCKED_PROPERTIES

export const KEYWORDS = ['true', 'false', 'null', 'undefined', 'in', 'not in'] as const
