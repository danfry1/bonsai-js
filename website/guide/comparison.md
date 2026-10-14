# Compared with Other Libraries

Several JavaScript libraries evaluate rules or expressions written outside your codebase. They make different trade-offs, and for many projects one of them is a better fit than Bonsai. This page compares them on facts measured on one machine or taken from each library's own documentation, so you can choose.

Everything here was measured on 2026-10-14 with the versions listed under [Methodology](#methodology). Libraries change; if a row is out of date, please open an issue.

## At a glance

| Library | Rules are | Min / gzip (browser) | Static check against a schema | Explains results | Evaluation budget (as documented) |
| --- | --- | --- | --- | --- | --- |
| bonsai-js | text, JS-like | 200.9 KB / 67.6 KB | Yes, with suggestions | Yes | Yes, on by default |
| @marcbachmann/cel-js 8.0.0 | text, CEL | 84.0 KB / 24.3 KB | Yes | No | Parse-time limits |
| @gorules/zen-engine 2.1.2 | text expressions, JSON decisions | Node native addon; WASM build below | Yes (see notes) | Partial | Graph depth and function-node timeout |
| json-rules-engine 7.3.1 | JSON | 83.5 KB / 24.3 KB | No | Yes | No |
| json-logic-js 2.0.5 | JSON | 5.8 KB / 2.0 KB | No | No | No |
| jsonata 2.2.2 | text, JSONata | 84.0 KB / 26.5 KB | No | No | No |
| jexl 2.3.0 | text, JS-like | 20.4 KB / 6.1 KB | No | No | No |
| filtrex 3.1.0 | text, own syntax | 26.5 KB / 7.8 KB | No | No | No |
| expr-eval 2.0.2 | text, math-like | 26.4 KB / 8.0 KB | No | No | No |
| expr-eval-fork 3.0.3 | text, math-like | 27.9 KB / 8.4 KB | No | No | No |

`@gorules/zen-engine-wasm` 0.23.1, the browser build of the ZEN expression engine, is 12.7 KB / 4.1 KB of JavaScript plus a 1,736,841-byte WebAssembly file (469,794 bytes gzipped) fetched at startup. Its README describes it as experimental and expressions-only.

## Where each one is the better choice

- **json-logic-js** is the smallest by far (2.0 KB gzipped, under 3% of Bonsai) and its rules are plain JSON, which suits a visual rule builder that emits JSON and a backend that stores it.
- **json-rules-engine** is a rules engine rather than an expression language: rules with events and asynchronous facts, stored as JSON, and every condition's fact value and result is reported back. Choose it when the problem is "fire events when conditions hold" and rules are edited as structured forms.
- **@marcbachmann/cel-js** implements the [Common Expression Language](https://github.com/google/cel-spec), a specification with implementations in other languages (its README links the Go implementation). Choose it when the same expressions must also run in Go, Java, or C++ services, or when CEL is already used in your stack (for example in policy systems). It type-checks against declared types, is about a third of Bonsai's browser size, and is fast.
- **@gorules/zen-engine** is a full business rules engine with decision tables, decision graphs, policy documents, a visual editor, and bindings for Node.js, Python, Go, Java, Kotlin, and .NET (per its README). Choose it when business users should edit decision tables, when the same rules must run on several platforms, or when you want a hosted rules platform. On Node.js it is a native addon (the darwin-arm64 binary is 21 MB on disk); in the browser it needs a 470 KB gzipped WebAssembly file.
- **jsonata** is a query and transformation language for JSON. Choose it when users reshape documents, not only test conditions. It is asynchronous and its date functions take UTC offsets rather than time zone names.
- **filtrex** compiles expressions to JavaScript functions and was the second fastest in the throughput test. It suits short filters in apps whose Content Security Policy allows `new Function`.
- **jexl** is small (6.1 KB) with JavaScript-like syntax and asynchronous transforms. Its last npm release was in 2020.
- **expr-eval** and **expr-eval-fork** suit math formulas and offer partial evaluation through `simplify()`.

**Bonsai's weaknesses.** It has the largest browser bundle of the libraries measured (67.6 KB gzipped, about 2.8 times cel-js and json-rules-engine; `bonsai-js/lite`, without explaining and partial evaluation, is about 56 KB). It is new. It runs only in JavaScript, so a Go or Python service cannot evaluate the same rules. It needs Node.js 22 or newer and is ESM-only. It has no decision tables or visual rule editor of its own (it provides a syntax tree, a printer, and a language service to build one). And it is not a standard: CEL expressions are portable to other CEL implementations, Bonsai expressions are not.

**Where Bonsai fits.** Bonsai is for text expressions written by people other than your developers, where you want to reject a broken rule when it is saved (with "did you mean" suggestions and exact ranges), show the author why a rule passed or failed, bound every evaluation deterministically, and optionally run the same filter in SQL or MongoDB. It is the only library measured here that does all of these in one package.

## Authoring features

Verified by running code unless the note says "per docs".

| | Bonsai | cel-js | zen-engine | json-rules-engine | json-logic-js | jsonata | jexl | filtrex | expr-eval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Static type check against a schema | Yes | Yes | Yes (note 1) | No | No | No | No | No | No |
| "Did you mean" suggestions | Yes | No | Not observed | No | No | No | No | No | No |
| Editor completions or hover shipped | Yes | No | Yes (note 2) | No | No | No | No | No | No |
| Explains why a rule passed or failed | Yes | No | Partial (note 3) | Yes | No | No | No | No | No |
| Partial evaluation | Yes | No | No | No | No | No | No | No | Yes (`simplify`) |
| Translation to SQL or MongoDB | Yes | No | No | No | No | No | No | No | No |
| Async host functions | Yes | Yes | Partial (note 4) | Yes (async facts) | No | Yes | Yes (transforms) | No | No |
| Date, time, and time zones | Yes, IANA zones | Yes, IANA zones | Yes, IANA zones | No | No | Partial (note 5) | No | No | No |
| Syntax | JS-like | CEL | ZEN (`and`, `or`) | JSON | JSON | JSONata | JS-like | own (`and`, `of`) | math-like |
| Rule stored as | text | text | text; decisions as JSON | JSON | JSON | text | text | text | text |
| TypeScript types | bundled, inferred from schema | bundled | bundled | bundled | `@types/json-logic-js` | bundled | `@types/jexl` | bundled | bundled |
| Runtime dependencies | 0 | 0 | 0 (plus a native binary per platform) | 4 direct, 7 installed | 0 | 0 | 1 (`@babel/runtime`) | 0 | 0 |
| Works under a CSP that forbids `eval` | Yes | Yes | Native on Node.js; the WASM glue uses `new Function` (note 6) | Yes (note 7) | Yes | Yes | Yes | No, compiles with `new Function` | Yes, except `toJSFunction()` |

`expr-eval-fork` matches `expr-eval` in every row of this table.

Notes:

1. The WebAssembly build's `VariableType.typeCheck` reported `` Operator `+` cannot be applied to types `number` and `"x"` `` for `user.age + "x"`, but typed the misspelled `user.agee` as `Any` without an error. The Node.js package's `Workspace` performs static type checking across policies and graphs (per its README; not exercised here).
2. In Node.js, `slotBatch` returned the field types available after `user.`; the WebAssembly build's `getCompletions()` returned 87 function entries. GoRules also publishes a React decision editor (per its README).
3. A decision evaluated with `{ trace: true }` reports each node's input and output and each named expression's result, not the sub-expressions inside one expression.
4. Standalone expressions have no host function API in the type declarations; decision graphs can call an async `customHandler` for custom nodes (per `index.d.ts`).
5. `$fromMillis(..., "[H01]", "-0500")` returned `"07"`; with `"America/New_York"` it returned `"NaN"`.
6. The wasm-bindgen glue in `@gorules/zen-engine-wasm` contains `new Function(...)`. The Node.js package is a native addon.
7. `jsonpath-plus`, a dependency, contains `new Function` for its `eval: 'native'` mode; its default is `'safe'`, and json-rules-engine does not change it.

How a misspelled field behaved without a schema check (`user.agee >= 18` with `user.age = 20`): jexl, json-logic-js, and expr-eval returned `false`; jsonata returned `undefined`; json-rules-engine did not fire the rule; filtrex returned an `Error` value at evaluation time; zen-engine threw `Opcode Compare: Unsupported type` at evaluation time.

## Bonsai's guarantees under hostile input

Each probe ran against Bonsai in its own Node.js process. `xs` is a list of 1,000 numbers, and `s` is `"a"` repeated 32 times followed by `"!"`.

| Probe | Result |
| --- | --- |
| `user.constructor`, `user.__proto__`, `"".constructor` | rejected when parsed: `Property "constructor" is not accessible` |
| `user["constructor"]["constructor"]` | `null` |
| `map` nested three deep over `xs` (10^9 operations) | `STEP_LIMIT` after 8 ms |
| `s.matches("(a+)+$")` | `false` in 2 ms (linear-time matcher) |
| `"x".repeat(1000000000)` | `STRING_LIMIT` in 2 ms |
| 10,000 nested parentheses | `TOO_DEEP` in 2 ms |

The step budget is on by default (1,000,000 steps per evaluation) and deterministic, so the same expression over the same data stops at the same point on any machine. See [Safety](/guide/safety) and [Limits](/api/limits).

For the other libraries, the "Evaluation budget" column above records what each documents: cel-js documents parse-time structural limits (`maxAstNodes`, `maxDepth`, list and map sizes); zen-engine documents a `maxDepth` option for decision graphs and a `functionTimeoutMillis` setting for JavaScript function nodes.

## Throughput

`user.age >= 18 && user.plan == "pro"` in each library's syntax, compiled once where the library allows it, evaluated 200,000 times alternating a passing and a failing context after 20,000 warm-up calls. One run on one machine; treat the numbers as indicative only.

| Library | Evaluations per second | Note |
| --- | --- | --- |
| Bonsai | 27.4 million | |
| filtrex | 16.8 million | compiled with `new Function` |
| cel-js | 12.6 million | |
| expr-eval | 9.1 million | |
| expr-eval-fork | 6.7 million | |
| json-logic-js | 4.4 million | no compile step |
| jexl | 1.7 million | |
| jsonata | 0.66 million | `evaluate()` returns a promise |
| zen-engine | 0.66 million | `evaluateExpressionSync`, which takes the source on every call |
| json-rules-engine | 0.10 million | asynchronous `engine.run()` per evaluation |

## Versions and releases

| Package | Version used (published) | Newest on 2026-10-14 |
| --- | --- | --- |
| bonsai-js | built from commit `e2d89dc` | |
| @marcbachmann/cel-js | 8.0.0 (2026-07-07) | 8.0.0 |
| @gorules/zen-engine | 2.1.2 (2026-10-02) | 2.1.7 |
| json-rules-engine | 7.3.1 (2025-02-20) | 7.3.1 |
| json-logic-js | 2.0.5 (2024-07-09) | 2.0.5 |
| jsonata | 2.2.2 (2026-07-16) | 2.2.2 |
| jexl | 2.3.0 (2020-09-15) | 2.3.0 |
| filtrex | 3.1.0 (2024-10-14) | 3.1.0 |
| expr-eval | 2.0.2 (2019-09-28) | 2.0.2 |
| expr-eval-fork | 3.0.3 (2026-02-02) | 3.0.3 |

## Methodology

- **Date and machine.** 2026-10-14, Apple M5 (10 cores, 24 GB), macOS (Darwin 25.5.0), Node.js 24.13.0, Bun 1.3.14, npm 11.19.0. The machine was shared; the 1-minute load average was between 3 and 8 during measurements.
- **Versions.** For each library, the newest version published at least 7 days before the measurement date, installed with `npm install --ignore-scripts --save-exact <pkg>@<version>` into its own directory. `@gorules/zen-engine` 2.1.7 was newer but under 7 days old, so 2.1.2 was used. Bonsai was built from commit `e2d89dc` (`bun install --frozen-lockfile --ignore-scripts`, `bun run build`, `npm pack`) and installed from the tarball.
- **Bundle size.** A minimal consumer per library evaluates the rule above, bundled with `bun build <entry> --minify --target=browser` and compressed with gzip level 9, the method of Bonsai's `scripts/size-budget.ts`. Each bundle was also run in Node.js and returned `true`; none was run in a browser. No library needed polyfills to bundle. The zen WebAssembly file is loaded with `new URL(..., import.meta.url)` and was measured separately.
- **Features.** Each "Yes" or "No" comes from a script that calls the library, except where a note says "per docs" or cites the README or type declarations. "No" for features such as partial evaluation or SQL means no such API appears in the package's README or type declarations; companion packages from other authors were not evaluated.
- **eval.** The shipped JavaScript of each package and its installed dependencies was searched for `new Function(` and `eval(`, and every match was read.
- **Bonsai probes.** Each probe ran as `perl -e 'alarm 10; exec @ARGV' node probe.mjs <name>`.
- **Throughput.** See [Throughput](#throughput). Bonsai's own benchmark against cel-js over several workloads is `bun run bench` (`benchmarks/vs-cel.bench.ts`).
