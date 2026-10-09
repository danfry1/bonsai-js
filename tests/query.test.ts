import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { test } from '@fast-check/vitest'
import { Query } from 'mingo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BonsaiError, Duration, bonsai, fn, t } from '../src/index.js'
import {
  BonsaiTranslationError,
  toMongo,
  toSQL,
  type Columns,
  type SQLOptions,
} from '../src/query/index.js'
import {
  columns,
  env,
  expected,
  known,
  predicate,
  rowsArbitrary,
  type Row,
} from './support/query-fuzz.js'

let lite: DatabaseSync
let pg: PGlite

beforeAll(async () => {
  lite = new DatabaseSync(':memory:')
  lite.exec(
    'create table t (id integer, name text, city text, total real, qty real, active integer, placed integer, wait integer) strict',
  )
  pg = new PGlite()
  await pg.exec(
    'create table t (id int, name text, city text, total float8, qty float8, active boolean, placed timestamptz, wait bigint)',
  )
})

afterAll(async () => {
  lite.close()
  await pg.close()
})

async function load(rows: readonly Row[], postgres = true): Promise<void> {
  lite.exec('delete from t')
  const insert = lite.prepare('insert into t values (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) {
    insert.run(
      ...[
        r.id,
        r.name,
        r.city,
        r.total,
        r.qty,
        r.active === null ? null : Number(r.active),
        r.placed?.getTime() ?? null,
        r.wait?.ms ?? null,
      ],
    )
  }
  if (!postgres) return
  await pg.exec('delete from t')
  for (const r of rows) {
    await pg.query('insert into t values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      r.id,
      r.name,
      r.city,
      r.total,
      r.qty,
      r.active,
      r.placed?.toISOString() ?? null,
      r.wait?.ms ?? null,
    ])
  }
}

/** Asserts every target selects exactly the rows Bonsai accepts. */
async function agree(
  source: string,
  rows: readonly Row[],
  targets: { postgres?: boolean; now?: Date; mustTranslate?: boolean } = {},
): Promise<number[]> {
  const now = targets.now
  const program = (now === undefined ? env : bonsai({ clock: () => now })).compile(source)
  const want = expected(source, rows, now)
  await load(rows, targets.postgres ?? true)
  const shared = { row: 'order', known, ...(now === undefined ? {} : { now }) }

  let sqlite: ReturnType<typeof toSQL>
  try {
    sqlite = toSQL(program, { ...shared, columns, dialect: 'sqlite' })
  } catch (error) {
    // Untranslatable is allowed; exactness is required of whatever translates.
    if (error instanceof BonsaiTranslationError && targets.mustTranslate !== true) return want
    throw error
  }
  const liteIds = lite
    .prepare(`select id from t where ${sqlite.sql} order by id`)
    .all(...(sqlite.params as (string | number | null)[]))
    .map((r) => (r as { id: number }).id)
  expect(liteIds, `sqlite: ${sqlite.sql}`).toEqual(want)

  // Postgres alone may refuse (timestamps outside the years 0001 to 9999).
  let postgres: ReturnType<typeof toSQL> | undefined
  if (targets.postgres ?? true) {
    try {
      postgres = toSQL(program, { ...shared, columns, dialect: 'postgres' })
    } catch (error) {
      if (!(error instanceof BonsaiTranslationError) || targets.mustTranslate === true) throw error
    }
  }
  if (postgres !== undefined) {
    try {
      const pgIds = (
        await pg.query<{ id: number }>(`select id from t where ${postgres.sql} order by id`, [
          ...postgres.params,
        ])
      ).rows.map((r) => r.id)
      expect(pgIds, `postgres: ${postgres.sql}`).toEqual(want)
    } catch (error) {
      // Documented: Postgres raises an error, never a wrong answer, when double arithmetic
      // overflows or underflows.
      if (!/value out of range: (?:overflow|underflow)/u.test(String(error))) throw error
    }
  }

  let mongo: ReturnType<typeof toMongo> | undefined
  try {
    mongo = toMongo(program, { ...shared, fields: columns })
  } catch (error) {
    if (!(error instanceof BonsaiTranslationError) || targets.mustTranslate === true) throw error
  }
  if (mongo !== undefined) {
    const filter = mongo.filter
    // MongoDB stores a duration as its milliseconds.
    const mongoIds = rows
      .filter((row) => new Query(filter).test({ ...row, wait: row.wait?.ms ?? null }))
      .map((r) => r.id)
    expect(mongoIds, `mongo: ${JSON.stringify(filter)}`).toEqual(want)
  }
  return want
}

const RUNS = Number(process.env.QUERY_FUZZ_RUNS ?? 300)

describe('differential: translated queries select exactly the rows Bonsai accepts', () => {
  test.prop([predicate, rowsArbitrary], {
    numRuns: RUNS,
    seed: Number(process.env.QUERY_FUZZ_SEED ?? 20260928),
  })('SQLite, Postgres, and MongoDB (mingo)', async (source, rows) => {
    await agree(source, rows)
  })
})

const row = (id: number, fields: Partial<Row>): Row => ({
  id,
  name: null,
  city: null,
  total: null,
  qty: null,
  active: null,
  placed: null,
  wait: null,
  ...fields,
})

