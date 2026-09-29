import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'
import { minimalSteps, outcome, outcomeAsync, run } from './helpers.js'

const env = bonsai()
/** Wall time of `f` in milliseconds. */
function timed(f: () => void): number {
  const start = performance.now()
  f()
  return performance.now() - start
}

const ASCII_MAX = 0x7f

// Generous bounds: the point is minutes-long work is now impossible, not a precise budget.
const QUICK_MS = 1500

/** `n` distinct non-ASCII characters, for patterns with large classes. */
function distinct(n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += String.fromCodePoint(0x100 + i * 3)
  return out
}

describe('regular expressions stay bounded', () => {
  it('rejects patterns over maxPatternLength', () => {
    const p = `[${'a'.repeat(5000)}]`
    expect(run('"a".matches(p)', { p })).toEqual({ code: 'PATTERN_LIMIT' })
    const roomy = bonsai({ limits: { maxPatternLength: 10_000 } })
    expect(roomy.evaluateSync('"a".matches(p)', { p })).toBe(true)
  })

  it('matches large classes in time proportional to the budget', () => {
    const p = `[^${distinct(4090)}]x`
    let result: unknown
    expect(
      timed(() => {
        result = run('"a".repeat(100000).matches(p)', { p })
      }),
    ).toBeLessThan(QUICK_MS)
    expect(result).toEqual({ value: false })
    // Ends in a class, so the literal prefilter cannot rule the text out.
    const repeated = `[${distinct(4000)}a]{1000}[bc]`
    expect(
      timed(() => {
        result = run('"a".repeat(7000).matches(p)', { p: repeated })
      }),
    ).toBeLessThan(QUICK_MS)
    expect(result).toEqual({ code: 'STEP_LIMIT' })
  })

  it('keeps huge classes linear when the pattern limit is raised', () => {
    const roomy = bonsai({ limits: { maxPatternLength: 200_000 } })
    const source =
      'let p = "[^" + "\\u0100".repeat(99990) + "]"; "a".repeat(100000).matches(p + "x")'
    expect(
      timed(() => {
        roomy.evaluateSync(source)
      }),
    ).toBeLessThan(QUICK_MS)
  })

  it('does not keep unbounded compiled patterns', () => {
    const roomy = bonsai({ limits: { maxPatternLength: 200_000 } })
    const source =
      'let c = "[" + "\\u0100".repeat(99000); "a".repeat(250).split("").map((x, i) => "b".matches(c + toString(i) + "]")).length'
    const before = process.memoryUsage().heapUsed
    expect(outcome(() => roomy.evaluateSync(source))).toEqual({ code: 'STEP_LIMIT' })
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200_000_000)
  })

  it('charges every NFA state it visits', () => {
    // 1000 alternatives stay live at every position: 100k positions x 1000 states.
    expect(run('"a".repeat(100000).matches("(?:a|a){1000}x")')).toEqual({ code: 'STEP_LIMIT' })
  })

  it('tries an anchored pattern at the start only', () => {
    // Passing 100k characters costs about 3k steps; searching every position would cost 100k.
    const ctx = { a: 'a'.repeat(100_000), b: 'b'.repeat(100_000) }
    expect(run('a.matches("^abc")', ctx, 5000)).toEqual({ value: false })
    expect(run('b.matches("^b|c")', ctx, 5000)).toEqual({ value: true })
    expect(run('a.matches("a[bc]")', ctx, 5000)).toEqual({ code: 'STEP_LIMIT' })
  })

  it('charges the same steps whether or not a pattern is cached', () => {
    const source = '"xyz".matches(p) && "xyz".matches(p)'
    const ctx = { p: `^${'x?'.repeat(500)}xyz` }
    const cold = minimalSteps(bonsai(), source, ctx)
    const warm = bonsai()
    warm.evaluateSync(source, ctx)
    expect(minimalSteps(warm, source, ctx)).toBe(cold)
  })

  test.prop([
    fc.array(
      fc.oneof(
        fc.constantFrom('a', 'Z', '0', '_', ' ', '-', '\\d', '\\w', '\\s', '\\D', '\\W', '\\S'),
        fc.constantFrom('a-f', 'A-F', '0-9', 'x-z', '\\u00e0-\\u00ff', '\\u{1F600}-\\u{1F64F}'),
      ),
      { minLength: 1, maxLength: 5 },
    ),
    fc.boolean(),
    fc.boolean(),
    fc.string({ unit: 'binary', maxLength: 6 }),
  ])('classes match like JavaScript regular expressions', (members, negated, ignoreCase, text) => {
    const body = `[${negated ? '^' : ''}${members.join('')}]`
    const flags = ignoreCase ? 'iu' : 'u'
    let native: boolean
    try {
      native = new RegExp(body, flags).test(text)
    } catch {
      return
    }
    // Bonsai's (?i) folds ASCII letters only; skip texts where JavaScript would fold more.
    if (ignoreCase && Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) > ASCII_MAX)) return
    expect(
      env.evaluateSync('text.matches(p)', { text, p: `${ignoreCase ? '(?i)' : ''}${body}` }),
    ).toBe(native)
  })
})

