# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-15

### Added

- **JS-style array method chaining:** `users.filter(.age >= 18).map(.name)` — `filter`, `map`, `find`, `some`, and `every` now work as native array methods with lambda arguments, no stdlib import required
- **Bare dot identity lambda:** `. > 2` and `. * 10` now work as lambda shorthand for the current item itself, in both method calls and pipe transforms (e.g., `[1,2,3,4].filter(. > 2)`, `[1,2,3] |> map(. * 10)`)
- Async-safe evaluation for all higher-order array methods — lambda predicates that return Promises are correctly resolved in both top-level and nested contexts via `evaluate()`
- Documentation for array methods, lambda shorthand, and method chaining in README and website docs

## [Unreleased]

### Added

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
