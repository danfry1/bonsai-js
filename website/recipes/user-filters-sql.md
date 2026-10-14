# User-Defined Filters in SQL

This recipe is for apps where end users save their own filters over a table, such as "paid orders over the team's minimum in the last 30 days", and expect them to run against the full dataset. It builds the path from text a user typed to a parameterized `WHERE` clause (SQLite or Postgres) or a MongoDB filter that selects exactly the records Bonsai would accept, and back to a helpful message when part of a filter has no database equivalent.

## Declare the row and the known values

A filter reads one record variable (here `order`) and, optionally, values that are the same for every row, such as the tenant's settings. Declare both. The columns map each field the filter may read to its database type; a field you do not list cannot be queried.

```ts
import { bonsai, t } from 'bonsai-js'

const env = bonsai({
  variables: {
    order: t.object({
      status: t.enum('open', 'paid', 'refunded'),
      total: t.number(),
      email: t.optional(t.string()),
      placed: t.timestamp(),
    }),
    tenant: t.object({ minTotal: t.number() }),
  },
  limits: { maxSourceLength: 2_000 },
})

const columns = { status: 'text', total: 'number', email: 'text', placed: 'timestamp' } as const
```

## Check the filter when it is saved

Users make the same mistakes in filters as anywhere else. `check()` catches misspelled fields and type errors before the filter is saved, with offsets to underline them; `expect: t.boolean()` rejects a filter that is not a condition.

<!-- continue -->
```ts
const typo = env.check('order.totl > 100', { expect: t.boolean() })
typo.diagnostics.map((d) => d.message) // => ["Property \"totl\" does not exist on order; did you mean \"total\"?"]

const source = 'order.status == "paid" && order.total >= tenant.minTotal && now() - order.placed < days(30)'
env.check(source, { expect: t.boolean() }).ok // => true
```

## Translate to SQL

`toSQL` takes the compiled filter, the row variable, the columns, a dialect, and the values that are known before the query runs. Known values are folded in by [partial evaluation](/api/partial) and sent as parameters, never spliced into the SQL. `now` fixes the time `now()` returns, so a relative date becomes a comparison with a fixed instant that can use an index.

<!-- continue -->
```ts
import { toMongo, toSQL } from 'bonsai-js/query'

const filter = env.compile(source, { expect: t.boolean() })
const tenant = { minTotal: 100 }
const now = new Date('2026-10-14T12:00:00Z')

const sqlite = toSQL(filter, { row: 'order', columns, dialect: 'sqlite', known: { tenant }, now })
sqlite.sql // => '(((`status` = ?1) AND (`total` >= ?2)) AND ((`placed` IS NOT NULL) AND (`placed` > ?3)))'
sqlite.params // => ["paid", 100, 1789387200000]
```

In SQLite a timestamp column holds epoch milliseconds, so the 30-day bound is a number. Run the query with your driver; with `node:sqlite`:

<!-- no-run -->
```ts
const rows = db.prepare(`SELECT * FROM orders WHERE ${sqlite.sql}`).all(...sqlite.params)
```

`params` is typed so `node:sqlite` and the Postgres drivers take it without a cast.

## Combine with your own conditions

A filter usually runs inside a query that has its own conditions, such as the tenant's id. Put yours first and pass `paramOffset` with the number of parameters they use, so the filter's parameters are numbered after them:

<!-- continue -->
```ts
const postgres = toSQL(filter, { row: 'order', columns, dialect: 'postgres', known: { tenant }, now, paramOffset: 1 })
postgres.params // => ["paid", 100, "2026-09-14T12:00:00.000Z"]
postgres.sql.includes('$1') // => false
postgres.sql.includes('$4::timestamptz') // => true

const tenantId = 'acme'
const query = `SELECT * FROM orders WHERE tenant_id = $1 AND ${postgres.sql}`
const values = [tenantId, ...postgres.params]
values.length // => 4
```

Always join the translated condition with `AND` inside parentheses as returned; to exclude what a filter selects, translate `!(filter)` instead of wrapping the SQL in `NOT`, since SQL's `NULL` logic differs from Bonsai's (see [The contract](/api/query#the-contract)).

## Translate to MongoDB

`toMongo` takes the same program and known values, with `fields` in place of `columns`. Pass the returned `options` to `find()`, so text compares exactly even on a collection with a case-insensitive default collation.

<!-- continue -->
```ts
const mongo = toMongo(filter, { row: 'order', fields: columns, known: { tenant }, now })
mongo.filter // => { $and: [{ $and: [{ status: { $eq: "paid" } }, { total: { $gte: 100 } }] }, { $and: [{ placed: { $ne: null } }, { placed: { $gt: 2026-09-14T12:00:00.000Z } }] }] }
mongo.options // => { collation: { locale: "simple" } }
```

<!-- no-run -->
```ts
const docs = await db.collection('orders').find(mongo.filter, mongo.options).toArray()
```

## When part of a filter does not translate

Some expressions have no exact database equivalent: case conversion, division, lambdas, calendar functions in a time zone. Translation throws a `BonsaiTranslationError` (code `UNTRANSLATABLE`) whose `span` covers the part, and whose message says why and, where there is one, what to write instead. Show both to the user, the same way as a check error:

<!-- continue -->
```ts
import { BonsaiTranslationError } from 'bonsai-js'

function translate(text: string) {
  const program = env.compile(text, { expect: t.boolean() })
  try {
    return { ok: true as const, ...toSQL(program, { row: 'order', columns, dialect: 'sqlite', known: { tenant }, now }) }
  } catch (error) {
    if (!(error instanceof BonsaiTranslationError) || error.span === undefined) throw error
    return { ok: false as const, part: text.slice(error.span.start, error.span.end), message: error.message }
  }
}

const refused = translate('order.email?.toLowerCase() == "ada@example.com"')
refused.ok ? undefined : refused.part // => "order.email?.toLowerCase()"
refused.ok ? undefined : refused.message // => "toLowerCase() is not translated, since databases do not change case as JavaScript does"
translate('order.email?.endsWith("@example.com") ?? false').ok // => true
```

[Not translated, and why](/api/query#not-translated-and-why) lists every case with its alternative. A filter can still be evaluated in memory with `filter.evaluateSync(...)` when it cannot be translated, so an app can fall back to filtering a bounded set of rows.

Known values must cover every path the filter reads outside the row: a filter that reads `tenant.maxTotal` when `known` has no such field is refused rather than reading it as null.

## What the database must hold

The query selects exactly what Bonsai selects when each record keeps the declared types. Translation does not validate records, so let the database enforce them:

- a field declared without `t.optional` is `NOT NULL`;
- an enum is a `CHECK (status IN ('open', 'paid', 'refunded'))`;
- in SQLite, tables are `STRICT`, timestamps are `INTEGER` epoch milliseconds, and booleans hold only 0 or 1;
- in Postgres, timestamps are `timestamptz` and text columns are indexed with `COLLATE "C"` to use an index.

[Columns](/api/query#columns) has the full mapping for each type and database, and [Indexes](/api/query#indexes) how to index translated conditions.
