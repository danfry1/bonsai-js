# Bonsai v1 Readiness Review

Review date: 24 August 2026. This is a release decision document, not a list of
every feature an expression language could contain.

## Product thesis

Bonsai should be the JavaScript-native choice for applications that need all
four of these at once:

1. readable expressions for non-programmer-authored rules;
2. a data-only interpreter boundary rather than JavaScript code generation;
3. a typed authoring/control plane that never executes host code;
4. an exceptionally small, fast, dependency-free production package.

It should not try to be a JavaScript subset, a general workflow engine, or a
drop-in CEL/JsonLogic wire format. A narrow language with unusually clear
semantics is the stronger product.

## Measured scorecard

| Dimension | Current evidence | v1 assessment |
|---|---|---|
| Correctness | 1,512 tests across 59 files; portable semantics fixtures execute one-shot/compiled and sync/async | Strong |
| Coverage | 93.45% statements, 89.22% branches, 98.92% functions, 94.77% lines; CI floors 90/84/95/91 | Strong |
| Warm performance | 33.7M cached literals/s, 13.9M cached comparisons/s, 14.0M compiled comparisons/s, 16.0M transform pipelines/s; every relative case retains at least 79% of `main` on the same runner | Excellent |
| Collection performance | 229K `map(.x)` runs/s over 1,000 items; 139K `filter(.active).map(.x)` runs/s; 217K 1,000-item spreads/s | Healthy with safety accounting enabled |
| Cache value | 16.60× cached-versus-cold comparison throughput; compiled/cached parity 1.01× | Material |
| Relative gate | order-balanced `bench:compare` fails a PR when any case retains < 75% of base throughput on the same runner | Guarded in CI |
| Browser-minified gates | core <66 KiB, full stdlib <76 KiB, autocomplete <87 KiB, checker <86 KiB | Guarded in CI |
| Dependencies | zero runtime dependencies | Best-in-class |
| Package integrity | packed-artifact smoke tests for root, stdlib, autocomplete, checker on Node 24 LTS; ATTW; ESM declarations; browser-targeted isolated execution | Strong |
| Supply chain | pinned Actions, seven-day dependency cooldown, CodeQL, Scorecard, OIDC provenance, staged publish plus human 2FA | Excellent |
| Security assurance | threat model, property tests, scheduled fuzzing, typed security codes; 1,730,400 fuzz cases passed in 20 seconds; independent runtime-core, stdlib, and async mutation floors remain above their thresholds even when timeouts count as failures | Strong across sync core, bundled transforms, and async execution |

Throughput figures are local regression evidence, not cross-machine promises.
The stable commitment is the performance gate, not a headline number.

The current sync-to-sync Jexl run measured Bonsai 38.7× faster for repeated
default API usage and 2.2×–13.3× faster across six pre-compiled scenarios. The spread is
more honest than a single marketing multiplier: property access and transforms
are the narrowest leads, while constant arithmetic benefits most from Bonsai's
compiler.

## Language and syntax

What is right for v1:

- familiar arithmetic, comparison, conditional, nullish, optional-chain,
  collection, template, and method syntax;
- `|>` reads transformations left-to-right and is materially clearer than
  nested calls;
- `.field` and `. > value` make the dominant filter/map case concise;
- strict equality and same-type arithmetic/comparison remove JavaScript's most
  error-prone coercion surprises;
- arrays/records/templates cover useful result construction without adding
  statements or mutation;
- the safe method catalog is recognizable but intentionally finite.

The language contract is now explicit rather than “whatever JavaScript does”:
own-only member reads, no receiver-provided iterators/method callbacks or object
conversion hooks, arrays-only spread, captured methods, primitive interpolation,
strict arithmetic/ordering, and nullish-tolerant property reads with strict
method calls. These choices are slightly less permissive and much easier to teach,
check, audit, and reproduce, while staying fast over plain data.

Named lambdas would improve deeply nested collection expressions, but they are
additive syntax and do not need to delay v1. The v1 guidance should keep complex
nested computation in a named trusted extension instead of growing a second
programming language inside configuration.

## Security boundary

The boundary is unusually strong for a JavaScript expression evaluator:

- no `eval`, `Function`, generated closures, global lookup, or module access;
- dangerous names blocked at every navigation boundary;
- own-only member reads; host-provided own getters/Proxy traps are explicitly
  inside the trusted-context boundary;
- no arbitrary iterable or callback execution;
- exact captured intrinsics instead of receiver-provided methods;
- source/token/AST/object/call/depth/step/array/string limits;
- produced-value limits, including extension results, without rejecting large
  context values merely passed through unchanged;
- sync Promise-like rejection across realms;
- async deadline racing and `AbortSignal` cancellation;
- immutable, revisioned, sealable extension registries.

The honest non-guarantees remain important: trusted extensions can do anything,
Proxies can execute reflection traps, cooperative limits cannot pre-empt a
synchronous host call, and in-process evaluation is not a memory/process
sandbox.

