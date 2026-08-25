# Architecture

This document orients contributors to how bonsai turns an expression string into
a value. For the public API and the lambda/safety model, see the
[README](./README.md); for the support boundary, see
[docs/stability-policy.md](./docs/stability-policy.md).

## Pipeline

```
source string
  -> tokenize        (src/lexer.ts)      -> Token[]
  -> parse           (src/parser.ts)     -> ASTNode      (recursive-descent / Pratt)
  -> compile         (src/compiler.ts)   -> ASTNode      (constant folding + dead-branch elimination)
  -> evaluate        (src/evaluator.ts)        -> value          (synchronous)
     evaluateAsync   (src/evaluator-async.ts)  -> Promise<value> (asynchronous)
```

A `bonsai()` instance (`src/index.ts`) wires these together and adds:

- **Caching** (`src/cache.ts`): an LRU for parsed-and-compiled ASTs keyed by
  source and one for `CompiledExpression` objects keyed by extension-registry
  revision plus source.
- **A pooled `ExecutionContext`** (`src/execution-context.ts`) reused across
  `evaluateSync` calls to avoid per-call allocation on the hot path. A
  reentrancy guard allocates a fresh context when a registered function calls
  back into `evaluateSync` mid-evaluation.
- **A revisioned plugin registry** (`src/plugins.ts`) holding transforms (used
  with `|>`) and the shared pure/context function namespace. Each mutation
  creates immutable bindings; compiled expressions capture one revision,
  plugin application is transactional, and `seal()` permanently closes the
  registry.

## Security

The sandbox is enforced in `src/execution-context.ts` (`SecurityPolicy` +
`ExecutionContext`) and `src/eval-ops.ts`:

- blocked properties (`__proto__`, `constructor`, `prototype`) at every access
  level; own-property-only reads; allow/deny lists for member and method names;
- pre-evaluation source, token, AST, object-property, and call-argument limits;
- depth, array-size, string-size, and step limits, plus cooperative timeouts and
  per-run cancellation;
- a method allowlist keyed by receiver type (`src/safe-methods.ts`) that invokes
  captured intrinsics instead of receiver properties;
- branded Bonsai-only higher-order callbacks; index-based spread that never
  consults an iterator; subclasses and arrays with own constructor or
  spreadability hooks neutralized before species-producing intrinsics run;
- primitive-only conversion rules (`src/coerce.ts`) that cannot call host
  `toString`, `valueOf`, or `Symbol.toPrimitive` hooks.

All shared evaluation primitives (operators, member access, method validation,
array receiver resolution, spread expansion, result-size checks) live in
`src/eval-ops.ts` so both evaluators apply identical rules. The portable
`tests/fixtures/v1-semantics.json` corpus runs through one-shot and compiled,
sync and async paths and is the compatibility oracle for language behavior.

## Why there are two evaluators (and four tree-walks)

`evaluate` (sync) and `evaluateAsync` (async) are intentionally separate, and
each contains a second inline walk for lambda bodies (`.x`, `. > 0`). This is a
deliberate trade, not an oversight:

- A single walk that is always `async` would force the synchronous path to
  allocate a Promise and schedule a microtask at every node; bonsai's value
  proposition includes a fast synchronous path, so that regression is not
  acceptable.
- A single "maybe-async" walk (check-for-Promise-then-thread) adds a branch and
  a closure allocation per node even when nothing is async, also regressing the
  sync path.

So the duplication buys a fast sync path. The cost is that **any change to
node evaluation semantics or a security guard must be reflected in all four walks**:
`evalNode`/`evalCompound` and `evalLambdaBody` in `src/evaluator.ts`, and
`evalNodeAsync`/`evalCompoundAsync` and `evalLambdaBodyAsync` in
`src/evaluator-async.ts`. Shared operation helpers remove duplication where they
can; for example, the async top-level and lambda walks use one method-call path.

This rule is enforced by tests, not just convention:

