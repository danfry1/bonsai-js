import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'
import { toMongo, toSQL } from '../src/query/index.js'
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

/** Thrown values whose inspection itself throws. */
function hostileThrowables(): [string, unknown][] {
  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  return [
    ['a revoked Proxy', revoked],
    [
      'a Proxy whose getPrototypeOf throws',
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('trap')
          },
        },
      ),
    ],
    [
      'an Error whose name getter throws',
      Object.defineProperty(new Error('y'), 'name', {
        get() {
          throw new Error('name')
        },
      }),
    ],
  ]
}

describe('a getter that throws a value whose inspection throws', () => {
  for (const [label, thrown] of hostileThrowables()) {
    const ctx = () => ({
      a: {
        get b(): number {
          throw thrown
        },
      },
      x: 1,
      xs: [
        {
          get v(): number {
            throw thrown
          },
        },
      ],
    })

    it(`becomes a HOST_ERROR try() recovers from (${label})`, async () => {
      const env = bonsai()
      expect(env.evaluateSync('try(a.b, 1) + x', ctx())).toBe(2)
      expect(await env.evaluate('try(a.b, 1) + x', ctx())).toBe(2)
      expect(env.evaluateSync('try(xs.map(.v * 2), [])', ctx())).toEqual([])
      const explained = env.explainSync('try(a.b, 1) + x', ctx())
      expect(explained.ok && explained.value).toBe(2)
      const partial = env.compile('try(a.b, 1) + x').partial(ctx())
      expect(partial.status === 'value' && partial.value).toBe(2)
    })

    it(`is a HOST_ERROR under validateContext (${label})`, async () => {
      const env = bonsai({
        variables: { a: t.object({ b: t.number() }) },
        validateContext: true,
      })
      expect(codeOf(() => env.evaluateSync('a.b', ctx()))).toBe('HOST_ERROR')
      await expect(env.evaluate('a.b', ctx())).rejects.toMatchObject({ code: 'HOST_ERROR' })
      const explained = env.explainSync('a.b', ctx())
      expect(explained.ok ? 'value' : explained.error.code).toBe('HOST_ERROR')
      expect(codeOf(() => env.compile('a.b').partial(ctx()))).toBe('HOST_ERROR')
    })
  }
})

describe('serializing an explanation', () => {
  it('gives the same text every time, whatever was serialized before', () => {
    const env = bonsai()
    const big: Record<string, number> = {}
    for (let i = 0; i < 600_000; i++) big[`k${i}`] = i
    const once = env.explainSync('m != null && x == 1', { m: big, x: 1 })
    expect(JSON.stringify(once)).toBe(JSON.stringify(once))
    const strings = env.explainSync('m != null && x == 1', { m: big, x: 1 })
    expect(String(strings)).toBe(String(strings))
    // A rendering after a serialization reads the same as a fresh one.
    const fresh = String(env.explainSync('m != null && x == 1', { m: big, x: 1 }))
    const after = env.explainSync('m != null && x == 1', { m: big, x: 1 })
    JSON.stringify(after)
    expect(String(after)).toBe(fresh)
  })
})

describe('toSQL and toMongo', () => {
  it('translate a filter whose residual would be longer than maxSourceLength', () => {
    const env = bonsai({ limits: { maxSourceLength: 30 } })
    const program = env.compile('row.a == k || row.b == k')
    const known = { k: 'x'.repeat(16) }
    expect(codeOf(() => program.partial({ ...known, row: undefined }, { unknown: ['row'] }))).toBe(
      'SOURCE_TOO_LONG',
    )
    const columns = { a: 'text', b: 'text' } as const
    expect(toSQL(program, { row: 'row', columns, dialect: 'sqlite', known }).sql).toBe(
      '((`a` = ?1) OR (`b` = ?1))',
    )
    expect(toMongo(program, { row: 'row', fields: columns, known }).filter).toEqual({
      $or: [{ a: { $eq: known.k } }, { b: { $eq: known.k } }],
    })
  })
})

describe('partial() unknown paths', () => {
  const program = bonsai().compile('user.age > 1 && x == 2')
  const known = { user: { age: 5 }, x: 2 }

  it.each([
    'user["age"]',
    ' user',
    'user age',
    '__proto__',
    'user.__proto__',
    'constructor',
    'true',
    '',
    'user.',
  ])('rejects %j', (path) => {
    expect(() => program.partial(known, { unknown: [path] })).toThrow(TypeError)
  })

  it('accepts a field name a bracket read spells', () => {
    const residual = bonsai()
      .compile('user["risk score"] > 1')
      .partial({ user: { 'risk score': 5 } }, { unknown: ['user.risk score'] })
    expect(residual.status === 'residual' && residual.dependsOn).toEqual(['user.risk score'])
  })
})

describe('language service arguments', () => {
  const service = createLanguageService(bonsai({ variables: { user: t.object({}) } }))

  it('throws a RangeError for -Infinity', () => {
    expect(() => service.complete('user.', -Infinity)).toThrow(RangeError)
    expect(() => service.hover('user', -Infinity)).toThrow(RangeError)
  })

  it('throws a TypeError for an offset that is not a number', () => {
    for (const offset of ['3', null, undefined, {}, 1n]) {
      expect(() => service.complete('user.', offset as number)).toThrow(TypeError)
      expect(() => service.hover('user', offset as number)).toThrow(TypeError)
    }
  })

  it('throws a TypeError for a source that is not a string', () => {
    expect(() => service.complete(null as unknown as string, 0)).toThrow(
      'An expression must be a string',
    )
    expect(() => service.hover(null as unknown as string, 0)).toThrow(
      'An expression must be a string',
    )
  })

  it('still treats NaN and offsets past the end as the end', () => {
    expect(service.complete('user.', NaN)).toEqual(service.complete('user.', 5))
    expect(service.complete('user.', Infinity)).toEqual(service.complete('user.', 5))
  })
})

it('a host function with hostile throwables stays catchable (unchanged)', () => {
  for (const [, thrown] of hostileThrowables()) {
    const env = bonsai({
      functions: {
        f: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw thrown
          },
        }),
      },
    })
    expect(env.evaluateSync('try(f(), 2)')).toBe(2)
  }
})
