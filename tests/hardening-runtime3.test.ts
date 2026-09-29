import { describe, expect, it } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'
import { outcome, outcomeAsync, run } from './helpers.js'

const env = bonsai()
describe('text an expression produces is charged by its length', () => {
  it('stops building long strings at the step limit, holding little memory', () => {
    // Each iteration builds (and, by indexing, flattens) a new 100,000-character string.
    const source =
      'let s = "a".repeat(99990); "a".repeat(50000).split("").map((x, i) => let r = s + toString(i); r[0] == "a" ? r : "").length'
    expect(run(source)).toEqual({ code: 'STEP_LIMIT' })
  })

  it('charges a concatenation by the length of its result', () => {
    const ctx = { s: 'a'.repeat(32_000) }
    expect(run('(s + "x").length', ctx, 500)).toEqual({ code: 'STEP_LIMIT' })
    expect(run('(s + "x").length', ctx, 5000)).toEqual({ value: 32_001 })
  })

  it('charges a template by the length of its result', () => {
    const ctx = { s: 'a'.repeat(32_000) }
    expect(run('`${s}!`.length', ctx, 500)).toEqual({ code: 'STEP_LIMIT' })
  })

  it("charges a built-in's text result", () => {
    expect(run('"ab".repeat(20000).toUpperCase().length', {}, 1000)).toEqual({ code: 'STEP_LIMIT' })
    expect(run('"ab".repeat(20000).toUpperCase().length', {}, 20_000)).toEqual({ value: 40_000 })
  })

  it('charges comparing equal strings, even when they are the same string', () => {
    const s = 'a'.repeat(100_000)
    expect(run('s == s && s == t', { s, t: `${'a'.repeat(99_999)}a` }, 1000)).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(run('s != s', { s }, 1000)).toEqual({ code: 'STEP_LIMIT' })
    expect(run('s == s', { s }, 10_000)).toEqual({ value: true })
  })
})

describe('failures caught by try() are paid for', () => {
  it.each([
    ['try(1 / 0, 0)'],
    ['try(toNumber("zz"), 0)'],
    ['try(formatCurrency(1, "QQ"), "")'],
    ['try(formatNumber(1, 2, "!!"), "")'],
    ['try(startOfDay(now(), "Bad/Zone"), now())'],
  ])('%s costs at least an error each time', (body) => {
    const source = `"a".repeat(20000).split("").map(x => ${body}).length`
    expect(run(source)).toEqual({ code: 'STEP_LIMIT' })
    expect(run(`"a".repeat(100).split("").map(x => ${body}).length`)).toEqual({ value: 100 })
  })

  it('charges compiling a pattern before it fails', () => {
    const p = `[${'a'.repeat(4000)}z-a]`
    // Distinct failing patterns: each one is read (and charged) before it fails.
    expect(
      run(
        '"a".repeat(300).split("").map((x, i) => try("b".matches(p + toString(i)), false)).length',
        {
          p,
        },
      ),
    ).toEqual({ code: 'STEP_LIMIT' })
    // The same failing pattern is remembered: repeats cost only the error.
    expect(
      run('"a".repeat(1000).split("").map(x => try("b".matches(p), false)).length', { p }),
    ).toEqual({ value: 1000 })
  })
})

describe('formatDate', () => {
  const at = new Date('2026-03-29T01:30:00Z')

  it('checks the result length before building it', () => {
    expect(run('formatDate(at, p)', { at, p: 'EEEE'.repeat(25_000) })).toEqual({
      code: 'STRING_LIMIT',
    })
  })

  it('charges each pattern token', () => {
    expect(run('formatDate(at, p).length', { at, p: 's'.repeat(100_000) }, 100_000)).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(run('formatDate(at, "yyyy-MM-dd \'at\' HH:mm")', { at })).toEqual({
      value: '2026-03-29 at 01:30',
    })
  })
})

describe('values that are not what they seem', () => {
  it('reads an object with a then method as a map, and a real promise as opaque', () => {
    expect(run('x.a + 1', { x: { a: 1, then: (): void => undefined } })).toEqual({ value: 2 })
    expect(run('type(p)', { p: Promise.resolve(1) })).toEqual({ value: 'opaque' })
  })

  it('treats an object that only inherits from Date.prototype as opaque', () => {
    const fake = Object.create(Date.prototype) as Date
    expect(run('type(x)', { x: fake })).toEqual({ value: 'opaque' })
    expect(run('x == x', { x: fake })).toEqual({ value: true })
    expect(run('year(x)', { x: fake })).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(outcome(() => env.evaluateSync('x', { x: fake }))).toEqual({ value: fake })
  })

  it('classifies a prototype the same whatever was seen first', () => {
    class Foo {
      readonly a = 1
    }
    const disguised = Object.setPrototypeOf(new Map([['a', 2]]), Foo.prototype) as object
    const fresh = bonsai()
    fresh.evaluateSync('type(m)', { m: disguised })
    expect(outcome(() => fresh.evaluateSync('f.a', { f: new Foo() }))).toEqual({ value: 1 })
    expect(outcome(() => fresh.evaluateSync('type(f)', { f: new Foo() }))).toEqual({ value: 'map' })
  })
})

