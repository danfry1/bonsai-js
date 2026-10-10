import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, t } from '../src/index.js'

/** The value evaluation returned, or the code of the error it raised. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

describe('a size limit in a part evaluation may skip does not end partial()', () => {
  it('leaves a list that would be too long in a branch the program may skip', () => {
    const env = bonsai({
      variables: { xs: t.list(t.number()), n: t.number() },
      limits: { maxListLength: 3 },
    })
    const guarded = env.compile('n > 0 && (xs + xs).length > 0')
    const result = guarded.partial({ xs: [1, 2, 3] })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(result.evaluateSync({ xs: [1, 2, 3], n: 0 })).toBe(false)
    expect(outcome(() => result.evaluateSync({ xs: [1, 2, 3], n: 1 }))).toEqual({
      code: 'LIST_LIMIT',
    })

    // The left operand fails first when n is 0, as evaluation reports.
    const ordered = env.compile('(1 / n) + (xs + xs).length')
    const residual = ordered.partial({ xs: [1, 2, 3] })
    expect(residual.status).toBe('residual')
    if (residual.status !== 'residual') return
    expect(outcome(() => residual.evaluateSync({ xs: [1, 2, 3], n: 0 }))).toEqual({
      code: 'DIVISION_BY_ZERO',
    })
  })

  it('leaves a string that would be too long, as folding known values builds it', () => {
    const env = bonsai({
      variables: {
        row: t.object({ flag: t.boolean(), k: t.optional(t.number()) }),
        n: t.optional(t.number()),
      },
    })
    for (const source of [
      'row.flag ? "x".repeat(n ?? row.k ?? 0).length : 0',
      'row.flag && "x".repeat(n ?? row.k ?? 0).length > 5',
    ]) {
      const program = env.compile(source)
      const result = program.partial({ n: 1e8 }, { unknown: ['row'] })
      expect(result.status).toBe('residual')
      if (result.status !== 'residual') continue
      const context = { row: { flag: false, k: 1 }, n: 1e8 }
      expect(result.evaluateSync(context)).toEqual(program.evaluateSync(context))
    }
  })

  it('still throws a limit every completion reaches, as evaluation does', () => {
    const env = bonsai({
      variables: { xs: t.list(t.number()), n: t.number() },
      limits: { maxListLength: 3 },
    })
    expect(() => env.compile('try((xs + xs).length, 0)').partial({ xs: [1, 2, 3] })).toThrow(
      expect.objectContaining({ code: 'LIST_LIMIT' }),
    )
  })

  it('reports the list literal limit before the errors of its items, as evaluation does', () => {
    const env = bonsai({ variables: { n: t.number() }, limits: { maxListLength: 1 } })
    const program = env.compile('[1 / 0, n]')
    expect(outcome(() => program.evaluateSync({ n: 1 }))).toEqual({ code: 'LIST_LIMIT' })
    expect(outcome(() => program.partial({}))).toEqual({ code: 'LIST_LIMIT' })
  })
})

describe('explaining a residual costs the steps evaluating it does', () => {
  it('fits the same step budget', () => {
    const env = bonsai({ variables: { u: t.object({ tags: t.list(t.string()) }) } })
    const residual = env.compile('u.tags').partial({}, { unknown: ['u'] })
    if (residual.status !== 'residual') throw new Error('expected a residual')
    const data = { u: { tags: ['a'] } }
    expect(residual.evaluateSync(data, { maxSteps: 1 })).toEqual(['a'])
    const explained = residual.explainSync(data, { maxSteps: 1 })
    expect(explained.ok).toBe(true)
    if (explained.ok) expect(explained.value).toEqual(['a'])
  })

  it('reaches the same limit first', () => {
    const env = bonsai({
      variables: { u: t.object({ name: t.string() }) },
      limits: { maxStringLength: 1 },
    })
    const residual = env.compile('[u.name].first()').partial({}, { unknown: ['u'] })
    if (residual.status !== 'residual') throw new Error('expected a residual')
    for (const maxSteps of [1, 2, 3, 4, 5]) {
      const data = { u: { name: 'k1' } }
      const evaluated = outcome(() => residual.evaluateSync(data, { maxSteps }))
      const explained = residual.explainSync(data, { maxSteps })
      expect(explained.ok ? { value: explained.value } : { code: explained.error.code }).toEqual(
        evaluated,
      )
    }
  })
})

describe('partial() and evaluation agree under small size limits', () => {
  const env = bonsai({
    variables: {
      row: t.object({ flag: t.boolean() }),
      n: t.number(),
      xs: t.list(t.number()),
      s: t.string(),
      k: t.number(),
    },
    limits: { maxListLength: 3, maxStringLength: 4 },
  })
  const sized = fc.constantFrom(
    '(xs + xs).length > 0',
    '(xs + xs + xs).length > 0',
    '[xs, xs, xs, xs].length > 0',
    '(s + s).length > 0',
    's.repeat(k).length > 0',
    '1 / n > 0',
    'xs.length > 0',
  )
  const shape = fc.constantFrom(
    (e: string) => `row.flag && ${e}`,
    (e: string) => `row.flag ? ${e} : false`,
    (e: string) => `!row.flag || ${e}`,
    (e: string) => `n > 0 && ${e}`,
    (e: string) => `try(${e}, false)`,
    (e: string) => `${e} && row.flag`,
    (e: string) => e,
  )
  const data = fc.record({
    n: fc.constantFrom(-1, 0, 1),
    xs: fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 }),
    s: fc.string({ maxLength: 3 }),
    k: fc.integer({ min: 0, max: 4 }),
  })

  it('throws a size limit only when every completion throws it, and the residual matches', () => {
    fc.assert(
      fc.property(sized, shape, data, fc.boolean(), (part, wrap, known, nUnknown) => {
        const program = env.compile(wrap(part))
        const unknown = nUnknown ? ['row', 'n'] : ['row']
        const given = nUnknown ? { xs: known.xs, s: known.s, k: known.k } : known
        const completions = [true, false].flatMap((flag) =>
          (nUnknown ? [-1, 0, 1] : [known.n]).map((n) => ({ ...known, n, row: { flag } })),
        )
        const expected = completions.map((context) => outcome(() => program.evaluateSync(context)))
        const result = outcome(() => program.partial(given, { unknown }))
        if ('code' in (result as object)) {
          for (const each of expected) expect(each).toEqual(result)
          return
        }
        const partial = (result as { value: ReturnType<typeof program.partial> }).value
        completions.forEach((context, i) => {
          if (partial.status === 'value') expect({ value: partial.value }).toEqual(expected[i])
          else if (partial.status === 'error')
            expect({ code: partial.error.code }).toEqual(expected[i])
          else expect(outcome(() => partial.evaluateSync(context))).toEqual(expected[i])
        })
      }),
      { numRuns: 1500 },
    )
  })
})
