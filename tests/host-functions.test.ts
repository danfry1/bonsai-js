// Host functions: argument validation against every Type kind, result
// validation, context functions, rest and optional parameters, declaration
// errors, and context validation (validateContext) for every Type kind.
import { describe, expect, it } from 'vitest'
import { BonsaiError, Duration, bonsai, fn, t, withContext, type Type } from '../src/index.js'

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiError) return error.code
    throw error
  }
  return 'OK'
}

/** An environment with one host function `f` that accepts `type` and echoes a marker. */
function accepting(type: Type, limits: Parameters<typeof bonsai>[0] = {}) {
  return bonsai({
    ...limits,
    functions: { f: fn({ params: [type], returns: t.boolean(), run: () => true }) },
  })
}

const handle = { opaque: true }
const later = new Date('2024-01-01T00:00:00Z')

describe('host argument validation', () => {
  const kinds: [string, Type, unknown[], unknown[]][] = [
    ['any', t.any(), [1, 'a', null, [], {}], []],
    ['never', t.never(), [], [1, null]],
    ['null', t.null(), [null, undefined], [0, '']],
    ['boolean', t.boolean(), [true, false], [1, 'true']],
    ['number', t.number(), [0, -1.5], ['1', true]],
    ['string', t.string(), ['', 'a'], [1, []]],
    ['literal', t.literal('pro'), ['pro'], ['free', 1]],
    ['enum', t.enum('a', 1, true), ['a', 1, true], ['b', 2, false]],
    ['timestamp', t.timestamp(), [later], ['2024-01-01', 0]],
    ['duration', t.duration(), [new Duration(1000)], [1000, 'PT1S']],
    ['opaque', t.opaque('Handle'), [handle, () => 1, Symbol('s'), 10n], [1, 'a', true]],
    ['list', t.list(t.number()), [[], [1, 2]], [[1, 'a'], { 0: 1 }, 'ab']],
    ['list of any', t.list(t.any()), [[1, 'a', null]], [{}]],
    ['nested list', t.list(t.list(t.string())), [[['a'], []]], [[['a', 1]], [1]]],
    [
      'closed map',
      t.object({ id: t.string(), age: t.optional(t.number()) }),
      [{ id: 'x' }, { id: 'x', age: 3 }, { id: 'x', extra: [] }],
      [{ age: 3 }, { id: 1 }, { id: 'x', age: 'old' }, [], null],
    ],
    ['open map', t.record(t.number()), [{}, { a: 1, b: 2 }], [{ a: 'x' }, { a: 1, b: null }]],
    ['open map of any', t.record(t.any()), [{ a: 'x', b: [] }], [[1]]],
    [
      'map with fields and rest',
      { kind: 'map', fields: { id: t.string() }, rest: t.number() },
      [{ id: 'x', n: 1 }],
      [
        { id: 'x', n: 'y' },
        { id: 1, n: 1 },
      ],
    ],
    ['union', t.union(t.string(), t.list(t.number())), ['a', [1]], [1, ['a'], null]],
    ['optional', t.optional(t.number()), [1], ['a']],
  ]

  for (const [name, type, good, bad] of kinds) {
    it(`checks ${name} arguments`, () => {
      const env = accepting(type)
      for (const value of good) expect(env.evaluateSync('f(v)', { v: value }), name).toBe(true)
      for (const value of bad) {
        expect(
          code(() => env.evaluateSync('f(v)', { v: value })),
          `${name}: ${String(value)}`,
        ).toMatch(/^(?:NO_OVERLOAD|NULL_RECEIVER)$/u)
      }
    })
  }

  it('accepts null for optional parameters at any position', () => {
    const env = accepting(t.optional(t.number()))
    expect(env.evaluateSync('f(v)', { v: null })).toBe(true)
  })

  it('bounds argument validation by the value depth limit', () => {
    const deep = t.list(t.list(t.list(t.number())))
    const env = accepting(deep, { limits: { maxValueDepth: 2 } })
    expect(env.evaluateSync('f(v)', { v: [[]] })).toBe(true)
    expect(code(() => env.evaluateSync('f(v)', { v: [[[1]]] }))).toBe('NO_OVERLOAD')
  })

  it('charges steps for validating large arguments', () => {
    const env = accepting(t.list(t.number()), { limits: { maxSteps: 100 } })
    expect(code(() => env.evaluateSync('f(v)', { v: Array.from({ length: 500 }, () => 1) }))).toBe(
      'STEP_LIMIT',
    )
    const maps = accepting(t.record(t.number()), { limits: { maxSteps: 100 } })
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    expect(code(() => maps.evaluateSync('f(v)', { v: wide }))).toBe('STEP_LIMIT')
  })

  it('names the actual kinds in NO_OVERLOAD messages', () => {
    const env = accepting(t.number())
    expect(() => env.evaluateSync('f(v)', { v: 'x' })).toThrow(/f\(\) cannot take \(a string\)/u)
    expect(() => env.evaluateSync('f(v)', { v: null })).toThrow(/cannot take null/u)
    expect(() => env.evaluateSync('v.f()', { v: null })).toThrow(/Cannot call \.f\(\) on null/u)
  })
})

