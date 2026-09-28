import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { fc, test } from '@fast-check/vitest'
import { Query } from 'mingo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BonsaiError, bonsai } from '../src/index.js'
import { BonsaiTranslationError, toMongo, toSQL, type Columns } from '../src/query/index.js'

const columns: Columns = {
  name: 'text',
  city: 'text',
  total: 'number',
  qty: 'number',
  active: 'boolean',
  placed: 'timestamp',
}

interface Row {
  id: number
  name: string | null
  city: string | null
  total: number | null
  qty: number | null
  active: boolean | null
  placed: Date | null
}

const env = bonsai()
const known = {
  limit: 10,
  word: 'apple pie',
  words: ['a', 'apple', 'É', null],
  since: new Date('2026-01-01T00:00:00.000Z'),
}

const STRINGS = [
  '',
  'a',
  'A',
  'ab',
  'a ',
  ' a',
  'é',
  'É',
  'ß',
  '%',
  '_',
  'a%',
  '\\',
  'x\ny',
  'apple',
  'Apple',
  'ap',
  '😀',
  '😀a',
]
// Extremes overflow or underflow in arithmetic.
const NUMBERS = [0, -1, 1, 2.5, 10, 100, -0.5, 1e10, 1e308, -1e308, 1e-300]
const DATES = [
  '2025-06-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-03-15T12:30:45.123Z',
].map((d) => new Date(d))

const text = fc.oneof(fc.constantFrom(...STRINGS), fc.constant(null))
const num = fc.oneof(fc.constantFrom(...NUMBERS), fc.constant(null))
const rowArbitrary = (id: number): fc.Arbitrary<Row> =>
  fc.record({
    id: fc.constant(id),
    name: text,
    city: text,
    total: num,
    qty: num,
    active: fc.oneof(fc.boolean(), fc.constant(null)),
    placed: fc.oneof(fc.constantFrom(...DATES), fc.constant(null)),
  })
const rowsArbitrary = fc
  .integer({ min: 1, max: 10 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => rowArbitrary(i + 1))))

const quoted = (s: string): string => JSON.stringify(s)
const strConst = fc.constantFrom(...STRINGS).map(quoted)
const numConst = fc.oneof(fc.constantFrom(...NUMBERS).map(String), fc.constant('limit'))
const textCol = fc.constantFrom('order.name', 'order.city')
const numCol = fc.constantFrom('order.total', 'order.qty')
const anyCol = fc.constantFrom(
  'order.name',
  'order.city',
  'order.total',
  'order.qty',
  'order.active',
  'order.placed',
)
const cmp = fc.constantFrom('<', '<=', '>', '>=')

const atom: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(numCol, cmp, numConst).map(([c, op, k]) => `${c} ${op} ${k}`),
  fc.tuple(numConst, cmp, numCol).map(([k, op, c]) => `${k} ${op} ${c}`),
  fc.tuple(numCol, cmp, numCol).map(([a, op, b]) => `${a} ${op} ${b}`),
  fc.tuple(textCol, fc.constantFrom('==', '!='), strConst).map(([c, op, k]) => `${c} ${op} ${k}`),
  fc.tuple(textCol, fc.constantFrom('==', '!='), textCol).map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(numCol, fc.constantFrom('==', '!='), fc.oneof(numConst, strConst))
    .map(([c, op, k]) => `${c} ${op} ${k}`),
  fc.tuple(anyCol, fc.constantFrom('== null', '!= null')).map(([c, op]) => `${c} ${op}`),
  fc.constantFrom('order.active', '!order.active', 'order.active == true', 'order.active != false'),
  fc
    .tuple(
      textCol,
      fc.constantFrom('.', '?.'),
      fc.constantFrom('startsWith', 'endsWith', 'includes'),
      strConst,
    )
    .map(([c, dot, f, k]) => `${c}${dot}${f}(${k})`),
  fc
    .tuple(textCol, fc.constantFrom('in', 'not in'))
    .map(([c, op]) => `${c} ${op} ["a", "apple", null, "É"]`),
  fc.tuple(textCol, fc.constantFrom('in', 'not in')).map(([c, op]) => `${c} ${op} words`),
  fc.tuple(numCol, fc.constantFrom('in', 'not in')).map(([c, op]) => `${c} ${op} [1, 2.5, -1]`),
  fc.tuple(strConst, textCol).map(([k, c]) => `${k} in ${c}`),
  textCol.map((c) => `${c} in word`),
  fc
    .tuple(numCol, fc.constantFrom('*', '+', '-'), fc.oneof(numConst, numCol), cmp, numConst)
    .map(([c, op, x, rel, k]) => `${c} ${op} ${x} ${rel} ${k}`),
  fc
    .tuple(
      numCol,
      fc.constantFrom('+ 1', '* 2', '* order.qty', '- order.total'),
      fc.constantFrom('in', 'not in'),
      fc.constantFrom('[]', '["a"]', '[1, null]', '[0, 2]'),
    )
    .map(([c, arith, op, list]) => `${c} ${arith} ${op} ${list}`),
  fc
    .tuple(
      fc.oneof(
        numCol,
        numCol.map((c) => `${c} * 2`),
      ),
      cmp,
    )
    .map(([c, op]) => `${c} ${op} null`),
  fc
    .tuple(fc.constantFrom('>=', '<'), fc.constantFrom('since'))
    .map(([op, k]) => `order.placed ${op} ${k}`),
  fc.constantFrom('true', 'false'),
)