describe('text operations charge their worst case', () => {
  const ctx = {
    t: 'a'.repeat(100_000),
    p: `${'a'.repeat(25_000)}b${'a'.repeat(24_999)}`,
  }
  it.each([
    'p in t',
    't.includes(p)',
    't.indexOf(p)',
    't.lastIndexOf(p)',
    't.split(p).length',
    't.replace(p, "")',
    't.replaceAll(p, "")',
  ])('%s fails fast instead of searching for seconds', (body) => {
    let result: unknown
    expect(
      timed(() => {
        result = run(`"a".repeat(620).split("").map(x => ${body}).length`, ctx)
      }),
    ).toBeLessThan(QUICK_MS)
    expect(result).toEqual({ code: 'STEP_LIMIT' })
  })

  it('still searches ordinary text cheaply', () => {
    expect(run('"a".repeat(100).split("").map(x => t.includes("ab")).length', ctx)).toEqual({
      value: 100,
    })
  })

  it('charges comparing and sorting long strings', () => {
    const long = { s: 'a'.repeat(100_000), u: `${'a'.repeat(99_999)}b` }
    for (const body of ['s < u', 's == u', 's in [u, u, u]']) {
      expect(run(`"a".repeat(100000).split("").map(x => ${body}).length`, long)).toEqual({
        code: 'STEP_LIMIT',
      })
    }
    expect(
      run('"ab".repeat(20000).split("").map(x => x == "a" ? s : u).sort().length', long),
    ).toEqual({ code: 'STEP_LIMIT' })
  })

  it('charges appending in reduce by the text built; join builds long text in one step', () => {
    expect(run('reduce("abcde".repeat(1000).split(""), (a, x) => a + x, "").length')).toEqual({
      value: 5000,
    })
    expect(run('reduce("abcde".repeat(20000).split(""), (a, x) => a + x, "").length')).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(run('join("abcde".repeat(20000).split(""), "").length')).toEqual({ value: 100_000 })
  })

  it('shortens input echoed in error messages', () => {
    const long = 'z'.repeat(10_000)
    for (const source of ['timestamp(x)', 'toNumber(x)', 'year(now(), x)']) {
      try {
        env.evaluateSync(source, { x: long })
        expect.unreachable()
      } catch (error) {
        expect((error as Error).message.length, source).toBeLessThan(200)
      }
    }
  })
})

describe('time zones are charged by their real cost', () => {
  it('bounds a million zoned computations', () => {
    const source =
      'let xs = "x".repeat(1000).split(""); let d = timestamp("2026-03-29T01:30:00Z"); xs.map(a => xs.map(b => startOfDay(d, "Europe/Berlin"))).length'
    let result: unknown
    expect(
      timed(() => {
        result = run(source)
      }),
    ).toBeLessThan(QUICK_MS)
    expect(result).toEqual({ code: 'STEP_LIMIT' })
  })

  it('charges formatter creation per evaluation, not per cache state', () => {
    const source = 'formatNumber(1.5, 2, "de-DE") + formatNumber(2.5, 2, "de-DE")'
    const e = bonsai()
    const cold = minimalSteps(e, source, {})
    // The formatter is now cached in this environment; the charge must not change.
    expect(minimalSteps(e, source, {})).toBe(cold)
    expect(cold).toBeGreaterThan(256)
  })
})

