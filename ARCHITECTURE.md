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

- **Caching** (`src/cache.ts`): an LRU for parsed-and-compiled ASTs and one for
  `CompiledExpression` objects, both keyed by source string.
- **A pooled `ExecutionContext`** (`src/execution-context.ts`) reused across
  `evaluateSync` calls to avoid per-call allocation on the hot path. A
  reentrancy guard allocates a fresh context when a registered function calls
  back into `evaluateSync` mid-evaluation.
- **A plugin registry** (`src/plugins.ts`) holding transforms (used with `|>`)
  and the shared pure/context function namespace.

## Security

The sandbox is enforced in `src/execution-context.ts` (`SecurityPolicy` +
`ExecutionContext`) and `src/eval-ops.ts`:

- blocked properties (`__proto__`, `constructor`, `prototype`) at every access
  level; allow/deny lists for member and method names;
- depth, array-size, and string-size limits, plus a cooperative step/timeout;
- a method allowlist keyed by receiver type (`isAllowedReceiver`).

All shared evaluation primitives (operators, member access, method validation,
spread expansion, result-size checks) live in `src/eval-ops.ts` so both
evaluators apply identical rules.

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
evaluation semantics or a security guard must be made in all four walks**:
`evalNode`/`evalCompound` and `evalLambdaBody` in `src/evaluator.ts`, and
`evalNodeAsync`/`evalCompoundAsync` and `evalLambdaBodyAsync` in
`src/evaluator-async.ts`.

This rule is enforced by tests, not just convention:

- `tests/parity.test.ts` runs a curated corpus through both evaluators and
  asserts identical results.
- `tests/property.test.ts` fuzzes generated expressions (including transforms,
  methods, pipes, and lambdas) and asserts `evaluateSync`, `evaluate`, and
  `compile().evaluate*` all agree.

If you change one walk, run the suite; a divergence will surface there.

## Autocomplete

`src/autocomplete/` is an independent, optional subpath (`bonsai-js/autocomplete`).
It uses a tolerant tokenizer that falls back to a regex scanner for the
incomplete expressions typical while typing, and filters suggestions through the
instance security policy.
