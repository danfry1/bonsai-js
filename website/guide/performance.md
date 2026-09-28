# Performance

Bonsai parses and checks an expression once, compiles it to a tree of closures, and evaluates that tree directly. There is no interpreter loop over the syntax tree and no `eval`. A typical rule evaluates in well under a microsecond.

## Recommended usage

| Practice | Why |
| --- | --- |
| Create one environment and reuse it | The environment owns the program cache. Creating one per request throws the cache away. |
| `compile()` expressions that run repeatedly | Parsing and checking happen once. Keep the `Program` next to the data it evaluates. |
| Prefer `evaluateSync()` | The synchronous path avoids promise overhead. Use `evaluate()` only when an expression calls an async host function. |
| Size the cache for your workload | `env.evaluateSync(source, ...)` caches up to `cacheSize` programs (default 256) by source text. Raise it if you evaluate thousands of distinct sources; set `0` to disable caching. |
| Keep compiled programs | Checking and compiling cost more than evaluating: a 10-term rule compiles in about 10 microseconds and then evaluates in about a quarter of a microsecond. Compile once and keep the `Program`, or let the cache do it. |

```ts
import { bonsai, t } from 'bonsai-js'

const env = bonsai({
  variables: { order: t.object({ total: t.number(), country: t.string() }) },
})

// Compile once...
const rule = env.compile('order.total >= 100 && order.country == "GB"', { expect: t.boolean() })

// ...evaluate many times.
const orders = [
  { total: 120, country: 'GB' },
  { total: 80, country: 'GB' },
]
orders.filter((order) => rule.evaluateSync({ order })).length // => 1
```

## Why it is fast

- **Checked once, compiled once.** The static checker resolves overloads ahead of time when argument types are known, so the compiled program calls the right implementation directly instead of dispatching on every evaluation.
- **Closures, not a tree walk.** Each syntax node becomes a small closure; a program is a function call away from its result.
- **Reused evaluation state.** A program reuses its evaluation state between synchronous runs instead of allocating a new one each time.
- **Cheap limits.** The step budget is a counter, and the timeout reads the clock only periodically, so the safety limits cost little on the hot path.
- **No dependencies.** Nothing to initialize or ship besides the library itself.

## Benchmarks

The repository includes a comparison against `@marcbachmann/cel-js`, another safe expression language, on the same workloads. On Node, a typical rule evaluates about 10 million times per second, 1.3x to 2x faster than cel-js. Reproduce it from a checkout with:

```bash
bun run bench
```

Treat benchmark numbers as point-in-time guidance for your hardware, not as part of the API contract.

## Things that cost more

- **Large data.** Work proportional to data (lambdas over long lists, deep equality on big values, long templates) is linear in the data, like the JavaScript equivalent. The step budget bounds it.
- **Async evaluation.** An expression that calls an async host function runs on a separate async path with an `await` per async call. Expressions that do not call async functions run on the synchronous path even through `evaluate()`.
- **Async host calls run one at a time.** `orders.map(fxRate(.currency) * .amount)` waits for each call before starting the next, so twenty calls at 10 ms each take about 200 ms. When a function reaches a network or database, batch in the host: prefetch the data into the context, or cache inside your function.
- **Context validation.** `validateContext: true` checks the whole context before every evaluation, which can cost more than the expression itself: over a list of 1,000 records it makes a filter-and-map expression roughly nine times slower. Enable it where the context comes from outside your code, not for data your own typed code builds.
- **Timeouts.** A `timeout` makes each evaluation read the clock, and adds a timer around each async host call. The cost is small for synchronous expressions and noticeable for expressions that make many async calls.
- **Regular expressions.** `matches` runs a linear-time engine, which is predictable but slower than JavaScript's native `RegExp` on simple patterns. Prefer `startsWith`, `endsWith`, and `includes` where they express the test.
- **Cache misses.** Every distinct source text passed to `env.evaluate*()` is parsed, checked, and compiled the first time it is seen. If your sources are generated with values embedded in them, pass the values through the context instead so the text stays the same.
- **Runtime `expect` checks.** When the checker cannot prove a result matches `expect` (the result type is partly `any`), the result is checked on every evaluation, at about 7 steps per record for a list of small maps. Declaring variable types lets the checker prove it instead.

## What fits in the default budget

The step budget (`maxSteps`, default 1,000,000) is charged in proportion to the work each operation does, so it bounds how much data one evaluation can process. Approximate costs and the most records one evaluation can handle at the default budget:

| Operation | Steps | Most at the default budget |
| --- | --- | --- |
| `filter` over records | about 2 per record | the list limit (100,000) |
| `map` to a number | about 6 per record | the list limit |
| `filter`, `map`, and `sum` together | about 11 per record | about 94,000 records |
| `sortBy` | about 12 per record | about 56,000 records |
| `unique` over 10-field records | about 17 per record | about 58,000 records |
| A template per record | about 10 per record | about 99,000 records |
| `formatNumber`, `formatCurrency` | about 20 per call | about 50,000 calls |
| A host function call | its `cost` (default 32) | about 31,000 calls |
| `matches` | TODO(runtime2) steps per character of text | TODO(runtime2) |
| Calendar functions in a time zone (`startOfDay(t, zone)`) | TODO(runtime2) per call | TODO(runtime2) calls |

If a legitimate workload needs more, raise `maxSteps` for that environment or that evaluation; the budget then bounds proportionally more time. Lower a pure helper function's `cost` so its calls do not dominate.

The compiled regular expressions, number formats, and time zone data that these functions use are cached process-wide, with a fixed memory bound (TODO(runtime2) size), and shared by every environment. Step charges do not depend on whether something was already cached, so the same evaluation uses the same steps every time.
