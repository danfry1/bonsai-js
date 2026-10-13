import { describe, expect, it } from 'vitest'
import { BonsaiError, BonsaiLimitError, bonsai, fn, t, type PartialOptions } from '../src/index.js'
import { toSQL } from '../src/query/index.js'
import { createLanguageService } from '../src/service/index.js'

/** The code of the Bonsai error `run` throws, or `value` when it returns. */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'value'
  } catch (error) {
    return error instanceof BonsaiError ? error.code : 'RAW'
  }
}

/** A STEP_LIMIT raised by another evaluation. */
function foreignLimit(): unknown {
  try {
    bonsai().evaluateSync('"ab".repeat(100).length + 1 + 2 + 3', {}, { maxSteps: 2 })
  } catch (error) {
    return error
  }
  throw new Error('expected a limit')
}

describe('round 11: explain attributes host-thrown Bonsai errors as evaluation does', () => {
  const env = bonsai()

  it('ignores a limit error thrown by host data in exhaustive extra work', async () => {
    const thrown = [
      foreignLimit(),
      new BonsaiLimitError('STEP_LIMIT', 'built by the host'),
      new Proxy({}, { getPrototypeOf: () => BonsaiLimitError.prototype }),
    ]
    for (const error of thrown) {
      const ctx = {
        x: 1,
        a: {
          get b(): never {
            throw error
          },
        },
      }
      expect(env.evaluateSync('x == 1 || a.b == 2', ctx)).toBe(true)
      const explained = env.explainSync('x == 1 || a.b == 2', ctx, { exhaustive: true })
      expect(explained).toMatchObject({ ok: true, value: true })
      const asynced = await env.explain('x == 1 || a.b == 2', ctx, { exhaustive: true })
      expect(asynced).toMatchObject({ ok: true, value: true })
    }
  })

  it('records HOST_ERROR on every trace node for a Bonsai error a getter threw', () => {
    const lookup = bonsai()
    const ctx = {
      a: {
        get b(): unknown {
          return lookup.evaluateSync('1 / z', { z: 0 })
        },
      },
    }
    expect(codeOf(() => env.evaluateSync('a.b + 1', ctx))).toBe('HOST_ERROR')
    const explained = env.explainSync('a.b + 1', ctx)
    expect(explained.ok).toBe(false)
    if (explained.ok) return
    expect(explained.error.code).toBe('HOST_ERROR')
    expect(explained.error.cause).toMatchObject({ code: 'DIVISION_BY_ZERO' })
    expect(explained.trace.error?.code).toBe('HOST_ERROR')
    expect(explained.trace.children[0]?.error?.code).toBe('HOST_ERROR')
    expect(String(explained)).not.toContain('DIVISION_BY_ZERO')
    expect(explained.reasons().map((reason) => reason.error?.code)).toEqual(['HOST_ERROR'])
  })

  it('renders a trace error from a hostile thrown value as text, never throwing', () => {
    const message = {
      toString(): never {
        throw new Error('boom')
      },
    }
    const fields: Record<string, unknown> = { code: 'TIMEOUT', message }
    const thrown: unknown = new Proxy(
      {},
      {
        getPrototypeOf: () => BonsaiError.prototype,
        get: (_, key) => (typeof key === 'string' ? fields[key] : undefined),
      },
    )
    const explained = env.explainSync('a.b + 1', {
      a: {
        get b(): never {
          throw thrown
        },
      },
    })
    expect(explained.ok).toBe(false)
    expect(explained.trace.error?.code).toBe('HOST_ERROR')
    expect(typeof explained.trace.error?.message).toBe('string')
    expect(() => String(explained)).not.toThrow()
    expect(() => JSON.stringify(explained)).not.toThrow()
  })

  it('records the error on the failing node for a revoked Proxy thrown by a getter', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const thrown: unknown = proxy
    const explained = env.explainSync('a.b + 1', {
      a: {
        get b(): never {
          throw thrown
        },
      },
    })
    expect(explained.ok).toBe(false)
    if (explained.ok) return
    expect(explained.error.cause).toBe(proxy)
    expect(explained.trace.children[0]?.error?.code).toBe('HOST_ERROR')
  })
})

describe('round 11: traces picked out of an explanation stay within its JSON', () => {
  it('serializes a list of traces as their parts of the explanation', () => {
    const v = Array.from({ length: 50 }, () =>
      Array.from({ length: 50 }, () => Array.from({ length: 50 }, (_, i) => i)),
    )
    const source = `[${Array.from({ length: 200 }, () => 'v').join(',')}].length`
    const explained = bonsai().explainSync(source, { v })
    const whole = JSON.stringify(explained)
    const list = explained.trace.children[0]?.children ?? []
    expect(list.length).toBe(200)
    const picked = JSON.stringify(list)
    expect(picked.length).toBeLessThan(whole.length)
    const parsed = JSON.parse(whole) as { trace: { children: { children: unknown[] }[] } }
    expect(JSON.parse(picked)).toEqual(parsed.trace.children[0]?.children)
    // The same whichever is serialized first.
    const again = bonsai().explainSync(source, { v })
    const first = JSON.stringify(again.trace.children[0]?.children)
    expect(first).toBe(picked)
    expect(JSON.stringify(again)).toBe(whole)
  })

  it('bounds a copy of reasons() by the explanation', () => {
    const big = Array.from({ length: 50 }, () => Array.from({ length: 50 }, (_, i) => i))
    const source = Array.from({ length: 200 }, (_, i) => `m.length == ${i + 1}`).join(' || ')
    const explained = bonsai().explainSync(source, { m: big }, { exhaustive: true })
    const copied = JSON.stringify([...explained.reasons()])
    expect(copied.length).toBeLessThanOrEqual(JSON.stringify(explained).length)
  })
})