- `tests/parity.test.ts` runs a curated corpus through both evaluators and
  asserts identical results.
- `tests/property.test.ts` fuzzes generated expressions (including transforms,
  methods, pipes, and lambdas) and asserts `evaluateSync`, `evaluate`, and
  `compile().evaluate*` all agree.

If you change one walk, run the suite; a divergence will surface there.

## Performance

bonsai aims to be the fastest safe expression evaluator without paying for it in
clarity or safety. The rule for optimization here is narrow: a change may remove
*wasted* work, but it must keep results, evaluation semantics, and every security
guard identical. Speed is never bought with a trick a reviewer has to forgive.

What that looks like in practice:

- **A leaf fast path.** `evalNode` returns literals and identifiers without depth
  tracking or step counting; only compound nodes pay for those guards.
- **Pooled per-evaluation state.** The synchronous path reuses one
  `ExecutionContext` and one `EvalEnv` per instance instead of allocating them per
  call. Reuse is gated by an in-use flag; a reentrant call (a registered function
  calling back into `evaluateSync`) falls back to fresh allocation, so the pool is
  never aliased.
- **Compile-time work stays at compile time.** Constant folding and dead-branch
  elimination run once in `src/compiler.ts`, and the cache (`src/cache.ts`) keeps
  the parsed-and-compiled AST so steady-state evaluation skips lexing and parsing
  entirely.
- **Registry snapshots avoid lookup churn.** One-shot evaluation reads the
  current immutable bindings object; a compiled expression captures that object
  once. Replacing an extension never changes an already-compiled rule.
- **Static guards are not re-checked per value.** Where a property name is known
  statically (`obj.prop`), access takes a fast path that does not re-derive the
  key or run checks that the policy makes constant.

This is kept honest by `bun run bench:gate` (a throughput floor that fails a
catastrophic regression) and by the parity and property tests: a "faster" change
that alters any result cannot pass.

### Non-goals

Some well-known ways to go faster are deliberately declined, because each trades
away something bonsai treats as load-bearing:

- **A native or WebAssembly evaluator.** The interpreter touches host JavaScript
  values on almost every node: context properties, built-in methods, and
  user-registered functions and transforms. A native or WASM core would marshal
  across the host boundary on each of those accesses, and that crossing would
  dominate the nanoseconds the pure-JS path already takes. It would also cost the
  zero-dependency install, browser support, and a sandbox that can be audited in
  one language.
- **Code generation via `new Function`.** Generating and running source is the
  theoretical ceiling, but it executes constructed code and requires
  `unsafe-eval` under a Content Security Policy. For a sandbox whose purpose is to
  not run arbitrary code, that is a non-starter.
- **A second "compiled closure" evaluation engine.** Compiling each AST to nested
  closures measures at roughly 2 to 3x on boolean and comparison expressions, but
  it would duplicate every node type and every security guard into another engine
  (plus an async variant), doubling the surface the parity tests hold together and
  reintroducing the maybe-async problem above. It stays a documented option to
  revisit if a batch-filtering workload ever needs it, not a default.

## Autocomplete

`src/autocomplete/` is an independent, optional subpath (`bonsai-js/autocomplete`).
It uses a tolerant tokenizer that falls back to a regex scanner for the
incomplete expressions typical while typing, and filters suggestions through the
instance security policy. Inference is deliberately static: it snapshots own
data properties and consumes declarative extension metadata, but never calls a
transform, function, getter, or expression while the user is typing.

## Static checker

`src/checker/` is another optional subpath (`bonsai-js/checker`). Its
JSON-serializable type descriptors, AST walk, assignability rules, and stable
diagnostics form the typed control plane. It reads the instance's frozen
extension metadata and security policy but never imports or calls extension
implementations. Keeping it in a subpath preserves the core evaluator's bundle
and hot path. Autocomplete accepts the same schema descriptors, so checking and
completion share one declared view of context data.
