<p align="center">
  <img src="https://raw.githubusercontent.com/danfry1/bonsai-js/main/website/public/logo.png" alt="bonsai-js" width="120" />
</p>

<h1 align="center">bonsai-js</h1>

[![npm version](https://img.shields.io/npm/v/bonsai-js)](https://www.npmjs.com/package/bonsai-js)
[![npm downloads](https://img.shields.io/npm/dm/bonsai-js)](https://www.npmjs.com/package/bonsai-js)
[![CI](https://github.com/danfry1/bonsai-js/actions/workflows/ci.yml/badge.svg)](https://github.com/danfry1/bonsai-js/actions/workflows/ci.yml)
[![CodeQL](https://github.com/danfry1/bonsai-js/actions/workflows/codeql.yml/badge.svg)](https://github.com/danfry1/bonsai-js/actions/workflows/codeql.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/bonsai-js)](https://bundlephobia.com/package/bonsai-js)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/bonsai-js)
[![node](https://img.shields.io/node/v/bonsai-js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-typed-blue)](https://www.typescriptlang.org)
[![license](https://img.shields.io/npm/l/bonsai-js)](https://github.com/danfry1/bonsai-js/blob/main/LICENSE)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12173/badge)](https://www.bestpractices.dev/projects/12173)

A small, safe, typed expression language for rules, filters, formulas, and templates that people other than your developers write. Zero dependencies, runs in any modern JavaScript runtime, and never executes JavaScript.

```ts
import { bonsai, t } from 'bonsai-js'

const env = bonsai({
  variables: {
    user: t.object({ age: t.number(), plan: t.enum('free', 'pro'), tags: t.list(t.string()) }),
    orders: t.list(t.object({ total: t.number(), paid: t.boolean(), created: t.timestamp() })),
  },
})

const rule = env.compile(
  'user.plan == "pro" && orders.filter(.paid && now() - .created < days(30)).map(.total).sum() > 100',
  { expect: t.boolean() },
)

rule.evaluateSync(context) // boolean, checked before it ever runs
```

## Install

```bash
npm install bonsai-js
```

## Why Bonsai

- **Familiar.** JavaScript syntax and JavaScript names: `a.b`, `?.`, `??`, templates, `filter`, `map`, `includes`, `toUpperCase`. Every function also works as a method, so `sum(xs)` and `xs.sum()` are the same call.
- **Checked.** Declare your data once with `t` and get errors for typos, wrong types, and possible nulls before an expression is saved, with "did you mean" suggestions and exact source ranges. TypeScript types for the context and result are inferred from the same declaration.
- **Safe by construction.** No prototype access, no globals, no calling functions found in data, no conversion hooks, no mutation. Every evaluation terminates and is bounded by a step budget, size limits, an optional timeout, and an `AbortSignal`.
- **Fast.** Expressions compile to closures once (no `eval`, CSP-safe). A typical rule evaluates about 10 million times per second on Node, 1.3x to 2x faster than `@marcbachmann/cel-js` on the same workloads (`bun run bench` reproduces this with `benchmarks/vs-cel.bench.ts`).
- **Editor-ready.** A language service provides completions (including methods applicable to each type), hover, and diagnostics without evaluating anything.

## The language in one screen

```js
user.age >= 18 && user.country in ["GB", "IE"]         // logic and membership
user.nickname ?? user.firstName                         // null defaults
user.address?.city                                      // safe navigation
`Hello ${user.name}, you have ${cart.items.length} items` // templates
items.filter(.price > 10).map(.name)                    // "." is the current item
items.map(.price * .qty).sum()                          // every function is also a method
orders.filter(o => o.lines.some(.sku == o.promo))       // named lambdas for nesting
let total = items.map(.price).sum(); total > 100 ? total * 0.9 : total
has(user.email)                                         // present, even if null
try(stats.visits / stats.days, 0)                       // recover from evaluation errors
now() - user.createdAt > days(30)                       // timestamps and durations
startOfDay(order.placedAt, "Europe/Berlin")             // calendar math in time zones
// comments work too
```

The full reference is [docs/language.md](./docs/language.md). The rules that matter most:

- There is one absent value, `null`. Missing properties and host `undefined` read as `null`, so `x == null` means "missing or null".
- `==` compares by value (lists and maps deeply). There is no type coercion: `1 == "1"` is `false` and `"a" + 1` is an error.
- Comparisons with `null` are `false`, so `users.filter(.age >= 18)` skips users without an age instead of failing.
- `&&`, `||`, `!` and `?:` take booleans (`null` counts as false). Use `??` for defaults.
- Arithmetic that would produce `NaN` or `Infinity` is an error, including division by zero.

## Evaluating

```ts
const env = bonsai()

env.evaluateSync('price * qty', { price: 3, qty: 4 }) // 12, compiled once and cached
await env.evaluate('price * qty', { price: 3, qty: 4 }) // async, needed for async functions

const program = env.compile('items.filter(.active).length')
program.evaluateSync({ items })
program.evaluateSync({ items }, { timeout: 50, maxSteps: 10_000, signal })
```

Without declared variables an environment is open: unknown identifiers read the context and are typed `any`. With `variables`, the checker knows their types; add `strict: true` to reject undeclared variables too.

## Checking

```ts
const env = bonsai({ variables: { user: t.object({ age: t.number(), nick: t.optional(t.string()) }) }, strict: true })

env.check('user.agee > 18')
// { ok: false, diagnostics: [{ code: 'UNKNOWN_PROPERTY', message: 'Property "agee" does not exist on { age: number, nick: string | null }; did you mean "age"?', start: 5, end: 14, severity: 'error' }] }

env.check('user.nick.toUpperCase()')
// NULLABLE_RECEIVER: The value before .toUpperCase() may be null; use ?.toUpperCase() or ?? to supply a default

env.compile('user.age + 1', { expect: t.boolean() }) // throws BonsaiCheckError: Expected ... boolean ...
```

Types: `t.string()`, `t.number()`, `t.boolean()`, `t.null()`, `t.timestamp()`, `t.duration()`, `t.literal(v)`, `t.enum(...values)`, `t.list(T)`, `t.object({...})`, `t.record(V)`, `t.optional(T)`, `t.union(...)`, `t.any()`. `Infer<typeof type>` gives the TypeScript type.

## Host functions

```ts
import { bonsai, fn, t } from 'bonsai-js'

const env = bonsai({
  functions: {
    hasRole: fn({ params: [t.string()], returns: t.boolean(), context: true, run: (ctx, role) => roles(ctx).includes(role) }),
    fxRate: fn({ params: [t.string()], returns: t.number(), async: true, run: (currency) => rates.get(currency) }),
  },
})

await env.evaluate('hasRole("admin") || orders.map(fxRate(.currency) * .amount).sum() < 1000', ctx)
```

- Parameter and result types are declared with `t`; `run`'s argument types are inferred from them. Arguments are validated before your code runs and results are checked against the declared type.
- `async: true` functions are awaited by `evaluate()`. `evaluateSync()` rejects expressions that call them before any host code runs.
- A host function with the same name as a built-in replaces it for that environment, so new built-ins in future releases never change the meaning of your expressions.
- `withContext<AppContext>()` returns a version of `fn` whose `run` receives the typed context first: `withContext<Ctx>()({ params: [], returns: t.string(), run: (ctx) => ctx.tenant.id })`.
- Optional parameters (after `required`) arrive as `null` when omitted, so declare them with `t.optional(...)`.
- Bundle functions into a `Library` (`{ name, functions }`) and pass `libraries: [a, b]`; a name defined twice is an error. `env.extend({...})` derives a new environment.

Context data is not validated against the declared types by default (it is your data, and validation costs time proportional to it). Pass `validateContext: true` to check it before every evaluation; a mismatch fails with `INVALID_CONTEXT` and the exact path, e.g. `user.created should be timestamp, got string "2026-01-01"`.

## Built-in functions

All callable as `f(x, ...)` or `x.f(...)`.

| Area | Functions |
|---|---|
| Text | `toUpperCase` `toLowerCase` `trim` `trimStart` `trimEnd` `startsWith` `endsWith` `includes` `indexOf` `lastIndexOf` `slice` `split` `replace` `replaceAll` `padStart` `padEnd` `repeat` `at` `matches` `toString` `toNumber` |
| Lists | `map` `filter` `find` `findIndex` `some` `every` `none` `count` `flatMap` `reduce` `sort` `sortBy` `groupBy` `reverse` `unique` `flat` `first` `last` `join` `slice` `at` `includes` `indexOf` `isEmpty` |
| Numbers | `round` `floor` `ceil` `trunc` `abs` `sqrt` `clamp` `toFixed` `formatNumber` `formatCurrency` `min` `max` `sum` `avg` |
| Maps | `keys` `values` `entries` `type` |
| Time | `now` `timestamp` `weeks` `days` `hours` `minutes` `seconds` `milliseconds` `inDays` `inHours` `inMinutes` `inSeconds` `inMilliseconds` `year` `month` `day` `hour` `minute` `second` `dayOfWeek` `startOfDay` `startOfMonth` `startOfYear` `addDays` `addMonths` `addYears` `formatDate` |

`matches(text, pattern)` uses RE2 syntax and runs in linear time, so a user-written pattern cannot hang evaluation; backreferences and lookaround are rejected. `formatDate` understands `yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h a mm m ss s SSS` and rejects unknown letters; constant patterns are checked when the expression is compiled.

`env.listFunctions()` returns every signature and description, for documentation or tooling.

## Explaining results

`explain()` evaluates and records the value of every sub-expression, so you can show why a rule passed or failed: in a support tool, an audit log, or next to the rule in an editor.

```ts
const rule = env.compile('user.age >= 18 && user.plan == "pro"')
const explanation = rule.explain({ user: { age: 25, plan: 'free' } })

explanation.ok     // true
explanation.value  // false
console.log(String(explanation))
// user.age >= 18 && user.plan == "pro"  → false
// ├─ user.age >= 18  → true
// │  └─ user.age  → 25
// └─ user.plan == "pro"  → false
//    └─ user.plan  → "free"
```

`explanation.reasons()` returns just the conditions that decided the result. By default `&&` stops at the first false condition; pass `{ exhaustive: true }` to evaluate the rest too, so a "why was this rejected" screen can list every reason:

```ts
rule.explain(context, { exhaustive: true }).reasons().map((r) => r.text)
// ['user.age >= 18', 'user.plan == "pro"']
```

`explanation.trace` is the full tree: each node has an `id`, `kind`, `text`, `start`/`end` source offsets, `value` or `error`, and `children`. Parts skipped by short-circuiting are marked `evaluated: false`, and lambdas record each item they ran on under `iterations` (up to `maxIterations`, default 20; `maxTraceNodes` caps the whole trace). `JSON.stringify(explanation)` gives a bounded, cycle-safe snapshot that never runs getters. Evaluation errors are returned (`ok: false`, `error`) with the failing node marked, never thrown. Use `explainAsync()` for expressions that call async host functions. Explaining uses a separately compiled program, so ordinary evaluation is not slowed down.

## Partial evaluation

`partial()` evaluates what it can from the data you have and returns either the answer or a simplified expression that needs only the missing data:

```ts
const rule = env.compile('user.plan == "pro" && order.total > limits.minTotal')

rule.partial({ user: { plan: 'free' }, limits })  // { status: 'value', value: false }

const result = rule.partial({ user: { plan: 'pro' }, limits: { minTotal: 100 } })
result.source                        // 'order.total > 100'
result.dependsOn                     // ['order.total']
result.evaluateSync({ order })       // same answer as rule.evaluateSync({ user, limits, order })
```

Use it to decide early (can this user ever pass?), to precompute the per-user part of a rule once and evaluate the rest per request, or to push a filter down to where the data lives. Unknowns default to the variables missing from what you pass; `unknown: ['order', 'user.riskScore']` names them explicitly (unknown wins over a value you did pass).

The result is exact: evaluating the residual with the full data gives the same value or error as evaluating the original. Short primitives are written into the residual; other known values (lists, maps, dates) are kept in `result.bindings` and referenced by name, and `evaluateSync`/`evaluate` on the result supply them. `now()` and host functions stay in the residual unless you pass `now` or `callHostFunctions: true`. When the known data already decides that evaluation fails, the result is `{ status: 'error', error }`.

## Filters in your database

`bonsai-js/query` turns a filter written in Bonsai into a SQL `WHERE` clause (Postgres, SQLite) or a MongoDB filter, so user-defined filters run where the data lives:

```ts
import { toMongo, toSQL } from 'bonsai-js/query'

const filter = env.compile('order.status == "paid" && order.total > minTotal')
const columns = { status: 'text', total: 'number' } as const

toSQL(filter, { row: 'order', columns, dialect: 'postgres', known: { minTotal: 100 } })
// { sql: '(COALESCE(("status" COLLATE "C") = ($1::text COLLATE "C"), FALSE) AND COALESCE("total"::float8 > $2::float8, FALSE))',
//   params: ['paid', 100] }

toMongo(filter, { row: 'order', fields: columns, known: { minTotal: 100 } })
// { filter: { $and: [{ status: { $eq: 'paid' } }, { total: { $gt: 100 } }] }, options: { collation: { locale: 'simple' } } }
```

The query selects exactly the records for which the filter evaluates to `true` in Bonsai, including null handling (SQL's three-valued logic is made two-valued) and records where the filter would fail (they are excluded). Only declared columns can be queried, values are always parameters, and anything without an exact database equivalent throws a `BonsaiTranslationError` pointing at it. This is checked by differential tests against real SQLite, Postgres, and a MongoDB query engine.

## Syntax trees and visual editors

`env.parse(source)` returns a JSON syntax tree with source offsets on every node, and `print(tree)` turns a tree back into source. Printing is deterministic and round-trips: `print(env.parse(print(tree)))` is the same text, with the fewest parentheses that keep the meaning. That is what a visual rule builder needs: parse, edit the tree, print, save.

```ts
import { bonsai, print } from 'bonsai-js'

const tree = bonsai().parse('trim(name).toUpperCase()')
print(tree)                        // 'trim(name).toUpperCase()'
print(tree, { calls: 'method' })   // 'name.trim().toUpperCase()'
print(tree, { calls: 'function' }) // 'toUpperCase(trim(name))'
```

`f(x)` and `x.f()` produce the same call node, so a builder can show any chain as a list of steps and choose how to print it. `env.listFunctions()` provides the palette (names, signatures, descriptions), and the language service provides the types at any position for dropdowns. Comments are not part of the tree.

## Editor support

```ts
import { createLanguageService } from 'bonsai-js/service'

const service = createLanguageService(env)
service.complete('orders.filter(.', 15) // id, total, paid, ... then methods such as map, sum
service.hover('orders.map(.total)', 2)  // { detail: '{ total: number, ... }[]' }
service.diagnostics('user.agee')        // same diagnostics as env.check
```

The service never evaluates expressions or calls host functions.

## Errors

Every error is a `BonsaiError` with a stable `code`, the `source`, a `span`, a 1-based `position`, and a `formatted` message with a code frame.

| Class | Codes |
|---|---|
| `BonsaiSyntaxError` | `SYNTAX` |
| `BonsaiCheckError` | `CHECK` (see `.diagnostics`) |
| `BonsaiLimitError` | `SOURCE_TOO_LONG` `TOO_DEEP` `TOO_MANY_NODES` `STEP_LIMIT` `STRING_LIMIT` `LIST_LIMIT` `TIMEOUT` `ABORTED` |
| `BonsaiRuntimeError` | `TYPE_ERROR` `NO_OVERLOAD` `NULL_RECEIVER` `DIVISION_BY_ZERO` `NON_FINITE` `BLOCKED_PROPERTY` `INVALID_ARGUMENT` `INVALID_CONTEXT` `ASYNC_IN_SYNC` `HOST_ERROR` |

## Limits

All limits are on by default; `limits` changes the budget. `0` disables `maxSteps` and `timeout`; the other limits must be at least 1.

| Limit | Default | Bounds |
|---|---|---|
| `maxSourceLength` | 100,000 | expression length |
| `maxDepth` | 128 | syntax tree depth |
| `maxNodes` | 20,000 | syntax tree size |
| `maxSteps` | 1,000,000 | work per evaluation (lambda calls and every element touched) |
| `maxStringLength` | 100,000 | strings an expression produces |
| `maxListLength` | 100,000 | lists an expression produces |
| `maxValueDepth` | 64 | nesting walked by equality (cyclic data fails closed) |
| `timeout` | none | wall-clock milliseconds per evaluation |

Host functions are trusted code: limits cannot interrupt a synchronous host function that is already running, and a getter or Proxy you put in the context runs when it is read. See [SECURITY.md](./SECURITY.md) and [docs/threat-model.md](./docs/threat-model.md).

## License

MIT
