import { describe, expect, it } from 'vitest'
import { bonsai, BonsaiTypeError } from '../src/index.js'
import { arrays, math, strings } from '../src/stdlib/index.js'

describe('data-only evaluation boundary', () => {
  it('reads own root properties, including host-defined own getters, and never inherited ones', async () => {
    let calls = 0
    const context = Object.create({ inherited: 'leak' }) as Record<string, unknown>
    Object.defineProperty(context, 'secret', {
      enumerable: true,
      get() {
        calls++
        return 42
      },
    })
    const expr = bonsai()

    expect(expr.evaluateSync('secret', context)).toBe(42)
    await expect(expr.evaluate('secret', context)).resolves.toBe(42)
    expect(calls).toBe(2)
    expect(expr.evaluateSync('inherited', context)).toBeUndefined()
    await expect(expr.evaluate('inherited', context)).resolves.toBeUndefined()
  })

  it.each([
    'value + 1',
    'value < 1',
    '+value',
    '`value: ${value}`',
    'record[value]',
    '{ [value]: 1 }',
  ])('never invokes conversion hooks for %s', (source) => {
    let calls = 0
    const value = {
      [Symbol.toPrimitive]() {
        calls++
        return 'key'
      },
      valueOf() {
        calls++
        return 1
      },
      toString() {
        calls++
        return 'key'
      },
    }

    expect(() => bonsai().evaluateSync(source, { value, record: { key: 'secret' } })).toThrow(
      BonsaiTypeError,
    )
    expect(calls).toBe(0)
  })

  it('rejects mixed-type addition instead of applying JavaScript coercion', () => {
    expect(() => bonsai().evaluateSync('1 + "2"')).toThrow(BonsaiTypeError)
    expect(() => bonsai().evaluateSync('"1" + 2')).toThrow(BonsaiTypeError)
  })

  it('reads members of a nullish receiver as undefined; only method calls require a value', async () => {
    const expr = bonsai()
    expect(expr.evaluateSync('user.name', { user: null })).toBeUndefined()
    expect(expr.evaluateSync('user.address.city', { user: { address: null } })).toBeUndefined()
    expect(expr.evaluateSync('user?.name', { user: null })).toBeUndefined()
    await expect(expr.evaluate('user.name', { user: undefined })).resolves.toBeUndefined()
    await expect(expr.evaluate('user?.name', { user: undefined })).resolves.toBeUndefined()
    expect(() => expr.evaluateSync('user.name.trim()', { user: { name: null } })).toThrow(
      BonsaiTypeError,
    )
    expect(expr.evaluateSync('user.name?.trim()', { user: { name: null } })).toBeUndefined()
  })

  it('calls captured array intrinsics directly while charging their native work', async () => {
    const items = [1, 2, 3]
    const expr = bonsai()
    expect(expr.evaluateSync('items.slice(0, 2)', { items })).toEqual([1, 2])
    await expect(expr.evaluate('items.slice(0, 2)', { items })).resolves.toEqual([1, 2])
    // The receiver is used as-is, but the native linear scan is pre-charged so
    // maxSteps remains a bound on work rather than only on wrapper overhead.
    expect(() =>
      bonsai({ maxSteps: 5 }).evaluateSync('items.includes(2)', {
        items: Array.from({ length: 1000 }, (_, i) => i),
      }),
    ).toThrow('step budget')
    expect(() =>
      bonsai({ maxSteps: 1_010 }).evaluateSync('items.includes(2)', {
        items: Array.from({ length: 1000 }, (_, i) => i),
      }),
    ).not.toThrow()
  })

  it('copies subclassed arrays to a plain Array so no host species constructor runs', async () => {
    let constructed = 0
    class Tracked extends Array<unknown> {
      constructor(...args: unknown[]) {
        super(...(args as []))
        constructed++
      }
    }
    const items = Tracked.from([1, 2, 3])
    constructed = 0
    const expr = bonsai()

    const result = expr.evaluateSync<unknown[]>('items.map(. + 1)', { items })
    expect(result).toEqual([2, 3, 4])
    expect(Object.getPrototypeOf(result)).toBe(Array.prototype)
    await expect(expr.evaluate('items.filter(. > 1)', { items })).resolves.toEqual([2, 3])
    expect(constructed).toBe(0)
  })

  it('does not run an own species constructor on an ordinary array', async () => {
    let constructed = 0
    function Species(length: number): unknown[] {
      constructed++
      return new Array<unknown>(length)
    }
    const items = [1, 2, 3]
    Object.defineProperty(items, 'constructor', {
      value: { [Symbol.species]: Species },
    })
    const expr = bonsai()

    expect(expr.evaluateSync('items.map(. + 1)', { items })).toEqual([2, 3, 4])
    await expect(expr.evaluate('items.filter(. > 1)', { items })).resolves.toEqual([2, 3])
    expect(expr.evaluateSync('items.slice(1)', { items })).toEqual([2, 3])
    expect(constructed).toBe(0)
  })

  it('uses captured operations for bundled array and math transforms', () => {
    let methodCalls = 0
    let iteratorCalls = 0
    const items = [1, 2, 3]
    Object.defineProperties(items, {
      map: {
        value() {
          methodCalls++
          return ['overridden']
        },
      },
      reduce: {
        value() {
          methodCalls++
          return 999
        },
      },
      [Symbol.iterator]: {
        value() {
          iteratorCalls++
          return [999][Symbol.iterator]()
        },
      },
    })
    const expr = bonsai().use(arrays).use(math)

    expect(expr.evaluateSync('items |> map(. + 1)', { items })).toEqual([2, 3, 4])
    expect(expr.evaluateSync('items |> reverse', { items })).toEqual([3, 2, 1])
    expect(expr.evaluateSync('items |> sum', { items })).toBe(6)
    expect(methodCalls).toBe(0)
    expect(iteratorCalls).toBe(0)
  })

  it('rejects array-method conversion hooks before invoking native code', () => {
    let calls = 0
    const value = {
      valueOf() {
        calls++
        return 0
      },
      toString() {
        calls++
        return '-'
      },
    }
    const expr = bonsai()

    expect(() => expr.evaluateSync('items.slice(value)', { items: [1, 2], value })).toThrow(
      BonsaiTypeError,
    )
    expect(() => expr.evaluateSync('items.join(value)', { items: [1, 2], value })).toThrow(
      BonsaiTypeError,
    )
    expect(calls).toBe(0)
  })

  it('does not invoke concat spreadability hooks', () => {
    let calls = 0
    const left = [1, 2]
    const right = [3]
    // Each getter closes over the shared invocation counter intentionally.
    for (const value of [left, right]) {
      Object.defineProperty(value, Symbol.isConcatSpreadable, {
        // oxlint-disable-next-line eslint/no-loop-func
        get() {
          calls++
          return true
        },
      })
    }

    expect(bonsai().evaluateSync('left.concat(right)', { left, right })).toEqual([1, 2, 3])
    expect(calls).toBe(0)
  })

  it('uses intrinsics captured at module initialization despite later prototype patching', () => {
    // oxlint-disable-next-line eslint/no-extend-native
    const original = Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed')
    let calls = 0
    // oxlint-disable-next-line eslint/no-extend-native
    Object.defineProperty(Array.prototype, 'toReversed', {
      configurable: true,
      writable: true,
      value() {
        calls++
        return ['patched']
      },
    })
    try {
      expect(bonsai().evaluateSync('[1, 2].toReversed()')).toEqual([2, 1])
      expect(calls).toBe(0)
    } finally {
      if (original) {
        // oxlint-disable-next-line eslint/no-extend-native
        Object.defineProperty(Array.prototype, 'toReversed', original)
      }
    }
  })

  it('rejects object arguments before string methods can invoke conversion hooks', () => {
    let calls = 0
    const value = {
      toString() {
        calls++
        return 'x'
      },
    }

    expect(() => bonsai().evaluateSync('text.includes(value)', { text: 'x', value })).toThrow(
      BonsaiTypeError,
    )
    expect(calls).toBe(0)
  })

  it('rejects conversion hooks in bundled padding transforms', () => {
    let calls = 0
    const length = {
      valueOf() {
        calls++
        return 10
      },
    }
    const expr = bonsai().use(strings)

    expect(() => expr.evaluateSync('text |> padStart(length)', { text: 'x', length })).toThrow(
      BonsaiTypeError,
    )
    expect(calls).toBe(0)
  })
})