## Type and authoring model

The optional checker closes the largest strategic gap without taxing runtime-
only users. One JSON-serializable schema now powers strict operator/property
checking, extension signature and arity checking, expected-result validation,
lambda inference, stable ranged diagnostics, and autocomplete without live
values. `validate()` stays the single name for the syntax/reference-only phase;
semantic checks live in the checker.

This is deliberately a runtime AST checker, not a TypeScript type-level parser.
A dynamic string cannot honestly become statically proven because a caller
writes `evaluate<boolean>()`. Future checked artifacts may bind inferred result
types more tightly, but v1 should not claim that generic result annotations are
proof.

## Competitive position

Registry metadata checked on the review date:

| Package | Current release / registry update | Distinguishing strength | Bonsai position |
|---|---|---|---|
| [`@marcbachmann/cel-js`](https://github.com/marcbachmann/cel-js) | 8.0.0 / 7 Jul 2026; 227 kB unpacked | CEL portability, mature typed Environment, named macros, broad types | Closest active technical competitor; Bonsai is more JS-number-native, smaller in language scope, and stricter at implicit host-execution boundaries |
| [`jexl`](https://github.com/TomFrost/Jexl) | 2.3.0 / 19 Jun 2022; 88 kB unpacked; one runtime dependency | Familiar syntax and transforms | Bonsai has the stronger maintained package, sync/async tooling, checker, limits, and assurance story |
| [`expr-eval`](https://github.com/silentmatt/expr-eval) | 2.0.2 / 17 Jun 2022; 146 kB unpacked | Mathematical expressions and symbolic operations | Not a safe default for hostile context data; the published release is affected by [CVE-2025-12735](https://github.com/advisories/GHSA-jc85-fpwf-qm7x) |
| [`json-logic-js`](https://github.com/jwadhams/json-logic-js) | 2.0.5 / 9 Jul 2024; 65 kB unpacked | Serializable cross-language JSON rule format | Better interchange format; substantially worse human authoring and editor ergonomics |
| [`filtrex`](https://github.com/cshaa/filtrex) | 3.1.0 / 14 Oct 2024; 678 kB unpacked | End-user-friendly filtering grammar | Bonsai offers the broader production control plane and smaller installed surface |

The right competitive message is not “more operators.” It is: the expression,
checker, autocomplete, sandbox policy, diagnostics, and release artifact all
describe the same language.

## v1 release gate

Candidate status:

- [x] Complete post-checker suite and coverage ratchet are green.
- [x] Isolated performance gate remains comfortably above every floor.
- [x] Checker/schema safety is part of the scheduled fuzz corpus.
- [x] The scoped runtime-core mutation gate passes at 88.07% overall / 90.91%
  covered across 1,852 mutants; 1,627 were actually killed (87.85%), so the
  87% regression floor does not depend on four timeouts being counted as kills.
- [x] The bundled stdlib mutation cohort passes at 88.78% overall / 93.98%
  covered across 633 mutants; 553 were killed (87.36%), independent of nine
  timeouts. Dates, math, strings, and types each score 100%.
- [x] The async evaluator mutation cohort passes at 87.16% overall / 88.76%
  covered across 444 scored mutants; 381 were killed (85.81%), independent of
  six timeouts. Its top-level and lambda method paths now share one implementation.
- [x] ATTW passes all four packed entry points.
- [x] Jexl/direct-JavaScript migration and shared checker/autocomplete guidance
  are published in the docs source.
- [x] The prepared bump files were applied: `package.json` is `1.0.0`, the
  generated changelog contains the reviewed breaking changes, and a `none`
  release marker keeps the combined implementation/release PR passing strict
  bump-file validation without requesting a second version bump.
- [x] Packed smoke tests pass Node 24 LTS; Bun runtime, website build, and a
  browser-targeted bundle executing without Node globals pass.
- [x] The blocking high/critical dependency audit passes after refreshing
  vulnerable transitive development-tool packages to compatible patched
  releases; the runtime package still has zero dependencies.
- [x] The exact local 1.0.0 tarball passes packed-runtime smoke tests, ATTW for
  all four entrypoints, manifest inspection, npm's publish dry-run, and the
  blocking dependency audit. It contains 32 files, is 184.1 kB compressed, and
  has SHA-256 `b46de2aadccb25c840d65a9a4b7958750052697ba119fc21a9daf62101be2f0f`.
- [ ] After merge, tag `v1.0.0`, inspect the OIDC provenance and deployed live
  playground, then approve the npm staged publish with 2FA.

Not release blockers: bytecode, named lambdas, a CLI/LSP, execution tracing,
rule branch coverage, framework adapters, and a plugin marketplace. Those are
valuable additive 1.x work, but forcing them into 1.0 would make the first stable
contract broader and less trustworthy.