describe('null-safe text idioms', () => {
  const rows = [
    row(1, {}),
    row(2, { name: 'x@acme.com', active: true }),
    row(3, { name: 'abc', active: false }),
  ]
  const translates = { mustTranslate: true }

  it('translates ?. with ?? and a boolean default', async () => {
    expect(await agree('order.name?.endsWith("@acme.com") ?? false', rows, translates)).toEqual([2])
    expect(await agree('order.name?.endsWith("@acme.com") ?? true', rows, translates)).toEqual([
      1, 2,
    ])
    expect(await agree('!(order.name?.endsWith("@acme.com") ?? false)', rows, translates)).toEqual([
      1, 3,
    ])
    expect(await agree('order.name?.startsWith("a") ?? order.active', rows, translates)).toEqual([
      3,
    ])
    expect(await agree('order.active ?? true', rows, translates)).toEqual([1, 2])
  })

  it('translates a ?. call compared with a boolean or null', async () => {
    expect(await agree('order.name?.endsWith("@acme.com") == true', rows, translates)).toEqual([2])
    expect(await agree('order.name?.endsWith("@acme.com") == false', rows, translates)).toEqual([3])
    expect(await agree('order.name?.endsWith("@acme.com") != true', rows, translates)).toEqual([
      1, 3,
    ])
    expect(await agree('order.name?.endsWith("@acme.com") == null', rows, translates)).toEqual([1])
    // Without ?., the call fails on a null name, so that row is never selected.
    expect(await agree('order.name.endsWith("@acme.com") == false', rows, translates)).toEqual([3])
    expect(await agree('!(order.name.endsWith("@acme.com") == false)', rows, translates)).toEqual([
      2,
    ])
  })

  it('translates a call on a ?? default', async () => {
    expect(await agree('(order.name ?? "").endsWith("@acme.com")', rows, translates)).toEqual([2])
    expect(await agree('(order.name ?? "a").startsWith("a")', rows, translates)).toEqual([1, 3])
    expect(await agree('!(order.name ?? "").includes("b")', rows, translates)).toEqual([1, 2])
  })
})

describe('relative dates', () => {
  const now = new Date('2026-01-15T00:00:00.000Z')
  const at = (iso: string): Date => new Date(iso)
  const rows = [
    row(1, {}),
    row(2, { placed: at('2026-01-10T00:00:00.000Z') }),
    row(3, { placed: at('2025-12-01T00:00:00.000Z') }),
    row(4, { placed: at('2026-01-01T00:00:00.000Z') }),
    row(5, { placed: at('2026-01-20T00:00:00.000Z') }),
  ]
  const options = { now, mustTranslate: true }

  it('translates the distance from now compared with a duration, both ways round', async () => {
    expect(await agree('now() - order.placed < days(14)', rows, options)).toEqual([2, 5])
    expect(await agree('days(14) > now() - order.placed', rows, options)).toEqual([2, 5])
    expect(await agree('now() - order.placed >= days(14)', rows, options)).toEqual([3, 4])
    expect(await agree('order.placed - now() > days(0)', rows, options)).toEqual([5])
    // A null timestamp fails the subtraction: excluded from a negation too.
    expect(await agree('!(now() - order.placed < days(14))', rows, options)).toEqual([3, 4])
  })

  it('translates a timestamp shifted by a duration', async () => {
    expect(await agree('order.placed + days(14) > now()', rows, options)).toEqual([2, 5])
    expect(await agree('order.placed - days(3) < now()', rows, options)).toEqual([2, 3, 4])
    expect(await agree('!(order.placed + days(14) > now())', rows, options)).toEqual([3, 4])
  })

  it('fails rows the shift would push out of the Date range', async () => {
    const edge = [row(1, { placed: new Date(8.64e15 - 1) }), row(2, { placed: new Date(0) })]
    expect(await agree('order.placed + days(1) > d0', edge, { postgres: false })).toEqual([2])
    expect(await agree('!(order.placed + days(1) > d0)', edge, { postgres: false })).toEqual([])
  })

  it('translates a fractional duration as the whole milliseconds Bonsai rounds it to', async () => {
    const edge = [row(1, { placed: new Date(now.getTime() - 1) }), row(2, { placed: now })]
    expect(await agree('now() - order.placed < milliseconds(0.5)', edge, options)).toEqual([2])
  })
})

