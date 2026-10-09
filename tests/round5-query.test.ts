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

/** Doubles on both sides of every boundary where float8 arithmetic overflows or rounds to zero. */
const edges = (() => {
  const centres = [
    0,
    1,
    0.5,
    2,
    3,
    Number.MAX_VALUE,
    Number.MAX_VALUE / 2,
    2 ** 1023,
    2 ** 512,
    Math.sqrt(Number.MAX_VALUE),
    1e308,
    1e154,
    5e-324,
    2 ** -537,
    2 ** -538,
    2 ** -500,
    Math.sqrt(2 ** -1075),
    1e-160,
    1e-200,
    1e-300,
  ]
  const values = new Set<number>()
  for (const centre of centres) {
    for (const value of [centre, nextAfter(centre, Infinity), nextAfter(centre, 0)]) {
      values.add(value)
      values.add(-value)
    }
  }
  return [...values].filter((value) => Number.isFinite(value))
})()

describe('Postgres arithmetic excludes the records whose arithmetic fails, as evaluation does', () => {
  const rows: { id: number; a: number | null; b: number | null }[] = []
  for (const a of [...edges, null])
    for (const b of [...edges, null]) rows.push({ id: rows.length, a, b })
  // Pairs whose exact product sits right at 2^-1075, where only the exact product error decides.
  for (const [a, b] of [
    [0.5, 5e-324],
    [nextAfter(0.5, 0), 5e-324],
    [nextAfter(0.5, 1), 5e-324],
    [2 ** -537, 2 ** -538],
    [nextAfter(2 ** -537, 0), 2 ** -538],
    [nextAfter(2 ** -537, 1), 2 ** -538],
    // Just above 2^-1075 (rounds to 5e-324) and just below (rounds to 0); both round to p = 1.
    [(2 ** 52 + 1) * 2 ** -600, (2 ** 53 - 1) * 2 ** -580],
    [(2 ** 52 + 1) * 2 ** -600, (2 ** 53 - 2) * 2 ** -580],
    [0.75, 5e-324 * 3],
  ] as const) {
    for (const [x, y] of [
      [a, b],
      [b, a],
      [-a, b],
    ])
      rows.push({ id: rows.length, a: x, b: y })
  }

  // Doubles from random bit patterns, so every exponent is about as likely: products and
  // sums of these overflow and round to zero often.
  let seed = 20_261_009
  const random32 = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return (x ^ (x >>> 14)) >>> 0
  }
  const randomDouble = (): number => {
    const view = new DataView(new ArrayBuffer(8))
    for (;;) {
      view.setUint32(0, random32())
      view.setUint32(4, random32())
      const value = view.getFloat64(0)
      if (Number.isFinite(value)) return value
    }
  }
  for (let i = 0; i < 1500; i++) {
    const a = randomDouble()
    // Half the partners are close in magnitude to a's reciprocal, where products land near 1.
    const b = i % 2 === 0 ? randomDouble() : (1 / a) * (1 + (random32() / 2 ** 32 - 0.5) * 2 ** -40)
    rows.push({ id: rows.length, a, b: Number.isFinite(b) ? b : null })
  }

  let pg: PGlite
  let lite: DatabaseSync
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec('create table t (id integer, a float8, b float8)')
    lite = new DatabaseSync(':memory:')
    lite.exec('create table t (id integer, a real, b real) strict')
    const insert = lite.prepare('insert into t values (?, ?, ?)')
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      await pg.query(`insert into t select * from unnest($1::int[], $2::float8[], $3::float8[])`, [
        chunk.map((r) => r.id),
        chunk.map((r) => r.a),
        chunk.map((r) => r.b),
      ])
    }
    for (const row of rows) insert.run(row.id, row.a, row.b)
  }, 30_000)
  afterAll(async () => {
    await pg.close()
    lite.close()
  })

  const columns: Columns = { a: 'number', b: 'number' }
  const expected = (source: string): number[] => {
    const program = open.compile(source)
    return rows
      .filter((row) => {
        try {
          return program.evaluateSync({ r: row }) === true
        } catch {
          return false
        }
      })
      .map((row) => row.id)
  }

  it('covers both sides of the exact product error test', () => {
    const band = rows.filter(
      ({ a, b }) =>
        a !== null &&
        b !== null &&
        a !== 0 &&
        b !== 0 &&
        Math.abs(a) < 2 ** -500 &&
        Math.abs(b) < 1,
    )
    const scaled = (x: number, y: number): number => {
      const [small, large] = Math.abs(x) < Math.abs(y) ? [x, y] : [y, x]
      return Math.abs(small) * 2 ** 537 * (Math.abs(large) * 2 ** 538)
    }
    const decided = band.filter(({ a, b }) => scaled(a as number, b as number) === 1)
    expect(decided.some(({ a, b }) => (a as number) * (b as number) === 0)).toBe(true)
    expect(decided.some(({ a, b }) => (a as number) * (b as number) !== 0)).toBe(true)
  })

  it.each([
    'r.a * r.b > 0',
    'r.a * r.b < 0',
    'r.a * r.b == 0',
    'r.a * r.b != 0',
    'r.a + r.b > 0',
    'r.a - r.b < 0',
    'r.a + r.b == r.a',
    'r.a * r.b * 2 > 1',
    '(r.a + r.b) * r.b >= 0',
    'r.a * 3 > 1',
    'r.a * 1e-300 > 0',
    'r.a * 1e300 < 0',
    'r.a * 5e-324 != 0',
    'r.a + 1e308 > 0',
    '1e308 - r.a > 0',
    '-r.a > 0',
    '!(r.a * r.b > 0)',
    'r.a * r.b > 0 || r.a == 1',
  ])('%s', async (source) => {
    const want = expected(source)
    const query = toSQL(open.compile(source), { row: 'r', columns, dialect: 'postgres' })
    const got = await pg.query<{ id: number }>(
      `select id from t where ${query.sql} order by id`,
      query.params,
    )
    expect(got.rows.map((row) => row.id)).toEqual(want)
    const sqlite = toSQL(open.compile(source), { row: 'r', columns, dialect: 'sqlite' })
    const liteIds = lite
      .prepare(`select id from t where ${sqlite.sql} order by id`)
      .all(...sqlite.params)
      .map((row) => (row as { id: number }).id)
    expect(liteIds).toEqual(want)
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