describe('unique is linear and agrees with ==', () => {
  it('handles thousands of maps', () => {
    let result: unknown
    expect(
      timed(() => {
        result = run('"a".repeat(16000).split("").map((x, i) => {id: i % 100}).unique().length')
      }),
    ).toBeLessThan(QUICK_MS)
    expect(result).toEqual({ value: 100 })
  })

  it('treats values as == does', () => {
    const d1 = new Date(0)
    const d2 = new Date(0)
    const m = new Map()
    const ctx = { d1, d2, m, m2: new Map() }
    expect(
      env.evaluateSync(
        '[{a: 1, b: [1, 2]}, {b: [1, 2], a: 1}, {a: 1}, [1, "1"], [1, "1"], d1, d2, days(1), hours(24), m, m, m2, 0, -0, "x", "x", null].unique()',
        ctx,
      ),
    ).toEqual([
      { a: 1, b: [1, 2] },
      { a: 1 },
      [1, '1'],
      d1,
      expect.objectContaining({ ms: 86_400_000 }),
      m,
      ctx.m2,
      0,
      'x',
      null,
    ])
  })

  test.prop([fc.array(fc.jsonValue({ maxDepth: 3 }), { maxLength: 12 })])(
    'keeps exactly the first of each group of equal items',
    (items) => {
      const got = env.evaluateSync('xs.unique()', { xs: items }) as unknown[]
      const eq = env.compile('a == b')
      const expected: unknown[] = []
      for (const item of items) {
        const value = item ?? null
        if (!expected.some((kept) => eq.evaluateSync({ a: kept, b: value }) === true))
          expected.push(value)
      }
      expect(got).toEqual(expected)
    },
  )
})

describe('produced values are bounded', () => {
  it('stops a result that doubles by sharing', () => {
    let result: unknown
    expect(
      timed(() => {
        result = run('reduce("a".repeat(60).split(""), (acc, x) => [acc, acc], 0)')
      }),
    ).toBeLessThan(QUICK_MS)
    expect(result).toEqual({ code: 'STEP_LIMIT' })
    expect(run('reduce("a".repeat(30).split(""), (acc, x) => {l: acc, r: acc}, 0)')).toEqual({
      code: 'STEP_LIMIT',
    })
  })

  it('stops nesting at maxValueDepth', () => {
    expect(run('reduce("a".repeat(100000).split(""), (acc, x) => [acc], 0)')).toEqual({
      code: 'TOO_DEEP',
    })
    expect(run('reduce("a".repeat(100).split(""), (acc, x) => {inner: acc}, 0)')).toEqual({
      code: 'TOO_DEEP',
    })
    const deep = run('reduce("a".repeat(60).split(""), (acc, x) => [acc], 0)') as { value: unknown }
    expect(JSON.stringify(deep.value).length).toBe(121)
  })

  it('charges repeating a large list', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => i)
    expect(run('"a".repeat(1000).split("").map(x => big).length', { big })).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(run('"a".repeat(1000).split("").map(x => [1, 2, 3]).length')).toEqual({ value: 1000 })
  })

  it('builds ordinary nested results', () => {
    expect(
      env.evaluateSync('xs.map({id: ., tags: [., . + 1], meta: {n: .}}).length', {
        xs: Array.from({ length: 10_000 }, (_, i) => i),
      }),
    ).toBe(10_000)
    expect(env.evaluateSync('entries({a: 1, b: [1]})')).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: [1] },
    ])
    expect(env.evaluateSync('[1, 2, 3, 4].groupBy(. % 2 == 0)')).toEqual({
      false: [1, 3],
      true: [2, 4],
    })
  })
})

