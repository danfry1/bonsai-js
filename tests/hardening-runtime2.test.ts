import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'
import { minimalSteps, outcome, outcomeAsync, run } from './helpers.js'

/** "value", or the code of a Bonsai error: a trap may or may not be reached, but nothing raw escapes. */
function settled(f: () => unknown): string {
  const result = outcome(f)
  return typeof result === 'object' && result !== null && 'code' in result
    ? String(result.code)
    : 'value'
}

const env = bonsai()
describe('compiled patterns are always paid for', () => {
  it('charges a pattern by its compiled size, not its length', () => {
    // 14 characters that compile to about 5000 instructions.
    const small = minimalSteps(env, 'matches("", p)', { p: '(?:abcd){2}' })
    const large = minimalSteps(env, 'matches("", p)', { p: '(?:abcd){999}' })
    expect(large - small).toBeGreaterThan(3000)
  })

  it('stops cycling through many patterns within the budget', () => {
    const source =
      'split(repeat("a", 40000), "").map((c, i) => matches("", `(?:abcd){999}${i % 1000}`)).length'
    expect(run(source)).toEqual({ code: 'STEP_LIMIT' })
  })

  it('charges the same steps whether or not a pattern is cached', () => {
    const fresh = bonsai()
    const source = 'matches(text, p)'
    const ctx = { text: 'hello world', p: `[a-z]+ w${Math.random().toString(36).slice(2)}` }
    const cold = minimalSteps(fresh, source, ctx)
    const warm = minimalSteps(fresh, source, ctx)
    expect(warm).toBe(cold)
  })

  it('reports an over-long pattern as a limit error, which try() does not catch', () => {
    const p = 'a'.repeat(5000)
    expect(run('matches("a", p)', { p })).toEqual({ code: 'PATTERN_LIMIT' })
    expect(run('try(matches("a", p), false)', { p })).toEqual({ code: 'PATTERN_LIMIT' })
  })

  it('reads escaped surrogate pairs as one code point, as the u flag does', () => {
    expect(run('matches(s, "\\\\uD83D\\\\uDE00")', { s: '😀' })).toEqual({ value: true })
    expect(run('matches(s, "^[\\\\uD83D\\\\uDE00]$")', { s: '😀' })).toEqual({ value: true })
    expect(run('matches(s, "^[\\\\uD83D\\\\uDE00]$")', { s: '\uD83D' })).toEqual({ value: false })
    expect(run('matches(s, "^\\\\uD83D$")', { s: '\uD83D' })).toEqual({ value: true })
  })
})

describe('host data never escapes as a raw error', () => {
  const throwing = {
    get a(): number {
      throw new Error('boom')
    },
  }
  const trapped = (trap: 'getPrototypeOf' | 'ownKeys' | 'getOwnPropertyDescriptor'): object =>
    new Proxy(
      { a: 1 },
      {
        [trap]: () => {
          throw new Error(`${trap} trap`)
        },
      },
    )

  it('wraps failures in the expect check', async () => {
    const program = bonsai().compile('x', { expect: t.object({ a: t.number() }) })
    expect(outcome(() => program.evaluateSync({ x: throwing }))).toEqual({ code: 'HOST_ERROR' })
    expect(await outcomeAsync(() => program.evaluate({ x: throwing }))).toEqual({
      code: 'HOST_ERROR',
    })
    const record = bonsai().compile('x', { expect: t.record(t.number()) })
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const)
      expect(
        settled(() => record.evaluateSync({ x: trapped(trap) })),
        trap,
      ).toMatch(/^(?:value|HOST_ERROR)$/u)
  })

  it('wraps failures in context validation', () => {
    const typed = bonsai({
      variables: { x: t.object({ a: t.number() }) },
      validateContext: true,
    })
    expect(outcome(() => typed.evaluateSync('x.a', { x: throwing }))).toEqual({
      code: 'HOST_ERROR',
    })
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
      const trappedCtx = { x: trapped(trap) } as unknown as { x: { a: number } }
      expect(
        settled(() => typed.evaluateSync('x.a', trappedCtx)),
        trap,
      ).toMatch(/^(?:value|HOST_ERROR)$/u)
    }
  })

  it('wraps failures reading a result that looks like a promise', async () => {
    const result = {
      get then(): unknown {
        throw new Error('then getter')
      },
    }
    expect(await outcomeAsync(() => bonsai().evaluate('x', { x: result }))).toEqual({
      code: 'HOST_ERROR',
    })
  })

  it('wraps a Bonsai error a host function throws, keeping it as the cause', () => {
    const inner = new BonsaiError('STEP_LIMIT', 'inner evaluation ran out')
    const hosted = bonsai({
      functions: {
        nested: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw inner
          },
        }),
      },
    })
    let caught: unknown
    try {
      hosted.evaluateSync('nested()')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'HOST_ERROR', cause: inner })
    // A host failure, not this evaluation's limit: try() recovers from it.
    expect(hosted.evaluateSync('try(nested(), 7)')).toBe(7)
  })

  it('wraps rejections from async host functions, but not the limits racing them', async () => {
    const hosted = bonsai({
      functions: {
        failing: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: () => Promise.reject(new BonsaiError('TIMEOUT', 'the host timed out')),
        }),
        slow: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: async () =>
            new Promise<number>(() => {
              // Never settles.
            }),
        }),
      },
    })
    expect(await outcomeAsync(() => hosted.evaluate('failing()'))).toEqual({ code: 'HOST_ERROR' })
    expect(await outcomeAsync(() => hosted.evaluate('slow()', {}, { timeout: 20 }))).toEqual({
      code: 'TIMEOUT',
    })
  })
})

