import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'
import { codeOf } from './helpers.js'

const env = bonsai()

describe('sandbox', () => {
  it('blocks prototype navigation in every syntactic position', () => {
    for (const source of [
      'x.__proto__',
      'x.constructor',
      'x.prototype',
      '{ __proto__: 1 }',
      '{ constructor: 1 }',
      'let constructor = 1; constructor',
    ]) {
      expect(['SYNTAX', 'CHECK']).toContain(codeOf(() => env.evaluateSync(source, { x: {} })))
    }
    for (const source of ['x["__proto__"]', 'x["constru" + "ctor"]', '{ [k]: 1 }']) {
      expect(codeOf(() => env.evaluateSync(source, { x: {}, k: '__proto__' }))).toBe(
        'BLOCKED_PROPERTY',
      )
    }
  })

  it('never reads inherited members', () => {
    class Account {
      balance = 10
      // oxlint-disable-next-line typescript/class-literal-property-style -- the getter must live on the prototype
      get secret(): string {
        return 'prototype getter'
      }
      withdraw(): number {
        return 0
      }
    }
    const account = new Account()
    expect(env.evaluateSync('a.balance', { a: account })).toBe(10)
    expect(env.evaluateSync('a.secret', { a: account })).toBe(null)
    expect(env.evaluateSync('a.withdraw', { a: account })).toBe(null)
    expect(env.evaluateSync('a.toString', { a: {} })).toBe(null)
    expect(env.evaluateSync('a.hasOwnProperty', { a: {} })).toBe(null)
  })

  it('never calls functions found in data', () => {
    let called = false
    const ctx = {
      evil: () => {
        called = true
        return 1
      },
      obj: { trim: () => ((called = true), 'x') },
    }
    expect(codeOf(() => env.evaluateSync('evil()', ctx))).toBe('CHECK')
    expect(env.evaluateSync('obj.trim', ctx)).toBeTypeOf('function')
    expect(codeOf(() => env.evaluateSync('obj.trim()', ctx))).toBe('NO_OVERLOAD')
    expect(codeOf(() => env.evaluateSync('[1].map(evil)', ctx))).toBe('CHECK')
    expect(called).toBe(false)
  })

  it('does not run conversion hooks', () => {
    let hooked = false
    const sneaky = {
      valueOf: () => ((hooked = true), 1),
      toString: () => ((hooked = true), 'x'),
      [Symbol.toPrimitive]: () => ((hooked = true), 1),
    }
    for (const source of [
      'v + 1',
      'v < 2',
      '`${v}`',
      '"a" + v',
      'v == 1',
      'v in [1]',
      '[1][v]',
      'toString(v)',
    ]) {
      try {
        env.evaluateSync(source, { v: sneaky })
      } catch {
        // errors are fine; hooks are not
      }
    }
    expect(hooked).toBe(false)
  })

  it('ignores array subclass hooks and does not mutate host data', () => {
    class Sneaky extends Array<number> {
      static override get [Symbol.species](): ArrayConstructor {
        throw new Error('species hook ran')
      }
    }
    const xs = Sneaky.from([3, 1, 2]) as Sneaky
    expect(env.evaluateSync('xs.sort()', { xs })).toEqual([1, 2, 3])
    expect(env.evaluateSync('xs.reverse()', { xs })).toEqual([2, 1, 3])
    expect(env.evaluateSync('xs.filter(. > 1)', { xs })).toEqual([3, 2])
    expect([...xs]).toEqual([3, 1, 2])
  })

  it('produced maps are plain objects and skip blocked keys from spread host data', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as object
    const result = env.evaluateSync('{ ...h, x: 1 }', { h: hostile }) as Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.keys(result).sort()).toEqual(['ok', 'x'])
    expect(({} as Record<string, unknown>).polluted).toBe(undefined)
    expect(env.evaluateSync('keys(h)', { h: hostile })).toEqual(['ok'])
  })

  it('has no access to globals', () => {
    for (const name of [
      'globalThis',
      'process',
      'window',
      'eval',
      'Function',
      'require',
      'import',
    ]) {
      expect(env.evaluateSync(name)).toBe(null)
    }
  })

  it('does not execute a thenable in the context', async () => {
    let executed = false
    const query = {
      then: () => {
        executed = true
      },
    }
    expect(env.evaluateSync('q', { q: query })).toBe(query)
    expect(await env.evaluate('q == null', { q: query })).toBe(false)
    await expect(env.evaluate('q', { q: query })).rejects.toMatchObject({ code: 'TYPE_ERROR' })
    expect(executed).toBe(false)
  })
})
