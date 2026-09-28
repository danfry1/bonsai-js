/**
 * Differential tests against real database servers, through real drivers.
 * Skipped unless QUERY_SERVERS=1. Start the servers with:
 *
 *   docker run -d --rm --name bonsai-q-pg17 -e POSTGRES_PASSWORD=bonsai -p 55432:5432 postgres:17
 *   docker run -d --rm --name bonsai-q-pg13 -e POSTGRES_PASSWORD=bonsai -p 55433:5432 postgres:13
 *   docker run -d --rm --name bonsai-q-mongo -p 57017:27017 mongo:8.0
 *
 * Override the addresses with QUERY_PG_URLS (comma-separated) and QUERY_MONGO_URL.
 */
import { test } from '@fast-check/vitest'
import { MongoClient, type Collection } from 'mongodb'
import pg from 'pg'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { BonsaiTranslationError, toMongo, toSQL } from '../src/query/index.js'
import {
  columns,
  env,
  expected,
  known,
  predicate,
  rowsArbitrary,
  type Row,
} from './support/query-fuzz.js'

const enabled = process.env.QUERY_SERVERS === '1'
const PG_URLS = (
  process.env.QUERY_PG_URLS ??
  'postgres://postgres:bonsai@localhost:55432/postgres,postgres://postgres:bonsai@localhost:55433/postgres'
).split(',')
const MONGO_URL = process.env.QUERY_MONGO_URL ?? 'mongodb://localhost:57017'
const RUNS = Number(process.env.QUERY_FUZZ_RUNS ?? 200)
// Every case round-trips to each server.
const TIMEOUT = 60 * 60 * 1000

// The plain contract, and the looser one the docs allow (varchar, numeric compared as float8).
const TABLES = {
  bonsai_q_plain:
    'id int, name text, city text, total float8, qty float8, active boolean, placed timestamptz',
  bonsai_q_loose:
    'id int, name varchar(200), city varchar(200), total numeric, qty numeric, active boolean, placed timestamptz',
}

interface Server {
  readonly url: string
  readonly nodePg: pg.Client
  readonly postgresJs: postgres.Sql
}

let servers: Server[] = []
let mongo: MongoClient
let plain: Collection
let caseInsensitive: Collection

beforeAll(async () => {
  if (!enabled) return
  servers = await Promise.all(
    PG_URLS.map(async (url) => {
      const nodePg = new pg.Client({ connectionString: url })
      await nodePg.connect()
      for (const [table, definition] of Object.entries(TABLES)) {
        await nodePg.query(`drop table if exists ${table}`)
        await nodePg.query(`create table ${table} (${definition})`)
      }
      return { url, nodePg, postgresJs: postgres(url, { onnotice: () => undefined }) }
    }),
  )
  mongo = new MongoClient(MONGO_URL)
  await mongo.connect()
  const db = mongo.db('bonsai_query_test')
  await db.dropDatabase()
  plain = await db.createCollection('plain')
  // A case-insensitive default: the translated options must override it.
  caseInsensitive = await db.createCollection('ci', { collation: { locale: 'en', strength: 2 } })
})

afterAll(async () => {
  if (!enabled) return
  for (const server of servers) {
    await server.nodePg.end()
    await server.postgresJs.end()
  }
  await mongo.close()
})

const OVERFLOW = /value out of range: (?:overflow|underflow)/u

async function loadPostgres(server: Server, rows: readonly Row[]): Promise<void> {
  for (const table of Object.keys(TABLES)) {
    await server.nodePg.query(`delete from ${table}`)
    for (const r of rows) {
      await server.nodePg.query(`insert into ${table} values ($1, $2, $3, $4, $5, $6, $7)`, [
        r.id,
        r.name,
        r.city,
        r.total,
        r.qty,
        r.active,
        r.placed?.toISOString() ?? null,
      ])
    }
  }
}

async function loadMongo(rows: readonly Row[]): Promise<void> {
  // Odd ids leave null fields out entirely: missing and null must read the same.
  const docs = rows.map((r) =>
    r.id % 2 === 1 ? Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) : { ...r },
  )
  for (const collection of [plain, caseInsensitive]) {
    await collection.deleteMany({})
    await collection.insertMany(docs.map((d) => ({ ...d })))
  }
}

