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

rule.evaluateSync({
  user: { age: 36, plan: 'pro', tags: [] },
  orders: [{ total: 150, paid: true, created: new Date() }],
}) // => true
```

## Install

```bash
npm install bonsai-js
```

Requires Node.js 22 or newer, current Bun, or a modern browser. The package is ESM; `require('bonsai-js')` works where Node can load ES modules synchronously (22.12 and newer).

## Why Bonsai

- **Familiar.** JavaScript syntax and JavaScript names: `a.b`, `?.`, `??`, templates, `filter`, `map`, `includes`, `toUpperCase`. Every function also works as a method, so `sum(xs)` and `xs.sum()` are the same call.
- **Checked.** Declare your data once with `t` and get errors for typos, wrong types, and possible nulls before an expression is saved, with "did you mean" suggestions and exact source ranges. TypeScript types for the context and result are inferred from the same declaration.
- **Safe by construction.** No prototype access, no globals, no calling functions found in data, no conversion hooks, no mutation. Every evaluation terminates: a deterministic step budget charges each operation for the work it does (including text search, regular expressions, sorting, and time zone math), and produced strings, lists, and nested values are size-limited. A timeout and an `AbortSignal` bound time spent waiting on your own host functions.
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
import { bonsai } from 'bonsai-js'

const env = bonsai()

env.evaluateSync('price * qty', { price: 3, qty: 4 }) // => 12
await env.evaluate('price * qty', { price: 3, qty: 4 }) // => 12

const program = env.compile('items.filter(.active).length')
const items = [{ active: true }, { active: false }]
program.evaluateSync({ items }) // => 1
program.evaluateSync({ items }, { timeout: 50, maxSteps: 10_000, signal: AbortSignal.timeout(1_000) }) // => 1
```

`evaluateSync` compiles the source once and caches the program; `evaluate` is needed only for expressions that call async host functions.

Without declared variables an environment is open: unknown identifiers read the context and are typed `any`. With `variables`, the environment is strict: the checker knows their types and rejects any other name. Pass `strict: false` to let undeclared names read the context as `any`.

## Checking

```ts
import { bonsai, t } from 'bonsai-js'

const env = bonsai({ variables: { user: t.object({ age: t.number(), nick: t.optional(t.string()) }) } })

env.check('user.agee > 18')
// { ok: false, diagnostics: [{ code: 'UNKNOWN_PROPERTY', message: 'Property "agee" does not exist on { age: number, nick: string | null }; did you mean "age"?', severity: 'error', start: 0, end: 9 }] }

env.check('user.nick.toUpperCase()')
// NULLABLE_RECEIVER: The value before .toUpperCase() may be null; use ?.toUpperCase() or ?? to supply a default

env.compile('user.age + 1', { expect: t.boolean() }) // throws: CHECK
```

Types: `t.string()`, `t.number()`, `t.boolean()`, `t.null()`, `t.timestamp()`, `t.duration()`, `t.literal(v)`, `t.enum(...values)`, `t.list(T)`, `t.object({...})`, `t.record(V)`, `t.optional(T)`, `t.union(...)`, `t.any()`. `Infer<typeof type>` gives the TypeScript type.

## Host functions

```ts
import { bonsai, fn, t } from 'bonsai-js'

const rates = new Map([['EUR', 1.1], ['GBP', 1.3]])

const env = bonsai({
  functions: {
    hasRole: fn({ params: [t.string()], returns: t.boolean(), context: true, run: (ctx, role) => (ctx.roles as string[]).includes(role) }),
    fxRate: fn({ params: [t.string()], returns: t.number(), async: true, run: async (currency) => rates.get(currency) ?? 1 }),
  },
})

await env.evaluate('hasRole("admin") || orders.map(fxRate(.currency) * .amount).sum() < 1000', {
  roles: ['editor'],
  orders: [{ currency: 'EUR', amount: 100 }],
}) // => true
```