describe('host results', () => {
  const returning = (type: Type, result: unknown) =>
    bonsai({
      functions: {
        g: fn({ params: [], returns: type, run: () => result as never }),
      },
    })

  it('accepts results of the declared kind and reads undefined as null', () => {
    expect(returning(t.number(), 1).evaluateSync('g()')).toBe(1)
    expect(returning(t.optional(t.string()), undefined).evaluateSync('g()')).toBeNull()
    expect(returning(t.list(t.number()), [1]).evaluateSync('g()')).toEqual([1])
    expect(returning(t.timestamp(), later).evaluateSync('g()')).toBe(later)
  })

  it('rejects results of another kind with HOST_ERROR', () => {
    expect(code(() => returning(t.number(), '1').evaluateSync('g()'))).toBe('HOST_ERROR')
    expect(code(() => returning(t.string(), undefined).evaluateSync('g()'))).toBe('HOST_ERROR')
    expect(() => returning(t.boolean(), 1).evaluateSync('g()')).toThrow(
      /g\(\) returned a number, but declares boolean/u,
    )
  })

  it('wraps thrown host errors, including non-Error values', () => {
    const env = bonsai({
      functions: {
        e: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw new Error('broken')
          },
        }),
        s: fn({
          params: [],
          returns: t.number(),
          run: () => {
            // oxlint-disable-next-line typescript/only-throw-error, no-throw-literal -- a host may throw anything
            throw 'text'
          },
        }),
      },
    })
    expect(() => env.evaluateSync('e()')).toThrow(/e\(\) failed: broken/u)
    expect(() => env.evaluateSync('s()')).toThrow(/s\(\) failed: text/u)
    expect(env.evaluateSync('try(e(), 0)')).toBe(0)
  })
})

describe('host parameters', () => {
  it('fills missing optional arguments with null', () => {
    const seen: unknown[][] = []
    const env = bonsai({
      functions: {
        greet: fn({
          params: [t.string(), t.optional(t.string())],
          returns: t.string(),
          required: 1,
          run: (name, greeting) => {
            seen.push([name, greeting])
            return `${greeting ?? 'Hello'}, ${name}`
          },
        }),
      },
    })
    expect(env.evaluateSync('greet("ann")')).toBe('Hello, ann')
    expect(env.evaluateSync('greet("ann", "Hi")')).toBe('Hi, ann')
    expect(env.evaluateSync('greet("ann", g)', { g: null })).toBe('Hello, ann')
    expect(seen).toEqual([
      ['ann', null],
      ['ann', 'Hi'],
      ['ann', null],
    ])
    expect(env.check('greet()').ok).toBe(false)
    expect(env.check('greet("a", "b", "c")').ok).toBe(false)
  })

  it('passes rest arguments after the declared parameters', () => {
    const env = bonsai({
      functions: {
        total: fn({
          params: [],
          rest: t.number(),
          returns: t.number(),
          run: (...values: number[]) => values.reduce((a, b) => a + b, 0),
        }),
      },
    })
    expect(env.evaluateSync('total()')).toBe(0)
    expect(env.evaluateSync('total(1, 2, 3)')).toBe(6)
    expect(env.evaluateSync('total(...xs)', { xs: [4, 5] })).toBe(9)
    expect(code(() => env.evaluateSync('total(...xs)', { xs: [1, 'a'] }))).toBe('NO_OVERLOAD')
    expect(env.describeFunction('total')?.signatures[0]?.rest).toEqual(t.number())
  })

  it('passes the evaluation context to context functions', () => {
    const env = bonsai({
      functions: {
        tenant: fn({
          params: [],
          returns: t.string(),
          context: true,
          run: (ctx) => String(ctx.tenant),
        }),
        scoped: fn({
          params: [t.optional(t.string())],
          returns: t.string(),
          required: 0,
          context: true,
          run: (ctx, suffix) => `${String(ctx.tenant)}${suffix ?? ''}`,
        }),
      },
    })
    expect(env.evaluateSync('tenant()', { tenant: 'acme' })).toBe('acme')
    expect(env.evaluateSync('scoped()', { tenant: 'acme' })).toBe('acme')
    expect(env.evaluateSync('scoped("-eu")', { tenant: 'acme' })).toBe('acme-eu')
  })

  it('supports async context functions typed with withContext', async () => {
    const contextFn = withContext<{ user: { id: string } }>()
    const env = bonsai({
      functions: {
        userId: contextFn({
          params: [],
          returns: t.string(),
          async: true,
          run: async (ctx) => {
            await Promise.resolve()
            return ctx.user.id
          },
        }),
      },
    })
    await expect(env.evaluate('userId()', { user: { id: 'u1' } })).resolves.toBe('u1')
    expect(code(() => env.evaluateSync('userId()', { user: { id: 'u1' } }))).toBe('ASYNC_IN_SYNC')
  })
})