describe.skipIf(!enabled)('differential against real servers', () => {
  test.prop([predicate, rowsArbitrary], {
    numRuns: RUNS,
    seed: Number(process.env.QUERY_FUZZ_SEED ?? 20260928),
  })(
    'Postgres (node-postgres, postgres.js) and MongoDB',
    async (source, rows) => {
      const program = env.compile(source)
      const want = expected(source, rows)

      let sql: ReturnType<typeof toSQL> | undefined
      try {
        sql = toSQL(program, { row: 'order', columns, dialect: 'postgres', known })
      } catch (error) {
        if (!(error instanceof BonsaiTranslationError)) throw error
      }
      if (sql !== undefined) {
        for (const server of servers) {
          await loadPostgres(server, rows)
          for (const table of Object.keys(TABLES)) {
            const query = `select id from ${table} where ${sql.sql} order by id`
            const label = `${server.url} ${table}: ${sql.sql} ${JSON.stringify(sql.params)}`
            try {
              const viaPg = await server.nodePg.query<{ id: number }>(query, [...sql.params])
              expect(
                viaPg.rows.map((r) => r.id),
                `pg ${label}`,
              ).toEqual(want)
              const viaJs = await server.postgresJs.unsafe<{ id: number }[]>(query, [
                ...(sql.params as postgres.ParameterOrJSON<never>[]),
              ])
              expect(
                viaJs.map((r) => r.id),
                `postgres.js ${label}`,
              ).toEqual(want)
            } catch (error) {
              // Documented: arithmetic that overflows a double is a database error.
              if (!OVERFLOW.test(String(error))) throw error
            }
          }
        }
      }

      let filter: ReturnType<typeof toMongo> | undefined
      try {
        filter = toMongo(program, { row: 'order', fields: columns, known })
      } catch (error) {
        if (!(error instanceof BonsaiTranslationError)) throw error
      }
      if (filter !== undefined) {
        await loadMongo(rows)
        for (const collection of [plain, caseInsensitive]) {
          const found = await collection
            .find(filter.filter, { ...filter.options, projection: { id: 1 } })
            .sort({ id: 1 })
            .toArray()
          expect(
            found.map((d) => d.id as number),
            `${collection.collectionName}: ${JSON.stringify(filter.filter)}`,
          ).toEqual(want)
        }
      }
    },
    TIMEOUT,
  )
})

describe.skipIf(!enabled)('server-specific behavior', () => {
  const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id)
  const baseUrl = (url: string, database: string): string => {
    const parsed = new URL(url)
    parsed.pathname = `/${database}`
    return parsed.toString()
  }

  test.each([
    ['EUC_JP', ['上海', '上', '下'], '上'],
    ['LATIN1', ['ÿa', 'ÿ', 'y'], 'ÿ'],
  ])('text functions in a %s database', async (encoding, names, needle) => {
    for (const url of PG_URLS) {
      const database = `bonsai_q_${encoding.toLowerCase()}`
      const admin = new pg.Client({ connectionString: url })
      await admin.connect()
      await admin.query(`drop database if exists ${database}`)
      await admin.query(
        `create database ${database} encoding '${encoding}' lc_collate 'C' lc_ctype 'C' template template0`,
      )
      const client = new pg.Client({ connectionString: baseUrl(url, database) })
      await client.connect()
      try {
        await client.query('create table t (id int, name text)')
        for (const [i, name] of names.entries())
          await client.query('insert into t values ($1, $2)', [i + 1, name])
        for (const op of ['startsWith', 'endsWith', 'includes']) {
          const source = `order.name.${op}(${JSON.stringify(needle)})`
          const rows = names.map((name, i) => ({ ...emptyRow(i + 1), name }))
          const q = toSQL(env.compile(source), { row: 'order', columns, dialect: 'postgres' })
          const found = await client.query<{ id: number }>(
            `select id from t where ${q.sql} order by id`,
            [...q.params],
          )
          expect(ids(found.rows), `${url} ${encoding} ${source}`).toEqual(expected(source, rows))
        }
      } finally {
        await client.end()
        await admin.query(`drop database ${database}`)
        await admin.end()
      }
    }
  })

  test('comparing citext columns stays case-sensitive', async () => {
    for (const server of servers) {
      await server.nodePg.query('create extension if not exists citext')
      await server.nodePg.query('drop table if exists bonsai_q_citext')
      await server.nodePg.query('create table bonsai_q_citext (id int, name citext, city citext)')
      await server.nodePg.query(
        `insert into bonsai_q_citext values (1, 'Apple', 'apple'), (2, 'apple', 'apple')`,
      )
      for (const source of ['order.name == order.city', 'order.name == "apple"']) {
        const q = toSQL(env.compile(source), { row: 'order', columns, dialect: 'postgres' })
        const found = await server.nodePg.query<{ id: number }>(
          `select id from bonsai_q_citext where ${q.sql} order by id`,
          [...q.params],
        )
        expect(ids(found.rows), `${server.url} ${source}`).toEqual([2])
      }
    }
  })
})

function emptyRow(id: number): Row {
  return { id, name: null, city: null, total: null, qty: null, active: null, placed: null }
}
