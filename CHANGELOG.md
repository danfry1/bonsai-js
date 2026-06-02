# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Bounded parser recursion: pathologically nested input (deep parentheses, unary chains) now fails closed with a typed `ExpressionError` ("Maximum expression nesting depth exceeded") instead of overflowing the native call stack with an uncaught `RangeError`. `validate()` reports it as a normal syntax error rather than a stack-overflow message.
- `maxArrayLength` is now enforced on array-returning methods (`split`, `map`, `flatMap`, `flat`, `concat`, `toSorted`, `toReversed`, `with`, `toSpliced`), not just array literals and spread, in both the sync and async evaluators.
- Added `maxStringLength` (default 100,000) and enforced it as a ceiling on every string produced by a method call, in both the sync and async evaluators. `padStart`/`padEnd`/`repeat` are checked before allocation (capping the produced length, not just the repeat count); all other string-returning methods (`join`, `concat`, `slice`, `toUpperCase`, ...) are checked on their output. This closes single-operation amplifiers such as `arr.join(sep)`, whose output length is array length times separator length in one native call that the cooperative timeout cannot interrupt.

### Added

- `maxStringLength` option on `bonsai(options)` and a `BonsaiSecurityError('MAX_STRING_LENGTH', ...)` error code.

### Fixed

- Async/sync parity for higher-order array methods (`map`, `filter`, `find`, `some`, `every`, `findIndex`, `flatMap`). Predicates now evaluate sequentially in the async evaluator, matching the synchronous one: `some`/`every`/`find`/`findIndex` short-circuit at the first decisive element, and `maxDepth` is no longer inflated by array length (an expression that succeeded with `evaluateSync` could previously throw a spurious `Maximum expression depth` error with `evaluate`).
- Malformed numeric literals now raise a parse-time `ExpressionError` instead of silently evaluating to `NaN` or coercing: a base prefix or exponent with no digits (`1e`, `1e+`, `0x`, `0b`, `0o`), and misplaced numeric separators (`1_`, `1__0`, `0xff_`), which are rejected the way JavaScript rejects them.
- Template interpolations containing string literals or nested template literals with braces (for example `` `${ "x}" }` `` or `` `${ `a}b` }` ``) now parse correctly instead of failing with an "Unterminated string"/"Unterminated template literal" error.
- Higher-order array helpers now fail loud on a non-function callback instead of silently doing the wrong thing. The lambda shorthand (`.x`, `. > 0`) is a function value; passing it to a function (for example `map(inc(.x))`) evaluates to a plain value, which previously made the stdlib `map`/`filter`/`find`/`some`/`every` transforms silently return the input unchanged and the `.map`/`.filter`/`.find`/`.findIndex`/`.some`/`.every`/`.flatMap` methods throw a raw `TypeError`. Both now throw a typed `BonsaiTypeError` naming the helper. No-argument forms (`|> map`, `|> filter`) are unaffected.

## [0.4.0] - 2026-06-02

### Added

- **Context-aware functions** (`addContextFunction`): register functions that receive the evaluation context as their first parameter (typed `Readonly<TCtx>`, passed by reference), enabling auth/permission/personalization patterns without threading context through expression arguments. Pure and context-aware functions share a single namespace; `isContextFunction(name)` introspects the kind.
- **Generic context typing** (`bonsai<TCtx>()`): the factory is now generic over context type, with end-to-end type safety through `evaluate`, `evaluateSync`, `compile`, and `addContextFunction`. Backward compatible: defaults to `Record<string, unknown>` when unspecified.
- New exported types: `ContextFunctionFn`, generic `BonsaiPlugin<TCtx>`, generic `CompiledExpression<TCtx>`, generic `BonsaiInstance<TCtx>`.
- Internal: pure and context-aware functions share one tagged registry, and the cached `Bindings` snapshot consolidates transforms and that registry into a single object passed to the evaluator.

### Resolves

- #33: context access from registered functions.

### Credits

- Thanks to @jaenyf for raising #33 and contributing PR #34.