describe('host declarations', () => {
  const noop = fn({ params: [], returns: t.null(), run: () => null })

  it('rejects invalid and reserved function names', () => {
    expect(() => bonsai({ functions: { 'bad-name': noop } })).toThrow(/Invalid function name/u)
    expect(() => bonsai({ functions: { has: noop } })).toThrow(/Invalid function name/u)
    expect(() => bonsai({ functions: { try: noop } })).toThrow(/Invalid function name/u)
  })

  it('requires a run function', () => {
    const broken = { params: [], returns: t.null(), run: 'nope' } as never
    expect(() => bonsai({ functions: { f: broken } })).toThrow(/needs a run function/u)
  })

  it('requires optional parameters to accept null', () => {
    const optionalNumber = {
      params: [t.number(), t.number()],
      returns: t.number(),
      required: 1,
      run: () => 1,
    } as never
    expect(() => bonsai({ functions: { f: optionalNumber } })).toThrow(/t\.optional/u)
  })

  it('rejects a name defined twice across libraries and functions', () => {
    const library = { name: 'lib', functions: { f: noop } }
    expect(() => bonsai({ libraries: [library], functions: { f: noop } })).toThrow(
      /defined by both library "lib" and the functions option/u,
    )
    expect(() =>
      bonsai({ libraries: [library, { name: 'other', functions: { f: noop } }] }),
    ).toThrow(/library "lib" and library "other"/u)
  })

  it('lets a host function replace a built-in', () => {
    const env = bonsai({
      functions: { trim: fn({ params: [t.string()], returns: t.string(), run: () => 'host' }) },
    })
    expect(env.evaluateSync('" a ".trim()')).toBe('host')
    expect(env.describeFunction('trim')?.host).toBe(true)
    expect(env.listFunctions()[0]?.name).toBe('trim')
    expect(env.listFunctions().filter((f) => f.name === 'trim')).toHaveLength(1)
  })
})