describe('round 11: explain() rejects a thenable result as evaluate() does', () => {
  const env = bonsai()
  const thenable = {
    then(resolve: (value: number) => void): void {
      resolve(42)
    },
  }
  const throwingThen = {
    get then(): never {
      throw new Error('x')
    },
  }

  it('fails with the same code', async () => {
    await expect(env.evaluate('a', { a: thenable })).rejects.toMatchObject({ code: 'TYPE_ERROR' })
    expect(await env.explain('a', { a: thenable })).toMatchObject({
      ok: false,
      error: { code: 'TYPE_ERROR' },
    })
    await expect(env.evaluate('a', { a: throwingThen })).rejects.toMatchObject({
      code: 'HOST_ERROR',
    })
    expect(await env.explain('a', { a: throwingThen })).toMatchObject({
      ok: false,
      error: { code: 'HOST_ERROR' },
    })
    // The sync views return it, as evaluateSync() does.
    expect(env.explainSync('a', { a: thenable })).toMatchObject({ ok: true })
  })

  it('fails a residual explanation the same way', async () => {
    const result = bonsai()
      .compile('k ?? a')
      .partial({ k: null }, { unknown: ['a'] })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    await expect(result.evaluate({ a: thenable })).rejects.toMatchObject({ code: 'TYPE_ERROR' })
    expect(await result.explain({ a: thenable })).toMatchObject({
      ok: false,
      error: { code: 'TYPE_ERROR' },
    })
  })
})

describe('round 11: running out of call stack in host code', () => {
  const recurse = (n: number): number => recurse(n + 1) + 1

  it('is TOO_DEEP from a host function, as from a getter, and try() does not recover', () => {
    const env = bonsai({
      functions: { deep: fn({ params: [], returns: t.number(), run: () => recurse(0) }) },
    })
    expect(codeOf(() => env.evaluateSync('try(deep(), 0)'))).toBe('TOO_DEEP')
    const ctx = {
      a: {
        get b(): number {
          return recurse(0)
        },
      },
    }
    expect(codeOf(() => env.evaluateSync('try(a.b, 0)', ctx))).toBe('TOO_DEEP')
  })

  it('is TOO_DEEP from an async host function', async () => {
    const env = bonsai({
      functions: {
        deep: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: async () => {
            await Promise.resolve()
            return recurse(0)
          },
        }),
      },
    })
    await expect(env.evaluate('try(deep(), 0)')).rejects.toMatchObject({ code: 'TOO_DEEP' })
  })

  it('still recovers other host function failures', () => {
    const env = bonsai({
      functions: {
        bad: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw new RangeError('out of range')
          },
        }),
      },
    })
    expect(env.evaluateSync('try(bad(), 7)')).toBe(7)
  })
})

describe('round 11: translation-only partial() is unreachable from outside', () => {
  it('keeps maxSourceLength for a partial() called from a hand-built program', () => {
    const env = bonsai({ limits: { maxSourceLength: 40 } })
    const real = env.compile('row.a == k || row.b == k')
    const known = { k: 'x'.repeat(16) }
    // Translation itself is not bound by it.
    expect(
      toSQL(real, { row: 'row', columns: { a: 'text', b: 'text' }, dialect: 'sqlite', known }).sql,
    ).toContain('OR')
    let caught: unknown
    const fake = {
      source: real.source,
      ast: real.ast,
      references: real.references,
      partial: (data: Record<string, unknown>, options: PartialOptions) => {
        try {
          return real.partial(data, options)
        } catch (error) {
          caught = error
          throw error
        }
      },
    }
    expect(() =>
      toSQL(fake as never, {
        row: 'row',
        columns: { a: 'text', b: 'text' },
        dialect: 'sqlite',
        known,
      }),
    ).toThrow()
    expect(caught).toMatchObject({ code: 'SOURCE_TOO_LONG' })
    expect(codeOf(() => real.partial(known, { unknown: ['row'] }))).toBe('SOURCE_TOO_LONG')
  })
})

describe('round 11: hover at NaN or Infinity means the end', () => {
  it('matches an offset past the end', () => {
    const service = createLanguageService(
      bonsai({ variables: { user: t.object({ age: t.number() }) } }),
    )
    const end = service.hover('user.age', 100)
    expect(end).toBeDefined()
    expect(service.hover('user.age', Number.NaN)).toEqual(end)
    expect(service.hover('user.age', Number.POSITIVE_INFINITY)).toEqual(end)
  })
})
