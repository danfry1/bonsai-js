# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From 1.0.0, entries are generated at release time from the bump files in
[`.bumpy/`](./.bumpy/); entries up to 0.5.0 follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).





## 1.3.0
<sub>2026-10-26</sub>

- *(minor)*
  `fromSchema` converts an app's existing schema into a Bonsai type: a Zod 4 or ArkType schema, a Valibot schema wrapped with `toStandardJsonSchema` (any Standard JSON Schema), or a JSON Schema (draft-07, 2020-12, OpenAPI 3.0). A context declared with it is typed as the schema's output. New exports: `fromSchema`, and the types `SchemaType`, `FromSchemaOptions`, `JSONSchema`, and `StandardJSONSchema`. Passing a schema object where a type goes now throws an error that says to use `fromSchema`.

## 1.2.2
<sub>2026-10-26</sub>

- *(patch)*
  Check errors for a non-boolean in a condition, `!`, `&&` or `||` now say how to fix it. A default written with `||` (`user.nickname || "anon"`, or `discount || 0` on an untyped value) is reported once, suggesting `??`, and the rest of the expression is checked as if it used `??`, so a method call on it adds no further error. Where a boolean is wanted (a condition, `!`, `&&`), a number or string is told to compare it (`x != 0`), or to test it against null (`x != null`) when it may be null.
- The package homepage is now https://bonsai.danfry.dev.

## 1.2.1
<sub>2026-10-25</sub>

- *(patch)*
  Smaller browser bundles for `bonsai-js/runtime`, `bonsai-js/runtime/core`, and `bonsai-js/lite` (about 0.85 KB gzipped each): explain tracing and partial-evaluation residual handling now live with the main entry's explain and partial features instead of the shared compiler and runner. No change in behavior.

## 1.2.0
<sub>2026-10-25</sub>

- *(minor)*
  Add `bonsai-js/runtime/core` and `bonsai-js/builtins`: a runtime with only the built-in functions passed in `builtins`, so a browser bundle carries just what its rules call (about 30 KB gzipped for typical rules, against 43 KB for `bonsai-js/runtime`). `bonsai()` takes the same `builtins` option, and a call to a built-in left out is a CHECK error, so rules are checked against what the browser can run.
- *(patch)*
  Built-in function descriptions, which only `describeFunction()`, `listFunctions()`, and the language service read, are no longer bundled with `bonsai-js/runtime`, which is about 1.2 KB smaller gzipped (43 KB). Making each built-in separately removable adds about 0.8 KB to `bonsai-js` (69 KB), `bonsai-js/lite` (57 KB), and the language service (47 KB).

## 1.1.0
<sub>2026-10-24</sub>

- *(minor)*
  Add `bonsai-js/runtime` and `toArtifact()`: check and compile rules where the full toolchain runs, and evaluate them in the browser without the checker (about 44 KB minified and gzipped), with exactly the results the compiled programs give. A runtime whose definitions differ refuses an artifact with `BonsaiArtifactError` (code `ARTIFACT`) and a `reason`.
- *(patch)*
  Charge the step budget for each union member tried when a result is checked against its expected type or a host function's declared type. A list result checked against a large enum could previously run far past `maxSteps` and `timeout`.
- *(patch)*
  Check and cache a program against a private copy of its `expect` type. A type object with a `toJSON` method could previously be served a cached program checked against a different type, and a type object changed after compiling changed what the program's results were checked against. The language service's `expect` option is kept the same way. Types built with `t` are used as given.

## 1.0.0
<sub>2026-10-19</sub>

