# Database Filters

`bonsai-js/query` translates a Bonsai filter into a SQL `WHERE` clause (Postgres or SQLite) or a MongoDB filter, so filters written by your users run in the database instead of in memory.

```ts
import { bonsai } from 'bonsai-js'
import { toMongo, toSQL } from 'bonsai-js/query'

const env = bonsai()
const filter = env.compile('order.status == "paid" && order.total > minTotal')
const columns = { status: 'text', total: 'number' } as const

const { sql, params } = toSQL(filter, { row: 'order', columns, dialect: 'postgres', known: { minTotal: 100 } })
// await db.query(`SELECT * FROM orders WHERE ${sql}`, params)

const { filter: mongoFilter, options } = toMongo(filter, { row: 'order', fields: columns, known: { minTotal: 100 } })
// await orders.find(mongoFilter, options)
```

## The contract

- A filter is an expression over one record variable (`row`). Every other variable must be in `known`, which is applied by [partial evaluation](./partial) before translating; a variable that is neither is rejected, so a misspelled `row` cannot silently read as null.
- The query selects **exactly** the records for which the filter evaluates to `true` in Bonsai. Records for which it would fail (for example calling `startsWith` on a null field) are excluded, as `try(filter, false)` would.
- SQL's three-valued `NULL` logic is converted to Bonsai's: `x != "a"` includes rows where `x` is `NULL`, comparisons with `NULL` are false, and `!` of a failing condition stays excluded. The returned SQL is true for the selected rows and may be `NULL` for the others, so negate a filter by translating `!(filter)`, not by wrapping the SQL in `NOT`.
- This is verified by differential tests that run random filters over random rows and compare the selected records with Bonsai's evaluation: in SQLite and PGlite on every run, and against Postgres 13 and 17 (through `pg` and `postgres`) and MongoDB 8.0 (through the official driver) with `bun run test:servers`.

## Columns

Every field a filter may read is declared, with its type. Anything else is rejected, so a user-written filter cannot probe columns you did not expose.

| Type | Postgres | SQLite | MongoDB |
|---|---|---|---|
| `text` | `text` or `varchar` (compared with the C collation) | `TEXT` | string |
| `number` | `float8`, or another numeric type (compared as `float8`) | `REAL`, or `INTEGER` within ±2^53 | double |
| `boolean` | `boolean` | `INTEGER` 0 or 1 | boolean |
| `timestamp` | `timestamptz` (not `timestamp`), millisecond precision | `INTEGER` epoch milliseconds | Date |

Use `{ type, name }` when the column (or MongoDB field path) differs from the key: `{ city: { type: 'text', name: 'ship_city' } }`. Nested keys (`'address.city'`) are dotted field paths in MongoDB. In SQL, a nested key is one column named after the whole key (`"address.city"`) unless `name` says otherwise.

The types are part of the contract, and results are exact only when the data keeps it:

- Number columns hold finite values, never `NaN` or infinities (Bonsai and the databases order them differently). Postgres `int8` and `numeric` are compared as `float8`, which matches Bonsai when your application reads them as JavaScript numbers.
- SQLite databases use UTF-8 (the default), tables are `STRICT`, text columns use the default `BINARY` collation (not `NOCASE`), and boolean columns hold only 0 or 1 (`CHECK (active IN (0, 1))`).
- MongoDB fields hold the declared scalar types, not arrays, and the objects on the way to a nested key exist. Numbers are doubles, 32-bit integers, or 64-bit integers within ±2^53; `Decimal128` values compare differently from Bonsai's doubles.

Invalid options (an unknown `dialect` or column type, a missing `row`, the row variable in `known`, an invalid column name) throw a `TypeError`.

## What translates

| Bonsai | Notes |
|---|---|
| `== != < <= > >=` | orderings on numbers and timestamps only |
| `&& \|\| !` | |
| `x == null`, `x != null` | |
| `x in [...]`, `x not in [...]` | with a known list |
| `order.flag` | boolean columns as conditions |
| `startsWith`, `endsWith`, `includes` | on text columns, with a known argument; `?.` calls read a null column as false |
| `"text" in order.name` | substring test |
| `order.name in text` | substring test, SQL only |
| `order.a == order.b`, `order.a < order.b` | comparing two columns, SQL only |
| `+ - *` | numbers, SQL only; a null operand or a non-finite result fails |

Anything else throws a `BonsaiTranslationError` (code `UNTRANSLATABLE`) with the span of the part that has no exact equivalent, including calls to host functions (which may replace a built-in of the same name). Deliberately not translated: ordering text (databases order by code point, Bonsai by UTF-16 unit), `toLowerCase`/`toUpperCase` (databases do not match JavaScript's Unicode case mapping), and division (databases differ on division by zero). Text with a lone surrogate is rejected, since drivers send it as U+FFFD.

A failing `&&` or `||` repeats part of its left side in the query, so deeply nested filters grow quickly; a translation larger than 1,000,000 characters of SQL or 100,000 MongoDB filter nodes is rejected, as is one needing more parameters than the database accepts (65,535 in Postgres, 32,766 in SQLite).

A filter that fails whatever the record is (say `limit / 0 > 1` with `limit` known) throws that `BonsaiRuntimeError` instead of translating to a query that selects nothing. The environment's runtime limits (`maxSteps`, `timeout`) apply to translating, not to the database: a filter that would exceed them per record in Bonsai (for example over a known list of millions of items) still matches rows in the database. Translating evaluates every known part of the filter up front, so a known part that evaluation would skip by short-circuiting still counts toward the limit.

## Indexes

Translated conditions are plain comparisons wherever Bonsai's semantics allow, so the database can use an index for equality, ranges, `in` lists, and `startsWith`:

- Postgres compares text with the C collation, so index text columns as `CREATE INDEX ON orders ((status COLLATE "C"))`. Number columns that are not `float8` are compared as `float8`: index them as `((total::float8))`.
- SQLite uses ordinary indexes.
- Negated conditions (`!=`, `not in`, `!`) are written to include `NULL`s, which indexes rarely help with, as in hand-written SQL.

## Options

| Option | Target | Meaning |
|---|---|---|
| `row` | both | The record variable |
| `columns` / `fields` | SQL / MongoDB | Declared columns |
| `dialect` | SQL | `'postgres'` or `'sqlite'` |
| `known` | both | Values for the other variables |
| `now` | both | The time `now()` returns |
| `paramOffset` | SQL | Parameters already used, so numbering (`$n`, `?n`) continues |

Parameters are always numbered (`$1` in Postgres, `?1` in SQLite) because a translated condition can repeat a sub-expression. In Postgres, a known list of text, numbers, or timestamps is one array parameter (`= ANY($1::text[])`), which drivers such as `pg`, `postgres`, and PGlite send as an array.

## Caveats

- Numbers: in Postgres, arithmetic that overflows or underflows a double raises a database error where Bonsai would exclude the record (or, for underflow, compute 0).
- Timestamps: known timestamps sent to Postgres must fall in the years 0001 to 9999.
- MongoDB: pass `options` to `find()` so string comparison is binary even if the collection has a case-insensitive default collation.
