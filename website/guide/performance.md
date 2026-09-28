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
