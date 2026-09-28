import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { fc, test } from '@fast-check/vitest'
import { Query } from 'mingo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'
import {
  BonsaiTranslationError,
  toMongo,
  toSQL,
  type Columns,
  type SQLOptions,
} from '../src/query/index.js'

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
  // A hole reads as null.
  // oxlint-disable-next-line no-sparse-arrays
  sparse: [1, , 'a'],
  dates: [new Date(-1), new Date(0), null],
  nums: [-0, 2 ** 53, 0.1, null],
  strs: ['e\u0301', '%', '\\', 'a\n'],
  mixed: [1, 'a', true, null, new Date(0)],
  empty: [],
  flag: true,
  nothing: null,
  d0: new Date(0),
  dm1: new Date(-1),
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
  'e\u0301',
  '\u00e9',
  'a\n',
  '\n',
  '\r\n',
  '%a',
  '_a',
  'a_',
  '\u{1F600}\u{1F601}',
  '\uFFFF',
  '\u{10FFFF}',
  'ab\\',
  '\\%',
  ' ',
]
// Extremes overflow or underflow in arithmetic.
const NUMBERS = [
  0,
  -0,
  -1,
  1,
  2.5,
  10,
  100,
  -0.5,
  1e10,
  1e308,
  -1e308,
  1e-300,
  2 ** 53,
  2 ** 53 + 2,
  5e-324,
  0.1,
  0.2,
  0.30000000000000004,
  2 ** 31,
  -(2 ** 63),
]
const DATES = ['2025-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-03-15T12:30:45.123Z']
  .map((d) => new Date(d))
  .concat([new Date(-1), new Date(0), new Date(1), new Date(-2208988800001)])

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
  fc
    .tuple(
      anyCol,
      fc.constantFrom('in', 'not in'),
      fc.constantFrom(
        'sparse',
        'dates',
        'nums',
        'strs',
        'mixed',
        'empty',
        '[null]',
        '[d0, dm1]',
        '[flag, nothing]',
      ),
    )
    .map(([c, op, l]) => `${c} ${op} ${l}`),
  fc.tuple(anyCol, fc.constantFrom('==', '!='), anyCol).map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      fc.constantFrom('order.placed'),
      cmp,
      fc.constantFrom('order.placed', 'd0', 'dm1', 'nothing'),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      anyCol,
      fc.constantFrom('==', '!='),
      fc.constantFrom(
        'd0',
        'dm1',
        'nothing',
        'flag',
        'limit',
        'word',
        '-0',
        '0.1 + 0.2',
        '9007199254740993',
      ),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      fc.constantFrom('flag', 'limit > 5', 'nothing == null', 'false'),
      numCol,
      numCol,
      cmp,
      numConst,
    )
    .map(([cond, a, b, op, k]) => `(${cond} ? ${a} : ${b}) ${op} ${k}`),
  fc
    .tuple(
      numCol,
      cmp,
      fc.constantFrom(
        '(nothing ?? limit)',
        '(limit ?? 0)',
        '(let x = limit; x)',
        'try(limit, 0)',
        'nums[1]',
        'strs.length',
      ),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      textCol,
      fc.constantFrom('==', '!=', 'in'),
      fc.constantFrom('`${word}`', '`a${limit}`', 'strs[0]', 'word.toUpperCase()', 'strs'),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(strConst, fc.constantFrom('in', 'not in'), textCol)
    .map(([k, op, c]) => `${k} ${op} ${c}`),
  fc
    .tuple(
      textCol,
      fc.constantFrom('in', 'not in'),
      fc.constantFrom('"apple pie"', 'word', '"😀a%_\\n"'),
    )
    .map(([c, op, k]) => `${c} ${op} ${k}`),
  fc
    .tuple(
      fc.constantFrom('flag', 'nothing == null', 'limit < 0', 'true', 'nothing'),
      fc.constantFrom('&&', '||'),
      fc.constantFrom('order.active', 'order.name.startsWith("a")', 'order.total * 2 > 1'),
    )
    .map(([a, op, b]) => `(${a} ${op} ${b})`),
  fc
    .tuple(
      fc.constantFrom('order.active', 'order.name.startsWith("a")', 'order.total * 2 > 1'),
      fc.constantFrom('&&', '||'),
      fc.constantFrom('flag', 'true', 'false', 'nothing', 'nothing == null'),
    )
    .map(([a, op, b]) => `(${a} ${op} ${b})`),
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

  let sqlite: ReturnType<typeof toSQL>
  try {
    sqlite = toSQL(program, { row: 'order', columns, dialect: 'sqlite', known })
  } catch (error) {
    // Untranslatable is allowed; exactness is required of whatever translates.
    if (error instanceof BonsaiTranslationError) return want
    throw error
  }
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
  })

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

describe('toSQL', () => {
  it('produces parameterized, typed Postgres', () => {
    const program = env.compile('order.total > limit && order.name.startsWith("ap")')
    expect(toSQL(program, { row: 'order', columns, dialect: 'postgres', known })).toEqual({
      sql: '(("total"::float8 > $1::float8) AND (("name" COLLATE "C") >= ($2::text COLLATE "C") AND ("name" COLLATE "C") < ($3::text COLLATE "C") AND left("name", char_length($2::text)) = ($2::text COLLATE "C")))',
      params: [10, 'ap', 'aq'],
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
