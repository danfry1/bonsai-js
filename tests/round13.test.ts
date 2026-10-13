import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

/** The code of the Bonsai error `run` throws or rejects with, or `value` when it returns. */
async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
    return 'value'
  } catch (error) {
    return error instanceof BonsaiError ? error.code : 'RAW'
  }
}

/** Sync and async twins of a counting host function, and their environments. */
// oxlint-disable-next-line typescript/explicit-function-return-type -- the environments' inferred types
function twins(limits: { maxListLength: number }) {
  let calls = 0
  const run = (x: number): number => {
    calls++
    return x
  }
  const variables = { xs: t.list(t.number()) }
  return {
    calls: () => calls,
    sync: bonsai({
      variables,
      limits,
      functions: { f: fn({ params: [t.number()], returns: t.number(), run }) },
    }),
    async: bonsai({
      variables,
      limits,
      functions: {
        f: fn({
          params: [t.number()],
          returns: t.number(),
          async: true,
          run: (x) => Promise.resolve(run(x)),
        }),
      },
    }),
  }
}

describe('round 13: async built-ins and literals check limits in the sync order', () => {
  const xs = Array.from({ length: 10 }, (_, i) => i)

  it('sortBy refuses an over-long list before running any key lambda', async () => {
    const { calls, sync, async } = twins({ maxListLength: 4 })
    const src = 'xs.sortBy(v => f(v))'
    expect(await codeOf(() => sync.evaluateSync(src, { xs }))).toBe('LIST_LIMIT')
    expect(calls()).toBe(0)
    expect(await codeOf(() => async.evaluate(src, { xs }))).toBe('LIST_LIMIT')
    expect(calls()).toBe(0)
    // Same step budget, same outcome: the limit comes first in both.
    expect(await codeOf(() => async.evaluate(src, { xs }, { maxSteps: 200 }))).toBe('LIST_LIMIT')
    expect(calls()).toBe(0)
  })

  it('a list literal longer than maxListLength fails before its items run', async () => {
    const { calls, sync, async } = twins({ maxListLength: 2 })
    const src = '[f(1), f(2), f(3), f(4)]'
    expect(await codeOf(() => sync.evaluateSync(src, { xs }))).toBe('LIST_LIMIT')
    expect(calls()).toBe(0)
    expect(await codeOf(() => async.evaluate(src, { xs }, { maxSteps: 80 }))).toBe('LIST_LIMIT')
    expect(calls()).toBe(0)
  })
})

describe('round 13: explain() of an async program checks its result in evaluate() order', () => {
  let thenReads = 0
  const q = {
    get then(): () => void {
      thenReads++
      return () => undefined
    },
  }
  const env = bonsai({
    functions: {
      k: fn({ params: [], returns: t.boolean(), async: true, run: () => Promise.resolve(true) }),
    },
  })
  const program = env.compile('k() ? q : null', {
    expect: t.optional(t.object({ a: t.number() })),
  })

  it('reports the expected-type failure evaluate() reports, without reading then', async () => {
    let evaluated: unknown
    try {
      await program.evaluate({ q })
    } catch (error) {
      evaluated = error
    }
    const explained = await program.explain({ q })
    expect(explained.ok).toBe(false)
    if (explained.ok) return
    expect(evaluated).toBeInstanceOf(BonsaiError)
    expect(explained.error.code).toBe((evaluated as BonsaiError).code)
    expect(explained.error.message).toBe((evaluated as BonsaiError).message)
    expect(explained.error.message).not.toMatch(/promise-like/u)
    expect(thenReads).toBe(0)
  })
})