describe('steps never depend on where a value came from', () => {
  it('counts a value from an earlier evaluation like any host value', () => {
    const nested = env.evaluateSync('xs.reduce((acc, x) => [acc], [])', {
      xs: Array.from({ length: 63 }, () => 0),
    })
    const copy: unknown = JSON.parse(JSON.stringify(nested))
    const source = '[x, [[1]]].length'
    expect(run(source, { x: nested })).toEqual(run(source, { x: copy }))
    expect(minimalSteps(env, source, { x: nested })).toBe(minimalSteps(env, source, { x: copy }))
    const wide = env.evaluateSync('xs.map(x => [x, x])', {
      xs: Array.from({ length: 1000 }, () => 1),
    })
    const wideCopy: unknown = JSON.parse(JSON.stringify(wide))
    expect(minimalSteps(env, '[x, x].length', { x: wide })).toBe(
      minimalSteps(env, '[x, x].length', { x: wideCopy }),
    )
  })
})

describe('sorting', () => {
  it('rejects non-finite numbers even when no comparison reaches them', () => {
    expect(run('sort([x])', { x: Infinity })).toEqual({ code: 'NON_FINITE' })
    expect(run('sort([x])', { x: Number.NaN })).toEqual({ code: 'NON_FINITE' })
    expect(run('[x].sortBy(.)', { x: Number.NaN })).toEqual({ code: 'NON_FINITE' })
    expect(run('[1, x].sortBy(. * 1)', { x: -Infinity })).toEqual({ code: 'NON_FINITE' })
  })

  it('is stable, in both directions', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ k: i % 7, i }))
    const asc = env.evaluateSync('items.sortBy(.k)', { items }) as { k: number; i: number }[]
    const desc = env.evaluateSync('items.sortBy(.k, "desc")', { items }) as typeof asc
    const reference = [...items].sort((a, b) => a.k - b.k)
    expect(asc).toEqual(reference)
    expect(desc).toEqual([...items].sort((a, b) => b.k - a.k))
    expect(env.evaluateSync('sort(xs)', { xs: [3, 1, 2, 1, 5, 0] })).toEqual([0, 1, 1, 2, 3, 5])
    expect(env.evaluateSync('sort(xs, "desc")', { xs: ['b', 'a', 'c'] })).toEqual(['c', 'b', 'a'])
  })

  it('makes the same comparisons however the input is arranged by the engine', () => {
    // Charged per comparison: identical inputs cost identical steps.
    const xs = Array.from({ length: 300 }, (_, i) => 'x'.repeat(100) + String((i * 7919) % 300))
    expect(minimalSteps(env, 'sort(xs).length', { xs })).toBe(
      minimalSteps(env, 'sort(xs).length', { xs: [...xs] }),
    )
  })
})

