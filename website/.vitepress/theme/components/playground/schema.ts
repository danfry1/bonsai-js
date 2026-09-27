// Turns the playground's context rows (name + JSON text) into an evaluation
// context and a variable schema, so the playground can type-check, complete,
// and hover against the data the user typed.
import { t, type Type } from '../../../../../src/index.ts'

export interface ContextRow {
  name: string
  value: string
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/u
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
// Keys Bonsai never reads; skipping them also keeps plain-object assignment safe.
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype'])

/** Strict JSON first, then a relaxed form (single quotes, unquoted keys), then raw text. */
export function parseValue(raw: string): unknown {
  const text = raw.trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    // fall through
  }
  try {
    const normalized = text
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/gu, '"$1"')
      .replace(/(?<=[{,]\s*)([A-Za-z_$][\w$]*)\s*:/gu, '"$1":')
    return JSON.parse(normalized)
  } catch {
    return raw
  }
}

/** ISO-8601 date-time strings (with a zone) become Dates, i.e. timestamps. */
export function revive(value: unknown): unknown {
  if (typeof value === 'string' && ISO_DATE_TIME.test(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date
  }
  if (Array.isArray(value)) return value.map(revive)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) if (!BLOCKED.has(key)) out[key] = revive(item)
    return out
  }
  return value
}

/** The type of a sample value. Unknown shapes are `any`, so the checker stays permissive. */
export function typeOf(value: unknown): Type {
  if (value === null || value === undefined) return t.any()
  if (typeof value === 'string') return t.string()
  if (typeof value === 'number') return t.number()
  if (typeof value === 'boolean') return t.boolean()
  if (value instanceof Date) return t.timestamp()
  if (Array.isArray(value)) {
    if (value.length === 0) return t.list(t.any())
    return t.list(value.map(typeOf).reduce(merge))
  }
  if (typeof value === 'object') {
    const fields: Record<string, Type> = {}
    for (const [key, item] of Object.entries(value)) if (!BLOCKED.has(key)) fields[key] = typeOf(item)
    return t.object(fields)
  }
  return t.any()
}

/** The type of values that may be either `a` or `b`, for list elements. */
function merge(a: Type, b: Type): Type {
  if (a.kind === 'any' || b.kind === 'any') return t.any()
  if (JSON.stringify(a) === JSON.stringify(b)) return a
  if (a.kind === 'map' && b.kind === 'map') {
    const fields: Record<string, Type> = {}
    for (const key of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
      const left = a.fields[key]
      const right = b.fields[key]
      fields[key] =
        left !== undefined && right !== undefined
          ? merge(left, right)
          : t.optional((left ?? right) as Type)
    }
    return t.object(fields)
  }
  if (a.kind === 'list' && b.kind === 'list') return t.list(merge(a.element, b.element))
  return t.any()
}

export function buildContext(rows: readonly ContextRow[]): {
  context: Record<string, unknown>
  variables: Record<string, Type>
} {
  const context: Record<string, unknown> = {}
  const variables: Record<string, Type> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!IDENTIFIER.test(name) || BLOCKED.has(name)) continue
    const value = revive(parseValue(row.value))
    context[name] = value
    variables[name] = typeOf(value)
  }
  return { context, variables }
}
