import { BLOCKED_PROPERTIES, isCanonicalIndex } from '../execution-context.js'
import type { InferredTypeName, ResolveResult } from '../types.js'
import { getMethodReturnType, type MethodReceiverType } from './catalog.js'

export function inferType(value: unknown): InferredTypeName {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  // function, symbol, bigint → treat as object for completion purposes
  return 'object'
}

/** Shared policy shape for property allow/deny filtering. */
export interface PropertyPolicy {
  allowedProperties?: ReadonlySet<string>
  deniedProperties?: ReadonlySet<string>
}

/** Policy options for property chain resolution. */
export type ResolveOptions = PropertyPolicy

export function resolvePropertyChain(
  context: Record<string, unknown>,
  chain: string[],
  policy?: ResolveOptions,
): ResolveResult {
  let current: unknown = context
  for (const key of chain) {
    if (BLOCKED_PROPERTIES.has(key)) return { found: false, reason: 'blocked' }
    // Canonical numeric indices bypass allow/deny lists, as at runtime.
    if (!isCanonicalIndex(key)) {
      if (policy?.allowedProperties && !policy.allowedProperties.has(key))
        return { found: false, reason: 'blocked' }
      if (policy?.deniedProperties?.has(key) === true) return { found: false, reason: 'blocked' }
    }
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null)
      return { found: false, reason: 'not-object' }
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (!descriptor || !('value' in descriptor)) return { found: false, reason: 'not-found' }
    current = descriptor.value
  }
  return { found: true, value: current }
}

/** Resolve an expression's root identifier without applying member allow/deny policy to it. */
export function resolveContextChain(
  context: Record<string, unknown>,
  chain: string[],
  policy?: ResolveOptions,
): ResolveResult {
  if (chain.length === 0) return { found: false, reason: 'not-found' }
  const root = resolvePropertyChain(context, chain.slice(0, 1))
  if (!root.found || chain.length === 1) return root
  if ((typeof root.value !== 'object' && typeof root.value !== 'function') || root.value === null) {
    return { found: false, reason: 'not-object' }
  }
  return resolvePropertyChain(root.value as Record<string, unknown>, chain.slice(1), policy)
}

// ── Element type info ──────────────────────────────────────────

export type ElementTypeInfo =
  | { type: 'unknown'; properties: []; value: undefined }
  | { type: 'object'; properties: string[]; value: Record<string, unknown> }
  | { type: 'string'; properties: []; value: string }
  | { type: 'number'; properties: []; value: number }
  | { type: 'boolean'; properties: []; value: boolean }
  | { type: 'array'; properties: []; value: unknown[] }

export function inferElementType(array: unknown[]): ElementTypeInfo {
  let first: unknown
  for (const key of Object.keys(array)) {
    if (!/^(?:0|[1-9]\d*)$/u.test(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(array, key)
    if (!descriptor || !('value' in descriptor) || descriptor.value == null) continue
    first = descriptor.value
    break
  }
  if (first === undefined) return { type: 'unknown', properties: [], value: undefined }

  const type = inferType(first)
  if (type === 'object' && first !== null && typeof first === 'object') {
    return {
      type: 'object',
      properties: enumerateProperties(first),
      value: first as Record<string, unknown>,
    }
  }
  if (type === 'array') return { type: 'array', properties: [], value: first as unknown[] }
  if (type === 'string') return { type: 'string', properties: [], value: first as string }
  if (type === 'number') return { type: 'number', properties: [], value: first as number }
  if (type === 'boolean') return { type: 'boolean', properties: [], value: first as boolean }
  return { type: 'unknown', properties: [], value: undefined }
}

export function inferMethodReturnType(
  receiverType: MethodReceiverType,
  method: string,
): InferredTypeName | 'unknown' {
  return getMethodReturnType(receiverType, method) ?? 'unknown'
}

export function enumerateProperties(value: unknown): string[] {
  if (value == null || typeof value !== 'object') return []
  return Object.keys(value).filter((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor
  })
}

/**
 * Copy only enumerable own data properties. Ordinary getters are deliberately
 * excluded so completion can inspect application context without invoking
 * property accessors.
 */
export function snapshotDataProperties(value: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of enumerateProperties(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) snapshot[key] = descriptor.value
  }
  return snapshot
}
