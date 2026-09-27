// Canonical display format for Bonsai values in the documentation.
// Strings are JSON-quoted, timestamps print as ISO-8601 text, durations as
// ISO-8601 durations (the text a template renders), and maps use JavaScript
// object-literal style with unquoted identifier keys.
import { Duration } from '../../src/index.ts'

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

export function display(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value)
  if (typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Duration) return value.toString()
  if (Array.isArray(value)) return `[${value.map(display).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const body = entries
      .map(([k, v]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${display(v)}`)
      .join(', ')
    return `{ ${body} }`
  }
  return String(value)
}

/** Collapses whitespace so hand-written expectations can wrap across lines. */
export function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/\[ /gu, '[').replace(/ \]/gu, ']').trim()
}

/** The fixed clock documentation examples run with, so now() is stable. */
export const CLOCK = '2026-01-15T10:30:00.000Z'
