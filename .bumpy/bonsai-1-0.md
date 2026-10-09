---
'bonsai-js': major
---

A redesign of the language and the engine. Expressions and host code written for 0.x need migrating; the [migration guide](https://danfry1.github.io/bonsai-js/guide/migrating) covers every change, including results that change without an error.

**Language**

- Every function is callable as `f(x, a)` or `x.f(a)`. The pipe operator `|>` is removed and its token reserved.
- The standard library is built in, with JavaScript names (`toUpperCase`, `includes`, `filter`) plus `sum`, `sortBy`, `groupBy`, `unique`, `keys`, `round(x, digits)`, and calendar functions with time zones. `upper`, `lower`, `flatten`, `isString`, `isNumber`, `isArray`, `isNull`, `toBool`, `diffDays`, `charCodeAt`, `toSpliced`, `with`, `substring`, `charAt`, and `concat` are removed.
- Lambdas: `x => ...` and `(acc, x) => ...` alongside `.field`. The implicit `.` binds to the nearest argument whose parameter takes a function, and only where that function's first parameter is the current item (so not in `reduce`). No-argument `filter`, `some`, and `every` are removed.
- New: `let` bindings, `try(expr, fallback)`, `has(a.b)`, comments, timestamps and durations (`now() - t > days(30)`), deep `==` on lists and maps.
- `null` is the single absent value: missing properties and host `undefined` read as `null`, and `x == null` holds for both. A map key holding `undefined` is absent to `==`, `keys`, `values`, `entries`, `has`, `in`, and spread. Ordering comparisons with `null` are `false`.
- `&&`, `||`, `!`, and `?:` take booleans (`null` counts as false). There is no coercion: `"a" + 1` and `null + 1` are errors. Division and remainder by zero and non-finite results are errors. Chained comparisons are parse errors, and so is `??` beside another binary operator without parentheses (`a ?? 0 > 10`).
- Results that changed: `round` rounds halves away from zero and honors its digits argument; `toFixed` rounds the written decimal; `avg([])` is `null`; `unique` compares by value; templates render `null` as empty text, dates as ISO-8601, and reject lists and maps; `toString(null)` is `""`; `toNumber` accepts decimal text only (no `0x`, `0b`, or `0o`); `formatNumber` and `formatCurrency` reject a locale the runtime has no data for instead of using the host's default; `sum` and `avg` add left to right; `now()` is a timestamp; `sort()` orders numbers numerically; `includes`, `indexOf`, and `in` compare lists and maps by value, and `Date`s at the same instant are equal; `replace` and `replaceAll` insert their replacement text literally (no `$&` patterns).
- Only plain objects and class instances are read as maps: reads see their own properties, and `keys()`, spread, and `==` see the enumerable ones, as in JavaScript. `Map`, `Set`, `RegExp`, promises, typed arrays, and errors are opaque; a plain object with a `then` method is an ordinary map and is never awaited. Map keys follow JavaScript property order.

**API**

- `bonsai({ variables, strict, functions, libraries, limits, cacheSize, clock, validateContext })` creates an immutable environment; `extend()` derives one. `use()`, plugins, `addFunction`, `addContextFunction`, `addTransform`, `remove*`, `has*`, `isContextFunction`, `getPolicy`, and `clearCache` are removed.
- Declaring `variables` makes an environment strict: undeclared names are check errors unless `strict: false`.
- Host functions are declared with `fn({ params, returns, run })`, validated on every call, and must be marked `async` to be awaited. A result that does not match the declared type, or a promise from a function not marked `async`, is a `HOST_CONTRACT` error that `try()` does not catch.
- `env.compile(source, { expect })` type-checks and returns a `Program`; `env.check()` replaces `validate()` and returns every diagnostic without throwing. The context type comes from `variables` instead of `bonsai<Ctx>()`.
- `bonsai-js/service` (`createLanguageService`) replaces `bonsai-js/autocomplete`; the `stdlib` and `autocomplete` subpaths are removed.
- `print(tree, { calls })` turns a syntax tree back into source, round-tripping with `env.parse`. Syntax tree node types are renamed.
- `program.explain(context)` (and `explainSync`, `env.explain`, `env.explainSync`) evaluates and returns a trace of every sub-expression's value, with skipped branches and per-item lambda runs; `reasons()` lists the conditions that decided the result.
- `program.partial(known, { unknown })` evaluates what the known data decides and returns a value, an error, or a residual expression over the unknown variables, to pre-evaluate rules once per tenant or request.
- `bonsai-js/query` (`toSQL`, `toMongo`) translates a filter over a declared record into a parameterized SQL `WHERE` clause (Postgres, SQLite) or a MongoDB filter that selects exactly the records the filter accepts.
- Errors are `BonsaiError` subclasses with stable codes and `{ start, end }` spans. `ExpressionError`, `BonsaiTypeError`, `BonsaiReferenceError`, `BonsaiSecurityError`, `formatError`, `formatBonsaiError`, `evaluateExpression`, `tokenize`, `parse`, and `compile` are removed, as are the `allowedProperties` and `deniedProperties` options.
- Limits move under `limits`; `maxArrayLength` is now `maxListLength`, and `maxDepth` now bounds syntax nesting.
- Requires Node.js 22 or newer.

**Engine**

- Expressions compile to closures. Async code is generated only for subtrees that reach an async host function.
- The package ships one module per source file, so bundlers drop what an app does not reach: importing only `t` or the error classes adds under 1 KB gzipped. A minimal browser bundle that evaluates expressions is about 56 KB gzipped.
- Every limit is on by default: source size, depth, node count, a deterministic step budget charged by the real cost of each operation, produced string and list sizes, value depth, regular expression pattern length, plus an optional timeout and `AbortSignal`.
