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
  class Account {
    readonly balance: number
    constructor(balance: number) {
      this.balance = balance
    }
  }

  it.each([
    ['err.message', { err: new Error('secret') }],
    ['re.lastIndex', { re: /a/gu }],
    ['m.size', { m: new Map([['a', 1]]) }],
  ])('%s is a TYPE_ERROR', (source, context) => {
    expect(() => env.evaluateSync(source, context)).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })

  it('still reads own fields of plain objects and class instances', () => {
    expect(env.evaluateSync('a.balance', { a: new Account(5) })).toBe(5)
    expect(env.evaluateSync('a.missing', { a: { x: 1 } })).toBeNull()
  })
})

describe('any absorbs the type variables it flows into', () => {
  const env = bonsai({ variables: { xs: t.list(t.number()), anything: t.any() } })

  it('types reduce over an empty list from an unknown initial value as any', () => {
    const source = 'reduce([], (acc, x) => [acc, x], anything)'
    expect(formatType(env.check(source).type ?? t.never())).toBe('any')
    expect(env.evaluateSync(source, { xs: [], anything: null })).toBeNull()
  })

  it('keeps reduce errors found while the accumulator widens', () => {
    const typed = bonsai({ variables: { ss: t.list(t.string()) } })
    expect(typed.check('reduce(ss, (acc, x) => acc.toFixed(1), 0)').ok).toBe(false)
  })
})