describe('context validation', () => {
  const validating = (variables: Record<string, Type>, limits = {}) =>
    bonsai({ variables, validateContext: true, limits })

  const message = (run: () => unknown): string => {
    try {
      run()
    } catch (error) {
      if (error instanceof BonsaiError) return `${error.code}: ${error.message}`
      throw error
    }
    return 'OK'
  }

  it('accepts conforming contexts of every kind', () => {
    const env = validating({
      n: t.null(),
      b: t.boolean(),
      num: t.number(),
      s: t.string(),
      lit: t.literal('x'),
      ts: t.timestamp(),
      d: t.duration(),
      list: t.list(t.number()),
      map: t.object({ a: t.string(), b: t.optional(t.number()) }),
      rec: t.record(t.boolean()),
      u: t.union(t.string(), t.number()),
      o: t.opaque('Handle'),
      a: t.any(),
    })
    const ok = env.evaluateSync('true', {
      n: null,
      b: false,
      num: 1,
      s: 's',
      lit: 'x',
      ts: later,
      d: new Duration(1),
      list: [1, 2],
      map: { a: 'a' },
      rec: { x: true, y: false },
      u: 3,
      o: handle,
      a: [],
    })
    expect(ok).toBe(true)
  })

  const mismatches: [string, Type, unknown, RegExp][] = [
    ['missing value', t.string(), undefined, /v should be string, got null \(missing\)/u],
    ['number', t.number(), 'abc', /v should be number, got string "abc"/u],
    [
      'long string',
      t.number(),
      'x'.repeat(60),
      new RegExp(`got string "${'x'.repeat(40)}\\.\\.\\."`, 'u'),
    ],
    ['boolean', t.boolean(), 1, /v should be boolean, got number 1/u],
    ['string', t.string(), true, /got boolean true/u],
    ['list', t.list(t.number()), { 0: 1 }, /v should be number\[\], got a map/u],
    ['list element', t.list(t.number()), [1, 'x'], /v\[1\] should be number/u],
    ['map', t.object({ a: t.number() }), [1], /v should be \{ a: number \}, got a list/u],
    ['map field', t.object({ a: t.number() }), { a: 'x' }, /v\.a should be number/u],
    ['missing field', t.object({ a: t.number() }), {}, /v\.a should be number, got null/u],
    ['rest value', t.record(t.number()), { a: 1, b: 'x' }, /v\.b should be number/u],
    ['union', t.union(t.string(), t.number()), [], /v should be string \| number, got a list/u],
    ['literal', t.literal('x'), 'y', /v should be "x"/u],
    ['timestamp', t.timestamp(), 'today', /v should be timestamp/u],
    ['invalid Date', t.timestamp(), new Date(Number.NaN), /got an invalid Date/u],
    ['duration', t.duration(), later, /v should be duration, got a timestamp/u],
    ['opaque', t.opaque('Handle'), 1, /v should be Handle/u],
    ['null', t.null(), () => 1, /v should be null, got function/u],
  ]

  for (const [name, type, value, pattern] of mismatches) {
    it(`reports a ${name} mismatch with its path`, () => {
      const env = validating({ v: type })
      const text = message(() => env.evaluateSync('true', { v: value }))
      expect(text).toMatch(/^INVALID_CONTEXT: Invalid context: /u)
      expect(text).toMatch(pattern)
    })
  }

  it('ignores blocked keys when checking open records', () => {
    const env = validating({ v: t.record(t.number()) })
    const value = JSON.parse('{"a": 1, "__proto__": "x"}') as unknown
    expect(env.evaluateSync('v.a', { v: value })).toBe(1)
  })

  it('skips declared fields when checking the rest of a record', () => {
    const env = validating({
      v: { kind: 'map', fields: { id: t.string() }, rest: t.number() },
    })
    expect(env.evaluateSync('v.id', { v: { id: 'x', n: 1 } })).toBe('x')
    expect(message(() => env.evaluateSync('true', { v: { id: 'x', n: 'y' } }))).toMatch(
      /v\.n should be number/u,
    )
  })

  it('does not validate without declared variables or when disabled', () => {
    expect(bonsai({ validateContext: true }).evaluateSync('v', { v: 1 })).toBe(1)
    const off = bonsai({ variables: { v: t.string() } })
    expect(off.evaluateSync('v', { v: 1 } as never)).toBe(1)
  })

  it('bounds validation by depth, steps, and time', () => {
    const deep = validating({ v: t.list(t.list(t.list(t.number()))) }, { maxValueDepth: 2 })
    expect(message(() => deep.evaluateSync('true', { v: [[[1]]] }))).toMatch(/^TOO_DEEP/u)

    const steps = validating({ v: t.list(t.number()) }, { maxSteps: 10 })
    expect(
      message(() => steps.evaluateSync('true', { v: Array.from({ length: 50 }, () => 1) })),
    ).toMatch(/^STEP_LIMIT: Context validation exceeded/u)
    expect(
      message(() =>
        steps.evaluateSync('true', { v: Array.from({ length: 50 }, () => 1) }, { maxSteps: 100 }),
      ),
    ).toBe('OK')

    const timed = validating({ v: t.list(t.number()) }, { maxSteps: 10_000_000 })
    const big = Array.from({ length: 3_000_000 }, () => 1)
    expect(message(() => timed.evaluateSync('true', { v: big }, { timeout: 1 }))).toMatch(
      /^TIMEOUT: Context validation timed out/u,
    )
  })
})
