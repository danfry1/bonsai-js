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

- A filter is an expression over one record variable (`row`), from a compiled program (`env.compile`); translate the original program with `known` rather than a partial-evaluation residual. Every other variable must be in `known`, which is applied by [partial evaluation](./partial) before translating; a variable that is neither is rejected, so a misspelled `row` cannot silently read as null; the error names the closest row, known value, or declared column. With `validateContext`, the known values are validated as evaluation validates them (`INVALID_CONTEXT`).
- A path the filter reads must be present in the known value it reads from: `order.total > limits.max` with `known: { limits: { min: 1 } }` is rejected (`limits.max is missing from the known values`) instead of reading the missing field as null. Pass `null` for a field with no value, or guard the read in the filter: `limits.max ?? 5`, a `limits.max == null` test, or `has(limits.max) && order.total > limits.max`. A guard covers only the read it guards (or the reads its `&&`, `||`, or `?:` branch reaches), and a `let` name is followed to the path it stands for. When the program's environment declares a known variable's type, a known object read whole (spread, `keys()`/`values()`/`entries()`, `==`, passed to a function) must have every field its type declares: `order.total in limits.values()` with `{ min: 1 }` for a declared `{ min, max }` is rejected.
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
| `duration` | a numeric type holding whole milliseconds (`bigint`), compared as `float8` | `INTEGER` milliseconds | number of milliseconds |

Use `{ type, name }` when the column (or MongoDB field path) differs from the key: `{ city: { type: 'text', name: 'ship_city' } }`. Nested keys (`'address.city'`) are dotted field paths in MongoDB. In SQL, a nested key is one column named after the whole key (`"address.city"`) unless `name` says otherwise. A `name` is always one quoted column name, never `table.column`: to filter a join, select the joined columns under plain names in a subquery or CTE (`WITH o AS (SELECT orders.id, customers.region FROM orders JOIN customers ON ...) SELECT * FROM o WHERE <sql>`).

The types are part of the contract, and results are exact only when the data keeps it. When the program's environment declares a type for a field, the column must fit it, or `toSQL` and `toMongo` throw a `TypeError` naming the field: a list field, for example, is not a `text` column (`"a" in order.tags` on a `text` column would be a substring test). In an open environment nothing is declared, so declare each column with the type the field really has.

- Number columns hold finite values, never `NaN` or infinities (Bonsai and the databases order them differently). Postgres `int8` and `numeric` are compared as `float8`, which matches Bonsai when your application reads them as JavaScript numbers.
- SQLite databases use UTF-8 (the default), tables are `STRICT`, text columns use the default `BINARY` collation (not `NOCASE`), and boolean columns hold only 0 or 1 (`CHECK (active IN (0, 1))`).
- MongoDB fields hold the declared scalar types, not arrays, and the objects on the way to a nested key exist. Numbers are doubles, 32-bit integers, or 64-bit integers within ±2^53; `Decimal128` values compare differently from Bonsai's doubles.

Invalid options (an unknown option key, an unknown `dialect` or column type, a missing `row`, the row variable in `known`, an invalid column name, a `paramOffset` that is not a number) throw a `TypeError`, as does translating something other than a compiled program; a `paramOffset` that is negative or not an integer throws a `RangeError`. `maxSteps`, `timeout`, `signal`, and `callHostFunctions` are validated as `partial()` validates them.

## What translates

