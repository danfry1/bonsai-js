import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

/** The code of the Bonsai error `run` throws, or `value` when it returns. */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'value'
  } catch (error) {
    return error instanceof BonsaiError ? error.code : 'RAW'
  }
}

/** An ORM-like query object: calling `then` runs the query. */
function query(): { calls: number; value: object } {
  const state = { calls: 0, value: {} }
  state.value = {
    sql: 'DELETE FROM users',
    then(resolve: (value: unknown) => void): void {
      state.calls++
      resolve('executed!')
    },
  }
  return state
}

describe('round 12: async evaluation never runs a thenable from the data', () => {
  const env = bonsai({
    strict: false,
    functions: {
      ready: fn({
        params: [],
        returns: t.boolean(),
        async: true,
        run: () => Promise.resolve(true),
      }),
      sid: fn({ params: [t.any()], returns: t.any(), run: (x) => x }),
    },
  })
  const sync = bonsai({
    strict: false,
    functions: { ready: fn({ params: [], returns: t.boolean(), run: () => true }) },
  })

  const inside = [
    '[ready() ? q : null]',
    '[ready() ? q : null][0] == "executed!"',
    'xs.map(x => ready() ? x : x)',
    'xs.map(x => ready() ? x : x)[0] == "executed!"',
    '[xs.find(x => ready())]',
    '[reduce(xs, (acc, x) => ready() ? x : acc, 0)]',
    'xs.filter(x => ready()).length',
    '[(ready() ? o : o).q]',
    '[try(ready() ? q : null, 1)]',
    '[q ?? ready()]',
    '{k: ready() ? q : 0}',
    'let a = ready(); [a ? q : 0]',
    '[ready() && true ? q : 1]',
    '[`${ready()}`.length, ready() ? q : 1]',
  ]

  it('keeps a thenable as opaque data in every async node, as the sync program does', async () => {
    for (const source of inside) {
      const q = query()
      const ctx = { q: q.value, o: { q: q.value }, xs: [q.value] }
      const value = await env.evaluate(source, ctx)
      expect(JSON.stringify(value), source).toBe(JSON.stringify(sync.evaluateSync(source, ctx)))
      const explained = await env.explain(source, ctx)
      expect(explained.ok, source).toBe(true)
      expect(q.calls, source).toBe(0)
    }
  })

  it('refuses a thenable result from an async program without calling it', async () => {
    for (const source of ['ready() ? q : null', 'xs.find(x => ready())', '(ready() ? o : o).q']) {
      const q = query()
      const ctx = { q: q.value, o: { q: q.value }, xs: [q.value] }
      await expect(env.evaluate(source, ctx), source).rejects.toMatchObject({ code: 'TYPE_ERROR' })
      expect(await env.explain(source, ctx), source).toMatchObject({
        ok: false,
        error: { code: 'TYPE_ERROR' },
        trace: { error: { code: 'TYPE_ERROR' } },
      })
      const residual = env.compile(source).partial({}, { unknown: ['q', 'o', 'xs'] })
      if (residual.status === 'residual') {
        await expect(residual.evaluate(ctx), source).rejects.toMatchObject({ code: 'TYPE_ERROR' })
        expect(await residual.explain(ctx), source).toMatchObject({ ok: false })
      }
      expect(q.calls, source).toBe(0)
    }
  })

  it('does not read a throwing then getter on data inside an async program', async () => {
    const hostile = {
      get then(): never {
        throw new Error('read')
      },
    }
    expect(await env.evaluate('[ready() ? h : null].length', { h: hostile })).toBe(1)
  })

  it('never calls then on a thenable a sync host function returns, even to clean up', async () => {
    const q = query()
    expect(codeOf(() => env.evaluateSync('sid(q)', { q: q.value }))).toBe('HOST_CONTRACT')
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(q.calls).toBe(0)
  })

  it('still awaits the promise an async host function returns', async () => {
    const delayed = bonsai({
      functions: {
        later: fn({
          params: [t.number()],
          returns: t.number(),
          async: true,
          run: async (n) => {
            await Promise.resolve()
            return n + 1
          },
        }),
      },
    })
    expect(await delayed.evaluate('[1, 2].map(x => later(x)).length + later(1)')).toBe(4)
  })
})