describe('the host boundary', () => {
  it('reads built-in host collections as opaque values', () => {
    const ctx = {
      m: new Map([['a', 1]]),
      set: new Set([1]),
      re: /a/u,
      err: new Error('x'),
      buf: new Uint8Array([1]),
      p: Promise.resolve(1),
      user: new (class User {
        name = 'Ada'
      })(),
    }
    for (const name of ['m', 'set', 're', 'err', 'buf', 'p']) {
      expect(run(`type(${name})`, ctx), name).toEqual({ value: 'opaque' })
      expect(run(`${name} == {}`, ctx), name).toEqual({ value: false })
      expect(run(`${name} == ${name}`, ctx), name).toEqual({ value: true })
      expect(run(`isEmpty(${name})`, ctx), name).toEqual({ code: 'NO_OVERLOAD' })
      expect(run(`keys(${name})`, ctx), name).toEqual({ code: 'NO_OVERLOAD' })
      expect(run(`{...${name}}`, ctx), name).toEqual({ code: 'TYPE_ERROR' })
      expect(run(`"a" in ${name}`, ctx), name).toEqual({ code: 'TYPE_ERROR' })
      expect(run(`${name}["zz"]`, ctx), name).toEqual({ code: 'TYPE_ERROR' })
    }
    expect(run('m.a', ctx)).toEqual({ code: 'TYPE_ERROR' })
    expect(run('set.size', ctx)).toEqual({ code: 'TYPE_ERROR' })
    // Class instances are still maps of their own properties.
    expect(run('user.name', ctx)).toEqual({ value: 'Ada' })
    expect(run('type(user)', ctx)).toEqual({ value: 'map' })
  })

  it('treats an invalid Date as opaque', () => {
    const ctx = { bad: new Date(Number.NaN), bad2: new Date(Number.NaN) }
    expect(run('type(bad)', ctx)).toEqual({ value: 'opaque' })
    expect(run('bad == bad', ctx)).toEqual({ value: true })
    expect(run('bad == bad2', ctx)).toEqual({ value: false })
    expect(run('timestamp(bad)', ctx)).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(run('year(bad)', ctx)).toEqual({ code: 'INVALID_ARGUMENT' })
  })

  it('never runs host code on list receivers', () => {
    let calls = 0
    class Spy extends Array<number> {
      static override get [Symbol.species](): ArrayConstructor {
        calls++
        return Array
      }
      override map<U>(...args: Parameters<Array<number>['map']>): U[] {
        calls++
        return super.map(...args) as U[]
      }
      override slice(start?: number, end?: number): number[] {
        calls++
        return super.slice(start, end)
      }
      override at(index: number): number | undefined {
        calls++
        return super.at(index)
      }
      override [Symbol.iterator](): ArrayIterator<number> {
        calls++
        return super[Symbol.iterator]()
      }
    }
    const xs = Spy.from([3, 1, 2])
    for (const source of [
      'xs.slice(0, 2)',
      'xs.sortBy(.)',
      'xs.sort()',
      'xs.reverse()',
      'xs.at(-1)',
      'last(xs)',
      'sum(xs)',
      'avg(xs)',
      'min(xs)',
      'max(xs)',
      'reduce(xs, (a, x) => a + x, 0)',
      'xs.flat()',
      'xs.flatMap([.])',
      'xs.unique()',
      '[...xs]',
      'max(...xs)',
    ]) {
      expect(run(source, { xs }), source).not.toHaveProperty('code')
    }
    expect(calls).toBe(0)
  })

  it('reports throwing host data as HOST_ERROR, which try() recovers from', async () => {
    const getter = {
      get x(): number {
        throw new Error('getter')
      },
    }
    const proxy = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap')
        },
        ownKeys: () => {
          throw new Error('trap')
        },
      },
    )
    const ctx = { getter, proxy }
    for (const source of ['getter.x', 'proxy.a', '"a" in proxy', 'keys(proxy)', '{...proxy}']) {
      expect(run(source, ctx), source).toEqual({ code: 'HOST_ERROR' })
      expect(run(`try(${source}, 7)`, ctx), source).toEqual({ value: 7 })
    }
    const lazy = bonsai({
      functions: {
        pause: fn({ params: [], returns: t.number(), async: true, run: () => Promise.resolve(1) }),
      },
    })
    expect(await outcomeAsync(() => lazy.evaluate('pause() + getter.x', ctx))).toEqual({
      code: 'HOST_ERROR',
    })
    expect(await outcomeAsync(() => lazy.evaluate('try(pause() + getter.x, 7)', ctx))).toEqual({
      value: 7,
    })
  })

  it('reports a host result with a throwing then as HOST_ERROR', () => {
    const e = bonsai({
      functions: {
        thenny: fn({
          params: [],
          returns: t.any(),
          run: () => ({
            get then(): never {
              throw new Error('then')
            },
          }),
        }),
      },
    })
    expect(outcome(() => e.evaluateSync('thenny()'))).toEqual({ code: 'HOST_ERROR' })
  })

  it('checks host results deeply, as HOST_CONTRACT that try() does not recover from', () => {
    const e = bonsai({
      functions: {
        nums: fn({
          params: [],
          returns: t.list(t.number()),
          run: () => ['a'] as unknown as number[],
        }),
        obj: fn({
          params: [],
          returns: t.object({ n: t.number() }),
          run: () => ({}) as { n: number },
        }),
        plan: fn({
          params: [],
          returns: t.object({ k: t.enum('free', 'pro') }),
          run: () => ({ k: 'gold' }) as unknown as { k: 'free' },
        }),
        when: fn({ params: [], returns: t.timestamp(), run: () => new Date(Number.NaN) }),
        fine: fn({ params: [], returns: t.list(t.number()), run: () => [1, 2] }),
      },
    })
    for (const call of ['nums()', 'obj()', 'plan()', 'when()']) {
      expect(
        outcome(() => e.evaluateSync(call)),
        call,
      ).toEqual({ code: 'HOST_CONTRACT' })
      expect(
        outcome(() => e.evaluateSync(`try(${call}, null)`)),
        call,
      ).toEqual({
        code: 'HOST_CONTRACT',
      })
    }
    expect(e.evaluateSync('fine()')).toEqual([1, 2])
  })

  it('caps host calls per evaluation', () => {
    let calls = 0
    const e = bonsai({
      functions: {
        ping: fn({ params: [], returns: t.number(), run: () => ++calls }),
      },
      limits: { maxSteps: 10_000 },
    })
    expect(
      outcome(() => e.evaluateSync('"a".repeat(10000).split("").map(x => ping()).length')),
    ).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(calls).toBeLessThan(10_000 / 32)
  })
})