describe('edge cases', () => {
  it('reads a ?. call on a null column as false', async () => {
    const rows = [row(1, {}), row(2, { name: 'abc' }), row(3, { name: 'x', active: true })]
    expect(await agree('!(order.name?.startsWith("a"))', rows)).toEqual([1, 3])
    expect(await agree('order.name?.endsWith("c") || order.active', rows)).toEqual([2, 3])
    expect(await agree('!(order.name?.includes("b"))', rows)).toEqual([1, 3])
  })

  it('keeps failing arithmetic when the comparison is decided', async () => {
    const rows = [row(1, {}), row(2, { total: 1 }), row(3, { total: 1e308 })]
    for (const [source, want] of [
      ['!(order.total + 1 in [])', [2, 3]],
      ['!(order.total + 1 in ["a"])', [2, 3]],
      ['!(order.total * 2 > null)', [2]],
      ['!(null < order.total * 2)', [2]],
    ] as const) {
      expect(await agree(source, rows), source).toEqual(want)
    }
  })

  it('fails arithmetic with a non-finite result', async () => {
    const rows = [
      row(1, { total: 1e308, qty: 10 }),
      row(2, { total: 2, qty: 3 }),
      row(3, { total: -1e308, qty: 1e308 }),
    ]
    expect(await agree('order.total * 10 > 0', rows)).toEqual([2])
    expect(await agree('order.total * order.qty != 0', rows)).toEqual([2])
    expect(await agree('order.total - order.qty < 0', rows)).toEqual([2])
  })

  it('does integer-valued arithmetic in doubles', async () => {
    const rows = [row(1, { total: 2 ** 53, qty: 1 })]
    expect(await agree('order.total + order.qty == order.total', rows)).toEqual([1])
  })

  it('matches SQLite text that holds NUL characters', async () => {
    const rows = [row(1, { name: 'a\0b' }), row(2, { name: 'ab' }), row(3, { name: 'b\0' })]
    expect(await agree('order.name.endsWith("b")', rows, { postgres: false })).toEqual([1, 2])
    expect(await agree('order.name.startsWith("a")', rows, { postgres: false })).toEqual([1, 2])
  })

  it('rejects text with lone surrogates', () => {
    for (const source of [
      'order.name == "\\uD83D"',
      'order.name.startsWith("\\uD83D")',
      '"\\uDE00" in order.name',
      'order.name == lone',
    ]) {
      expect(() =>
        toSQL(env.compile(source), {
          row: 'order',
          columns,
          dialect: 'sqlite',
          known: { lone: '\uD83D' },
        }),
      ).toThrow(/lone surrogate/u)
    }
  })

  it('rejects queries that grow too large', () => {
    let source = 'order.name.startsWith("a")'
    for (let i = 0; i < 30; i++) source = `(!(${source}) && order.city.startsWith("b"))`
    const program = env.compile(source)
    expect(() => toSQL(program, { row: 'order', columns, dialect: 'postgres' })).toThrow(
      /too large/u,
    )
    expect(() => toMongo(program, { row: 'order', fields: columns })).toThrow(/too large/u)
  })

  it('checks parameter limits and the offset', () => {
    const program = env.compile('order.total in list')
    const options = {
      row: 'order',
      columns,
      known: { list: Array.from({ length: 40_000 }, (_, i) => i) },
    }
    expect(() => toSQL(program, { ...options, dialect: 'sqlite' })).toThrow(
      /more than 32766 parameters/u,
    )
    // Postgres takes a list as one array parameter.
    expect(toSQL(program, { ...options, dialect: 'postgres' }).params).toHaveLength(1)
    for (const paramOffset of [-1, 1.5, Number.NaN, 1e21]) {
      expect(() =>
        toSQL(env.compile('order.total > 1'), {
          row: 'order',
          columns,
          dialect: 'postgres',
          paramOffset,
        }),
      ).toThrow(RangeError)
    }
  })

  it('rejects Postgres timestamps outside years 0001 to 9999', () => {
    const program = env.compile('order.placed < when')
    for (const when of [new Date('0000-06-01T00:00:00Z'), new Date(8.64e15)]) {
      expect(() =>
        toSQL(program, { row: 'order', columns, dialect: 'postgres', known: { when } }),
      ).toThrow(/0001 to 9999/u)
      expect(toSQL(program, { row: 'order', columns, dialect: 'sqlite', known: { when } })).toEqual(
        { sql: expect.any(String), params: [when.getTime()] },
      )
    }
  })

  it('rejects invalid column names', () => {
    const program = env.compile('order.city == "x"')
    for (const name of ['$where', 'a..b', '']) {
      expect(() =>
        toMongo(program, { row: 'order', fields: { city: { type: 'text', name } } }),
      ).toThrow(TypeError)
    }
    expect(() =>
      toSQL(program, {
        row: 'order',
        columns: { city: { type: 'text', name: 'a\0b' } },
        dialect: 'postgres',
      }),
    ).toThrow(TypeError)
  })
})

