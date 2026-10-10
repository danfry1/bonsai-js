import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

/** A value or the code of the error evaluation raised. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

/** A context holding only the values at `paths` of `full`, as a caller passing dependsOn builds. */
function onlyPaths(
  full: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  const context: Record<string, unknown> = {}
  for (const path of paths) {
    const segments = path.split('.')
    let from: unknown = full
    let into = context
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i]
      if (typeof from !== 'object' || from === null || Array.isArray(from)) break
      if (!Object.hasOwn(from, key)) break
      const value = (from as Record<string, unknown>)[key]
      const last = i === segments.length - 1
      if (last || typeof value !== 'object' || value === null || Array.isArray(value)) {
        into[key] = value
        break
      }
      if (!Object.hasOwn(into, key)) into[key] = {}
      into = into[key] as Record<string, unknown>
      from = value
    }
  }
  return context
}

const variables = {
  user: t.object({ a: t.optional(t.number()), b: t.string() }),
  o: t.optional(t.object({ a: t.number(), b: t.string() })),
  m: t.record(t.object({ f: t.string() })),
  u: t.union(t.object({ a: t.number(), b: t.string() }), t.object({ c: t.string() })),
  cfg: t.object({ limits: t.record(t.number()) }),
  x: t.number(),
}
const env = bonsai({ variables, validateContext: true })
const residualOf = (source: string, unknown: readonly string[]) => {
  const result = env.compile(source).partial({ x: 1 }, { unknown: [...unknown] })
  if (result.status !== 'residual') throw new Error(`expected a residual for ${source}`)
  return result
}

describe('a residual validates each step of the paths it reads by that step’s own type', () => {
  it('rejects a required parent that is null or absent', () => {
    const residual = residualOf('user?.a ?? x', ['user'])
    expect(residual.dependsOn).toEqual(['user.a'])
    expect(outcome(() => residual.evaluateSync({ user: null } as never))).toEqual({
      code: 'INVALID_CONTEXT',
    })
    expect(outcome(() => residual.evaluateSync({}))).toEqual({ code: 'INVALID_CONTEXT' })
    expect(() => residual.evaluateSync({})).toThrow(/user should be/u)
    const limits = residualOf('(cfg.limits.max ?? 5) > 3', ['cfg'])
    expect(() => limits.evaluateSync({ cfg: {} })).toThrow(/cfg\.limits should be/u)
  })

  it('rejects a present optional parent or record entry that lacks a required field', () => {
    const optional = residualOf('(o?.a ?? 0) > 1', ['o'])
    expect(() => optional.evaluateSync({ o: {} })).toThrow(/o\.a should be number/u)
    expect(() => optional.evaluateSync({ o: { a: null, b: 'x' } } as never)).toThrow(
      /o\.a should be/u,
    )
    expect(optional.evaluateSync({})).toBe(false)
    expect(optional.evaluateSync({ o: null })).toBe(false)
    const record = residualOf('m?.k1?.f == "a"', ['m'])
    expect(() => record.evaluateSync({ m: { k1: { q: 1 } } } as never)).toThrow(
      /m\.k1\.f should be/u,
    )
    expect(record.evaluateSync({ m: {} })).toBe(false)
  })

  it('accepts a context holding exactly dependsOn, siblings and undeclared keys included', () => {
    const extra = residualOf('has(user.extra)', ['user'])
    expect(extra.dependsOn).toEqual(['user.extra'])
    expect(extra.evaluateSync({ user: {} })).toBe(false)
    const union = residualOf('u?.a == 1', ['u'])
    expect(union.evaluateSync({ u: { a: 1 } })).toBe(true)
  })

  it('reports an ill-typed parent as INVALID_CONTEXT, as the program does', () => {
    const residual = residualOf('user.a ?? x', ['user'])
    expect(() => residual.evaluateSync({ user: 'str' } as never)).toThrow(
      /user should be .*got string/u,
    )
  })
})

