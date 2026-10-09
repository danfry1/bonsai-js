import { describe, expect, expectTypeOf, it } from 'vitest'
import { BonsaiLimitError, bonsai, fn, t, type LimitName } from '../src/index.js'

const fixed = new Date('2026-01-01T00:00:00Z')

describe('per-evaluation now', () => {
  const env = bonsai({ clock: () => fixed })

  it('fixes now() for one evaluation, then the clock applies again', async () => {
    const at = new Date('2030-06-01T12:00:00Z')
    expect(env.evaluateSync('year(now())', {}, { now: at })).toBe(2030)
    expect(await env.evaluate('year(now())', {}, { now: at })).toBe(2030)
    expect(env.evaluateSync('year(now())')).toBe(2026)
    const explanation = env.explainSync('year(now())', {}, { now: at })
    expect(explanation.ok && explanation.value).toBe(2030)
  })

  it('applies to a residual evaluation', () => {
    const result = env.compile('year(now()) + n').partial({}, { unknown: ['n'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.evaluateSync({ n: 1 }, { now: new Date('2040-01-01T00:00:00Z') })).toBe(2041)
  })

  it('is validated like the partial option', () => {
    expect(() => env.evaluateSync('now()', {}, { now: 'today' as never })).toThrow(TypeError)
    expect(() => env.evaluateSync('now()', {}, { now: new Date(Number.NaN) })).toThrow(TypeError)
  })
})

describe('compile caching', () => {
  it('returns the same program for the same source and expected type', () => {
    const env = bonsai({ variables: { a: t.number() } })
    const first = env.compile('a > 1', { expect: t.boolean() })
    expect(env.compile('a > 1', { expect: t.boolean() })).toBe(first)
    expect(env.compile('a > 1')).not.toBe(first)
    expect(env.compile('a > 1')).toBe(env.compile('a > 1'))
    expect(env.compile('a > 1', { expect: t.any() })).not.toBe(first)
  })

  it('keeps caching off when cacheSize is 0', () => {
    const env = bonsai({ cacheSize: 0 })
    expect(env.compile('1 + 2')).not.toBe(env.compile('1 + 2'))
  })
})

describe('env.partial', () => {
  const env = bonsai({ variables: { user: t.object({ age: t.number() }), limit: t.number() } })

  it('partially evaluates a source, like compile(source).partial', () => {
    const result = env.partial('user.age > limit', { limit: 18 })
    expect(result.status).toBe('residual')
    if (result.status === 'residual') expect(result.source).toBe('user.age > 18')
  })

  it('throws syntax and check errors like evaluateSync', () => {
    expect(() => env.partial('user.age >', {})).toThrow(expect.objectContaining({ code: 'SYNTAX' }))
    expect(() => env.partial('usr.age > 1', {})).toThrow(expect.objectContaining({ code: 'CHECK' }))
  })
})

describe('partial budgets', () => {
  const env = bonsai()

  it('takes maxSteps, timeout, and signal like evaluation', () => {
    const program = env.compile('[1, 2, 3].map(x => x * k).sum() + n')
    expect(() => program.partial({ k: 2 }, { unknown: ['n'], maxSteps: 2 })).toThrow(
      expect.objectContaining({ code: 'STEP_LIMIT' }),
    )
    const controller = new AbortController()
    controller.abort()
    expect(() => program.partial({ k: 2 }, { unknown: ['n'], signal: controller.signal })).toThrow(
      expect.objectContaining({ code: 'ABORTED' }),
    )
    expect(program.partial({ k: 2 }, { unknown: ['n'], timeout: 1000, maxSteps: 0 }).status).toBe(
      'residual',
    )
  })

  it('validates them with the same rules', () => {
    const program = env.compile('n + 1')
    expect(() => program.partial({}, { maxSteps: -1 })).toThrow(RangeError)
    expect(() => program.partial({}, { timeout: 'soon' as never })).toThrow(TypeError)
    expect(() => program.partial({}, { signal: {} as never })).toThrow(TypeError)
  })
})

describe('limit errors name their limit', () => {
  const limitOf = (run: () => unknown): LimitName | undefined => {
    try {
      run()
    } catch (error) {
      if (error instanceof BonsaiLimitError) return error.limit
      throw error
    }
    throw new Error('expected a limit error')
  }

  it('for each configurable limit', () => {
    expect(
      limitOf(() => bonsai({ limits: { maxSteps: 5 } }).evaluateSync('[1,2,3,4,5,6].map(x => x)')),
    ).toBe('maxSteps')
    expect(limitOf(() => bonsai({ limits: { maxSourceLength: 3 } }).evaluateSync('1 + 2'))).toBe(
      'maxSourceLength',
    )
    expect(limitOf(() => bonsai({ limits: { maxDepth: 2 } }).evaluateSync('((((1))))'))).toBe(
      'maxDepth',
    )
    expect(limitOf(() => bonsai({ limits: { maxNodes: 3 } }).evaluateSync('1 + 2 + 3 + 4'))).toBe(
      'maxNodes',
    )
    expect(
      limitOf(() => bonsai({ limits: { maxStringLength: 3 } }).evaluateSync('"ab" + "cd"')),
    ).toBe('maxStringLength')
    expect(
      limitOf(() => bonsai({ limits: { maxListLength: 3 } }).evaluateSync('[1, 2] + [3, 4]')),
    ).toBe('maxListLength')
    expect(limitOf(() => bonsai({ limits: { maxValueDepth: 2 } }).evaluateSync('[[[1]]]'))).toBe(
      'maxValueDepth',
    )
    expect(
      limitOf(() => bonsai({ limits: { maxPatternLength: 2 } }).evaluateSync('"a".matches("abc")')),
    ).toBe('maxPatternLength')
  })

  it('for time and cancellation, and not for fixed bounds', async () => {
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
              }, 200)
            }),
        }),
      },
    })
    await expect(slow.evaluate('wait()', {}, { timeout: 10 })).rejects.toMatchObject({
      limit: 'timeout',
    })
    const controller = new AbortController()
    controller.abort()
    await expect(slow.evaluate('wait()', {}, { signal: controller.signal })).rejects.toMatchObject({
      limit: 'signal',
    })
    const nested = `\`${'${`'.repeat(40)}x${'`}'.repeat(40)}\``
    let error: unknown
    try {
      bonsai().evaluateSync(nested)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'TOO_DEEP' })
    expect((error as BonsaiLimitError).limit).toBeUndefined()
  })
})

