import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'

// The async evaluator reimplements higher-order array methods (it must, to await
// Promise-returning bonsai lambdas). These tests pin that the reimplementation
// matches native/sync semantics exactly: callback arguments, sparse-hole
// handling per method, result shape, and overridden-method deference. Each case
// asserts async === sync === the native JS method.

const expr = bonsai()

const evalBoth = async (source: string, ctx: Record<string, unknown>) => ({
  sync: expr.evaluateSync(source, ctx),
  async: await expr.evaluate(source, ctx),
})

// Present indices + length capture sparse structure that JSON/deepEqual hide.
const shape = (v: unknown) =>
  Array.isArray(v) ? { len: v.length, present: Object.keys(v).map(Number) } : v

describe('callback receives (item, index, array)', () => {
  it('map forwards the index', async () => {
    const r = await evalBoth('items.map(f)', {
      items: [10, 20, 30],
      f: (_v: number, i: number) => i,
    })
    expect(r.sync).toEqual([0, 1, 2])
    expect(r.async).toEqual(r.sync)
  })

  it('filter forwards the index', async () => {
    const r = await evalBoth('items.filter(f)', {
      items: [5, 6, 7, 8],
      f: (_v: number, i: number) => i % 2 === 0,
    })
    expect(r.sync).toEqual([5, 7])
    expect(r.async).toEqual(r.sync)
  })

  it('the callback receives the source array as the third argument', async () => {
    const r = await evalBoth('items.map(f)', {
      items: [1, 2, 3],
      f: (_v: number, _i: number, a: number[]) => a.length,
    })
    expect(r.sync).toEqual([3, 3, 3])
    expect(r.async).toEqual(r.sync)
  })
})

describe('sparse-hole handling matches native per method', () => {
  const sparse = (): number[] => {
    const a: number[] = [1]
    a[3] = 3 // indices 1 and 2 are holes; length 4
    return a
  }

  it('map skips holes and preserves them in the result', async () => {
    const native = sparse().map((x) => x * 2)
    const r = await evalBoth('items.map(f)', { items: sparse(), f: (v: number) => v * 2 })
    expect(shape(r.sync)).toEqual(shape(native))
    expect(shape(r.async)).toEqual(shape(native))
  })

  it('filter skips holes', async () => {
    const native = sparse().filter(() => true)
    const r = await evalBoth('items.filter(f)', { items: sparse(), f: () => true })
    expect(r.sync).toEqual(native)
    expect(r.async).toEqual(native)
  })

  it('some skips holes (a hole never satisfies the predicate)', async () => {
    const native = sparse().some((v) => v === undefined)
    const r = await evalBoth('items.some(f)', {
      items: sparse(),
      f: (v: unknown) => v === undefined,
    })
    expect(r.sync).toBe(native) // false: holes are skipped, not seen as undefined
    expect(r.async).toBe(native)
  })

  it('findIndex visits holes as undefined (does not skip)', async () => {
    const native = sparse().findIndex((v) => v === undefined)
    const r = await evalBoth('items.findIndex(f)', {
      items: sparse(),
      f: (v: unknown) => v === undefined,
    })
    expect(r.sync).toBe(native) // 1: the first hole, visited as undefined
    expect(r.async).toBe(native)
  })
})

describe('overridden methods are deferred to, not reimplemented', () => {
  it('uses an own overridden map identically in both modes', async () => {
    const make = () => {
      const arr = [1, 2, 3]
      // Returns a sentinel only if it actually received the callback, proving
      // the override ran (not bonsai's reimplementation).
      Object.defineProperty(arr, 'map', {
        value: (cb: unknown) => (typeof cb === 'function' ? 'override-ran' : 'no-callback'),
      })
      return arr
    }
    const r = {
      sync: expr.evaluateSync('items.map(.x)', { items: make() }),
      async: await expr.evaluate('items.map(.x)', { items: make() }),
    }
    expect(r.sync).toBe('override-ran')
    expect(r.async).toBe(r.sync)
  })
})

describe('optional thisArg is honored', () => {
  it('binds thisArg for a host callback (2-argument form) identically in both modes', async () => {
    const make = () => ({
      items: [1, 2, 3],
      mult(this: { by: number }, v: number) {
        return v * this.by
      },
      ctx: { by: 10 },
    })
    const r = await evalBoth('items.map(mult, ctx)', make())
    expect(r.sync).toEqual([10, 20, 30])
    expect(r.async).toEqual(r.sync)
  })

  it('still awaits an async bonsai lambda when a thisArg is supplied', async () => {
    // The 2-argument form must not bypass async-aware iteration.
    const e = bonsai()
    e.addFunction('asyncFalse', () => Promise.resolve(false))
    await expect(
      e.evaluate('items.some(. > 0 && asyncFalse(), ignored)', { items: [1], ignored: null }),
    ).resolves.toBe(false)
    await expect(
      e.evaluate('items.filter(. > 0 && asyncFalse(), ignored)', { items: [1], ignored: null }),
    ).resolves.toEqual([])
  })
})

describe('callback-mutation timing matches native', () => {
  // These callbacks mutate their input, so each evaluation gets a fresh context
  // (a shared one would let the first run's mutation leak into the second).
  it('find returns the value passed to the predicate, not a later mutation', async () => {
    const make = () => ({
      items: [1, 2, 3],
      f: (_v: unknown, i: number, arr: unknown[]) => {
        arr[i] = 99 // mutate the slot after it was read
        return true
      },
    })
    const sync = expr.evaluateSync('items.find(f)', make())
    const asyncResult = await expr.evaluate('items.find(f)', make())
    expect(sync).toBe(1) // the original first value, not 99
    expect(asyncResult).toBe(sync)
  })

  it('flatMap flattens each result before the next callback runs', async () => {
    // The first callback returns an array that the second callback mutates.
    // Native flatMap has already flattened the first result, so the mutation
    // is not observed; a deferred flatten would observe it.
    const make = () => {
      const shared = [1]
      return {
        items: [0, 1],
        f: (_v: unknown, i: number) => {
          if (i === 0) return shared
          shared[0] = 99
          return []
        },
      }
    }
    const sync = expr.evaluateSync('items.flatMap(f)', make())
    const asyncResult = await expr.evaluate('items.flatMap(f)', make())
    expect(sync).toEqual([1])
    expect(asyncResult).toEqual(sync)
  })
})

describe('array subclasses preserve species', () => {
  it('returns the subclass from map in both modes', async () => {
    class Bag extends Array {}
    const make = () => ({ items: Bag.from([1, 2, 3]) as unknown[] })
    const sync = expr.evaluateSync('items.map(.x)', make())
    const asyncResult = await expr.evaluate('items.map(.x)', make())
    expect((sync as object).constructor.name).toBe('Bag')
    expect((asyncResult as object).constructor.name).toBe('Bag')
  })
})