describe('the known roots a call: true residual requires', () => {
  const cv = fn({
    params: [t.string()],
    returns: t.any(),
    call: true,
    run: (call, key) => (call.context[key] as { n?: unknown } | undefined)?.n ?? 'MISSING',
  })

  it('include non-enumerable known variables, which the language reads', () => {
    const program = bonsai({ functions: { cv } }).compile('x > 0 ? cv("tenant") : 0')
    const known = Object.defineProperty({}, 'tenant', { value: { n: 'T1' }, enumerable: false })
    const residual = program.partial(known, { unknown: ['x'] })
    expect(residual.status).toBe('residual')
    if (residual.status !== 'residual') return
    expect(outcome(() => residual.evaluateSync({ x: 1 }))).toEqual({ code: 'INVALID_CONTEXT' })
    expect(residual.evaluateSync({ x: 1, tenant: { n: 'T1' } })).toBe('T1')
  })

  it('leave out known keys that are not declared variables of a strict environment', () => {
    const typed = bonsai({ variables: { x: t.number(), tenant: t.any() }, functions: { cv } })
    const residual = typed
      .compile('x > 0 ? cv("tenant") : 0')
      .partial({ tenant: { n: 'T1' }, meta: 'not a variable' } as never, { unknown: ['x'] })
    expect(residual.status).toBe('residual')
    if (residual.status !== 'residual') return
    expect(residual.evaluateSync({ x: 1, tenant: { n: 'T1' } })).toBe('T1')
  })
})

describe('residual validation agrees with the program’s on the data it reads', () => {
  const SOURCES = [
    ['user?.a ?? x', ['user']],
    ['user.b == "q"', ['user']],
    ['(o?.a ?? 0) > 1', ['o']],
    ['m?.k1?.f == "a"', ['m']],
    ['has(user.extra)', ['user']],
    ['(cfg.limits.max ?? 5) > 3', ['cfg']],
  ] as const
  const BAD = [null, undefined, 'str', 7, {}, []] as const

  const conforming = fc.record({
    user: fc.record(
      {
        a: fc.option(fc.integer({ min: -3, max: 3 }), { nil: undefined }),
        b: fc.constantFrom('q', 'z'),
      },
      { requiredKeys: ['b'] },
    ),
    o: fc.option(
      fc.record({ a: fc.integer({ min: -3, max: 3 }), b: fc.string({ maxLength: 2 }) }),
      {
        nil: null,
      },
    ),
    m: fc.dictionary(fc.constantFrom('k0', 'k1'), fc.record({ f: fc.constantFrom('a', 'b') })),
    u: fc.oneof(
      fc.record({ a: fc.integer(), b: fc.string({ maxLength: 2 }) }),
      fc.record({ c: fc.string() }),
    ),
    cfg: fc.record({ limits: fc.dictionary(fc.constantFrom('max', 'min'), fc.integer()) }),
  })

  it('gives the program’s value or its INVALID_CONTEXT on a context of exactly dependsOn', () => {
    fc.assert(
      fc.property(
        conforming,
        fc.constantFrom(...SOURCES),
        fc.nat(),
        fc.constantFrom(...BAD),
        fc.boolean(),
        (data, [source, unknown], depth, bad, mutate) => {
          const residual = residualOf(source, unknown)
          const full: Record<string, unknown> = { ...structuredClone(data), x: 1 }
          if (mutate) {
            // Break a step of a path the residual reads; everything else stays valid.
            const path = residual.dependsOn[0].split('.')
            const cut = 1 + (depth % path.length)
            // An empty map in place of a parent drops its other fields, which the
            // residual does not read and so does not validate (documented).
            if (cut < path.length && typeof bad === 'object' && bad !== null && !Array.isArray(bad))
              return
            let parent: Record<string, unknown> = full
            for (let i = 0; i < cut - 1; i++) {
              const next = parent[path[i]]
              if (typeof next !== 'object' || next === null || Array.isArray(next)) return
              parent = next as Record<string, unknown>
            }
            if (bad === undefined) delete parent[path[cut - 1]]
            else parent[path[cut - 1]] = bad
          }
          const program = outcome(() => env.evaluateSync(source, full as never))
          const onPaths = outcome(() => residual.evaluateSync(onlyPaths(full, residual.dependsOn)))
          expect(onPaths).toEqual(program)
        },
      ),
      { numRuns: 1500 },
    )
  })
})
