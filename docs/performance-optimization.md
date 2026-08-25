# Performance Optimization: From 900K to 30M ops/sec

> Historical optimization case study. These measurements explain the registry
> snapshot design; use the benchmark suite and website performance guide for the
> current hardened runtime numbers.

## Summary

A single getter that called `Object.fromEntries()` on every evaluation was responsible for a **33x slowdown**. Combined with guard overhead reduction, Bonsai went from ~900K ops/sec to 30M ops/sec — and from losing to Jexl in pre-compiled benchmarks to beating it in every scenario.

## The Discovery

While building comparison benchmarks against Jexl (the most popular JS expression evaluator), we found something surprising:

| Scenario | Bonsai | Jexl |
|---|---|---|
| Default usage (repeated eval) | 900K ops/s | 160K ops/s |
| Pre-compiled eval | 900K ops/s | 2-10M ops/s |

Bonsai was **5x faster** in default usage thanks to automatic LRU caching, but **2-10x slower** when both libraries pre-compiled. That meant our speed advantage was entirely the cache — our actual evaluator was slow.

## Finding the Bottleneck

### Step 1: Isolate the layers

We benchmarked each layer of the evaluation path independently:

```
compiled.evaluateSync({})     →   960K ops/sec
raw evaluate(ast, ctx, ...)   →   23M ops/sec  (24x faster!)
direct switch on node.type    →   57M ops/sec
```

The raw evaluator was fast. The overhead was in the wrapper path.

### Step 2: Suspect the safety guard

The `SafetyGuard` called `Date.now()` on every `reset()` and ran `enterDepth()`/`exitDepth()` with try/finally on every AST node. We optimized:

- **Lazy timeout**: Only call `Date.now()` when `timeout` option is configured (almost never)
- **Selective depth tracking**: Only track depth on `MemberExpression` nodes that actually chain deeply, not on every node
- **Pre-compute options**: Read `maxDepth`, `maxArrayLength` once in constructor instead of on every check

Result: negligible improvement. The guard wasn't the bottleneck.

### Step 3: Find the real culprit — plugin registry getters

```ts
// plugins.ts — THE PROBLEM
get transforms() { return Object.fromEntries(transformMap) },
get functions() { return Object.fromEntries(functionMap) },
```

These ES5 getters rebuilt entire objects from Maps **on every property access**. The evaluation path accessed `registry.transforms` and `registry.functions` on every `evaluateSync()` call, which means:

- With 33 transforms loaded (strings + arrays + math plugins): allocate a new 33-property object every evaluation
- With 2 functions loaded: allocate a new 2-property object every evaluation
- Both objects immediately become garbage after the evaluation completes

**This single pattern caused a 33x slowdown.**

### Proof: bare vs loaded

```
bare bonsai (no plugins):     15M ops/sec
with plugins (strings+arrays+math):  895K ops/sec  ← 16x slower!
```

Same evaluator, same expressions, same everything — just having transforms registered killed performance.

## The Fix

Cache the snapshot objects and only rebuild when the registry actually changes:

```ts
let transformsCache: Record<string, TransformFn> = {}
let transformsDirty = false

addTransform(name, fn) {
  transformMap.set(name, fn)
  transformsDirty = true  // mark dirty on mutation
},

get transforms() {
  if (transformsDirty) {
    transformsCache = Object.fromEntries(transformMap)
    transformsDirty = false
  }
  return transformsCache  // return cached object
},
```

Transforms are registered at setup time, not during evaluation. The dirty flag is set during `addTransform()` calls (which happen once at startup) and cleared on first access. After that, every evaluation returns the same cached object reference — zero allocations.

## Final Results

### Bonsai alone (with plugins loaded)

| Expression | Before | After | Improvement |
|---|---|---|---|
| Simple literal `42` | 915K | 30M | **33x** |
| Arithmetic `1 + 2 * 3` | 929K | 30M | **33x** |
| Property access `user.name` | 893K | 21M | **23x** |
| Comparison + logic | 866K | 11M | **13x** |
| Ternary | 860K | 12M | **15x** |
| Transform pipeline | 750K | 12M | **16x** |
| Array operations | 827K | 17M | **21x** |

### vs Jexl (post-optimization)

| Scenario | Bonsai | Jexl | Result |
|---|---|---|---|
| Default usage | 11M ops/s | 125K ops/s | **Bonsai 88x faster** |
| Pre-compiled: literal | 32.5M ops/s | 10M ops/s | **Bonsai 3.2x faster** |
| Pre-compiled: property access | 21.3M ops/s | 6.7M ops/s | **Bonsai 3.2x faster** |
| Pre-compiled: comparison+logic | 11.8M ops/s | 2.1M ops/s | **Bonsai 5.6x faster** |

## Lessons

1. **Profile before optimizing.** We initially assumed the safety guard was the bottleneck (it made sense intuitively). It wasn't. The getter was.

2. **Getters that do work are invisible performance killers.** `registry.transforms` looks like a property read. It's actually `Object.fromEntries()` + object allocation. The syntax hides the cost.

3. **Test with realistic configuration.** Our initial benchmarks ran without plugins and showed 15M ops/sec. The real-world scenario (with stdlib loaded) was 16x slower. Always benchmark the way users will actually use your library.

4. **Allocation is the enemy of throughput.** At 900K evals/sec, each evaluation allocates and discards a 33-property object. That's 30M object allocations per second hitting the garbage collector. Eliminating that single allocation was the entire fix.

5. **Cache immutable-in-practice data.** The transform registry changes at setup time, never during evaluation. A dirty flag + cached snapshot is the right pattern for "changes rarely, reads constantly" data.

## Other optimizations applied

- **Lazy `Date.now()`**: Only called when `timeout` option is set (default: not set)
- **Selective depth tracking**: Only `MemberExpression` nodes track depth, not every node
- **Flattened evaluator**: Removed the `evaluate()` → `evaluateNode()` wrapper layer
- **Inlined hot path**: `instance.evaluateSync()` skips `CompiledExpression` object creation and goes straight to `getAst()` + `evaluate()`
- **Fast AST cache**: Simple `Map` for AST lookup alongside the LRU cache for `CompiledExpression` objects
