import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, Duration, bonsai, t } from '../src/index.js'
import { toMongo } from '../src/query/index.js'

/** A value (as text, so durations compare by meaning) or the code of the error evaluation raised. */
function outcome(run: () => unknown): unknown {
  try {
    const value = run()
    return { value: value instanceof Duration ? `duration ${value.toString()}` : value }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

/** The context holding only the given dotted paths of `full`. */
function only(full: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const keys = path.split('.')
    let from: unknown = full
    let to = out
    keys.forEach((key, i) => {
      from =
        typeof from === 'object' && from !== null && !Array.isArray(from)
          ? (from as Record<string, unknown>)[key]
          : undefined
      if (i === keys.length - 1) {
        if (from !== undefined) to[key] = from
      } else {
        to[key] ??= {}
        to = to[key] as Record<string, unknown>
      }
    })
  }
  return out
}

describe('residual calls keep the overloads the program chose', () => {
  const env = bonsai({
    variables: {
      ws: t.list(t.duration()),
      tags: t.list(t.string()),
      row: t.object({ wait: t.optional(t.duration()) }),
    },
  })

  it('in a residual with an implicit lambda', () => {
    const program = env.compile('sum(ws.map(.))')
    const residual = program.partial({})
    if (residual.status !== 'residual') throw new Error('expected a residual')
    expect(String(residual.evaluateSync({ ws: [] }))).toBe('PT0S')
    expect(String(program.evaluateSync({ ws: [] } as never))).toBe('PT0S')
  })

  it('for calls outside the lambda too', () => {
    const program = env.compile('[tags.map(.length), sum([row.wait])]')
    const residual = program.partial({})
    if (residual.status !== 'residual') throw new Error('expected a residual')
    const value = residual.evaluateSync({ row: {}, tags: [] }) as unknown[]
    expect(String(value[1])).toBe('PT0S')
  })
})

describe('a node whose children all turn out known is decided', () => {
  const env = bonsai()

  it('folds a comparison of known values', () => {
    expect(env.compile('(2 ?? row.total) >= 1').partial({})).toMatchObject({
      status: 'value',
      value: true,
    })
    expect(env.compile('(x ?? row.total) >= 1').partial({ x: 2 })).toMatchObject({
      status: 'value',
      value: true,
    })
    expect(env.compile('abs(-2 ?? row.total) + 1').partial({})).toMatchObject({
      status: 'value',
      value: 3,
    })
  })

  it('keeps an error a folded node always raises', () => {
    const result = env.compile('(2 ?? row.total) / 0').partial({})
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.error.code).toBe('DIVISION_BY_ZERO')
  })

  it('does not fold now() or a host function', () => {
    const result = env.compile('now() > (t ?? row.t)').partial({ t: new Date(0) })
    expect(result.status).toBe('residual')
  })

  it('translates a filter whose comparison is decided', () => {
    const { filter } = toMongo(env.compile('(2 ?? row.total) >= 1'), {
      row: 'row',
      fields: { total: 'number' },
    })
    expect(filter).toEqual({})
  })
})

describe('residuals with implicit lambdas and overloaded built-ins agree with the program', () => {
  const env = bonsai({
    variables: {
      ws: t.list(t.duration()),
      ns: t.list(t.number()),
      w: t.optional(t.duration()),
      n: t.number(),
      at: t.timestamp(),
      b: t.boolean(),
    },
  })
  const SOURCES = [
    'sum(ws.map(.))',
    'sum(ns.map(. * n))',
    'avg(ws.filter(. > (w ?? days(0)))) ?? days(1)',
    'min(ws.map(.)) ?? w',
    'max(ns.map(. + n)) ?? 0',
    '[ws.map(.), sum([w])]',
    'b ? sum(ws.map(.)) : days(n)',
    'addDays(at, n) > at && sum(ws.filter(b || . > days(0))) >= days(0)',
    'ws.map(. * 2).sum() == sum(ws) * 2',
    'max(sum(ws.map(.)), w ?? days(0))',
    'ns.filter(. > n).map(. - n).sum() + n',
    'startOfDay(at, "UTC") <= at ? min(ns.map(.)) : n',
  ]
  const VARIABLES = ['ws', 'ns', 'w', 'n', 'at', 'b'] as const
  const durations = fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 4 })
  const scenario = fc.record({
    source: fc.constantFrom(...SOURCES),
    ws: durations,
    ns: fc.array(fc.integer({ min: -9, max: 9 }), { maxLength: 4 }),
    w: fc.option(fc.integer({ min: -5, max: 5 }), { nil: null }),
    n: fc.integer({ min: -3, max: 3 }),
    at: fc.integer({ min: 0, max: 1e12 }),
    b: fc.boolean(),
    known: fc.subarray([...VARIABLES]),
  })

  it('on the full context and on dependsOn alone', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const full: Record<string, unknown> = {
          ws: s.ws.map((h) => new Duration(h * 3_600_000)),
          ns: s.ns,
          w: s.w === null ? null : new Duration(s.w * 60_000),
          n: s.n,
          at: new Date(s.at),
          b: s.b,
        }
        const program = env.compile(s.source)
        const expected = outcome(() => program.evaluateSync(full as never))
        const known = Object.fromEntries(s.known.map((name) => [name, full[name]]))
        const result = program.partial(known)
        if (result.status === 'value') expect(outcome(() => result.value)).toEqual(expected)
        else if (result.status === 'error') expect({ code: result.error.code }).toEqual(expected)
        else {
          expect(outcome(() => result.evaluateSync(full as never))).toEqual(expected)
          if (!result.readsContext) {
            const given = only(full, result.dependsOn)
            expect(outcome(() => result.evaluateSync(given as never))).toEqual(expected)
          }
        }
      }),
      { numRuns: 1500 },
    )
  })
})
