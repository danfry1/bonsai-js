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

describe('partial() checks a list literal against maxListLength in evaluation order', () => {
  const env = bonsai({
    variables: { z: t.number() },
    limits: { maxListLength: 2 },
    functions: {
      ha: fn({
        params: [t.number()],
        returns: t.number(),
        async: true,
        run: (x) => Promise.resolve(x),
      }),
    },
  })

  it('reports LIST_LIMIT, as evaluation does, when an item awaits a host function', async () => {
    const program = env.compile('[1 / z, 2, ha(1)]')
    expect(await codeOf(() => program.evaluate({ z: 0 }))).toBe('LIST_LIMIT')
    expect(
      await codeOf(() => program.partial({ z: 0 }, { unknown: [], callHostFunctions: true })),
    ).toBe('LIST_LIMIT')
  })
})
