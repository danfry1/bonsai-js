import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bonsai, t } from '../src/index.js'
import { toSQL, type Columns } from '../src/query/index.js'

const open = bonsai()

/** The next double after `x` toward `toward`. */
function nextAfter(x: number, toward: number): number {
  if (x === toward) return x
  if (x === 0) return toward > 0 ? 5e-324 : -5e-324
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, toward > x === x > 0 ? bits + 1n : bits - 1n)
  return view.getFloat64(0)
}

const OUT_OF_RANGE = /value out of range: (?:overflow|underflow)/u

describe('arithmetic at the edges of the double range: the rows evaluation selects, or a Postgres error', () => {
  // Doubles on both sides of where float8 arithmetic overflows or rounds to zero, paired
  // with partners that push them over: about 300 rows.
  const edges = new Set<number>()
  for (const centre of [1, 3, Number.MAX_VALUE, 1e308, 2 ** 512, 5e-324, 1e-200, 1e-300]) {
    for (const value of [centre, nextAfter(centre, Infinity), nextAfter(centre, 0)]) {
      if (Number.isFinite(value)) {
        edges.add(value)
        edges.add(-value)
      }
    }
  }
  const partners = [0, 1, -2, 0.5, 1e308, 1e-200, null]
  const rows: { id: number; a: number | null; b: number | null }[] = []
  for (const a of edges) for (const b of partners) rows.push({ id: rows.length, a, b })

  let pg: PGlite
  let lite: DatabaseSync
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec('create table t (id integer, a float8, b float8)')
    await pg.query('insert into t select * from unnest($1::int[], $2::float8[], $3::float8[])', [
      rows.map((r) => r.id),
      rows.map((r) => r.a),
      rows.map((r) => r.b),
    ])
    lite = new DatabaseSync(':memory:')
    lite.exec('create table t (id integer, a real, b real) strict')
    const insert = lite.prepare('insert into t values (?, ?, ?)')
    for (const row of rows) insert.run(row.id, row.a, row.b)
  }, 30_000)
  afterAll(async () => {
    await pg.close()
    lite.close()
  })

  const columns: Columns = { a: 'number', b: 'number' }
  const selects = (source: string, row: (typeof rows)[number]): boolean => {
    try {
      return open.evaluateSync(source, { r: row }) === true
    } catch {
      return false
    }
  }

  it.each([
    'r.a * r.b > 0',
    'r.a * r.b == 0',
    'r.a + r.b > 0',
    'r.a - r.b < 0',
    'r.a * 3 > 1',
    'r.a * 1e-300 != 0',
    '!(r.a * r.b > 0)',
  ])('%s', async (source) => {
    const program = open.compile(source)
    const want = rows.filter((row) => selects(source, row)).map((row) => row.id)

    // SQLite computes infinities and zeros, and excludes the rows evaluation fails on.
    const sqlite = toSQL(program, { row: 'r', columns, dialect: 'sqlite' })
    const liteIds = lite
      .prepare(`select id from t where ${sqlite.sql} order by id`)
      .all(...sqlite.params)
      .map((row) => (row as { id: number }).id)
    expect(liteIds).toEqual(want)

    // Postgres raises instead; it may fail the query, but never returns other rows. One
    // raising row fails a whole-table query, so each row is also asked about on its own.
    const whole = toSQL(program, { row: 'r', columns, dialect: 'postgres' })
    try {
      const got = await pg.query<{ id: number }>(
        `select id from t where ${whole.sql} order by id`,
        whole.params,
      )
      expect(got.rows.map((row) => row.id)).toEqual(want)
    } catch (error) {
      expect(String(error)).toMatch(OUT_OF_RANGE)
    }
    const single = toSQL(program, { row: 'r', columns, dialect: 'postgres', paramOffset: 1 })
    let raised = 0
    for (const row of rows) {
      try {
        const got = await pg.query(`select id from t where id = $1 and ${single.sql}`, [
          row.id,
          ...single.params,
        ])
        expect(got.rows.length === 1, `row ${JSON.stringify(row)}`).toBe(selects(source, row))
      } catch (error) {
        expect(String(error), `row ${JSON.stringify(row)}`).toMatch(OUT_OF_RANGE)
        raised++
      }
    }
    // The edge rows do reach the error, and the others answer, so the test sees both outcomes.
    expect(raised).toBeGreaterThan(0)
    expect(raised).toBeLessThan(rows.length)
  })
})

describe('refusals name the part that does not translate', () => {
  const typed = bonsai({
    variables: {
      order: t.object({
        placed: t.optional(t.timestamp()),
        region: t.optional(t.string()),
        email: t.optional(t.string()),
        total: t.number(),
      }),
      params: t.object({ minTotal: t.optional(t.number()) }),
    },
  })
  const columns: Columns = { placed: 'timestamp', region: 'text', email: 'text', total: 'number' }
  const options = {
    row: 'order',
    columns,
    dialect: 'postgres',
    now: new Date('2026-10-01T00:00:00Z'),
  } as const
  const refusal = (source: string, known?: Record<string, unknown>): string => {
    try {
      toSQL(typed.compile(source), known === undefined ? options : { ...options, known })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return 'translated'
  }

  it('translates relative dates on an optional timestamp after a null test', () => {
    expect(refusal('order.placed != null && now() - order.placed < days(14)')).toBe('translated')
  })

  it('says how to write date arithmetic on an optional timestamp', () => {
    for (const source of [
      'now() - (order.placed ?? now()) < days(14)',
      '(order.placed ?? timestamp(0)) + days(3) > now()',
    ]) {
      expect(refusal(source)).toMatch(
        /on a timestamp is translated only for a timestamp column itself.*x != null/u,
      )
    }
  })

  it('blames a call that does not translate, not the ?? after it', () => {
    expect(refusal('order.region?.matches("^E") ?? false')).toBe('matches() is not translated')
  })

  it('says text length does not translate', () => {
    expect(refusal('order.email?.length > 3')).toMatch(/^The length of text is not translated/u)
  })

  it('names a known value of the wrong type', () => {
    expect(refusal('order.total > params.minTotal', { params: { minTotal: '100' } })).toBe(
      'Cannot order number with text: the known value on the right is text',
    )
  })
})