- *(major)*
  A redesign of the language and the engine. Expressions and host code written for 0.x need migrating; the [migration guide](https://danfry1.github.io/bonsai-js/guide/migrating) covers every change, including results that change without an error.

  **Language**

  - Every function is callable as `f(x, a)` or `x.f(a)`. The pipe operator `|>` is removed and its token reserved.
  - The standard library is built in, with JavaScript names (`toUpperCase`, `includes`, `filter`) plus `sum`, `sortBy`, `groupBy`, `unique`, `keys`, `round(x, digits)`, and calendar functions with time zones. `upper`, `lower`, `flatten`, `isString`, `isNumber`, `isArray`, `isNull`, `toBool`, `diffDays`, `charCodeAt`, `toSpliced`, `with`, `substring`, `charAt`, and `concat` are removed.
  - Lambdas: `x => ...` and `(acc, x) => ...` alongside `.field`. The implicit `.` binds to the nearest argument whose parameter takes a function, and only where that function's first parameter is the current item (so not in `reduce`). No-argument `filter`, `some`, and `every` are removed.
  - New: `let` bindings, `try(expr, fallback)`, `has(a.b)`, comments, timestamps and durations (`now() - t > days(30)`), deep `==` on lists and maps. Durations are whole milliseconds (a fraction rounds, halves away from zero), so their arithmetic is exact, within ±(2^53 - 1) ms (about 285,000 years); a duration outside that range is `INVALID_ARGUMENT`, and `new Duration(ms)` throws a `RangeError` for one. Time zones are `"UTC"` or IANA `Area/Location` names in the tz database's spelling; abbreviations, legacy names, other spellings, and offsets are `INVALID_ARGUMENT`.
  - `null` is the single absent value: missing properties and host `undefined` read as `null`, and `x == null` holds for both. A map key holding `undefined` is absent to `==`, `keys`, `values`, `entries`, `has`, `in`, and spread. Ordering comparisons with `null` are `false`.
  - `&&`, `||`, `!`, and `?:` take booleans (`null` counts as false). There is no coercion: `"a" + 1` and `null + 1` are errors. Division and remainder by zero and non-finite results are errors. Chained comparisons are parse errors, and so is `??` beside another binary operator without parentheses (`a ?? 0 > 10`).
  - Results that changed: `round` rounds halves away from zero and honors its digits argument; `toFixed` rounds the written decimal; `avg([])` is `null`; `unique` compares by value; templates render `null` as empty text, dates as ISO-8601, and reject lists and maps; `toString(null)` is `""`; `toNumber` accepts decimal text only (no `0x`, `0b`, or `0o`); `formatNumber` and `formatCurrency` reject a locale the runtime has no data for instead of using the host's default, a locale tag over 64 characters, and a currency that is not a three-letter code, and never show a negative zero (an amount that rounds to zero at the shown precision prints unsigned, so not `-$0.00`); `round` leaves a number of 2^53 or more as it is at zero or more digits; `toFixed` writes every digit of a number of 1e21 or more instead of exponent form; `formatDate` reads `''` inside quotes as a quote and rejects a quote left open; `timestamp()` reads back the six-digit signed years a timestamp renders outside 0000-9999; `sum` and `avg` of durations check the range at each step, as `a + b + c` does; `sum` of a list of durations sums them whether or not the list's type is known; `sum` and `avg` add left to right; `now()` is a timestamp; `sort()` orders numbers numerically; `includes`, `indexOf`, and `in` compare lists and maps by value, and `Date`s at the same instant are equal; `replace` and `replaceAll` insert their replacement text literally (no `$&` patterns).
  - Only plain objects and class instances are read as maps: reads see their own properties, and `keys()`, spread, and `==` see the enumerable ones, as in JavaScript. `Map`, `Set`, `RegExp`, promises, typed arrays, and errors are opaque; a plain object with a `then` method is an ordinary map and is never awaited. Map keys follow JavaScript property order. A computed read of `__proto__`, `constructor`, or `prototype` is `null`; writing one is a `BLOCKED_PROPERTY` error. `groupBy` keys are text, so `1` and `"1"` share a group.
  - `duration("PT1H30M")` reads ISO-8601 duration text, the text a duration renders as (weeks down to milliseconds; years and months have no fixed length and are refused). `min`, `max`, and `avg` take durations as `sum` does, given as a list or one by one (`max(a, b)`). A reserved word is not a method name: `a.not(b)` is a syntax error. Syntax errors suggest `**` for `^` and `!=` for `<>`. A `\u{...}` escape takes any number of leading zeros, as in JavaScript, and `1.e3` (a read of `e3` on `1`) is a check error that says to write `1e3`.

  **API**

  - `bonsai({ variables, strict, functions, libraries, limits, cacheSize, clock, validateContext })` creates an immutable environment; `extend()` derives one. `use()`, plugins, `addFunction`, `addContextFunction`, `addTransform`, `remove*`, `has*`, `isContextFunction`, `getPolicy`, and `clearCache` are removed.
  - Declaring `variables` makes an environment strict: undeclared names are check errors unless `strict: false`.
  - Host functions are declared with `fn({ params, returns, run })`, validated on every call, and must be marked `async` to be awaited. With `call: true`, `run` first receives `{ context, signal }`: the read-only context, and a signal that aborts when the evaluation times out or is cancelled while waiting on the call. A result that does not match the declared type, or a promise from a function not marked `async`, is a `HOST_CONTRACT` error that `try()` does not catch.
  - `env.compile(source, { expect })` type-checks and returns a `Program`, cached per source and expected type; `env.check()` replaces `validate()` and returns every diagnostic without throwing. Evaluation options include `now`, the time `now()` returns for that evaluation, and `validateContext`, which turns context validation on or off for that evaluation (context validation rejects `NaN` and infinities where a number is declared), and a `BonsaiLimitError` names the option that bounds it in `limit`. The context type comes from `variables` and the variables of the `libraries` used, instead of `bonsai<Ctx>()`. A schema typed `Record<string, Type>` accepts interface-typed and class contexts, and a variable `extend()` declares again replaces the earlier one in the context type. A context that is not an object is a `TypeError`.
  - `bonsai-js/service` (`createLanguageService`) replaces `bonsai-js/autocomplete`; the `stdlib` and `autocomplete` subpaths are removed. A source that is not a string or an offset that is not a number is a `TypeError`, and a negative or fractional offset a `RangeError`.
  - `print(tree, { calls })` turns a syntax tree back into source, round-tripping with `env.parse`. Syntax tree node types are renamed. `forEachChild` walks a tree and `mapChildren` rewrites one, both visiting children in evaluation order; member and call nodes record the span of their name (`nameStart`, `nameEnd`; optional in trees built by hand).
  - `program.explain(context)` (and `explainSync`, `env.explain`, `env.explainSync`) evaluates and returns a trace of every sub-expression's value, with skipped branches and per-item lambda runs; `reasons()` lists the conditions that decided the result, a negated condition as written (`!("vip" in tags)`, with its own value). Trace text is capped at 120 characters, and no cut in a trace or its rendering splits a surrogate pair. `String(explanation)`, `JSON.stringify(explanation)`, `JSON.stringify(explanation.reasons())`, and `JSON.stringify(explanation.trace)` are bounded and cycle-safe, and any trace, lambda run, or list of them picked out of it serializes as its part of `JSON.stringify(explanation)`; a map shows its first 50 keys and is listed once per explanation, so serializing never grows with its size, and trace records stay plain objects. An explanation serializes to the same frozen snapshot every time, whatever was serialized before. `explain()` refuses a promise-like result as `evaluate()` does, and marks a result refused after evaluation (a promise-like value, a failed `expect` check) on the root of the trace.
  - `program.partial(known, { unknown })` (or `env.partial(source, known)`) evaluates what the known data decides and returns a value, an error, or a residual expression over the unknown variables (its tree is `ast`, as on a program), to pre-evaluate rules once per tenant or request. Data missing from `known`, including a field missing from a known object, and a known object the expression reads whole, is unknown unless an `unknown` list is given; with one, an object above a listed path that `known` leaves out is unknown as a whole, not null. An `unknown` path starts with a variable name and names fields as reads spell them; an empty or blocked segment is a `TypeError`. It takes the same step, time, and cancellation budgets as evaluation; a size limit (`LIST_LIMIT`, `STRING_LIMIT`, `VALUE_DEPTH_LIMIT`, `PATTERN_LIMIT`) in a known part that evaluation may not reach stays in the residual rather than ending `partial()`, and a list literal over `maxListLength` reports that limit before its items, as evaluation does, in async programs too. Known data that throws when read (a getter, a Proxy trap) fails at that read, as in evaluation, so a read behind `&&` or inside `try()` decides as the program does, and no getter runs to decide which variables are given. A residual longer than `maxSourceLength` is a `SOURCE_TOO_LONG` limit error (`toSQL` and `toMongo`, which never evaluate its text, are not bound by it), and a residual can be explained like a program, at the step cost of evaluating it. A residual runs every call with the overload the program chose, and a part whose inputs all turn out known (`(2 ?? row.total) >= 1`) is decided rather than left in the residual. A residual's bindings are the known values themselves (shared with `known`, not copied), and `call: true` host functions in a residual read exactly the context it is given (`readsContext` says when it calls one; that context must then hold every variable `known` gave, or the call is an `INVALID_CONTEXT` error). With `validateContext`, `partial()` validates the known data (all but what lies under a listed unknown path), and a residual validates the paths it reads, each step against its own declared type, so a context holding only `dependsOn` passes and invalid data on those paths fails as it would for the program (the whole context when `readsContext`). `PartialResult` and `ResidualResult` take the context type first, as `Program` does. Partial evaluation keeps memory in proportion to the program and charges the work of indexing and compiling it.
  - `bonsai-js/query` (`toSQL`, `toMongo`) translates a filter over a declared record into a parameterized SQL `WHERE` clause (Postgres, SQLite) or a MongoDB filter that selects exactly the records the filter accepts. This covers the null-safe text forms (`x?.endsWith(k) ?? false`, `(x ?? "").endsWith(k)`), columns with a known default (`(order.total ?? 0) >= 500`), duration columns, and relative dates (`now() - order.placed < days(14)`). A path the filter reads that is missing from `known` is refused rather than read as null (in a typed environment, so is a known object read whole without every declared field), and every refusal says why. A known value that throws when read is refused with the host's error as the `cause`. One `maxSteps`, `timeout`, and `signal` budget covers the whole translation, including the partial evaluation it runs, and in SQL a known value is sent once however often the filter uses it. SQL arithmetic covers unary `-` as well as `+ - *`; in Postgres a record whose arithmetic leaves the double range fails the query with `value out of range` (never a different set of rows), where SQLite excludes it. `params` is typed so `node:sqlite` and Postgres drivers take it without a cast. Known dates and durations are checked as evaluation checks them, so a value evaluation treats as opaque is refused. A comparison whose sides are both known is decided before translating, a known list with repeated entries matches as its entries, and a text function on `(field ?? default)` runs on the default where the field is null, so it is never null. A part that fails whenever it is reached after a read of the record (a list literal over `maxListLength`, say) is refused as `UNTRANSLATABLE` (naming its error), never sent to the database, and a relative date excludes a record whose distance from the known time leaves the duration range, as evaluation fails it. Records are not validated: with `validateContext`, the database must enforce the declared types for exact results. With `callHostFunctions: true`, sync host functions with known inputs are called before translating. `BonsaiTranslationError` is exported from `bonsai-js` as well as `bonsai-js/query`.
  - Errors are `BonsaiError` subclasses with stable codes and `{ start, end }` spans. Diagnostics carry the same `span`, `position`, and `formatted` code frame, plus a `suggestion` for an unknown name; `env.check()` also returns the checked tree, the type of each node, and (when ok) the compiled program. Any `BonsaiError` that a getter or Proxy in the context throws (from another evaluation, a parse, a check, or a translation it runs, or one the host built) is a `HOST_ERROR` with it as `cause`, as for host functions, in evaluation, explanation, validation, and `partial()` alike; only the errors an evaluation raises itself keep their code. Any other thrown value becomes a `HOST_ERROR` too, including one whose inspection throws (a revoked Proxy), so `try()` recovers from it, and every trace node an explanation records for it says `HOST_ERROR`; `explain({ exhaustive: true })` ignores it in the extra work, whatever it is. A stack overflow in a host function is a `HOST_ERROR` like anything else it throws; one in a getter or Proxy trap is `TOO_DEEP` (the engine's error is its `cause`), which `try()` does not recover from and `partial()` leaves to a branch that may not run. Only the engines' own overflow errors count as overflows, not any `RangeError`. Async evaluation never awaits a value from the data: a thenable in the context stays opaque inside every node, lambda, and host call result (an `async` host function's own result is awaited by JavaScript, so it must not return one). Async evaluation and explanation check list limits, expected types, and the deadline in the same order as sync evaluation, so they run the same host calls and report the same error. A host call's signal is aborted with a copy of the evaluation's error, so host code rethrowing it elsewhere is that evaluation's `HOST_ERROR`. `ExpressionError`, `BonsaiTypeError`, `BonsaiReferenceError`, `BonsaiSecurityError`, `formatError`, `formatBonsaiError`, `evaluateExpression`, `tokenize`, and `compile` are removed (`parse(source)` returns the new syntax tree), as are the `allowedProperties` and `deniedProperties` options.
  - `JSON.stringify(error)` gives one documented shape (`BonsaiErrorJSON`: name, code, message, span, position, plus `limit` or `diagnostics`) wherever an error is serialized. Check results, their diagnostics, and partial results are frozen. A program's environment types are checked against `toSQL` and `toMongo` column types. `DiagnosticJSON` types the diagnostics in that JSON, without the `formatted` code frame. `isBonsaiError` also recognizes errors from another copy of the package.
  - Limits move under `limits`; `maxArrayLength` is now `maxListLength`, and `maxDepth` now bounds syntax nesting (`TOO_DEEP`); nested data is bounded by `maxValueDepth` (`VALUE_DEPTH_LIMIT`), counted alike when building, comparing, `unique()`, and validating. Built-ins check `maxListLength` before they build a list, `groupBy` groups included.
  - `maxDepth` is at most 256 and `maxValueDepth` at most 1,024 (a larger value is a `RangeError`), so every stage stays inside the JavaScript call stack; a stack overflow anywhere is a `TOO_DEEP` limit error, never a raw `RangeError`. Host `Duration` values are read by their own frozen length and rendered by the engine, never by their own methods; one built without the constructor is an opaque value.
  - `expect` means "has at least these fields": an extra field in a map literal is an `EXPECTED_TYPE` warning, and the result keeps it. Literal locales, currencies, and duration text are checked before anything runs. In a non-strict environment with declared variables, an undeclared name one edit from a declared one is an `UNKNOWN_VARIABLE` warning with a `suggestion`. Diagnostic messages shorten type text to 120 characters.
  - Spans are balanced: a parenthesized expression's span includes its parentheses, so slicing the source at any node, error, diagnostic, or explanation span gives source that parses on its own. A later computed key or spread record makes earlier map fields it may overwrite (and keys it may leave absent) part of the checked type, and `print()` keeps the parentheses of a right-nested `&&`, `||`, or `??` so the printed tree parses back to the same shape. `createLanguageService(env, { expect })` adds `EXPECTED_TYPE` to the service's diagnostics, its completions work inside `try()` and computed keys with the same types check() gives, and a negative or fractional offset is a `RangeError`. An ordering with a value that may be `null` is a `MAYBE_NULL` warning only where it is written so its `false` becomes a verdict (under `!`, as a `?:` test, in `every` or `none`, or compared with `false`, looking through `?:` branches, `let` bodies, `try`, and `== true`), not where it means "skip" (`users.filter(.age >= 18)`); it is a heuristic over how the comparison is written, and a literal written with an exponent is an `UNSAFE_INTEGER` warning only when the number cannot keep the digits written (`9007199254740993e0`, not `1e308` or an exact `1.180591620717411303424e21`). A computed or `groupBy` key that is always one evaluation blocks (`{["__proto__"]: 1}`, `` {[`constructor`]: 1} ``) is a `BLOCKED_PROPERTY` error at check time, a template without substitutions is typed as its text, and a key a map literal writes is always present when spread, and a spread after an open declared object keeps any key it may lack typed as whatever the object held. Code frames and shortened type text never split a surrogate pair, a CRLF line is shown without its `\r`, and the caret lines up by characters. Completions also work inside brackets, calls, templates, and branches of a `let` value, nested ones included (`let v = try(b ? user.`), and inside `has()`, and detail each field with the type the read has there, narrowing included. A completion costs at most 100 parses, and about 12 of a source near the length limit.
  - `withContext<Ctx>()` builds host functions typed against a context, `Infer` gives the TypeScript type of a `t` type, `formatType` and `isAssignable` print and compare types, and `env.describeFunction` / `env.listFunctions()` (read-only) describe the callable functions for editors and builders. Error classes keep their `name` (and the JSON `name`, typed `BonsaiErrorName`) in minified bundles; a call stack overflow is `TOO_DEEP` with no `limit`, since no option raises it. `ExplanationJSON` types `explanation.toJSON()`, `SQLParam` and `QueryOptions` name the query types, and the standalone `parse(source, limits)` ignores the limits parsing does not use. The [stability policy](https://danfry1.github.io/bonsai-js/guide/stability) says what a minor release may change; the result type parameter of `env.evaluate<R>()` and the other environment calls is an unchecked assertion.
  - Requires Node.js 22 or newer.

  **Engine**

  - Expressions compile to closures. Async code is generated only for subtrees that reach an async host function. Compiling an expression that uses time zones loads their data (each zone it names once, and at most 16 per expression), so a first evaluation does not spend its `timeout` on it; a zone that comes from data, or that `partial()` writes into a residual, loads on first use.
  - The package ships one module per source file, so bundlers drop what an app does not reach: importing only `t` adds under 1 KB gzipped, and all the error classes about 1.6 KB. The `bonsai-js/service` entry is about 46 KB gzipped, since it includes the type checker. A minimal browser bundle that evaluates expressions is about 68 KB gzipped, and about 56 KB from `bonsai-js/lite`, which exports the same API without explaining and partial evaluation (`LiteEnvironment`, `LiteProgram`, and `LiteCheckResult` type its environments; the language service accepts them, and `toSQL` and `toMongo`, which translate through partial evaluation, say they cannot take its programs).
  - Every limit is on by default: source size, depth, node count, a deterministic step budget charged by the real cost of each operation, produced string and list sizes, value depth, regular expression pattern length, plus an optional timeout (in milliseconds, fractions allowed; only `0` turns it off) and `AbortSignal`. A built-in call is charged by the length of its string arguments, and an `ABORTED` error carries the signal's reason as its `cause`.

## [0.5.0] - 2026-06-02

### Security

- Bounded parser recursion: pathologically nested input (deep parentheses, unary chains) now fails closed with a typed `ExpressionError` ("Maximum expression nesting depth exceeded") instead of overflowing the native call stack with an uncaught `RangeError`. `validate()` reports it as a normal syntax error rather than a stack-overflow message.
- `maxArrayLength` is now enforced on array-returning methods (`split`, `map`, `flatMap`, `flat`, `concat`, `toSorted`, `toReversed`, `with`, `toSpliced`), not just array literals and spread, in both the sync and async evaluators.
- Added `maxStringLength` (default 100,000) and enforced it as a ceiling on every string produced by a method call, in both the sync and async evaluators. `padStart`/`padEnd`/`repeat` are checked before allocation (capping the produced length, not just the repeat count); all other string-returning methods (`join`, `concat`, `slice`, `toUpperCase`, ...) are checked on their output. This closes single-operation amplifiers such as `arr.join(sep)`, whose output length is array length times separator length in one native call that the cooperative timeout cannot interrupt.

### Added

- `maxStringLength` option on `bonsai(options)` and a `BonsaiSecurityError('MAX_STRING_LENGTH', ...)` error code.
- `bonsai(options)` now validates its options and throws a `RangeError`/`TypeError` at construction for out-of-range values (negative `cacheSize`, non-positive `maxDepth`, negative `maxArrayLength`/`maxStringLength`, negative or non-finite `timeout`, allow/deny lists that are not arrays of strings). Previously a negative `cacheSize` silently disabled caching and other bad values failed later with confusing errors.

### Fixed

- Async/sync parity for higher-order array methods (`map`, `filter`, `find`, `some`, `every`, `findIndex`, `flatMap`). Predicates now evaluate sequentially in the async evaluator, matching the synchronous one: `some`/`every`/`find`/`findIndex` short-circuit at the first decisive element, and `maxDepth` is no longer inflated by array length (an expression that succeeded with `evaluateSync` could previously throw a spurious `Maximum expression depth` error with `evaluate`).
- Malformed numeric literals now raise a parse-time `ExpressionError` instead of silently evaluating to `NaN` or coercing: a base prefix or exponent with no digits (`1e`, `1e+`, `0x`, `0b`, `0o`), and misplaced numeric separators (`1_`, `1__0`, `0xff_`), which are rejected the way JavaScript rejects them.
- Template interpolations containing string literals or nested template literals with braces (for example `` `${ "x}" }` `` or `` `${ `a}b` }` ``) now parse correctly instead of failing with an "Unterminated string"/"Unterminated template literal" error.
- Higher-order array helpers now fail loud on a non-function callback instead of silently doing the wrong thing. The lambda shorthand (`.x`, `. > 0`) is a function value; passing it to a function (for example `map(inc(.x))`) evaluates to a plain value, which previously made the stdlib `map`/`filter`/`find`/`some`/`every` transforms silently return the input unchanged and the `.map`/`.filter`/`.find`/`.findIndex`/`.some`/`.every`/`.flatMap` methods throw a raw `TypeError`. Both now throw a typed `BonsaiTypeError` naming the helper. No-argument forms (`|> map`, `|> filter`) are unaffected.
- Autocomplete no longer suggests `array.toString`, which the evaluator rejects (the method allowlist and the autocomplete catalog now derive from one shared source, so they cannot drift). Method completions also respect `allowedProperties`, matching the evaluator, so a method that would be rejected at runtime is no longer offered.
- stdlib correctness: `formatDate` now replaces every occurrence of a token (not just the first, so `"YYYY/YYYY"` works); `min`/`max` validate their arguments are numbers and return `undefined` for no arguments instead of leaking `Infinity`/`-Infinity`; `clamp` rejects non-finite bounds and `min > max`; `sort` orders strings by code point for deterministic, locale-independent results. NaN passthrough in the numeric transforms is now documented.

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