describe('non-enumerable own properties: read like JavaScript, never enumerated', () => {
  // As in JavaScript: reads see own properties; keys, spread, and == see enumerable ones.
  const hidden = Object.defineProperty({ a: 1 }, 'secret', { value: 's', enumerable: false })
  class Account {
    readonly balance = 5
    constructor() {
      Object.defineProperty(this, 'token', { value: 't', enumerable: false })
    }
  }

  it.each([
    ['x.secret', 's'],
    ['x["secret"]', 's'],
    ['"secret" in x', true],
    ['has(x.secret)', true],
    ['x == {a: 1}', true],
    ['keys(x)', ['a']],
    ['{...x}', { a: 1 }],
  ])('%s', (source, expected) => {
    expect(run(source, { x: hidden })).toEqual({ value: expected })
  })

  it('applies to class instances and the context itself', () => {
    expect(run('a.token', { a: new Account() })).toEqual({ value: 't' })
    expect(run('a.balance', { a: new Account() })).toEqual({ value: 5 })
    const ctx = Object.defineProperty({}, 'hiddenVar', { value: 1, enumerable: false })
    expect(run('hiddenVar', ctx)).toEqual({ value: 1 })
  })

  it('agrees with host argument checks and context validation', () => {
    const typed = bonsai({
      variables: { x: t.object({ secret: t.string() }) },
      validateContext: true,
    })
    const ctx = { x: hidden } as unknown as { x: { secret: string } }
    expect(outcome(() => typed.evaluateSync('x.secret', ctx))).toEqual({ value: 's' })
    const hosted = bonsai({
      functions: {
        read: fn({
          params: [t.object({ secret: t.string() })],
          returns: t.string(),
          run: (o) => o.secret,
        }),
      },
    })
    expect(outcome(() => hosted.evaluateSync('read(x)', { x: hidden }))).toEqual({ value: 's' })
  })

  it('never reaches private class fields', () => {
    class Vault {
      readonly #secret = 'p'
      readonly label = 'v'
      reveal(): string {
        return this.#secret
      }
    }
    expect(run('v.secret', { v: new Vault() })).toEqual({ value: null })
    expect(run('keys(v)', { v: new Vault() })).toEqual({ value: ['label'] })
  })
})

describe('values from other realms and thenables', () => {
  it('treats built-in objects from another realm as opaque', () => {
    for (const [expression, source] of [
      ['new Map([["a", 1]])', 'x.a'],
      ['new Set([1])', 'x.size'],
      ['new Date(0)', 'x.getTime'],
      ['/a/g', 'x.lastIndex'],
      ['new Error("e")', 'x.message'],
      ['new Uint8Array(2)', 'x.length'],
    ] as const) {
      const x: unknown = runInNewContext(expression)
      expect(run('type(x)', { x }), expression).toEqual({ value: 'opaque' })
      expect(run(source, { x }), expression).toEqual({ code: 'TYPE_ERROR' })
    }
  })

  it('reads plain objects and lists from another realm', () => {
    const x: unknown = runInNewContext('({ a: 1, list: [1, 2] })')
    expect(run('x.a + x.list[1]', { x })).toEqual({ value: 3 })
    expect(run('type(x)', { x })).toEqual({ value: 'map' })
  })

  it('reads objects with a then method as maps, and keeps promises opaque', () => {
    // Bonsai never awaits a value it reads; only a real Promise is opaque.
    const x = { a: 1, then: (): void => undefined }
    expect(run('type(x)', { x })).toEqual({ value: 'map' })
    expect(run('x.a', { x })).toEqual({ value: 1 })
    expect(run('type(p)', { p: Promise.resolve(1) })).toEqual({ value: 'opaque' })
  })
})

describe('unique', () => {
  it('compares bigints by value, symbols by identity, and never NaN', () => {
    const s = Symbol('s')
    expect(env.evaluateSync('unique(xs)', { xs: [1n, 1n, 2n] })).toEqual([1n, 2n])
    expect(env.evaluateSync('unique(xs)', { xs: [s, s, Symbol.for('a')] })).toEqual([
      s,
      Symbol.for('a'),
    ])
    expect(env.evaluateSync('unique(xs).length', { xs: [Number.NaN, Number.NaN, 1] })).toBe(3)
    expect(env.evaluateSync('unique(xs)', { xs: [0, -0, 0] })).toEqual([0])
  })

  it('gives a span to a limit error from comparing deep values', () => {
    const deep = (): unknown => {
      let value: unknown = 1
      for (let i = 0; i < 100; i++) value = [value]
      return value
    }
    // Distinct values: the same reference compares equal without walking it.
    for (const source of ['unique(xs)', 'xs.indexOf(xs[1])', 'xs[1] in [xs[0]]']) {
      try {
        env.evaluateSync(source, { xs: [deep(), deep()] })
        expect.unreachable(source)
      } catch (error) {
        expect(error, source).toMatchObject({ code: 'TOO_DEEP' })
        expect((error as BonsaiError).span, source).toBeDefined()
      }
    }
  })
})

