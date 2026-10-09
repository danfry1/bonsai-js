import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'
import { BonsaiTranslationError, toMongo, toSQL, type Columns } from '../src/query/index.js'

const columns: Columns = { a: 'text', total: 'number', name: 'text' }
const open = bonsai()

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiError) return error.code
    throw error
  }
  return 'ok'
}

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'ok'
}

describe('translation work is bounded by the budget', () => {
  // A known list used many times: each use used to re-read and copy the whole list.
  const manyUses = open.compile(Array.from({ length: 1000 }, () => 'r.a in L').join(' || '))
  const big = { L: Array.from({ length: 20_000 }, (_, i) => `id${i}`) }

  it('reads a known list once and sends it once to Postgres', () => {
    const start = performance.now()
    const query = toSQL(manyUses, {
      row: 'r',
      columns,
      dialect: 'postgres',
      known: big,
      timeout: 1000,
    })
    const elements = query.params.reduce<number>(
      (sum, p) => sum + (Array.isArray(p) ? p.length : 1),
      0,
    )
    expect(elements).toBeLessThanOrEqual(20_000)
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('charges list work against maxSteps on every target', () => {
    // Partial evaluation fits in 20,000 steps; reading the list does not.
    const options = { row: 'r', known: big, maxSteps: 20_000 }
    expect(codeOf(() => toSQL(manyUses, { ...options, columns, dialect: 'postgres' }))).toBe(
      'STEP_LIMIT',
    )
    expect(codeOf(() => toSQL(manyUses, { ...options, columns, dialect: 'sqlite' }))).toBe(
      'STEP_LIMIT',
    )
    expect(codeOf(() => toMongo(manyUses, { ...options, fields: columns }))).toBe('STEP_LIMIT')
  })

  it('checks the abort signal while lowering, not only during partial evaluation', () => {
    // A signal that aborts once it has been read more than `after` times.
    const counting = (after: number) => {
      let reads = 0
      return {
        signal: {
          get aborted() {
            return ++reads > after
          },
          addEventListener: () => {},
          removeEventListener: () => {},
        },
        reads: () => reads,
      }
    }
    const inPartial = counting(Infinity)
    manyUses.partial(big, { unknown: ['r'], signal: inPartial.signal })
    const { signal } = counting(inPartial.reads())
    expect(
      codeOf(() => toSQL(manyUses, { row: 'r', known: big, columns, dialect: 'postgres', signal })),
    ).toBe('ABORTED')
  })

  it('refuses a query that would emit too many list entries even without a step budget', () => {
    const start = performance.now()
    for (const run of [
      () => toSQL(manyUses, { row: 'r', known: big, maxSteps: 0, columns, dialect: 'sqlite' }),
      () => toMongo(manyUses, { row: 'r', known: big, maxSteps: 0, fields: columns }),
    ]) {
      expect(run).toThrow(BonsaiTranslationError)
    }
    expect(performance.now() - start).toBeLessThan(2000)
    // A Postgres array parameter does not grow the SQL text, so its entries are capped themselves.
    const huge = { L: Array.from({ length: 1_000_001 }, (_, i) => i) }
    expect(() =>
      toSQL(open.compile('r.total in L'), {
        row: 'r',
        known: huge,
        maxSteps: 0,
        columns,
        dialect: 'postgres',
      }),
    ).toThrow(/too large/u)
  })

  it('sends a long known text once however often it is used', () => {
    const repeated = open.compile(
      Array.from({ length: 300 }, () => 'r.a.startsWith(p)').join(' || '),
    )
    const p = 'x'.repeat(1_000_000)
    for (const dialect of ['sqlite', 'postgres'] as const) {
      const start = performance.now()
      const query = toSQL(repeated, { row: 'r', columns, dialect, known: { p } })
      const chars = query.params.reduce<number>(
        (sum, value) => sum + (typeof value === 'string' ? value.length : 0),
        0,
      )
      expect(chars, dialect).toBeLessThan(2_100_000)
      expect(performance.now() - start, dialect).toBeLessThan(1000)
    }
    expect(
      codeOf(() =>
        toSQL(repeated, { row: 'r', columns, dialect: 'sqlite', known: { p }, maxSteps: 1000 }),
      ),
    ).toBe('STEP_LIMIT')
  })
})

describe('a MongoDB filter that repeats long text is bounded by its size', () => {
  it('counts text toward the node limit', () => {
    // 300 uses of a 30,000-character pattern: about 48 MB once serialized.
    const repeated = open.compile(
      Array.from({ length: 300 }, () => 'r.a.startsWith(p)').join(' || '),
    )
    const p = 'x'.repeat(30_000)
    expect(() => toMongo(repeated, { row: 'r', fields: columns, known: { p } })).toThrow(
      /too large/u,
    )
    // A few uses of the same text still translate.
    const few = open.compile('r.a.startsWith(p) || r.a.endsWith(p)')
    expect(
      JSON.stringify(toMongo(few, { row: 'r', fields: columns, known: { p } }).filter),
    ).toContain(`"^${p}"`)
  })
})

describe('translation never reads data the caller did not provide', () => {
  const typed = bonsai({
    variables: {
      order: t.object({ total: t.number() }),
      lim: t.object({ min: t.number(), max: t.number() }),
    },
  })
  const sqlite = { row: 'order', columns: { total: 'number' }, dialect: 'sqlite' } as const

  it('refuses a known declared object read whole when a field is missing', () => {
    for (const source of [
      'order.total in lim.values()',
      'lim == {min: 1, max: 2} && order.total > 1',
      'lim.keys().length > 1 && order.total > 1',
    ]) {
      expect(
        messageOf(() => toSQL(typed.compile(source), { ...sqlite, known: { lim: { min: 1 } } })),
        source,
      ).toMatch(/lim\.max is missing from the known values/u)
    }
    // A complete object translates.
    expect(
      toSQL(typed.compile('order.total in lim.values()'), {
        ...sqlite,
        known: { lim: { min: 1, max: 2 } },
      }).params,
    ).toEqual([1, 2])
  })

  it('follows a let alias to the known data it names', () => {
    const program = open.compile('order.total > (let l = limits; l.max)')
    expect(messageOf(() => toSQL(program, { ...sqlite, known: { limits: { min: 1 } } }))).toMatch(
      /limits\.max is missing from the known values/u,
    )
  })

  it('exempts only the guarded use of a missing path', () => {
    const both = open.compile('order.total > lim.max && (lim.max ?? 0) >= 0')
    expect(messageOf(() => toSQL(both, { ...sqlite, known: { lim: { min: 1 } } }))).toMatch(
      /lim\.max is missing/u,
    )
    const guardedOnly = open.compile('(lim.max ?? 0) < order.total')
    expect(toSQL(guardedOnly, { ...sqlite, known: { lim: { min: 1 } } }).params).toEqual([0])
    // A guard on the key "a.b" says nothing about the path a.b.
    const dotted = open.compile('has(cfg["a.b"]) || order.total > cfg.a.b')
    expect(messageOf(() => toSQL(dotted, { ...sqlite, known: { cfg: { a: {} } } }))).toMatch(
      /cfg\.a\.b is missing/u,
    )
  })

  it('still allows a read reached only once has() or != null proves the path', () => {
    const known = { lim: { min: 1 } }
    for (const [source, sql] of [
      ['has(lim.max) && order.total > lim.max', '0'],
      ['lim.max != null && order.total > lim.max', '0'],
      ['!has(lim.max) || order.total > lim.max', '1'],
      ['lim.max == null || order.total > lim.max', '1'],
      ['has(lim.max) ? order.total > lim.max : order.total > 0', '(`total` > ?1)'],
      ['let l = lim; has(l.max) && order.total > l.max', '0'],
    ] as const) {
      expect(toSQL(open.compile(source), { ...sqlite, known }).sql, source).toBe(sql)
    }
    // A guard proves nothing outside the branch it guards.
    expect(
      messageOf(() =>
        toSQL(open.compile('(has(lim.max) || true) && order.total > lim.max'), {
          ...sqlite,
          known,
        }),
      ),
    ).toMatch(/lim\.max is missing/u)
  })

  it('works out the guards of a long chain of || in linear time', () => {
    const long = bonsai({
      limits: { maxSourceLength: 1_000_000, maxNodes: 1_000_000 },
    })
    const program = long.compile(
      Array.from({ length: 12_000 }, (_, i) => `order.total > ${i}`).join(' || '),
    )
    const start = performance.now()
    expect(toSQL(program, { ...sqlite, known: {} }).params).toHaveLength(12_000)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('checks every way a typed known object is read whole', () => {
    const env = bonsai({
      variables: {
        order: t.object({ total: t.number() }),
        lim: t.object({ min: t.number(), max: t.number() }),
        cfg: t.object({ lim: t.object({ min: t.number(), max: t.number() }) }),
        items: t.list(t.object({ n: t.number() })),
      },
    })
    const cases: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
      ['order.total > {...lim}.max', { lim: { min: 1 } }, /lim\.max is missing/u],
      ['let l = lim; l == {min: 1, max: 2} && order.total > 1', { lim: { min: 1 } }, /lim\.max/u],
      ['order.total in cfg.lim.values()', { cfg: { lim: { min: 1 } } }, /cfg\.lim\.max/u],
      ['order.total in items.map(.n)', { items: [{ n: 1 }, {}] }, /items\[1\]\.n/u],
    ]
    for (const [source, known, message] of cases) {
      expect(
        messageOf(() => toSQL(env.compile(source), { ...sqlite, known })),
        source,
      ).toMatch(message)
    }
    // Reading a member, or testing for presence, is not a whole read.
    expect(
      toSQL(env.compile('has(cfg.lim) && order.total > cfg.lim.min'), {
        ...sqlite,
        known: { cfg: { lim: { min: 1 } } },
      }).sql,
    ).toBe('(`total` > ?1)')
  })

  it('suggests a known name, never the name that was asked for', () => {
    const limit = open.compile('order.total > limit')
    expect(messageOf(() => toSQL(limit, { ...sqlite, known: { limit: undefined } }))).not.toMatch(
      /did you mean "limit"/u,
    )
    // "r" (the row) and "kk" are both one edit from "k": the known name is meant.
    const k = open.compile('r.total > k')
    expect(
      messageOf(() =>
        toSQL(k, { row: 'r', columns: { total: 'number' }, dialect: 'sqlite', known: { kk: 1 } }),
      ),
    ).toMatch(/did you mean "kk"/u)
  })
})

describe('translation errors name the part that does not translate', () => {
  it('points at the inner call, not the text function around it', () => {
    const source = 'order.name.toLowerCase().includes("q3")'
    try {
      toSQL(open.compile(source), {
        row: 'order',
        columns,
        dialect: 'sqlite',
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BonsaiTranslationError)
      const e = error as BonsaiTranslationError
      expect(e.message).toMatch(/toLowerCase\(\) is not translated/u)
      expect(source.slice(e.span?.start, e.span?.end)).toBe('order.name.toLowerCase()')
    }
  })
})

describe('host functions with known inputs', () => {
  const env = bonsai({
    variables: { order: t.object({ total: t.number() }), subject: t.object({ id: t.string() }) },
    functions: {
      memberOf: fn({
        params: [t.string(), t.string()],
        returns: t.boolean(),
        run: (id, group) => id === 'u1' && group === 'auditors',
      }),
    },
  })
  const program = env.compile('subject.id.memberOf("auditors") && order.total > 1')
  const options = { row: 'order', columns: { total: 'number' }, dialect: 'sqlite' } as const

  it('are called before translation with callHostFunctions', () => {
    expect(
      toSQL(program, { ...options, known: { subject: { id: 'u1' } }, callHostFunctions: true }),
    ).toEqual({ sql: '(`total` > ?1)', params: [1] })
    expect(
      toSQL(program, { ...options, known: { subject: { id: 'u2' } }, callHostFunctions: true }),
    ).toEqual({ sql: '0', params: [] })
  })

  it('stay untranslatable without it', () => {
    expect(
      messageOf(() => toSQL(program, { ...options, known: { subject: { id: 'u1' } } })),
    ).toMatch(/memberOf\(\) is a host function/u)
  })
})
