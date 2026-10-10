import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

/** A value or the code of the error evaluation raised. */
async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return { value: await run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

const variables = { user: t.object({ age: t.number(), tags: t.list(t.string()) }) }
const bad = { user: { age: '36', tags: [] } } as never

describe('the validateContext evaluation option', () => {
  const validated = bonsai({ variables, validateContext: true })
  const unvalidated = bonsai({ variables })

  it('turns validation off for one evaluation of a validating environment', async () => {
    const program = validated.compile('user.tags.length')
    expect(await outcome(() => program.evaluateSync(bad))).toEqual({ code: 'INVALID_CONTEXT' })
    expect(await outcome(() => program.evaluateSync(bad, { validateContext: false }))).toEqual({
      value: 0,
    })
    expect(await outcome(() => program.evaluate(bad, { validateContext: false }))).toEqual({
      value: 0,
    })
    expect(program.explainSync(bad, { validateContext: false }).ok).toBe(true)
    expect((await program.explain(bad, { validateContext: false })).ok).toBe(true)
    expect(
      await outcome(() =>
        validated.evaluateSync('user.tags.length', bad, { validateContext: false }),
      ),
    ).toEqual({ value: 0 })
  })

  it('turns validation on for one evaluation of a non-validating environment', async () => {
    const program = unvalidated.compile('user.tags.length')
    expect(await outcome(() => program.evaluateSync(bad))).toEqual({ value: 0 })
    expect(await outcome(() => program.evaluateSync(bad, { validateContext: true }))).toEqual({
      code: 'INVALID_CONTEXT',
    })
    const explained = program.explainSync(bad, { validateContext: true })
    expect(explained.ok ? undefined : explained.error.code).toBe('INVALID_CONTEXT')
    expect(
      await outcome(() => unvalidated.evaluate('user.tags.length', bad, { validateContext: true })),
    ).toEqual({ code: 'INVALID_CONTEXT' })
  })

  it('rejects a value that is not a boolean, as other options do', () => {
    const program = validated.compile('user.age')
    expect(() =>
      program.evaluateSync({ user: { age: 1, tags: [] } }, { validateContext: 'no' as never }),
    ).toThrow(TypeError)
    expect(() =>
      program.explainSync({ user: { age: 1, tags: [] } }, { validateContext: 1 as never }),
    ).toThrow(TypeError)
  })

  it('applies to residuals, including ones that read the whole context', async () => {
    const env = bonsai({
      validateContext: true,
      variables: {
        tenant: t.object({ max: t.number() }),
        user: t.object({ id: t.string(), level: t.number() }),
        region: t.string(),
      },
      functions: {
        isAdmin: fn({
          params: [],
          returns: t.boolean(),
          call: true,
          run: (call) => (call.context.user as { id: string }).id === 'root',
        }),
      },
    })
    const residual = env.compile('user.level <= tenant.max || isAdmin()').partial({
      tenant: { max: 2 },
    })
    if (residual.status !== 'residual') throw new Error('expected a residual')
    expect(residual.readsContext).toBe(true)
    // The whole context is validated on every evaluation (region is declared but missing);
    // a caller who validated what it needs upstream can skip that.
    const context = { tenant: { max: 2 }, user: { id: 'root', level: 5 } }
    expect(await outcome(() => residual.evaluateSync(context))).toEqual({
      code: 'INVALID_CONTEXT',
    })
    expect(await outcome(() => residual.evaluateSync(context, { validateContext: false }))).toEqual(
      { value: true },
    )
    // The known roots are still required: that is not validation.
    expect(
      await outcome(() =>
        residual.evaluateSync({ user: { id: 'root', level: 1 } }, { validateContext: false }),
      ),
    ).toEqual({ code: 'INVALID_CONTEXT' })
  })
})

describe('context validation of numbers', () => {
  const env = bonsai({
    validateContext: true,
    variables: {
      n: t.number(),
      order: t.object({ lines: t.list(t.object({ price: t.optional(t.number()) })) }),
      scores: t.record(t.number()),
      either: t.union(t.number(), t.string()),
    },
  })
  const valid = {
    n: 1,
    order: { lines: [{ price: 2 }, {}] },
    scores: { a: 1 },
    either: 'x',
  }

  it('accepts finite numbers', async () => {
    expect(await outcome(() => env.evaluateSync('n', valid))).toEqual({ value: 1 })
  })

  it.each([
    ['a top-level number', { n: Number.NaN }, 'n'],
    [
      'a field inside a list',
      { order: { lines: [{ price: Number.POSITIVE_INFINITY }] } },
      'order.lines[0].price',
    ],
    ['a record entry', { scores: { a: Number.NEGATIVE_INFINITY } }, 'scores.a'],
    ['a union member', { either: Number.NaN }, 'either'],
  ])('rejects NaN and infinities in %s, naming the path', (_label, change, path) => {
    const context = { ...valid, ...change }
    expect(() => env.evaluateSync('n', context)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTEXT', message: expect.stringContaining(path) }),
    )
  })

  it('leaves undeclared and any-typed values alone', async () => {
    const open = bonsai({ validateContext: true, variables: { x: t.any() } })
    expect(await outcome(() => open.evaluateSync('x', { x: Number.NaN }))).toEqual({
      value: Number.NaN,
    })
  })
})