describe('numbers never become non-finite', () => {
  const inf = { x: Number.POSITIVE_INFINITY, n: Number.NaN }
  it.each([
    '-x',
    'abs(x)',
    'floor(x)',
    'ceil(x)',
    'trunc(x)',
    'clamp(x, 1, 2)',
    'clamp(1, 0, x)',
    'min([1, x])',
    'max(1, x)',
    '[x, 1].sort()',
    '[n, 1].sort()',
    '[n, 1].sortBy(.)',
    'max([n, 3, 1])',
    'min([3, n, 1])',
    'sum([1, x])',
    'avg([n])',
    'formatNumber(x)',
    'formatCurrency(x, "EUR")',
    'toFixed(x, 2)',
  ])('%s', (source) => {
    expect(run(source, inf)).toEqual({ code: 'NON_FINITE' })
  })
})

describe('values', () => {
  it('compares maps symmetrically when a key is not enumerable', () => {
    const a = { k: 1, j: 2 }
    const b = { j: 2, z: 3 }
    Object.defineProperty(b, 'k', { value: 1, enumerable: false })
    expect(run('a == b', { a, b })).toEqual({ value: false })
    expect(run('b == a', { a, b })).toEqual({ value: false })
  })

  it('prints durations as ISO-8601 at any magnitude', () => {
    expect(env.evaluateSync('`${milliseconds(0.0001)}`')).toBe('PT0.0000001S')
    expect(env.evaluateSync('`${milliseconds(5e-324)}`')).toBe('PT0S')
    expect(env.evaluateSync('`${seconds(59.9999999999)}`')).toBe('PT1M')
    expect(env.evaluateSync('`${days(1e300)}`')).toMatch(/^P1\d{300}D$/u)
  })

  it('evaluates list literal items before charging, in sync and async alike', async () => {
    const e = bonsai({
      functions: {
        id: fn({ params: [t.any()], returns: t.any(), run: (x) => x }),
        aid: fn({
          params: [t.any()],
          returns: t.any(),
          async: true,
          run: (x) => Promise.resolve(x),
        }),
      },
    })
    // The host call costs 32 steps and the error 64; the failing item comes
    // before the list is charged.
    expect(outcome(() => e.evaluateSync('[id(1), z - 1]', { z: null }, { maxSteps: 97 }))).toEqual({
      code: 'TYPE_ERROR',
    })
    expect(
      await outcomeAsync(() => e.evaluate('[aid(1), z - 1]', { z: null }, { maxSteps: 97 })),
    ).toEqual({ code: 'TYPE_ERROR' })
  })
})