## [0.3.0] - 2026-03-21

### Added

- **Autocomplete API** (`bonsai-js/autocomplete`): cursor-aware expression completions with property, method, transform, function, and keyword suggestions
- `getPolicy()` method on `BonsaiInstance` for reading security policy
- `InferredTypeName`, `PolicySnapshot`, `ResolveResult` shared types
- Tolerant tokenization for incomplete expressions with regex fallback
- Type inference from sample context objects with array element type detection
- Lambda-aware dot classification (lambda-start, lambda member-access, top-level member-access)
- Security policy filtering in completions (respects allowedProperties/deniedProperties in all paths)
- Optional chaining (`?.`) support in completions
- Fuzzy matching with camelCase-aware scoring
- `onError` callback for debugging autocomplete failures
- `transformTypes` option to skip auto-probing for performance
- Eval-based type inference for method chains (e.g., `user.name.trim().`)
- Nested lambda element inference (e.g., `groups.map(.users.filter(.`)
- Pre-computed method completion cache for fast method suggestions
- Autocomplete benchmarks (`benchmarks/autocomplete.bench.ts`)

### Changed

- **Performance**: core `evaluateSync` 1.4–2.4x faster (LRU cache fast path, pooled ExecutionContext, leaf node fast path)
- **Performance**: autocomplete method completions 3–4x faster via pre-computed completion objects
- LRU cache uses `lastKey` tracking to skip reordering on repeated hits
- `ExecutionContext` reusable via `reset()` — avoids per-call allocation in `evaluateSync`
- Leaf AST nodes (literals, identifiers) skip depth tracking overhead in both sync and async evaluators

### Security

- Transform names validated as safe identifiers before `evaluateSync` interpolation
- `resolvePropertyChain` enforces `allowedProperties`/`deniedProperties` policy at every chain step
- `BLOCKED_NAMES` unified with `BLOCKED_PROPERTIES` from execution context (single source of truth)
- Catch blocks use `isExpectedError()` checking all 4 Bonsai error types — unexpected errors surface via `onError`
- Top-level `complete()` catches unexpected errors and returns `[]` (never crashes host)

## [0.2.1] - 2026-03-16

### Added

- Native method support for commonly expected string methods: `trim`, `toLowerCase`, `toUpperCase`, `split`, `padStart`, `padEnd`, `concat`, `lastIndexOf`
- Native method support for additional array methods: `join`, `flat`, `concat`, `lastIndexOf`, `findIndex`, `flatMap`
- ES2023 non-mutating array methods: `toReversed`, `toSorted`, `toSpliced`, `with`
- Mutating array methods (`reverse`, `sort`, `push`, `pop`, `splice`) are explicitly blocked to prevent context mutation

## [0.2.0] - 2026-03-15

### Added

- **JS-style array method chaining:** `users.filter(.age >= 18).map(.name)` — `filter`, `map`, `find`, `some`, and `every` now work as native array methods with lambda arguments, no stdlib import required
- **Bare dot identity lambda:** `. > 2` and `. * 10` now work as lambda shorthand for the current item itself, in both method calls and pipe transforms (e.g., `[1,2,3,4].filter(. > 2)`, `[1,2,3] |> map(. * 10)`)
- Async-safe evaluation for all higher-order array methods — lambda predicates that return Promises are correctly resolved in both top-level and nested contexts via `evaluate()`
- Documentation for array methods, lambda shorthand, and method chaining in README and website docs
- Deterministic property-based parser and evaluator invariant tests
- Random fuzz coverage for malformed parser input
- Adversarial regression tests for deep nesting, oversized arrays, nested blocked keys, and spread misuse
- Public runtime export stability tests for the root package and stdlib subpath
- CI performance gate and packed npm artifact smoke test
- Explicit stability policy documenting semver scope and compatibility guarantees

### Changed

- Release and CI verification now run the Vitest suite via `bun run test`
- Type checking now covers `src`, `tests`, `scripts`, `benchmarks`, and tool configs
- Publish validation now checks packed artifact contents and Node import resolution before release