| Bonsai | Notes |
|---|---|
| `== != < <= > >=` | orderings on numbers, timestamps, and durations only |
| `&& \|\| !` | |
| `x == null`, `x != null` | |
| `x in [...]`, `x not in [...]` | with a known list |
| `order.flag` | boolean columns as conditions |
| `startsWith`, `endsWith`, `includes` | on text columns, with a known argument; `?.` calls read a null column as false |
| `order.email?.endsWith(x) ?? false`, `order.flag ?? true` | `??` after a `?.` text call or a boolean column, with any translatable condition on the right |
| `order.email?.endsWith(x) == true`, `!= false`, `== null` | a text call compared with a boolean or `null` |
| `(order.email ?? "").endsWith(x)` | a text call on a column with a known text default |
| `(order.total ?? 0) >= 500`, `(order.code ?? "") == x`, `(order.qty ?? 1) in [...]` | a column with a known default of its type, compared with a known value or list; against another column or in arithmetic, SQL only |
| `order.wait > minutes(5)`, `order.wait in [...]` | duration columns, compared with known durations |
| `inMilliseconds(order.wait) > 100`, `order.wait?.inMilliseconds()` | the milliseconds of a duration column; without `?.` (a field the environment does not declare optional) a null duration fails, which only SQL can express; the checker asks for `?.` on an optional field |
| `"text" in order.name` | substring test |
| `order.name in text` | substring test, SQL only |
| `order.a == order.b`, `order.a < order.b` | comparing two columns, SQL only |
| `+ - *`, unary `-` | numbers, SQL only; a null operand or a non-finite result fails, so the record is excluded (in Postgres, a result out of the double range fails the query instead; see Caveats) |
| `now() - order.placed < days(14)`, `order.placed + days(3) > now()` | relative dates: a timestamp column shifted by a known duration, or its distance from a known time, compared with a known timestamp or duration (either way round) |
| `order.placed != null && now() - order.placed < days(14)` | relative dates on an optional timestamp column (the checker rejects the subtraction without the test; a `??` default does not translate) |

A text function on a nullable column has three exact forms. With a declared environment the checker rejects `order.email.endsWith(x)` on an optional field and suggests `?.` or `??`; all of these translate:

<!-- context: { order: { email: null } } -->
```bonsai
order.email != null && order.email.endsWith("@acme.com") // => false
order.email?.endsWith("@acme.com") ?? false // => false
(order.email ?? "").endsWith("@acme.com") // => false
```

Relative dates need `now`, from the `now` option (or a known timestamp in its place); the comparison is rewritten as the column against a fixed instant, so it can use an index. A null timestamp fails the subtraction, so the record is excluded from the filter and from its negation, as in Bonsai, and so is a record that a shift would push past the range of dates. Durations are whole milliseconds, like timestamps, so the bound is exact.

