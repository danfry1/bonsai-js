import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { Query } from 'mingo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BonsaiError, bonsai } from '../src/index.js'
import { toMongo, toSQL, type Columns } from '../src/query/index.js'

const env = bonsai()
const columns: Columns = { name: 'text', total: 'number' }
const rows = [
  { id: 1, name: null, total: null },
  { id: 2, name: 'za', total: 1 },
  { id: 3, name: 'zz', total: 2 },
  { id: 4, name: 'a', total: 2.5 },
]

let lite: DatabaseSync
let pg: PGlite
beforeAll(async () => {
  lite = new DatabaseSync(':memory:')
  lite.exec('create table t (id integer, name text, total real) strict')
  const insert = lite.prepare('insert into t values (?, ?, ?)')
  for (const r of rows) insert.run(r.id, r.name, r.total)
  pg = new PGlite()
  await pg.exec('create table t (id int, name text, total float8)')
  for (const r of rows) await pg.query('insert into t values ($1, $2, $3)', [r.id, r.name, r.total])
}, 30_000)
afterAll(async () => {
  lite.close()
  await pg.close()
})

/** The ids each target selects, next to the ids evaluation accepts. */
async function selected(source: string, known: Record<string, unknown> = {}) {
  const program = env.compile(source)
  const want = rows
    .filter((row) => {
      try {
        return program.evaluateSync({ ...known, row }) === true
      } catch (error) {
        if (error instanceof BonsaiError) return false
        throw error
      }
    })
    .map((r) => r.id)
  const shared = { row: 'row', known }
  const sqlite = toSQL(program, { ...shared, columns, dialect: 'sqlite' })
  const postgres = toSQL(program, { ...shared, columns, dialect: 'postgres' })
  const mongo = toMongo(program, { ...shared, fields: columns })
  return {
    want,
    sqlite: lite
      .prepare(`select id from t where ${sqlite.sql} order by id`)
      .all(...sqlite.params)
      .map((r) => (r as { id: number }).id),
    postgres: (
      await pg.query<{ id: number }>(
        `select id from t where ${postgres.sql} order by id`,
        postgres.params,
      )
    ).rows.map((r) => r.id),
    mongo: rows.filter((row) => new Query(mongo.filter).test(row)).map((r) => r.id),
    filter: mongo.filter,
  }
}

async function agrees(source: string, known: Record<string, unknown> = {}): Promise<number[]> {
  const got = await selected(source, known)
  expect(got.sqlite, `sqlite: ${source}`).toEqual(got.want)
  expect(got.postgres, `postgres: ${source}`).toEqual(got.want)
  expect(got.mongo, `mongo: ${source}`).toEqual(got.want)
  return got.want
}

describe('a known list with repeated entries', () => {
  it.each([
    ['row.name in ["a", "a"]', [4]],
    ['row.name not in ["a", "a"]', [1, 2, 3]],
    ['row.total in [1, 1]', [2]],
    ['row.total not in [1, 1]', [1, 3, 4]],
  ])('%s never reads a repeat as null', async (source, want) => {
    expect(await agrees(source)).toEqual(want)
  })

  it('treats a known list with repeats as its entries', async () => {
    expect(await agrees('row.name in tags', { tags: ['a', 'b', 'b'] })).toEqual([4])
    expect(await agrees('row.name not in tags', { tags: ['a', 'b', 'b'] })).toEqual([1, 2, 3])
  })
})

describe('a comparison whose sides are both known', () => {
  it.each([
    ['(2 ?? row.total) >= 1', [1, 2, 3, 4]],
    ['(2 ?? row.total) < 1', []],
    ['([2].first() ?? row.total) != null', [1, 2, 3, 4]],
    ['([2].first() ?? row.total) == null', []],
    ['(2 ?? row.total) in [1, 2]', [1, 2, 3, 4]],
  ])('%s is known, not a filter on a missing field', async (source, want) => {
    const got = await selected(source)
    expect(JSON.stringify(got.filter)).not.toContain('undefined')
    expect(await agrees(source)).toEqual(want)
  })

  it('folds a known value against another known value', async () => {
    expect(await agrees('(x ?? row.total) >= 1', { x: 2 })).toEqual([1, 2, 3, 4])
    expect(await agrees('(x ?? row.total) == 3', { x: 2 })).toEqual([])
  })
})

describe('a text call on a column with a known default', () => {
  it.each([
    ['(row.name ?? "zz")?.endsWith("a") ?? true', [2, 4]],
    ['(row.name ?? "zz").endsWith("a") ?? true', [2, 4]],
    ['(row.name ?? "zz").endsWith("a") != false', [2, 4]],
    ['(row.name ?? "zz").endsWith("a") != null', [1, 2, 3, 4]],
    ['(row.name ?? "zz").endsWith("a") == null', []],
    ['(row.name ?? "za").endsWith("a") == true', [1, 2, 4]],
  ])('%s calls the function on the default, so it is never null', async (source, want) => {
    expect(await agrees(source)).toEqual(want)
  })

  it('applies a computed known default', async () => {
    expect(
      await agrees('(row.name ?? (tags.first() ?? ""))?.startsWith("z") ?? true', { tags: ['zq'] }),
    ).toEqual([1, 2, 3])
  })
})