describe('production hardening', () => {
  it('rejects calls to host functions that replace a built-in', () => {
    const custom = bonsai({
      functions: {
        startsWith: fn({
          params: [t.string(), t.string()],
          returns: t.boolean(),
          run: (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase()),
        }),
      },
    })
    const program = custom.compile('order.name.startsWith("A")')
    expect(() => toSQL(program, { row: 'order', columns, dialect: 'sqlite' })).toThrow(
      /host function/u,
    )
    expect(() => toMongo(program, { row: 'order', fields: columns })).toThrow(/host function/u)
  })

  it('reads holes in known lists as null', async () => {
    const rows = [row(1, {}), row(2, { total: 1 }), row(3, { total: 7 })]
    expect(await agree('order.total in sparse', rows)).toEqual([1, 2])
    expect(await agree('order.total not in sparse', rows)).toEqual([3])
  })

  it('rejects variables that are neither the row nor known', () => {
    const program = env.compile('!(order.total > 1)')
    expect(() => toSQL(program, { row: 'orders', columns, dialect: 'postgres' })).toThrow(
      /order is neither the row \(orders\) nor a known value/u,
    )
    expect(() =>
      toMongo(env.compile('order.name != user'), { row: 'order', fields: columns }),
    ).toThrow(/user is neither/u)
  })

  it('suggests the closest row, known value, or column for a misspelled name', () => {
    expect(() =>
      toSQL(env.compile('order.total > 1'), { row: 'orders', columns, dialect: 'sqlite' }),
    ).toThrow(/order is neither the row \(orders\) nor a known value; did you mean "orders"\?/u)
    expect(() =>
      toSQL(env.compile('order.total > minTotal'), {
        row: 'order',
        columns,
        dialect: 'sqlite',
        known: { minTotl: 5 },
      }),
    ).toThrow(/minTotal is neither .*; did you mean "minTotl"\?/u)
    expect(() => toMongo(env.compile('order.totl > 1'), { row: 'order', fields: columns })).toThrow(
      /order\.totl is not a declared column; did you mean "total"\?/u,
    )
  })

  it('validates configuration', () => {
    const program = env.compile('order.name == "a"')
    const bad: unknown[] = [
      { row: 'order', columns, dialect: 'postgresql' },
      { row: 'order', columns: { name: 'string' }, dialect: 'postgres' },
      { row: 'order', columns: null, dialect: 'postgres' },
      { row: 'order', columns: { name: null }, dialect: 'postgres' },
      { row: '', columns, dialect: 'postgres' },
      {
        row: 'order',
        columns: { name: { type: 'text', name: 'x'.repeat(64) } },
        dialect: 'postgres',
      },
    ]
    for (const options of bad) {
      expect(() => toSQL(program, options as SQLOptions), JSON.stringify(options)).toThrow(
        TypeError,
      )
    }
    expect(() =>
      toMongo(program, { row: 'order', fields: { name: { type: 'text', name: 'a.$where' } } }),
    ).toThrow(TypeError)
  })

  it('gives every untranslatable part a span', () => {
    for (const source of [
      'order.total + 1 > 2',
      'order.total == order.qty',
      'order.name in word',
    ]) {
      let error: unknown
      try {
        toMongo(env.compile(source), { row: 'order', fields: columns, known })
      } catch (caught) {
        error = caught
      }
      expect(error, source).toBeInstanceOf(BonsaiTranslationError)
      expect((error as BonsaiTranslationError).span, source).toBeDefined()
    }
  })

  it('produces conditions Postgres can answer from an index', async () => {
    const db = new PGlite()
    await db.exec(`
      create table idx (id int, name text, total float8, placed timestamptz);
      insert into idx select i, 'n' || i, i, now() from generate_series(1, 20000) i;
      create index on idx ((name collate "C"));
      create index on idx (total);
      create index on idx (placed);
      analyze idx;
    `)
    const cols: Columns = { name: 'text', total: 'number', placed: 'timestamp' }
    for (const source of [
      'order.total == 5',
      'order.total > 19990',
      'order.total in [1, 2, 3]',
      'order.name == "n5"',
      'order.name in ["n5", "n6"]',
      'order.name.startsWith("n1999")',
      'order.placed > since && order.total < 3',
    ]) {
      const q = toSQL(env.compile(source), {
        row: 'order',
        columns: cols,
        dialect: 'postgres',
        known,
      })
      const plan = await db.query<{ 'QUERY PLAN': string }>(
        `explain select id from idx where ${q.sql}`,
        [...q.params],
      )
      const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
      expect(planText, `${source}: ${q.sql}`).toMatch(/Index|Bitmap/u)
    }
    await db.close()
    // Starting PGlite and seeding 20,000 rows takes about 4 s on a CI runner under coverage.
  }, 30_000)

  it('produces conditions SQLite can answer from an index', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      create table idx (id integer, name text, total real, placed integer) strict;
      create index idx_name on idx (name);
      create index idx_total on idx (total);
    `)
    const cols: Columns = { name: 'text', total: 'number', placed: 'timestamp' }
    for (const source of [
      'order.total == 5',
      'order.total > 100',
      'order.total in [1, 2, 3]',
      'order.name == "n5"',
      'order.name.startsWith("n1999")',
    ]) {
      const q = toSQL(env.compile(source), { row: 'order', columns: cols, dialect: 'sqlite' })
      const plan = db
        .prepare(`explain query plan select id from idx where ${q.sql}`)
        .all(...(q.params as (string | number)[]))
        .map((r) => (r as { detail: string }).detail)
        .join('\n')
      expect(plan, `${source}: ${q.sql}`).toMatch(/USING INDEX/u)
    }
    db.close()
  })
})

describe('review regressions', () => {
  it('fails a mismatched-kind comparison when its arithmetic fails', async () => {
    const rows = [
      row(1, { name: 'x' }),
      row(2, {}),
      row(3, { name: 'x', total: 1 }),
      row(4, { total: 1 }),
    ]
    expect(await agree('order.name != order.total + 1', rows)).toEqual([3, 4])
    expect(await agree('order.total + 1 != order.name', rows)).toEqual([3, 4])
    expect(await agree('order.active == order.total * 2', rows)).toEqual([])
  })

  it('escapes LIKE wildcards in a Postgres prefix', async () => {
    const rows = [row(1, { name: 'a%b' }), row(2, { name: 'axb' }), row(3, { name: 'a_\\c' })]
    expect(await agree('order.name.startsWith("a%")', rows)).toEqual([1])
    expect(await agree('order.name.startsWith("a_\\\\")', rows)).toEqual([3])
  })

  it('reads a known Date by its real time, never through an overridden getTime', () => {
    class Lying extends Date {
      override getTime(): number {
        return 0
      }
    }
    const when = new Lying('2026-01-01T00:00:00Z')
    const program = bonsai({
      variables: { order: t.object({ placed: t.timestamp() }), when: t.timestamp() },
    }).compile('order.placed > when')
    const sql = toSQL(program, {
      row: 'order',
      columns: { placed: 'timestamp' },
      dialect: 'sqlite',
      known: { when },
    })
    expect(sql.params).toEqual([Date.UTC(2026, 0, 1)])
    const pgSql = toSQL(program, {
      row: 'order',
      columns: { placed: 'timestamp' },
      dialect: 'postgres',
      known: { when },
    })
    expect(pgSql.params).toEqual(['2026-01-01T00:00:00.000Z'])
  })

  it('rejects MongoDB patterns over the length limit', () => {
    const program = env.compile('order.name.startsWith(long)')
    expect(() =>
      toMongo(program, { row: 'order', fields: columns, known: { long: '('.repeat(16_500) } }),
    ).toThrow(/too long/u)
  })

  it('rejects the row variable in known', () => {
    expect(() =>
      toSQL(env.compile('order.total > 1'), {
        row: 'order',
        columns,
        dialect: 'sqlite',
        known: { order: { total: 5 } },
      }),
    ).toThrow(TypeError)
  })
})

describe('toSQL', () => {
  it('produces parameterized, typed Postgres', () => {
    const program = env.compile('order.total > limit && order.name.startsWith("ap")')
    expect(toSQL(program, { row: 'order', columns, dialect: 'postgres', known })).toEqual({
      sql: '(("total"::float8 > $1::float8) AND (("name" COLLATE "C") LIKE $2::text ESCAPE \'\\\'))',
      params: [10, 'ap%'],
    })
  })

  it("checks declared columns against the environment's variable types", () => {
    const typed = bonsai({
      variables: {
        event: t.object({
          tags: t.list(t.string()),
          name: t.string(),
          at: t.optional(t.timestamp()),
          status: t.enum('open', 'closed'),
          meta: t.object({ count: t.number() }),
        }),
      },
    })
    const program = typed.compile('"a" in event.tags')
    expect(() =>
      toSQL(program, { row: 'event', columns: { tags: 'text' }, dialect: 'sqlite' }),
    ).toThrow(
      /columns\.tags is declared text, but the environment declares event\.tags as string\[\]/u,
    )
    expect(() => toMongo(program, { row: 'event', fields: { tags: 'text' } })).toThrow(
      /fields\.tags is declared text/u,
    )
    const fine = typed.compile(
      'event.name == "x" && event.status == "open" && event.meta.count > 1',
    )
    const columnsThatFit = {
      name: 'text',
      at: 'timestamp',
      status: 'text',
      'meta.count': 'number',
    } as const
    expect(() =>
      toSQL(fine, { row: 'event', columns: columnsThatFit, dialect: 'sqlite' }),
    ).not.toThrow()
    expect(() =>
      toSQL(fine, { row: 'event', columns: { 'meta.count': 'text' }, dialect: 'sqlite' }),
    ).toThrow(/meta\.count is declared text/u)
    // An open environment declares nothing, so there is nothing to check against.
    expect(() =>
      toSQL(bonsai().compile('"a" in event.tags'), {
        row: 'event',
        columns: { tags: 'text' },
        dialect: 'sqlite',
      }),
    ).not.toThrow()
  })

  it('takes known values typed by an interface or a class', () => {
    interface Known {
      limit: number
    }
    class Limits {
      readonly limit: number
      constructor(limit: number) {
        this.limit = limit
      }
    }
    const fromInterface: Known = { limit: 10 }
    const program = env.compile('order.total > limit')
    const options = { row: 'order', columns, dialect: 'postgres' } as const
    expect(toSQL(program, { ...options, known: fromInterface }).params).toEqual([10])
    expect(toSQL(program, { ...options, known: new Limits(10) }).params).toEqual([10])
  })

  it('continues parameter numbering from an offset', () => {
    const program = env.compile('order.total > 1')
    expect(
      toSQL(program, { row: 'order', columns, dialect: 'postgres', paramOffset: 3 }).sql,
    ).toContain('$4::float8')
  })

  it('maps keys to column names and quotes them', () => {
    const program = env.compile('order.city == "Paris"')
    const sql = toSQL(program, {
      row: 'order',
      columns: { city: { type: 'text', name: 'ship"city' } },
      dialect: 'postgres',
    }).sql
    expect(sql).toContain('"ship""city"')
  })

  it('turns decided predicates into constants', () => {
    const program = env.compile('limit > 5 || order.total > 1')
    expect(toSQL(program, { row: 'order', columns, dialect: 'sqlite', known }).sql).toBe('1')
  })

  it.each([
    ['order.password == "x"', /not a declared column/u],
    ['order == null', /not order itself/u],
    ['order.name > "a"', /Ordering text/u],
    ['order.name.toUpperCase() == "A"', /no exact database equivalent|not translated/u],
    ['order.total / 2 > 1', /"\/" is not translated/u],
    ['order.name', /Only boolean columns/u],
  ])('rejects %s', (source, message) => {
    expect(() =>
      toSQL(env.compile(source), { row: 'order', columns, dialect: 'postgres', known }),
    ).toThrow(message)
  })

  it('rethrows errors that happen whatever the row is', () => {
    expect(() =>
      toSQL(env.compile('limit / 0 > 1 && order.active'), {
        row: 'order',
        columns,
        dialect: 'postgres',
        known,
      }),
    ).toThrow(/Division by zero/u)
  })

  it('rejects text with NUL characters', () => {
    expect(() =>
      toSQL(env.compile('order.name == "a\\0b"'), { row: 'order', columns, dialect: 'postgres' }),
    ).toThrow(/NUL/u)
  })
})

describe('toMongo', () => {
  it('produces idiomatic filters with simple collation', () => {
    const program = env.compile('order.total > limit && order.name in ["a", "b"] && !order.active')
    expect(toMongo(program, { row: 'order', fields: columns, known })).toEqual({
      filter: {
        $and: [
          { $and: [{ total: { $gt: 10 } }, { name: { $in: ['a', 'b'] } }] },
          { $nor: [{ active: { $eq: true } }] },
        ],
      },
      options: { collation: { locale: 'simple' } },
    })
  })

  it('never lets a known value become an operator', () => {
    const program = bonsai().compile('order.name == value')
    expect(() =>
      toMongo(program, { row: 'order', fields: columns, known: { value: { $gt: '' } } }),
    ).toThrow(BonsaiTranslationError)
  })

  it('uses dotted paths for nested fields', () => {
    const program = env.compile('order.address.city == "Paris"')
    expect(toMongo(program, { row: 'order', fields: { 'address.city': 'text' } }).filter).toEqual({
      'address.city': { $eq: 'Paris' },
    })
  })
})

describe('translator options are validated like the others', () => {
  const program = env.compile('order.total > 1')
  const sql = { row: 'order', columns, dialect: 'postgres' } as const
  const mongo = { row: 'order', fields: columns } as const

  it('rejects unknown keys, so a misspelled paramOffset is never silently ignored', () => {
    expect(() => toSQL(program, { ...sql, paramOfset: 5 } as never)).toThrow(
      /Unknown toSQL option key "paramOfset"/u,
    )
    expect(() => toSQL(program, { ...sql, unknown: ['x'] } as never)).toThrow(TypeError)
    expect(() => toMongo(program, { ...mongo, dialect: 'postgres' } as never)).toThrow(
      /Unknown toMongo option key "dialect"/u,
    )
  })

  it('reports a wrongly typed paramOffset as a TypeError and a bad value as a RangeError', () => {
    expect(() => toSQL(program, { ...sql, paramOffset: '3' } as never)).toThrow(TypeError)
    expect(() => toSQL(program, { ...sql, paramOffset: null } as never)).toThrow(TypeError)
    expect(() => toSQL(program, { ...sql, paramOffset: -1 })).toThrow(RangeError)
    expect(toSQL(program, { ...sql, paramOffset: 2 }).sql).toContain('$3')
  })

  it('accepts undefined for optional options', () => {
    expect(
      toSQL(program, { ...sql, paramOffset: undefined, known: undefined, now: undefined }).sql,
    ).toContain('$1')
  })
})

describe('host functions are named when they block translation', () => {
  it('reports a host call used as a value, not only as a condition', () => {
    const host = bonsai({
      functions: { dbl: fn({ params: [t.number()], returns: t.number(), run: (n) => n * 2 }) },
    })
    const program = host.compile('dbl(k) < order.total')
    const options = {
      row: 'order',
      columns: { total: 'number' },
      dialect: 'sqlite',
      known: { k: 1 },
    } as const
    expect(() => toSQL(program, options)).toThrow(/dbl\(\) is a host function/u)
  })
})

describe('known values are validated as evaluation validates them', () => {
  it('reports INVALID_CONTEXT for known data that does not match its type', () => {
    const strictEnv = bonsai({
      variables: { user: t.object({ age: t.number() }), order: t.object({ total: t.number() }) },
      validateContext: true,
    })
    const program = strictEnv.compile('user.age > 30 && order.total > 0')
    const options = { row: 'order', columns: { total: 'number' }, dialect: 'sqlite' } as const
    expect(() => toSQL(program, { ...options, known: { user: { age: '36' } } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    )
    expect(toSQL(program, { ...options, known: { user: { age: 36 } } }).sql).toBe('(`total` > ?1)')
  })
})

describe('known values are read as the engine reads them', () => {
  const program = env.compile('order.total in xs')
  const sqlite = { row: 'order', columns, dialect: 'sqlite' } as const

  it('reads a known list by index, never through its own iterator', () => {
    const xs = [5]
    Object.defineProperty(xs, Symbol.iterator, {
      *value() {
        yield 20
      },
    })
    expect(toSQL(program, { ...sqlite, known: { xs } }).params).toEqual([5])
    class Odd extends Array<number> {
      *[Symbol.iterator](): ArrayIterator<number> {
        yield 20
      }
    }
    expect(toSQL(program, { ...sqlite, known: { xs: Odd.from([5]) } }).params).toEqual([5])
  })

  it('only ever throws Bonsai errors for host data that cannot be read', () => {
    const failing = (data: Record<string, unknown>, source = 'order.total > 1 || k > 1'): void => {
      let error: unknown
      try {
        toSQL(env.compile(source), { ...sqlite, known: data })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(BonsaiError)
    }
    const { proxy, revoke } = Proxy.revocable([1], {})
    revoke()
    const throwing = [1]
    Object.defineProperty(throwing, 0, {
      get() {
        throw new Error('boom')
      },
    })
    failing({ k: Object.create(Date.prototype) }, 'order.placed != k')
    failing(
      Object.defineProperty({}, 'k', {
        enumerable: true,
        get() {
          throw new Error('boom')
        },
      }),
    )
    failing({ xs: throwing }, 'order.total > 1 || order.total in xs')
    failing({ xs: proxy }, 'order.total > 1 || order.total in xs')
    failing(
      new Proxy(
        {},
        {
          has: () => {
            throw new Error('trap')
          },
          getOwnPropertyDescriptor: () => {
            throw new Error('trap')
          },
        },
      ),
      'order.total > 1',
    )
  })
})

describe('known values must hold every path the filter reads', () => {
  const sqlite = { row: 'order', columns, dialect: 'sqlite' } as const
  const mongo = { row: 'order', fields: columns } as const

  it('refuses a path missing from a known object instead of reading it as null', () => {
    const program = env.compile('order.total > limits.max')
    for (const data of [{ limits: { min: 1 } }, { limits: { min: 1, max: undefined } }]) {
      expect(() => toSQL(program, { ...sqlite, known: data })).toThrow(
        /limits\.max is missing from the known values/u,
      )
      expect(() => toMongo(program, { ...mongo, known: data })).toThrow(
        /limits\.max is missing from the known values/u,
      )
    }
    expect(() =>
      toSQL(env.compile('order.total > limits.a.b'), { ...sqlite, known: { limits: { a: {} } } }),
    ).toThrow(/limits\.a\.b is missing/u)
    expect(() =>
      toSQL(env.compile('order.name == cfg["label"]'), { ...sqlite, known: { cfg: {} } }),
    ).toThrow(/cfg\.label is missing/u)
  })

  it('translates a path that is present, even when it holds null', () => {
    const program = env.compile('order.total > limits.max')
    expect(toSQL(program, { ...sqlite, known: { limits: { max: 5 } } }).params).toEqual([5])
    expect(toSQL(program, { ...sqlite, known: { limits: { max: null } } }).sql).toBe('0')
  })

  it('accepts a missing path the filter guards with has(), ??, or a null test', () => {
    const data = { limits: { min: 1 } }
    for (const source of [
      'order.total > (limits.max ?? 5)',
      'has(limits.max) && order.total > limits.max',
      'limits.max == null || order.total > limits.max',
      'limits.max != null && order.total > limits.max',
    ]) {
      expect(() => toSQL(env.compile(source), { ...sqlite, known: data }), source).not.toThrow()
    }
  })
})

describe('numeric and text ?? defaults', () => {
  const rows = [row(1, {}), row(2, { total: 600 }), row(3, { total: 5 }), row(4, { total: 0 })]
  const translates = { mustTranslate: true }

  it('translates a column with a known default compared with a known value', async () => {
    expect(await agree('(order.total ?? 0) >= 500', rows, translates)).toEqual([2])
    expect(await agree('(order.total ?? 1000) >= 500', rows, translates)).toEqual([1, 2])
    expect(await agree('!((order.total ?? 0) >= 500)', rows, translates)).toEqual([1, 3, 4])
    expect(await agree('limit < (order.total ?? 11)', rows, translates)).toEqual([1, 2])
    expect(await agree('(order.total ?? 0) == 0', rows, translates)).toEqual([1, 4])
    expect(await agree('(order.total ?? 0) != 0', rows, translates)).toEqual([2, 3])
    expect(await agree('(order.total ?? 5) in [5, 600]', rows, translates)).toEqual([1, 2, 3])
    expect(await agree('(order.total ?? 5) not in [5, 600]', rows, translates)).toEqual([4])
    expect(await agree('(order.total ?? 0) > nothing', rows, translates)).toEqual([])
    const named = [row(1, {}), row(2, { name: '' }), row(3, { name: 'a' })]
    expect(await agree('(order.name ?? "") == ""', named, translates)).toEqual([1, 2])
  })

  it('translates a default against another column or in arithmetic for SQL', async () => {
    const pairs = [
      row(1, {}),
      row(2, { total: 3, qty: 2 }),
      row(3, { qty: -1 }),
      row(4, { total: 1 }),
    ]
    for (const source of ['(order.total ?? 0) > (order.qty ?? 0)', '(order.total ?? 0) + 1 > 2']) {
      expect(() =>
        toSQL(env.compile(source), { row: 'order', columns, dialect: 'sqlite' }),
      ).not.toThrow()
    }
    expect(await agree('(order.total ?? 0) > (order.qty ?? 0)', pairs)).toEqual([2, 3, 4])
    expect(await agree('(order.total ?? 0) + 1 > 2', pairs)).toEqual([2])
  })

  it('refuses a default of a different kind than its column', () => {
    expect(() =>
      toSQL(env.compile('(order.total ?? "none") > 5'), {
        row: 'order',
        columns,
        dialect: 'sqlite',
      }),
    ).toThrow(BonsaiTranslationError)
  })
})

describe('duration columns', () => {
  const ms = (n: number): Duration => new Duration(n)
  const rows = [
    row(1, {}),
    row(2, { wait: ms(500) }),
    row(3, { wait: ms(1_209_600_000) }),
    row(4, { wait: ms(-5) }),
  ]
  const translates = { mustTranslate: true }

  it('compares a duration column with known durations', async () => {
    expect(await agree('order.wait < seconds(1)', rows, translates)).toEqual([2, 4])
    expect(await agree('order.wait >= span', rows, translates)).toEqual([3])
    expect(await agree('order.wait == span', rows, translates)).toEqual([3])
    expect(await agree('!(order.wait < seconds(1))', rows, translates)).toEqual([1, 3])
    expect(await agree('order.wait in [span, milliseconds(500)]', rows, translates)).toEqual([2, 3])
    expect(await agree('order.wait == null', rows, translates)).toEqual([1])
    // A duration is never equal to a number.
    expect(await agree('order.wait == 500', rows, translates)).toEqual([])
  })

  it('reads inMilliseconds of a duration column in SQL, failing on null', async () => {
    expect(await agree('inMilliseconds(order.wait) > 100', rows)).toEqual([2, 3])
    expect(await agree('!(inMilliseconds(order.wait) > 100)', rows)).toEqual([4])
    expect(await agree('!(order.wait?.inMilliseconds() > 100)', rows)).toEqual([1, 4])
    expect(
      toSQL(env.compile('inMilliseconds(order.wait) > 100'), {
        row: 'order',
        columns,
        dialect: 'postgres',
      }).sql,
    ).toContain('"wait"')
  })

  it('refuses a duration compared with a number', () => {
    expect(() =>
      toSQL(env.compile('order.wait > 500'), { row: 'order', columns, dialect: 'sqlite' }),
    ).toThrow(BonsaiTranslationError)
  })
})

describe('untranslatable parts say why', () => {
  const options = { row: 'order', columns, dialect: 'sqlite', known } as const
  const reason = (source: string): string => {
    try {
      toSQL(bonsai().compile(source), options)
    } catch (error) {
      if (error instanceof BonsaiTranslationError) {
        expect(error.span, source).toBeDefined()
        return error.message
      }
      throw error
    }
    throw new Error(`${source} translated`)
  }

  it('names the missing now option, calendar functions, and unsupported constructs', () => {
    expect(reason('order.placed < now()')).toMatch(/now\(\).*`now` option/u)
    expect(reason('hour(order.placed) > 9')).toMatch(/hour\(\).*time zone/u)
    expect(reason('year(order.placed) == 2026')).toMatch(/year\(\).*time zone/u)
    expect(reason('(let x = order.total; x > 1)')).toMatch(/let/u)
    expect(reason('(order.active ? order.total : order.qty) > 1')).toMatch(/\?:/u)
    expect(reason('try(order.total > 1, false)')).toMatch(/try\(\)/u)
    expect(reason('order.total / 2 > 1')).toMatch(/"\/"/u)
    expect(reason('order.name.toUpperCase() == "A"')).toMatch(/toUpperCase\(\) is not translated/u)
  })
})

describe('translation shares the partial evaluation budget options', () => {
  const program = env.compile('order.total > 1 && limit > 0')
  const sql = { row: 'order', columns, dialect: 'sqlite', known } as const

  it('accepts maxSteps, timeout, and signal, validated like partial()', () => {
    expect(toSQL(program, { ...sql, maxSteps: 1000, timeout: 1000 }).sql).toContain('total')
    const signal = new AbortController().signal
    expect(toMongo(program, { row: 'order', fields: columns, known, signal }).filter).toBeDefined()
    expect(() => toSQL(program, { ...sql, maxSteps: -1 })).toThrow(RangeError)
    expect(() => toSQL(program, { ...sql, timeout: 'x' } as never)).toThrow(TypeError)
  })

  it('stops at the step budget and an aborted signal', () => {
    const terms = Array.from({ length: 200 }, () => 'limit > 0').join(' && ')
    const long = env.compile(`order.total > 1 && ${terms}`)
    expect(() => toSQL(long, { ...sql, maxSteps: 5 })).toThrow(
      expect.objectContaining({ code: 'STEP_LIMIT' }),
    )
    const controller = new AbortController()
    controller.abort()
    expect(() => toSQL(program, { ...sql, signal: controller.signal })).toThrow(
      expect.objectContaining({ code: 'ABORTED' }),
    )
  })
})

describe('the translators take compiled programs', () => {
  it('rejects a partial-evaluation residual or another object with a TypeError', () => {
    const residual = env
      .compile('order.total > limit')
      .partial({ limit: 1 }, { unknown: ['order'] })
    for (const value of [residual, { source: 'x' }, null]) {
      expect(() => toSQL(value as never, { row: 'order', columns, dialect: 'sqlite' })).toThrow(
        /takes a compiled program/u,
      )
      expect(() => toMongo(value as never, { row: 'order', fields: columns })).toThrow(
        /takes a compiled program/u,
      )
    }
  })
})
