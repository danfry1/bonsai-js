import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'
import { NUMBER_TYPE, STRING_TYPE, parameter } from './metadata.js'

const SYSTEM_NOW = Date.now.bind(Date)

export interface DatesOptions {
  /** Clock used by `now()`. Defaults to the host wall clock. */
  readonly now?: () => number
}

function expectNumber(val: unknown, name: string): number {
  if (typeof val !== 'number') throw new BonsaiTypeError(name, 'a number (timestamp)', val)
  return val
}

function expectString(val: unknown, name: string): string {
  if (typeof val !== 'string') throw new BonsaiTypeError(name, 'a string', val)
  return val
}

/** Create the date plugin with an injectable clock for deterministic evaluation and tests. */
export function createDates(options: DatesOptions = {}): BonsaiPlugin {
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('bonsai: dates now option must be a function')
  }
  const now = options.now ?? SYSTEM_NOW
  return (expr) => {
    expr.addFunction('now', () => now(), { parameters: [], returnType: NUMBER_TYPE })

    expr.addTransform(
      'formatDate',
      (val: unknown, format: unknown) => {
        const ts = expectNumber(val, 'formatDate')
        const date = new Date(ts)
        if (isNaN(date.getTime())) throw new BonsaiTypeError('formatDate', 'a valid timestamp', ts)
        const fmt = expectString(format, 'formatDate')
        const PAD_WIDTH = 2
        const pad = (n: number) => String(n).padStart(PAD_WIDTH, '0')

        // Single global pass so every occurrence of a token is replaced (chained
        // String.replace only replaces the first match) and tokens cannot interfere
        // with each other's output.
        const parts: Record<string, string> = {
          YYYY: String(date.getUTCFullYear()),
          MM: pad(date.getUTCMonth() + 1),
          DD: pad(date.getUTCDate()),
          HH: pad(date.getUTCHours()),
          mm: pad(date.getUTCMinutes()),
          ss: pad(date.getUTCSeconds()),
        }
        return fmt.replace(/YYYY|MM|DD|HH|mm|ss/gu, (token) => parts[token])
      },
      {
        inputType: NUMBER_TYPE,
        parameters: [parameter('format', STRING_TYPE)],
        returnType: STRING_TYPE,
      },
    )

    expr.addTransform(
      'diffDays',
      (val: unknown, other: unknown) => {
        const msPerDay = 86_400_000
        return Math.abs(
          Math.round((expectNumber(val, 'diffDays') - expectNumber(other, 'diffDays')) / msPerDay),
        )
      },
      {
        inputType: NUMBER_TYPE,
        parameters: [parameter('other', NUMBER_TYPE)],
        returnType: NUMBER_TYPE,
      },
    )
  }
}

/** Date plugin backed by the host wall clock. Use `createDates({ now })` for determinism. */
export const dates: BonsaiPlugin = createDates()