- Parameter and result types are declared with `t`; `run`'s argument types are inferred from them. Arguments are validated before your code runs, and results are checked deeply against the declared type: a mismatch is a `HOST_CONTRACT` error, which `try()` in an expression cannot catch. Anything your function throws, including a `BonsaiError`, becomes a `HOST_ERROR`, which `try()` can recover from.
- `async: true` functions are awaited by `evaluate()`, one call at a time. `evaluateSync()` rejects expressions that call them before any host code runs. A function not declared `async` that returns a promise is a `HOST_CONTRACT` error.
- A host function with the same name as a built-in replaces it for that environment, so new built-ins in future releases never change the meaning of your expressions.
- `withContext<AppContext>()` returns a version of `fn` whose `run` receives the typed context first: `withContext<Ctx>()({ params: [], returns: t.string(), run: (ctx) => ctx.tenant.id })`.
- Optional parameters (after `required`) arrive as `null` when omitted, so declare them with `t.optional(...)`.
- Each call is charged `cost` steps (default 32) against the step budget; set a lower `cost` for cheap pure helpers.
- Bundle functions into a `Library` (`{ name, functions }`) and pass `libraries: [a, b]`; a name defined twice is an error. `env.extend({...})` derives a new environment.

Context data is not validated against the declared types by default (it is your data, and validation costs time proportional to it). Pass `validateContext: true` to check it before every evaluation; a mismatch fails with `INVALID_CONTEXT` and the exact path, e.g. `user.created should be timestamp, got string "2026-01-01"`. Objects may carry more keys than their declared type lists (a database row with extra columns is fine); the checker accounts for that.

## Built-in functions

All callable as `f(x, ...)` or `x.f(...)`.

| Area | Functions |
|---|---|
| Text | `toUpperCase` `toLowerCase` `trim` `trimStart` `trimEnd` `startsWith` `endsWith` `includes` `indexOf` `lastIndexOf` `slice` `split` `replace` `replaceAll` `padStart` `padEnd` `repeat` `at` `matches` `toString` `toNumber` |
| Lists | `map` `filter` `find` `findIndex` `some` `every` `none` `count` `flatMap` `reduce` `sort` `sortBy` `groupBy` `reverse` `unique` `flat` `first` `last` `join` `slice` `at` `includes` `indexOf` `isEmpty` |
| Numbers | `round` `floor` `ceil` `trunc` `abs` `sqrt` `clamp` `toFixed` `formatNumber` `formatCurrency` `min` `max` `sum` `avg` |
| Maps | `keys` `values` `entries` `type` |
| Time | `now` `timestamp` `weeks` `days` `hours` `minutes` `seconds` `milliseconds` `inDays` `inHours` `inMinutes` `inSeconds` `inMilliseconds` `year` `month` `day` `hour` `minute` `second` `dayOfWeek` `startOfDay` `startOfMonth` `startOfYear` `addDays` `addMonths` `addYears` `formatDate` |

`matches(text, pattern)` uses JavaScript regular expression syntax (as with the `u` flag) and runs in linear time, so a user-written pattern cannot hang evaluation; backreferences, lookaround, named groups, `\p{...}`, and inline flags other than a leading `(?i)` are rejected ([full list](./docs/language.md)), a leading `(?i)` ignores ASCII case, and a pattern longer than `maxPatternLength` is a `PATTERN_LIMIT` error. `formatDate` understands `yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h a mm m ss s SSS` and rejects unknown letters; constant patterns are checked when the expression is compiled.

`env.listFunctions()` returns every signature and description, for documentation or tooling.

## Explaining results

`explain()` evaluates and records the value of every sub-expression, so you can show why a rule passed or failed: in a support tool, an audit log, or next to the rule in an editor.

```ts
import { bonsai } from 'bonsai-js'

const rule = bonsai().compile('user.age >= 18 && user.plan == "pro"')
const explanation = rule.explain({ user: { age: 25, plan: 'free' } })

explanation.ok // true
if (explanation.ok) explanation.value // false
console.log(String(explanation))
// user.age >= 18 && user.plan == "pro"  → false
// ├─ user.age >= 18  → true
// │  └─ user.age  → 25
// └─ user.plan == "pro"  → false
//    └─ user.plan  → "free"
```

`explanation.reasons()` returns just the conditions that decided the result. By default `&&` stops at the first false condition; pass `{ exhaustive: true }` to evaluate the rest too, so a "why was this rejected" screen can list every reason:

```ts
import { bonsai } from 'bonsai-js'

const rule = bonsai().compile('user.age >= 18 && user.plan == "pro"')
const user = { age: 16, plan: 'free' }

rule.explain({ user }, { exhaustive: true }).reasons().map((r) => r.text)
// ['user.age >= 18', 'user.plan == "pro"']
```