const predicate: fc.Arbitrary<string> = fc.letrec<{ p: string }>((tie) => ({
  p: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    atom,
    tie('p').map((p) => `!(${p})`),
    fc
      .tuple(tie('p'), fc.constantFrom('&&', '||'), tie('p'))
      .map(([a, op, b]) => `(${a} ${op} ${b})`),
  ),
})).p

let lite: DatabaseSync
let pg: PGlite

beforeAll(async () => {
  lite = new DatabaseSync(':memory:')
  lite.exec(
    'create table t (id integer, name text, city text, total real, qty real, active integer, placed integer) strict',
  )
  pg = new PGlite()
  await pg.exec(
    'create table t (id int, name text, city text, total float8, qty float8, active boolean, placed timestamptz)',
  )
})

afterAll(async () => {
  lite.close()
  await pg.close()
})

async function load(rows: readonly Row[], postgres = true): Promise<void> {
  lite.exec('delete from t')
  const insert = lite.prepare('insert into t values (?, ?, ?, ?, ?, ?, ?)')
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
      ],
    )
  }
  if (!postgres) return
  await pg.exec('delete from t')
  for (const r of rows) {
    await pg.query('insert into t values ($1, $2, $3, $4, $5, $6, $7)', [
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

/** The rows for which the predicate evaluates to true (failures excluded, as try(p, false)). */
function expected(source: string, rows: readonly Row[]): number[] {
  const program = env.compile(source)
  return rows
    .filter((order) => {
      try {
        return program.evaluateSync({ ...known, order }) === true
      } catch (error) {
        if (error instanceof BonsaiError) return false
        throw error
      }
    })
    .map((r) => r.id)
}

/** Asserts every target selects exactly the rows Bonsai accepts. */
async function agree(
  source: string,
  rows: readonly Row[],
  targets: { postgres?: boolean } = {},
): Promise<number[]> {
  const program = env.compile(source)
  const want = expected(source, rows)
  await load(rows, targets.postgres ?? true)

  const sqlite = toSQL(program, { row: 'order', columns, dialect: 'sqlite', known })
  const liteIds = lite
    .prepare(`select id from t where ${sqlite.sql} order by id`)
    .all(...(sqlite.params as (string | number | null)[]))
    .map((r) => (r as { id: number }).id)
  expect(liteIds, `sqlite: ${sqlite.sql}`).toEqual(want)

  if (targets.postgres ?? true) {
    const postgres = toSQL(program, { row: 'order', columns, dialect: 'postgres', known })
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
    mongo = toMongo(program, { row: 'order', fields: columns, known })
  } catch (error) {
    if (!(error instanceof BonsaiTranslationError)) throw error
  }
  if (mongo !== undefined) {
    const filter = mongo.filter
    const mongoIds = rows.filter((row) => new Query(filter).test({ ...row })).map((r) => r.id)
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
  ...fields,
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
    expect(toSQL(program, { ...options, dialect: 'postgres' }).params).toHaveLength(40_000)
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
      ).toThrow(BonsaiTranslationError)
    }
    expect(() =>
      toSQL(program, {
        row: 'order',
        columns: { city: { type: 'text', name: 'a\0b' } },
        dialect: 'postgres',
      }),
    ).toThrow(BonsaiTranslationError)
  })
})

describe('toSQL', () => {
  it('produces parameterized, typed Postgres', () => {
    const program = env.compile('order.total > limit && order.name.startsWith("ap")')
    expect(toSQL(program, { row: 'order', columns, dialect: 'postgres', known })).toEqual({
      sql: '(COALESCE("total"::float8 > $1::float8, FALSE) AND (("name" IS NOT NULL) AND COALESCE(left("name", char_length($2::text)) = ($2::text COLLATE "C"), FALSE)))',
      params: [10, 'ap'],
    })
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
    ['order.total / 2 > 1', /no exact database equivalent/u],
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