## [0.1.0] - 2026-03-07

First public release.

### Core

- Hand-written lexer and recursive descent parser
- Compiler with constant folding and dead branch elimination
- LRU-cached compile-once, evaluate-many architecture
- Synchronous and true async evaluation (awaits async transforms/functions)
- Safety sandbox: blocks `__proto__`/`constructor`/`prototype`, enforces depth/timeout/array limits
- Plugin system for custom transforms and functions

### Syntax

- Arithmetic: `+`, `-`, `*`, `/`, `%`, `**`, unary `+`/`-`
- Comparison: `==`, `!=`, `<`, `>`, `<=`, `>=` (strict equality)
- Logical: `&&`, `||`, `!` (short-circuit)
- Ternary: `a ? b : c`
- Nullish coalescing: `a ?? b`
- Membership: `x in arr`, `x not in arr`
- Pipe operator: `x |> transform`
- Optional chaining: `a?.b`, `a?.[i]`
- Property access: dot and bracket notation
- Safe method calls: `.includes()`, `.slice()`, `.startsWith()`, etc.
- Array/object literals with spread and trailing commas
- Object shorthand properties: `{ name }`
- Template literals: `` `Hello ${name}` ``
- Lambda predicates: `.active`, `.age >= 18`
- Number formats: hex (`0xFF`), binary (`0b101`), octal (`0o77`), scientific (`1e5`), separators (`1_000`)
- String escapes: unicode (`\u{1F600}`), hex (`\x41`), null (`\0`)

### Standard Library

- **strings:** `upper`, `lower`, `trim`, `split`, `replace`, `replaceAll`, `startsWith`, `endsWith`, `includes`, `padStart`, `padEnd`
- **arrays:** `count`, `first`, `last`, `reverse`, `flatten`, `unique`, `join`, `sort`, `filter`, `map`, `find`, `some`, `every`
- **math:** `round`, `floor`, `ceil`, `abs`, `sum`, `avg`, `clamp`, `min()`, `max()`
- **types:** `isString`, `isNumber`, `isArray`, `isNull`, `toBool`, `toNumber`, `toString`
- **dates:** `now()`, `formatDate`, `diffDays`
- **all:** convenience plugin that loads the entire stdlib

### API

- `bonsai(options?)` factory with `timeout`, `maxDepth`, `maxArrayLength`, `cacheSize`, `allowedProperties`, `deniedProperties`
- `evaluateSync<T>(expr, context?)` and `evaluate<T>(expr, context?)` with typed generics
- `compile(expr)` for pre-compiled repeated evaluation
- `validate(expr)` with AST, expression references (`identifiers`, `transforms`, `functions`), and formatted error strings
- `evaluateExpression<T>(expr, context?)` standalone shorthand
- Method chaining: `use()`, `addTransform()`, and `addFunction()` return `this`
- Registry introspection: `hasTransform()`, `hasFunction()`, `listTransforms()`, `listFunctions()`
- `removeTransform()`, `removeFunction()` for dynamic plugin management
- `clearCache()` to flush compiled expression caches

### Error Handling

- `ExpressionError` — parse errors with source position and caret highlighting
- `BonsaiTypeError` — runtime type mismatches with `transform`, `expected`, `received`
- `BonsaiReferenceError` — unknown transform/function with typo suggestions
- `BonsaiSecurityError` — security violations with error codes (`TIMEOUT`, `BLOCKED_PROPERTY`, `PROPERTY_NOT_ALLOWED`, `PROPERTY_DENIED`, `MAX_DEPTH`, `MAX_ARRAY_LENGTH`)
- All evaluation errors include `location` pointing to the exact source position
- `formatError()` utility exported for custom error formatting

### Performance

- 11–32M ops/sec on Apple Silicon with full stdlib loaded
- 88x faster than Jexl in default usage, 3–6x faster pre-compiled
- `sideEffects: false` for proper tree-shaking
- Zero runtime dependencies