describe('typing', () => {
  it('lets a non-strict environment take undeclared keys', () => {
    const env = bonsai({ variables: { a: t.number() }, strict: false })
    expect(env.evaluateSync('a + b', { a: 1, b: 2 })).toBe(3)
    const strict = bonsai({ variables: { a: t.number() } })
    // @ts-expect-error: a strict environment knows only its declared variables
    strict.evaluateSync('a', { a: 1, b: 2 })
    // @ts-expect-error: declared keys stay typed
    env.evaluateSync('a', { a: 'x' })
  })

  it('types rest arguments, optional results, and undefined flags', () => {
    const total = fn({
      params: [t.number()],
      rest: t.number(),
      returns: t.number(),
      run: (first, ...more) => {
        expectTypeOf(more).toEqualTypeOf<number[]>()
        return more.reduce((sum, n) => sum + n, first)
      },
    })
    const maybe = fn({
      params: [t.string()],
      returns: t.optional(t.string()),
      async: undefined,
      call: undefined,
      run: (s) => (s === '' ? undefined : s),
    })
    const env = bonsai({ functions: { total, maybe } })
    expect(env.evaluateSync('total(1, 2, 3)')).toBe(6)
    expect(env.evaluateSync('maybe("")')).toBe(null)
  })

  it('takes known data typed by an interface, with undefined optional fields', () => {
    interface Known {
      user?: { age?: number | undefined }
    }
    const env = bonsai({ variables: { user: t.object({ age: t.number() }), n: t.number() } })
    const known: Known = { user: { age: undefined } }
    const result = env.compile('n + 1').partial(known, { unknown: ['n'] })
    expect(result.status).toBe('residual')
  })
})

describe('residual explanations', () => {
  it('explain a residual as its program would, with the bindings supplied', async () => {
    const env = bonsai({
      variables: { user: t.object({ tag: t.string() }), tags: t.list(t.string()) },
    })
    const result = env.compile('user.tag in tags').partial({ tags: ['a', 'b'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    const sync = result.explainSync({ user: { tag: 'b' } })
    expect(sync.ok && sync.value).toBe(true)
    expect(String(sync)).toContain('user.tag')
    const later = await result.explain({ user: { tag: 'z' } })
    expect(later.ok && later.value).toBe(false)
    expect(later.reasons().length).toBeGreaterThan(0)
  })
})

describe('spreading an unknown map (found by the fuzzer)', () => {
  it('widens the fields written before it, which it may overwrite', () => {
    const env = bonsai({ variables: { when: t.timestamp() } })
    const source = '{ id: 1, ...(reduce([], (acc, x) => { v: acc }, { id: when })) }'
    expect(env.compile(source).type).toMatchObject({ fields: { id: { kind: 'any' } } })
    expect(() =>
      env.compile(source, { expect: t.object({ id: t.number() }) }).evaluateSync({ when: fixed }),
    ).toThrow(expect.objectContaining({ code: 'TYPE_ERROR' }))
  })
})