`explanation.trace` is the full tree: each node has an `id`, `kind`, `text`, `start`/`end` source offsets, `value` or `error`, and `children`. Parts skipped by short-circuiting are marked `evaluated: false`, and lambdas record each item they ran on under `iterations` (up to `maxIterations`, default 20; `maxTraceNodes` caps the whole trace). `JSON.stringify(explanation)` gives a bounded, cycle-safe snapshot that never runs getters. Evaluation errors are returned (`ok: false`, `error`) with the failing node marked, never thrown; invalid options or context throw, as with `evaluate()`. Use `explainAsync()` for expressions that call async host functions. Explaining uses a separately compiled program, so ordinary evaluation is not slowed down.

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

<!-- no-run -->
```ts
import { createLanguageService } from 'bonsai-js/service'

const service = createLanguageService(env) // env from the first example
service.complete('orders.filter(.', 15) // { start: 15, end: 15, items: created, paid, total, then methods that take a map, such as keys and type }
service.hover('orders.map(.total)', 2)  // { start: 0, end: 6, detail: '{ total: number, paid: boolean, created: timestamp }[]' }
service.diagnostics('user.agee')        // same diagnostics as env.check
```

The service never evaluates expressions or calls host functions.

## Errors

Every error thrown while checking or evaluating an expression is a `BonsaiError` with a stable `code`, the `source`, a `span` (`{ start, end }`), a 1-based `position`, and a `formatted` message with a code frame. That includes failures in your own code: a host function that throws, or a getter or Proxy in the context that throws when read, becomes a `HOST_ERROR` with the original error as its `cause`. Invalid configuration passed to `bonsai()` or `fn()`, and a syntax tree `print()` cannot print faithfully, throw a `TypeError` or `RangeError` immediately; invalid per-evaluation options do too from `evaluateSync()`, and make `evaluate()` reject.

| Class | Codes |
|---|---|
| `BonsaiSyntaxError` | `SYNTAX` |
| `BonsaiCheckError` | `CHECK` (see `.diagnostics`) |
| `BonsaiLimitError` | `SOURCE_TOO_LONG` `TOO_DEEP` `TOO_MANY_NODES` `TOO_COMPLEX` `STEP_LIMIT` `STRING_LIMIT` `LIST_LIMIT` `PATTERN_LIMIT` `TIMEOUT` `ABORTED` |
| `BonsaiRuntimeError` | `TYPE_ERROR` `NO_OVERLOAD` `NULL_RECEIVER` `DIVISION_BY_ZERO` `NON_FINITE` `BLOCKED_PROPERTY` `INVALID_ARGUMENT` `INVALID_CONTEXT` `ASYNC_IN_SYNC` `HOST_ERROR` `HOST_CONTRACT` |

`try(expr, fallback)` in an expression catches runtime errors except `HOST_CONTRACT`; it never catches syntax, check, or limit errors.

## Limits

All limits are on by default; `limits` changes the budget. `0` disables `maxSteps` and `timeout`; the other limits must be positive integers.

| Limit | Default | Bounds |
|---|---|---|
| `maxSourceLength` | 100,000 | expression length |
| `maxDepth` | 128 | syntax nesting depth |
| `maxNodes` | 20,000 | syntax tree size, and the work of checking and compiling |
| `maxSteps` | 1,000,000 | work per evaluation, charged by the real cost of each operation |
| `maxStringLength` | 100,000 | strings an expression produces |
| `maxListLength` | 100,000 | lists an expression produces |
| `maxValueDepth` | 64 | nesting of values an expression builds or walks (cyclic data fails closed) |
| `maxPatternLength` | 4,096 | regular expression patterns passed to `matches` |
| `timeout` | none | wall-clock milliseconds per evaluation |

The step budget is deterministic: the same expression over the same data uses the same steps on every machine, and at the default budget any expression finishes or fails within about 100 ms on Node (about 150 ms for the slowest shapes we have found). Host functions are trusted code: limits cannot interrupt a synchronous host function that is already running, and a getter or Proxy you put in the context runs when it is read. Set a `timeout` when expressions call slow host functions. See [SECURITY.md](./SECURITY.md) and [docs/threat-model.md](./docs/threat-model.md).

## License

MIT
