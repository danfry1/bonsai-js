import type { BonsaiPlugin } from '../types.js'
import { BonsaiTypeError } from '../errors.js'

function expectNumber(val: unknown, name: string): number {
  if (typeof val !== 'number') throw new BonsaiTypeError(name, 'a number (timestamp)', val)
  return val
}

function expectString(val: unknown, name: string): string {
  if (typeof val !== 'string') throw new BonsaiTypeError(name, 'a string', val)
  return val
}

export const dates: BonsaiPlugin = (expr) => {
  expr.addFunction('now', () => Date.now())

  expr.addTransform('formatDate', (val: unknown, format: unknown) => {
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
  })

  expr.addTransform('diffDays', (val: unknown, other: unknown) => {
    const msPerDay = 86_400_000
    return Math.abs(
      Math.round((expectNumber(val, 'diffDays') - expectNumber(other, 'diffDays')) / msPerDay),
    )
  })
}
