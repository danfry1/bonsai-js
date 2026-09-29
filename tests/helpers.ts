// Shared test helpers. Not a test file itself (vitest only collects *.test.ts).
import { expect } from 'vitest'
import { BonsaiError, bonsai } from '../src/index.js'

type Env = ReturnType<typeof bonsai>

/** The value, or the error code, of an evaluation. Anything but a BonsaiError fails the test. */
export function outcome(f: () => unknown): unknown {
  try {
    return { value: f() }
  } catch (error) {
    expect(error).toBeInstanceOf(BonsaiError)
    return { code: (error as BonsaiError).code }
  }
}

export async function outcomeAsync(f: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: await f() }
  } catch (error) {
    expect(error).toBeInstanceOf(BonsaiError)
    return { code: (error as BonsaiError).code }
  }
}

/** The code of the BonsaiError `f` throws, or 'OK' when it completes. Any other error is rethrown. */
export function codeOf(f: () => unknown): string {
  try {
    f()
  } catch (error) {
    if (error instanceof BonsaiError) return error.code
    throw error
  }
  return 'OK'
}

const env = bonsai()

/** `outcome` of evaluating `source` in a default environment, optionally under a step budget. */
export const run = (
  source: string,
  ctx: Record<string, unknown> = {},
  maxSteps?: number,
): unknown =>
  outcome(() => env.evaluateSync(source, ctx, maxSteps === undefined ? undefined : { maxSteps }))

/** The smallest step budget with which `source` completes. */
export function minimalSteps(e: Env, source: string, ctx: Record<string, unknown>): number {
  let low = 1
  let high = 10_000_000
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const result = outcome(() => e.evaluateSync(source, ctx, { maxSteps: mid }))
    if ((result as { code?: string }).code === 'STEP_LIMIT') low = mid + 1
    else high = mid
  }
  return low
}
