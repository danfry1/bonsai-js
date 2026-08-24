# Bonsai v1 Contract

Status: release-candidate contract. This document defines what `1.0.0` means;
it is intentionally narrower than the project roadmap.

## Product promise

Bonsai v1 is a small, dependency-free expression language for evaluating
untrusted expression text against host-supplied data. It provides the runtime,
static checker, and autocomplete metadata needed to author the same language
without evaluating JavaScript source or extension code.

It is not a JavaScript subset, a process sandbox, a workflow engine, or a
cross-language rule interchange format.

## Sources of truth

| Contract area | Normative source |
|---|---|
| Expression behavior | `docs/language-semantics.md` and `tests/fixtures/v1-semantics.json` |
| Public package/API stability | `docs/stability-policy.md` and packed declaration tests |
| Threat boundary and non-guarantees | `docs/threat-model.md` and `SECURITY.md` |
| Static type behavior | `docs/static-type-system.md` and checker diagnostics tests |
| Performance regressions | `scripts/perf-gate.ts` and `scripts/perf-compare.ts` |
| Release readiness evidence | `docs/v1-readiness.md` |

When prose and an executable fixture disagree before v1, they must be reconciled
before release. After v1, changing an existing fixture's meaning requires a
major version.

## Stable package surfaces

V1 supports four ESM entrypoints:

- `bonsai-js`: evaluator, compiler/parser helpers, errors, public types, and
  static type builders;
- `bonsai-js/stdlib`: opt-in string, array, math, type, and date plugins;
- `bonsai-js/checker`: schema-based semantic checking and type utilities;
- `bonsai-js/autocomplete`: side-effect-free completion over context values or
  static schemas.

The root API commits to `bonsai()`, `evaluateExpression()`, `tokenize()`,
`parse()`, `compile()`, `t`, the documented error classes/guards, and the types
exported from the root declaration. A `bonsai()` instance commits to evaluation,
compilation, validation, extension registration/replacement/removal, metadata
inspection, policy inspection, cache clearing, and registry sealing.

`evaluate<T>()` and `evaluateSync<T>()` use `T` as a caller assertion; they do
not prove a dynamic expression's result. Applications that require proof use
the checker against a schema before evaluation.

## Evaluation and lifecycle

- `evaluateSync()` is the allocation-conscious synchronous path and rejects a
  Promise-like extension result with a Bonsai typed error.
- `evaluate()` always returns a Promise, awaits extensions and lambdas, and
  preserves sync/async semantic parity. Async higher-order callbacks run
  sequentially and retain native short-circuit order.
- `compile()` does not generate or execute JavaScript. A compiled expression
  captures the immutable extension-registry revision present at compilation;
  later replacements do not alter it.
- `validate()` checks syntax and references only. Semantic type diagnostics are
  the checker's responsibility; the two phases deliberately do not share a
  misleading name.
- `seal()` permanently closes an instance's registry. Registration is
  transactional, and pure/context functions share one namespace.
- Context-aware functions receive the live context by reference. `Readonly<T>`
  communicates intent but does not copy or freeze nested data.

## Authoring control plane

Extension metadata is the shared contract for runtime argument validation,
checker signatures, and autocomplete. Bundled stdlib metadata is tested as an
exact catalog.

The checker and autocomplete never invoke a registered extension. Autocomplete
also avoids context accessors while inspecting live values. A static schema is
the recommended authoring source whenever the live context contains getters,
Proxies, secrets, or expensive objects.

## Security claim

Expression text cannot directly reach `eval`, `Function`, globals, modules,
constructors, prototype traversal, receiver-provided methods/iterators/species,
object conversion hooks, or arbitrary callbacks. Navigation is own-property
only, dangerous names are blocked, built-ins are captured and audited, and
produced strings/arrays plus evaluator work are bounded by configurable limits.

The trust boundary is equally important:

- registered functions/transforms are trusted host code;
- host-owned getters and Proxy traps are trusted context behavior;
- cooperative limits cannot interrupt synchronous host code already running;
- Bonsai is not a memory, CPU, or process isolation boundary.

Use a worker/process boundary when the context or extensions themselves are
untrusted.

## Runtime and artifact contract

- ESM only;
- Node.js 24 or newer, current Bun, and modern ES2022-capable browsers;
- zero runtime dependencies;
- side-effect-free package metadata and independently tree-shakeable subpaths;
- packed-artifact smoke tests for every entrypoint on Node 24 LTS;
- browser bundle execution without Node globals;
- exact minified-size ceilings and relative/absolute performance regression
  gates.

Audited methods that depend on a newer host intrinsic are available only when
that intrinsic exists (for example ES2023 copy-on-write array methods).

## Deliberate v1 non-goals

The following are useful additive 1.x work, not reasons to broaden 1.0:

- named lambda parameters or a general lambda syntax;
- bytecode, native/Wasm execution, or JavaScript code generation;
- assignments, statements, mutation, loops, or user-defined functions;
- a CLI, LSP server, framework adapters, execution tracing, or rule coverage;
- CEL/JsonLogic wire compatibility or cross-language serialization;
- a plugin marketplace.

Complex nested business logic should remain a named, trusted extension rather
than turning the expression language into a second application runtime.

## Release acceptance

- [x] The v1 language fixture passes one-shot/compiled and sync/async paths.
- [x] Core, stdlib, and async evaluator mutation cohorts have independent,
  timeout-independent regression floors.
- [x] The checker, autocomplete, runtime method catalog, and stdlib metadata are
  cross-checked by tests.
- [x] Security limits, cancellation, extension lifecycle, and hostile data
  boundaries have focused tests and scheduled fuzzing.
- [ ] The complete release matrix is green on the final candidate tree.
- [ ] A staged `1.0.0` tarball has been inspected and executed on every supported
  runtime without publishing it.
- [ ] The changelog, README examples, website, declaration files, package file
  list, provenance configuration, and live playground match the staged artifact.
