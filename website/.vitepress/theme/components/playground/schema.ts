// Turns the playground's data (one JSON object, each key a variable) into an
// evaluation context and a variable schema, so the playground can type-check,
// complete, and hover against the data the user typed.
import { t, type Type } from '../../../../../src/index.ts'

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/u
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
// Keys Bonsai never reads; skipping them also keeps plain-object assignment safe.
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype'])

/** Strict JSON, else a relaxed form (single quotes, unquoted keys); throws strict JSON's error. */
function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const normalized = text
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/gu, '"$1"')
      .replace(/(?<=[{,]\s*)([A-Za-z_$][\w$]*)\s*:/gu, '"$1":')
    try {
      return JSON.parse(normalized)
    } catch {
      throw error
    }
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
  // A field missing from some items is optional; merging it with the field's own type keeps it optional.
  const base = (x: Type): Type | undefined =>
    x.kind === 'union' && x.types.length === 2 && x.types.some((m) => m.kind === 'null')
      ? x.types.find((m) => m.kind !== 'null')
      : undefined
  if (base(a) || base(b)) return t.optional(merge(base(a) ?? a, base(b) ?? b))
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

export type Data =
  | { ok: true; context: Record<string, unknown>; variables: Record<string, Type> }
  | { ok: false; message: string }

/** The data as typed: a JSON object whose keys are the variables. Keys that aren't names are skipped. */
export function parseData(text: string): Data {
  let value: unknown
  try {
    value = text.trim() === '' ? {} : parseJSON(text)
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'The data must be a JSON object; each key is a variable.' }
  }
  const context: Record<string, unknown> = {}
  const variables: Record<string, Type> = {}
  for (const [name, item] of Object.entries(value)) {
    if (!IDENTIFIER.test(name) || BLOCKED.has(name)) continue
    context[name] = revive(item)
    variables[name] = typeOf(context[name])
  }
  return { ok: true, context, variables }
}

/** One JSON object from the name and value text of each variable, as older share links store them. */
export function fromRows(rows: Readonly<Record<string, string>>): string {
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(rows)) {
    try {
      out[name.trim()] = raw.trim() === '' ? null : parseJSON(raw)
    } catch {
      out[name.trim()] = raw
    }
  }
  return JSON.stringify(out, null, 2)
}