Anything else throws a `BonsaiTranslationError` (code `UNTRANSLATABLE`) with the span of the part that has no exact equivalent, including calls to host functions (which may replace a built-in of the same name). The message says why: `now()` without the `now` option, calendar functions such as `hour()` or `startOfDay()` (they follow time zone rules databases do not apply as Bonsai does; compare the timestamp with known bounds instead), `let`, `?:` (write the condition with `&&` and `||`), `try()`, computed reads, and other operators each name themselves. Deliberately not translated: ordering text (databases order by code point, Bonsai by UTF-16 unit), the `.length` of text (databases count characters, Bonsai UTF-16 units), `toLowerCase`/`toUpperCase` (databases do not match JavaScript's Unicode case mapping), and division (databases differ on division by zero). Text with a lone surrogate is rejected, since drivers send it as U+FFFD.

A failing `&&` or `||` repeats part of its left side in the query, so deeply nested filters grow quickly; a translation larger than 1,000,000 characters of SQL or 100,000 MongoDB filter nodes is rejected, as is one needing more parameters than the database accepts (65,535 in Postgres, 32,766 in SQLite), more than 1,000,000 entries in Postgres array parameters, or more than 16,000,000 characters of SQL parameter text. In a MongoDB filter, every 160 characters of text count as one node toward its limit, so the filter stays near the 16 MB a MongoDB document can hold. In SQL, a known value is sent once however often the filter uses it: a parameter is reused wherever the same value (with the same type) appears.

A filter that fails whatever the record is (say `limit / 0 > 1` with `limit` known) throws that `BonsaiRuntimeError` instead of translating to a query that selects nothing. When the failing part comes after a read of the record (`order.total > 1e308 * limit`), that read could fail first, so the part is left untranslated and reported as `UNTRANSLATABLE`. The `maxSteps`, `timeout`, and `signal` options of a translation apply to translating, not to the database. They are one budget for the whole translation: checking the known values, the partial evaluation it runs, and writing the query, so a filter that uses a large known list many times stops with `STEP_LIMIT`, `TIMEOUT`, or `ABORTED` instead of running long. Without `maxSteps`, the partial evaluation uses the environment's own limit and the rest of the work is bounded by 1,000,000 steps; without `timeout`, the partial evaluation uses the environment's timeout. A filter that would exceed them per record in Bonsai (for example over a known list of millions of items) still matches rows in the database. Translating evaluates every known part of the filter up front, so a known part that evaluation would skip by short-circuiting still counts toward the limit.

## Host functions

A call to a host function has no database equivalent, so it does not translate by default. With `callHostFunctions: true`, sync host functions whose inputs are all known are called before translating, as `partial()` calls them, and their results become part of the query. A call that reads the row, an `async` function, and a `call: true` function (which reads the evaluation context) still do not translate.

This is how an authorization policy lists the records a user may see: the policy is written once over the subject and the record, the subject is known, and its checks run once instead of per row.

```ts
import { bonsai, fn, t } from 'bonsai-js'
import { toSQL } from 'bonsai-js/query'

const env = bonsai({
  variables: {
    subject: t.object({ id: t.string() }),
    order: t.object({ owner: t.string(), total: t.number() }),
  },
  functions: {
    memberOf: fn({
      params: [t.string(), t.string()],
      returns: t.boolean(),
      run: (id, group) => id === 'u1' && group === 'auditors',
    }),
  },
})
const canView = env.compile('subject.id.memberOf("auditors") || order.owner == subject.id')
const options = { row: 'order', columns: { owner: 'text' }, dialect: 'sqlite', callHostFunctions: true } as const

toSQL(canView, { ...options, known: { subject: { id: 'u1' } } }).sql // => "1"
toSQL(canView, { ...options, known: { subject: { id: 'u2' } } }).sql // => "(`owner` = ?1)"
```

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
| `maxSteps`, `timeout`, `signal` | both | One budget and cancellation for the whole translation, including the partial evaluation it runs; validated as for `partial()` |
| `callHostFunctions` | both | Call sync host functions whose inputs are all known before translating, as for `partial()`. Default `false` |
| `paramOffset` | SQL | Parameters already used, so numbering (`$n`, `?n`) continues |

Parameters are always numbered (`$1` in Postgres, `?1` in SQLite) because a translated condition can repeat a sub-expression. In Postgres, a known list of text, numbers, or timestamps is one array parameter (`= ANY($1::text[])`), which drivers such as `pg`, `postgres`, and PGlite send as an array. `params` is a new array on every call, typed so drivers take it as is: numbers and text for SQLite (`statement.all(...params)` in `node:sqlite`), plus booleans and arrays for Postgres (`db.query(sql, params)`).

## Caveats

- Numbers: in Postgres, when a record's arithmetic overflows a double (`order.total * 2` with a total of `1e308`), or a nonzero product rounds to zero (`order.qty * order.qty` with a quantity of `1e-200`), the whole query fails with the error `value out of range: overflow` (or `underflow`). It fails loudly and never returns a different set of rows. Bonsai and SQLite exclude a record whose arithmetic overflows, and compute 0 for a product that rounds to zero. To avoid the failure, keep stored numbers within the range the filters' arithmetic can take (a `CHECK` constraint such as `CHECK (abs(total) < 1e150)` does this), or exclude large values with a comparison in the filter (`order.total < 1e300 && order.total * 2 > limit`). Postgres does not promise the order in which it checks the parts of a condition, so only the first way is guaranteed; the second avoids the error in practice. SQLite computes infinities and zeros instead of raising, so there a filter never fails on its values.
- Timestamps: known timestamps sent to Postgres must fall in the years 0001 to 9999.
- MongoDB: pass `options` to `find()` so string comparison is binary even if the collection has a case-insensitive default collation.
