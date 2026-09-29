# Architecture

How Bonsai turns an expression string into a value. The language itself is
specified in [docs/language.md](./docs/language.md).

## Pipeline

```
source
  -> tokenize   src/syntax/lexer.ts     tokens (comments dropped, templates pre-scanned)
  -> parse      src/syntax/parser.ts    syntax tree (precedence climbing; depth/node/size limits)
  -> analyze    src/check/checker.ts    bind "." to lambdas, infer types, resolve overloads
  -> compile    src/compile/compiler.ts closures over a per-run State
  -> run        src/environment.ts      evaluate / evaluateSync
```

Every phase has its own limits, so a hostile expression is rejected at the
cheapest point: size before lexing, depth and node count while parsing, work
and output size while running.

### Parse

One precedence-climbing parser produces a JSON-serializable tree
(`src/syntax/ast.ts`). Names bound by `let` and lambda parameters are resolved
to `Local` nodes here; everything else is a `Variable`. The implicit parameter
`.` is left as an `It` node, because which lambda it belongs to depends on
function signatures.

### Analyze

`analyze()` runs two passes over the tree:

1. **Binding.** An argument whose parameter is function-typed (per the
   function's overloads) and that contains a free `It` becomes an implicit
   `Lambda`. This is what makes `users.filter(.score > max(.a, .b))` mean the
   natural thing: `max` does not take a function, so `.a` belongs to `filter`.
2. **Types.** Gradual type inference over `src/types.ts`. It reports
   diagnostics, resolves each call to candidate overloads (a single candidate
   with proven argument types is marked `direct`, so the runtime skips
   dispatch), and marks every node on a path to an async host function.

The same analysis powers `env.check`, `env.compile`, and the language service
(`src/service`), which completes by analyzing the text before the cursor with a
probe identifier and synthesized closing brackets. There is one inference
engine.

### Compile

Each node becomes a closure `(state) => value`. There is no tree-walking
interpreter and no generated JavaScript (CSP-safe).

- **Async only where needed.** In async mode a node becomes an `async`
  closure only if the analysis marked it as reaching an async host function.
  Pure data and operator subtrees stay synchronous even inside `evaluate()`,
  so an expression with no async calls runs at synchronous speed either way.
  Strict nodes (operators, member reads, literals, templates) are defined by one
  semantic function used by both the sync and the async closure; only
  short-circuiting nodes (`&&`, `||`, `??`, `?:`, `try`, `let`, calls) spell
  out both forms.
- **Static slots.** Lambda parameters and `let` bindings get fixed indices into
  `state.locals`. There is no recursion and evaluation within one run is
  sequential (including async), so a slot is never live twice.
- **Specialization.** Chains of static member reads fuse into one closure; hot
  operators have single-closure fast paths for numbers; member reads directly on
  a lambda parameter read the slot inline.

### Run

`State` (`src/runtime/state.ts`) holds the context, locals, step counter,
deadline, and abort signal. `charge(n)` is one addition and one comparison
against `nextSample`, the next step count at which the step limit or the clock
needs checking. The synchronous path reuses one pooled `State` per program
(falling back to a fresh one on reentrancy); async runs always get their own.

## Values and the cost model

`src/runtime/values.ts` implements the value semantics: kinds, deep equality,
ordering (with `null` making comparisons false), arithmetic with the duration
and timestamp rules, member and index reads (own properties only, blocked keys
rejected), and template rendering.

Straight-line code is bounded by the AST size limit. Every operation charges
steps for its real worst-case cost before it runs: lambda invocations, equality
and membership over lists and maps, concatenation, spread, templates,
characters scanned by text search and comparison, regular expression
compilation and matching, sort comparisons, time zone conversions, and the
size of lists and maps an expression builds. A single native call never does
unbounded work between budget checks, so steps bound wall-clock time too.
Sizes are checked before allocation, and built values are limited in depth.
Host lists are copied by index before built-ins touch them, so no host
iterator, species hook, or method ever runs.

## Functions

Built-ins (`src/functions/builtins.ts`) and host functions share one
representation (`FunctionDef` with typed `Overload`s, `src/functions/define.ts`).
The checker reads the declared types; the compiler dispatches on runtime kinds
only when static types did not prove a single overload. Higher-order built-ins
have a synchronous loop and an `async` variant used only when a lambda body
awaits a host function. Host functions get deep argument validation and a
deep result check around every call; a mismatch is `HOST_CONTRACT`.

## Environments

`bonsai()` (`src/environment.ts`) builds an immutable environment: variable
types, host functions, limits, and a clock. `extend()` derives a new one. There
is no registry mutation, so compiled programs never observe later changes.
`evaluate(source)` compiles through an LRU cache keyed by source.

## Invariants the tests hold

- `tests/conformance.test.ts` pins the language against the spec, running every
  case through `evaluateSync`, `evaluate`, and a compiled program.
- `tests/security.test.ts` and `tests/limits.test.ts` pin the sandbox and every
  resource limit.
- `scripts/fuzz.ts` generates expressions and checks that no non-Bonsai error
  escapes, that all three evaluation paths agree, and that checked expressions
  do not fail with type errors on conforming data.
