import { BLOCKED_PROPERTIES } from '../execution-context.js'
import type { InferredTypeName, ResolveResult } from '../types.js'
import { getMethodReturnType } from './catalog.js'

export function inferType(value: unknown): InferredTypeName {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value as InferredTypeName
}

export interface ResolveOptions {
  allowedProperties?: ReadonlySet<string>
  deniedProperties?: ReadonlySet<string>
}

export function resolvePropertyChain(
  context: Record<string, unknown>,
  chain: string[],
  policy?: ResolveOptions,
): ResolveResult {
  let current: unknown = context
  for (const key of chain) {
    if (BLOCKED_PROPERTIES.has(key)) return { found: false, reason: 'blocked' }
    if (policy?.allowedProperties && !policy.allowedProperties.has(key)) return { found: false, reason: 'blocked' }
    if (policy?.deniedProperties?.has(key)) return { found: false, reason: 'blocked' }
    if (current == null || typeof current !== 'object') return { found: false, reason: 'not-object' }
    const obj = current as Record<string, unknown>
    if (!(key in obj)) return { found: false, reason: 'not-found' }
    current = obj[key]
  }
  return { found: true, value: current }
}

// ── Element type info ──────────────────────────────────────────

export type ElementTypeInfo =
  | { type: 'unknown'; properties: []; value: undefined }
  | { type: 'object'; properties: string[]; value: Record<string, unknown> }
  | { type: 'string'; properties: []; value: string }
  | { type: 'number'; properties: []; value: number }
  | { type: 'boolean'; properties: []; value: boolean }
  | { type: 'array'; properties: []; value: unknown[] }
  | { type: 'null'; properties: []; value: null }

export function inferElementType(array: unknown[]): ElementTypeInfo {
  const first = array.find(el => el != null)
  if (first === undefined) return { type: 'unknown', properties: [], value: undefined }

  const type = inferType(first)
  if (type === 'object' && first !== null && typeof first === 'object') {
    return {
      type: 'object',
      properties: Object.keys(first as Record<string, unknown>),
      value: first as Record<string, unknown>,
    }
  }
  if (type === 'array') return { type: 'array', properties: [], value: first as unknown[] }
  if (type === 'string') return { type: 'string', properties: [], value: first as string }
  if (type === 'number') return { type: 'number', properties: [], value: first as number }
  if (type === 'boolean') return { type: 'boolean', properties: [], value: first as boolean }
  return { type: 'unknown', properties: [], value: undefined }
}

export function inferMethodReturnType(receiverType: string, method: string): string {
  return getMethodReturnType(receiverType, method) ?? 'unknown'
}

export function enumerateProperties(value: unknown): string[] {
  if (value == null || typeof value !== 'object') return []
  return Object.keys(value as Record<string, unknown>)
}
