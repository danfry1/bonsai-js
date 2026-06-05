# Performance

The fastest path is a reused instance, compiled hot-path expressions, and sync execution when your extensions do not need promises.

| Need | Best choice |
| --- | --- |
| One quick sync evaluation | `evaluateSync()` |
| Repeated hot-path evaluation | `compile()` once, then `compiled.evaluateSync()` |
| Async plugin or function call | `evaluate()` or `compiled.evaluate()` |
| Small bundle surface | Import only the stdlib modules you actually use |

## Recommended usage

| Practice | Why it helps |
| --- | --- |
| Create one instance and reuse it | Keeps the per-instance caches warm and avoids repeated setup work. |
| Compile repeated expressions | Avoids repeated parse/compile work and gives you an explicit reusable handle. |
| Prefer `evaluateSync()` | Avoids promise overhead when your transforms/functions are synchronous. |
| Import only the stdlib modules you need | Keeps bundle size and startup overhead down. |
| Use `clearCache()` sparingly | Clearing caches is useful for churny workloads, but it throws away warm-state performance. |

## Benchmarks

Measured with [vitest bench](https://vitest.dev/guide/features.html#benchmarking) on Apple Silicon (M-series). Treat these as point-in-time guidance, not part of the API contract.

| Expression | Example | ops/sec | µs/op |
| --- | --- | --- | --- |
| Simple literal | `42` | ~30,000,000 | 0.033 |
| Arithmetic | `1 + 2 * 3` | ~30,000,000 | 0.033 |
| Property access | `user.name` | ~21,000,000 | 0.048 |
| Comparison + logic | `user.age >= 18 && user.verified` | ~11,000,000 | 0.091 |
| Transform pipeline | `user.name \|> upper` | ~12,000,000 | 0.083 |
| Array operations | `items \|> sum` | ~17,000,000 | 0.059 |

### vs Jexl

| Scenario | Speedup |
| --- | --- |
| Default usage (parse + evaluate) | 88x faster |
| Pre-compiled literal | 3.2x faster |
| Pre-compiled comparison | 5.6x faster |

Run benchmarks yourself: `bunx vitest bench`

## Why it's fast

- **Per-instance caches** - repeated expressions reuse parsed ASTs and compiled expression objects.
- **Compiler optimizations** - Constant folding and dead branch elimination at compile time.
- **Zero dependencies** - no runtime dependency graph to initialize or ship.
- **Hand-written parser** - Recursive descent, no parser generators or regex-heavy tokenizers.

## Optimization tips

**Use `compile()` for repeated expressions.** If the same expression runs in a loop or on every request, compile it once and reuse the compiled object. This skips parsing and optimization entirely.

```ts
// Good: compile once, evaluate many
const rule = expr.compile('order.total >= freeShippingThreshold && order.country == "GB"')
for (const order of orders) {
  if (rule.evaluateSync({ order, freeShippingThreshold: 100 })) { /* ... */ }
}
```

**Use `evaluateSync` over `evaluate`.** The sync path avoids Promise overhead. Only use `evaluate` when you have async transforms.

**Choose an appropriate cache size.** The default (256) works well for most applications. If you have thousands of unique expression strings, increase it. If memory is tight, decrease it.

```ts
// High-volume: larger cache
const expr = bonsai({ cacheSize: 1024 })

// Memory-constrained: smaller cache
const expr = bonsai({ cacheSize: 64 })
```

> **Most apps do not need benchmark chasing:** the biggest wins usually come from reusing one instance, compiling repeated expressions, and avoiding async evaluation unless you genuinely need it.
