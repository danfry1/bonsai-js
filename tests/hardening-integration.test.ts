import { describe, expect, it } from 'vitest'
import { bonsai, formatType, t } from '../src/index.js'

describe('expect is enforced at run time when the checker cannot prove it', () => {
  it('rejects a result that does not match an expected type the checker could not verify', () => {
    const env = bonsai()
    const program = env.compile('x', { expect: t.number() })
    expect(program.evaluateSync({ x: 5 })).toBe(5)
    expect(() => program.evaluateSync({ x: 'five' })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })

  it('checks nested values the checker only knew as any', async () => {
    const env = bonsai({ variables: { row: t.object({ id: t.number() }) } })
    const program = env.compile('values(row)', { expect: t.list(t.number()) })
    expect(program.evaluateSync({ row: { id: 1 } })).toEqual([1])
    // Declared objects are open: an extra key can hold anything.
    const extra = { row: { id: 1, name: 'x' } } as { row: { id: number } }
    await expect(program.evaluate(extra)).rejects.toMatchObject({
      code: 'TYPE_ERROR',
    })
  })

  it('adds no check when the checker proved the type', () => {
    const env = bonsai({ variables: { n: t.number() } })
    const program = env.compile('n + 1', { expect: t.number() })
    expect(program.evaluateSync({ n: 1 })).toBe(2)
  })
})

describe('opaque host values are never read into', () => {
  const env = bonsai()
  it.each([
    ['err.message', { err: new Error('secret') }],
    ['re.lastIndex', { re: /a/gu }],
    ['m.size', { m: new Map([['a', 1]]) }],
  ])('%s is a TYPE_ERROR', (source, context) => {
    expect(() => env.evaluateSync(source, context)).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })
})

describe('any absorbs the type variables it flows into', () => {
  const env = bonsai({ variables: { xs: t.list(t.number()), anything: t.any() } })

  it('types reduce over an empty list from an unknown initial value as any', () => {
    const source = 'reduce([], (acc, x) => [acc, x], anything)'
    expect(formatType(env.check(source).type ?? t.never())).toBe('any')
    expect(env.evaluateSync(source, { xs: [], anything: null })).toBeNull()
  })
})

describe('last resource-bound holes', () => {
  const env = bonsai()

  it('charges both key lists before comparing map sizes', () => {
    const source =
      'let m = "a".repeat(50000).split("").groupBy((x, i) => i); "a".repeat(100000).split("").map(x => m == {} || m == {}).length'
    expect(() => env.evaluateSync(source)).toThrow(expect.objectContaining({ code: 'STEP_LIMIT' }))
    // A modest map still compares.
    expect(env.evaluateSync('{a: 1, b: 2} == {a: 1}')).toBe(false)
  })

  it('merges a union of maps once, within the check budget', () => {
    const members = Array.from({ length: 2000 }, (_, i) => `{k${i}: 1}`).join(' ?? ')
    const spreads = Array.from({ length: 200 }, () => '{...u}').join(', ')
    const big = bonsai({ limits: { maxSourceLength: 1_000_000, maxNodes: 1_000_000 } })
    const start = performance.now()
    try {
      big.check(`let u = ${members}; [${spreads}]`)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('TOO_COMPLEX')
    }
    // Unbudgeted this took eight seconds; bounded work takes well under one.
    expect(performance.now() - start).toBeLessThan(5000)
  })
})