describe('round 12: an explanation serializes to one frozen snapshot', () => {
  it('cannot be changed through what toJSON() returns', () => {
    const env = bonsai()
    const e = env.explainSync('a.b + 1 > 0 && c', { a: { b: 1 }, c: true })
    const before = JSON.stringify(e)
    const json = e.toJSON()
    expect(Object.isFrozen(json)).toBe(true)
    expect(() => {
      ;(json as { ok: unknown }).ok = 'tampered'
    }).toThrow(TypeError)
    const part = e.trace.children[0] as unknown as { toJSON: () => { children: unknown[] } }
    expect(() => {
      part.toJSON().children.length = 0
    }).toThrow(TypeError)
    expect(JSON.stringify(e)).toBe(before)
  })
})

describe('round 12: running out of call stack', () => {
  const recurse = (n: number): number => recurse(n + 1) + 1

  it('keeps an ordinary RangeError from a host function recoverable, with its cause', () => {
    const thrown = new RangeError('stack size must be at most 10')
    const env = bonsai({
      functions: {
        stackish: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw thrown
          },
        }),
      },
    })
    expect(env.evaluateSync('try(stackish(), 0)')).toBe(0)
    try {
      env.evaluateSync('stackish()')
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: 'HOST_ERROR', cause: thrown })
    }
  })

  it('makes a host function overflow a HOST_ERROR with its cause, which try() recovers', () => {
    const env = bonsai({
      functions: { deep: fn({ params: [], returns: t.number(), run: () => recurse(0) }) },
    })
    expect(env.evaluateSync('try(deep(), 0)')).toBe(0)
    try {
      env.evaluateSync('deep()')
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: 'HOST_ERROR' })
      expect((error as Error).cause).toBeInstanceOf(RangeError)
    }
  })

  it('keeps the engine error as the cause of TOO_DEEP from a getter', () => {
    const ctx = {
      a: {
        get b(): number {
          return recurse(0)
        },
      },
    }
    try {
      bonsai().evaluateSync('try(a.b, 0)', ctx)
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: 'TOO_DEEP' })
      expect((error as Error).cause).toBeInstanceOf(RangeError)
    }
  })

  it('leaves an overflow in a branch that may not run to the residual', () => {
    const env = bonsai({
      functions: { deep: fn({ params: [], returns: t.number(), run: () => recurse(0) }) },
    })
    const known = {
      k: {
        get v(): number {
          return recurse(0)
        },
      },
    }
    for (const source of ['x > 1 && deep() == 0', 'x > 1 && k.v == 0']) {
      const program = env.compile(source)
      const result = program.partial(known, { callHostFunctions: true, unknown: ['x'] })
      expect(result.status, source).toBe('residual')
      if (result.status === 'residual') expect(result.evaluateSync({ x: 0 }), source).toBe(false)
    }
  })
})

describe('round 12: a refused result is marked on the root of the trace', () => {
  it('marks a promise-like result and a failed expect check', async () => {
    const thenable = { then: (): void => undefined }
    const refused = await bonsai().explain('a ?? b', { a: thenable, b: 1 })
    expect(refused).toMatchObject({ ok: false, trace: { error: { code: 'TYPE_ERROR' } } })
    expect(refused.trace.value).toBeUndefined()
    expect(String(refused)).toContain('error TYPE_ERROR')
    expect(refused.reasons()[0]).toMatchObject({ error: { code: 'TYPE_ERROR' } })

    const mismatch = bonsai({ strict: false })
      .compile('a + 1', { expect: t.string() })
      .explainSync({ a: 1 })
    expect(mismatch).toMatchObject({ ok: false, trace: { error: { code: 'TYPE_ERROR' } } })
  })
})

describe('round 12: a residual nests folded values as the original does', () => {
  it('reaches the value depth limit where evaluation does', () => {
    const env = bonsai({ strict: false, limits: { maxValueDepth: 2 } })
    const program = env.compile('u.tags.map(p1 => [hours(1)])')
    const full = { u: { tags: ['a', 'b'] } }
    expect(codeOf(() => program.evaluateSync(full))).toBe('VALUE_DEPTH_LIMIT')
    const residual = program.partial({ u: {} }, { unknown: ['u.tags'] })
    expect(residual.status).toBe('residual')
    if (residual.status === 'residual')
      expect(codeOf(() => residual.evaluateSync(full))).toBe('VALUE_DEPTH_LIMIT')
  })
})