describe('long computed keys cost their length', () => {
  it('stops building maps with long keys within the budget', () => {
    expect(
      run(
        'let s = "a".repeat(99990); "a".repeat(3000).split("").map((x, i) => {[s + toString(i)]: 1}).length',
      ),
    ).toEqual({ code: 'STEP_LIMIT' })
    expect(
      run(
        'let s = "a".repeat(99990); "a".repeat(1000).split("").groupBy((x, i) => s + toString(i)).keys().length',
      ),
    ).toEqual({ code: 'STEP_LIMIT' })
  })

  it('charges looking a long key up', () => {
    const k = 'a'.repeat(50_000)
    const short = minimalSteps(env, 'm[k]', { m: {}, k: 'a' })
    const long = minimalSteps(env, 'm[k]', { m: {}, k })
    expect(long - short).toBeGreaterThan(1000)
    expect(
      minimalSteps(env, 'k in m', { m: {}, k }) - minimalSteps(env, 'k in m', { m: {}, k: 'a' }),
    ).toBeGreaterThan(1000)
  })

  it('charges isEmpty by the number of keys', () => {
    const m = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]))
    expect(minimalSteps(env, 'isEmpty(m)', { m })).toBeGreaterThan(10_000)
  })
})

describe('host call cost', () => {
  const make = (cost?: number): ReturnType<typeof bonsai> =>
    bonsai({
      functions: {
        id: fn({
          params: [t.number()],
          returns: t.number(),
          run: (n) => n,
          ...(cost === undefined ? {} : { cost }),
        }),
      },
    })

  it('defaults to 32 steps a call, and follows a declared cost', () => {
    const source = 'xs.map(x => id(x)).length'
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const standard = minimalSteps(make(), source, { xs })
    const cheap = minimalSteps(make(1), source, { xs })
    const free = minimalSteps(make(0), source, { xs })
    expect(standard - cheap).toBe(31 * 100)
    expect(cheap - free).toBe(100)
  })

  it('rejects an invalid cost', () => {
    const spec = { params: [], returns: t.number(), run: () => 1 }
    expect(() => fn({ ...spec, cost: -1 })).toThrow(RangeError)
    expect(() => fn({ ...spec, cost: 1.5 })).toThrow(RangeError)
    expect(() => fn({ ...spec, cost: '1' as unknown as number })).toThrow(TypeError)
  })
})

describe('time zones', () => {
  it('groups 50,000 events of a year by local day within the default budget', () => {
    const start = Date.UTC(2025, 0, 1)
    const events = Array.from(
      { length: 50_000 },
      (_, i) => new Date(start + Math.floor((i / 50_000) * 365 * 86_400_000)),
    )
    expect(
      env.evaluateSync(
        'events.groupBy(e => toString(startOfDay(e, "Europe/Berlin"))).keys().length',
        { events },
      ),
    ).toBe(366)
  })

  it('charges the same steps whether or not offsets are cached', () => {
    const fresh = bonsai()
    const source = 'xs.map(e => hour(e, "Asia/Kolkata")).length'
    const xs = Array.from(
      { length: 50 },
      (_, i) => new Date(Date.UTC(1990, 0, 1) + i * 86_400_000 * 11),
    )
    const cold = minimalSteps(fresh, source, { xs })
    const warm = minimalSteps(fresh, source, { xs })
    expect(warm).toBe(cold)
  })

  it('agrees with Intl across transitions', () => {
    const zones = ['America/New_York', 'Europe/Dublin', 'Australia/Lord_Howe', 'Pacific/Chatham']
    for (const zone of zones) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        hour: 'numeric',
        minute: 'numeric',
      })
      for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2025, 0, 1); ms += 37 * 60_000 + 13_000) {
        const parts = formatter.formatToParts(new Date(ms))
        const want = parts
          .filter((p) => p.type === 'hour' || p.type === 'minute')
          .map((p) => Number(p.value))
        const got = env.evaluateSync('[hour(d, z), minute(d, z)]', { d: new Date(ms), z: zone })
        expect(got, `${zone} ${new Date(ms).toISOString()}`).toEqual(want)
      }
    }
  })
})
