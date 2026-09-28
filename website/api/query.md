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

- A filter is an expression over one record variable (`row`). Every other variable comes from `known`, which is applied by [partial evaluation](./partial) before translating.
- The query selects **exactly** the records for which the filter evaluates to `true` in Bonsai. Records for which it would fail (for example calling `startsWith` on a null field) are excluded, as `try(filter, false)` would.
- SQL's three-valued `NULL` logic is converted to Bonsai's: `x != "a"` includes rows where `x` is `NULL`, comparisons with `NULL` are false, and `!` of a failing condition stays excluded.
- This is verified by differential tests that run random filters over random rows in real SQLite, real Postgres (PGlite), and a MongoDB query engine, and compare the selected records with Bonsai's evaluation.

## Columns

Every field a filter may read is declared, with its type. Anything else is rejected, so a user-written filter cannot probe columns you did not expose.

| Type | Postgres | SQLite | MongoDB |
|---|---|---|---|
| `text` | `text` (compared with the C collation) | `TEXT` | string |
| `number` | any numeric type (compared as `float8`), finite | `REAL` or `INTEGER` | double, finite |
| `boolean` | `boolean` | `INTEGER` 0/1 | boolean |
| `timestamp` | `timestamptz`, millisecond precision | `INTEGER` epoch milliseconds | Date |

Use `{ type, name }` when the column (or MongoDB field path) differs from the key: `{ city: { type: 'text', name: 'ship_city' } }`. Nested keys (`'address.city'`) are dotted field paths in MongoDB. SQLite tables should be `STRICT` so columns cannot hold other types, and MongoDB fields must hold the declared scalar types, not arrays. Number columns must not hold `NaN` or infinities (Bonsai and the databases order them differently). The objects on the way to a nested key must exist.

## What translates

| Bonsai | Notes |
|---|---|
| `== != < <= > >=` | orderings on numbers and timestamps only |
| `&& \|\| !` | |
| `x == null`, `x != null` | |
| `x in [...]`, `x not in [...]` | with a known list |
| `order.flag` | boolean columns as conditions |
| `startsWith`, `endsWith`, `includes` | on text columns, with a known argument; `?.` calls read a null column as false |
| `"text" in order.name`, `order.name in text` | substring tests |
| `+ - *` | numbers, SQL only; a null operand or a non-finite result fails |

Anything else throws a `BonsaiTranslationError` (code `UNTRANSLATABLE`) with the span of the part that has no exact equivalent. Deliberately not translated: ordering text (databases order by code point, Bonsai by UTF-16 unit), `toLowerCase`/`toUpperCase` (databases do not match JavaScript's Unicode case mapping), and division (databases differ on division by zero). Text with a lone surrogate is rejected, since drivers send it as U+FFFD.

A failing `&&` or `||` repeats part of its left side in the query, so deeply nested filters grow quickly; a translation larger than 1,000,000 characters of SQL or 100,000 MongoDB filter nodes is rejected, as is one needing more parameters than the database accepts (65,535 in Postgres, 32,766 in SQLite).

## Options

| Option | Target | Meaning |
|---|---|---|
| `row` | both | The record variable |
| `columns` / `fields` | SQL / MongoDB | Declared columns |
| `dialect` | SQL | `'postgres'` or `'sqlite'` |
| `known` | both | Values for the other variables |
| `now` | both | The time `now()` returns |
| `paramOffset` | SQL | Parameters already used, so numbering (`$n`, `?n`) continues |

Parameters are always numbered (`$1` in Postgres, `?1` in SQLite) because a translated condition can repeat a sub-expression.

## Caveats

- Numbers: in Postgres, arithmetic that overflows or underflows a double raises a database error where Bonsai would exclude the record (or, for underflow, compute 0).
- Timestamps: known timestamps sent to Postgres must fall in the years 0001 to 9999.
- MongoDB: pass `options` to `find()` so string comparison is binary even if the collection has a case-insensitive default collation.