describe('sort, min, and max check every item, even alone', () => {
  it.each([
    ['sort([x])', { x: 1n }, 'TYPE_ERROR'],
    ['min([x])', { x: { a: 1 } }, 'TYPE_ERROR'],
    ['sort([x])', { x: new Map() }, 'TYPE_ERROR'],
    ['sort([x])', { x: new Date(Number.NaN) }, 'INVALID_ARGUMENT'],
    ['max([null, x])', { x: new Date(Number.NaN) }, 'INVALID_ARGUMENT'],
    ['sortBy([x], .)', { x: 1n }, 'TYPE_ERROR'],
  ])('%s with %o is %s', (source, ctx, code) => {
    expect(run(source, ctx)).toEqual({ code })
  })

  it('still orders a single valid item', () => {
    expect(run('sort([3])')).toEqual({ value: [3] })
    expect(run('max([null, 2])')).toEqual({ value: 2 })
  })
})

describe('regular expressions', () => {
  it('lets only ASCII punctuation stand for itself when escaped', () => {
    const matches = (text: string, pattern: string): unknown =>
      run('matches(text, pattern)', { text, pattern })
    expect(matches('a-b.c', 'a\\-b\\.c')).toEqual({ value: true })
    expect(matches('é', '\\é')).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(matches(' ', '\\ ')).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(matches('😀', '\\😀')).toEqual({ code: 'INVALID_ARGUMENT' })
  })
})

describe('time', () => {
  it('reports an out-of-range year offset as such', () => {
    const result = outcome(() => env.evaluateSync('addYears(now(), 1e308)'))
    expect(result).toEqual({ code: 'INVALID_ARGUMENT' })
    try {
      env.evaluateSync('addYears(now(), 1e308)')
    } catch (error) {
      expect((error as Error).message).toContain('out of range')
    }
  })
})

describe('host errors whose message cannot be read', () => {
  function unreadable(): Error {
    const error = new Error('x')
    Object.defineProperty(error, 'message', {
      get() {
        // A null-prototype object: not an Error, and it cannot even be turned into text.
        // oxlint-disable-next-line typescript/only-throw-error -- the point of the test
        throw Object.create(null) as object
      },
    })
    return error
  }

  it('are HOST_ERRORs when reading context data, and try() recovers', () => {
    const o = {
      get x(): number {
        throw unreadable()
      },
    }
    expect(run('o.x', { o })).toEqual({ code: 'HOST_ERROR' })
    expect(run('try(o.x, 1)', { o })).toEqual({ value: 1 })
    expect(run('[o].map(.x)', { o })).toEqual({ code: 'HOST_ERROR' })
  })

  it('are HOST_ERRORs from host functions, and try() recovers', () => {
    const hosted = bonsai({
      functions: {
        boom: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw unreadable()
          },
        }),
      },
    })
    expect(outcome(() => hosted.evaluateSync('boom()'))).toEqual({ code: 'HOST_ERROR' })
    expect(outcome(() => hosted.evaluateSync('try(boom(), 1)'))).toEqual({ value: 1 })
  })
})

describe('evaluation options and signals are host code too', () => {
  const slow = bonsai({
    functions: {
      wait: fn({
        params: [],
        returns: t.number(),
        async: true,
        run: () =>
          new Promise<number>((resolve) => {
            setTimeout(() => {
              resolve(1)
            }, 5)
          }),
      }),
    },
  })

  it('settles when removing the abort listener throws', async () => {
    const signal = {
      aborted: false,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => {
        throw new Error('broken')
      },
    }
    expect(await outcomeAsync(() => slow.evaluate('wait()', {}, { signal }))).toEqual({ value: 1 })
  })

  it('fails closed when adding the abort listener throws', async () => {
    const signal = {
      aborted: false,
      addEventListener: (): void => {
        throw new Error('broken')
      },
      removeEventListener: (): void => undefined,
    }
    expect(await outcomeAsync(() => slow.evaluate('wait()', {}, { signal }))).toEqual({
      code: 'ABORTED',
    })
  })

  it('reads a signal whose aborted getter throws as aborted', async () => {
    let calls = 0
    const signal = {
      get aborted(): boolean {
        calls++
        // The option check reads it once; the evaluation's reads throw.
        if (calls > 1) throw new Error('broken')
        return false
      },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }
    expect(await outcomeAsync(() => slow.evaluate('wait()', {}, { signal }))).toEqual({
      code: 'ABORTED',
    })
  })

  it('does not time out early with a very long timeout', async () => {
    expect(await outcomeAsync(() => slow.evaluate('wait()', {}, { timeout: 3e9 }))).toEqual({
      value: 1,
    })
  })

  it('rejects options whose getters throw as invalid options', () => {
    const options = {
      get maxSteps(): number {
        throw new Error('broken')
      },
    }
    expect(() => env.evaluateSync('1', {}, options)).toThrow(TypeError)
  })
})
