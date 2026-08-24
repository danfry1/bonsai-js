# Threat Model

This document states what the Bonsai sandbox does and does not protect, the
trust boundaries it assumes, and how each guarantee is enforced and verified. It
is intended for engineers deciding whether Bonsai is safe for a given use, and
for security reviewers auditing the sandbox.

It describes current, shipped behavior. To report a vulnerability, see
[SECURITY.md](../SECURITY.md). For what is covered by semver, see
[stability-policy.md](./stability-policy.md).

## Purpose

Bonsai evaluates expression _text_ that may come from a source you do not fully
trust: end users, admin tooling, configuration, a database, a CMS, or a language
model. The goal is to run that text usefully while guaranteeing it cannot escape
into arbitrary host behavior. Bonsai is an interpreter over a parsed AST; it
never compiles expressions to JavaScript and never calls `eval` or `new
Function`. An expression's only reach into the host is the data and extensions
the host explicitly provides.

## Trust boundaries

The single most important thing to understand: **Bonsai sandboxes the expression
text, not the host code you connect to it.**

| Component                                                                    | Trust                                       | Notes                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expression text                                                              | Untrusted                                   | The thing the sandbox is designed to contain.                                                                                                                                                                     |
| `SecurityPolicy` / `BonsaiOptions`                                           | Trusted                                     | You configure the limits and allow/deny lists.                                                                                                                                                                    |
| Registered functions and transforms (`use()`, `addFunction`, `addTransform`) | Trusted                                     | Run with full host privilege when the expression calls them.                                                                                                                                                      |
| Context object and values                                                    | Trusted container, untrusted data           | Bonsai reads own properties only and never walks prototypes. Anything the host places in the context that can run code when read (an own getter, a `Proxy`) runs with host privilege when an expression reads it. |
| The evaluation result                                                        | Trusted to Bonsai, your boundary downstream | Bonsai does not encode or escape output.                                                                                                                                                                          |

The consequence is explicit and load-bearing: the security of the whole system
is Bonsai's guarantees **intersected with** the safety of what you register. If
you register a function that reads the filesystem, performs network calls, or
reflects over host objects, an expression that is allowed to call it inherits
that capability. Context functions additionally receive the live context object
as their first argument. Register only what you would be comfortable letting an
untrusted expression author invoke.

## What the sandbox protects

The assets Bonsai is responsible for protecting against untrusted expression
text:

- **The host runtime.** No arbitrary code execution, no reach into globals,
  prototypes, or constructors.
- **Application availability.** Default structural, recursion, output-size, and
  evaluator-work limits, plus optional wall-clock and cancellation controls.
- **Host data not explicitly exposed.** An expression can read the context and
  call registered extensions, and nothing else.

## Attacker model

The attacker controls the full expression string and can submit it repeatedly.
They cannot modify the host application, the registered extensions, the
`SecurityPolicy`, or the Bonsai source. They aim to: execute host code, read the
prototype chain or constructors, reach values outside the provided context,
exhaust CPU or memory, or smuggle asynchronous or uninterruptible work into a
synchronous evaluation.

## Controls

Each control is enforced in the evaluator's hot path and applies identically to
the synchronous and asynchronous walks (a parity test suite keeps the two
aligned, so a guard cannot be present in one and missing in the other).

### No arbitrary code execution

The evaluator walks a parsed AST. There is no code generation: `new Function`,
`eval`, a native or WebAssembly core, and a second compiled-closure engine are
documented non-goals (see `ARCHITECTURE.md`). An expression's only effects are
reading context values, applying built-in operators, calling allow-listed
built-in methods, and calling host-registered functions and transforms.

### Prototype-chain and constructor access is blocked

`__proto__`, `constructor`, and `prototype` are rejected on **every** access
kind: root identifiers, member access, method calls, and object-literal keys.
The block also applies to computed access, because static (`obj.constructor`)
and computed (`obj["constructor"]`) member access route through the same guard
after the computed key is coerced to a string. Object literals are built with
`Object.create(null)`, so they have no prototype to pollute. This closes the
standard `constructor.constructor("...")()` escape and prototype-pollution via
object-literal keys.

All normal reads resolve **own** properties only (`Object.hasOwn` followed by a
plain read). Prototype traversal is never used, so neither inherited host
methods nor a polluted `Object.prototype` can surface as values. An own getter
is host-authored data and is read like any other own property; expression text
cannot introduce one. Computed keys and core string/number conversion accept
primitives only, so `toString`, `valueOf`, and `Symbol.toPrimitive` hooks
cannot be triggered implicitly.

### Property access control (opt-in)

Member and method access can be restricted with an allow-list
(`allowedProperties`) or a deny-list (`deniedProperties`). Root identifiers and
object-literal keys are not subject to these lists (a root identifier names a
context entry, not a traversal), and canonical non-negative integer indices
bypass them so array indexing keeps working. These lists are **opt-in**; by
default every property that is not in the blocked set above is readable.

### Method allow-list

Methods may only be called on `string`, `array`, and `number` receivers, and
only if the method name is in a small, audited allow-list of non-mutating
built-ins (`src/safe-methods.ts` is the single source of truth, shared with the
autocomplete catalog so the two cannot drift). Bonsai invokes an exact intrinsic
captured when the module loads, not a receiver property, so own overrides,
subclasses, and later prototype monkey-patches cannot replace an allow-listed
method. The captured intrinsics read only `length` and indices, never the
receiver's iterator; arrays whose prototype is not `Array.prototype`
(subclasses), or which provide their own constructor/spreadability hooks, are
copied into a neutral array first so receiver-provided species code cannot run.
Bundled array transforms use captured operations and the same receiver rules,
not live receiver methods or iterators. Mutating methods (`push`,
`sort`, `splice`, `reverse`, and so on) are absent by design; their immutable
counterparts (`toSorted`, `toReversed`, `toSpliced`, `with`) are included.
Methods on arbitrary objects and functions are not callable at all.

### Method-argument hardening

Allow-listed methods that could be abused are constrained:

- `replace` / `replaceAll` reject function arguments (no callback injection),
  `RegExp` arguments (no catastrophic-backtracking denial of service), and
  object arguments. Only string replacement is permitted.
- `repeat`, `padStart`, and `padEnd` cap the requested size before allocation,
  so a single native call cannot amplify a small input into a huge string.
- Higher-order methods (`map`, `filter`, `find`, and so on) accept only callbacks
  branded by Bonsai's lambda syntax. Context-supplied host functions are treated
  as data and are never invoked as callbacks.
- Bundled higher-order transforms await async callbacks sequentially; `find`,
  `some`, and `every` stop at the first decisive element instead of creating
  unbounded concurrent work.
- Built-in method arity and parameter types are checked before invocation.
  Arguments in positions a native method would coerce cannot use object
  conversion hooks. Array `join` and `toSorted` accept only elements with primitive string
  representations, and function-valued arguments are rejected wherever a
  built-in could invoke them.

### Data-only collection semantics

Spread accepts arrays, not arbitrary iterables. It reads a bounded length and
copies elements by index, ignores a custom `Symbol.iterator`, and materializes
sparse holes as `undefined`. Array membership (`in`) calls the captured
`Array.prototype.includes`. This keeps iterator and callback execution out of
the expression language.

### Resource limits

| Limit             | Option                | Default   | Bounds                                                                                                                                                                            |
| ----------------- | --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source length     | `maxSourceLength`     | 100,000   | UTF-16 input length before tokenization.                                                                                                                                          |
| Token count       | `maxTokens`           | 25,000    | Lexical tokens before parsing.                                                                                                                                                    |
| AST nodes         | `maxAstNodes`         | 10,000    | Parser/compiler structure.                                                                                                                                                        |
| Object properties | `maxObjectProperties` | 10,000    | Properties in one object literal.                                                                                                                                                 |
| Call arguments    | `maxCallArguments`    | 1,000     | Arguments in one call, checked syntactically and again after spread expansion.                                                                                                    |
| Expression depth  | `maxDepth`            | 100       | Evaluator recursion, call-stack growth, and native `flat` depth.                                                                                                                  |
| Array length      | `maxArrayLength`      | 100,000   | Every array produced by the language, a method, transform, or function. Context data read back unchanged is never rejected for its size.                                          |
| String length     | `maxStringLength`     | 100,000   | Every string produced by the language, a method, transform, or function, plus allocation pre-checks. Context data read back unchanged is never rejected for its size.             |
| Step budget       | `maxSteps`            | 1,000,000 | Accounted evaluator work, including AST nodes, lambda calls, spread/literal loops, and receiver-length charges before linear native methods. Excludes opaque host-extension work. |
| Wall-clock time   | `timeout`             | 0 (off)   | Total evaluation time, checked cooperatively.                                                                                                                                     |
| Cancellation      | per-run `signal`      | none      | `AbortSignal`, sampled during sync work and raced at async waits.                                                                                                                 |

Depth, the array/string ceilings, and `maxSteps` are enforced by default. The
timeout is **opt-in**: with no `timeout` set there is no wall-clock bound.
`maxSteps`, the timeout, and synchronous cancellation are _cooperative_ and
sampled as the interpreter advances. They cannot interrupt a synchronous
registered extension already running. Async evaluation races every awaited
boundary against its deadline and `AbortSignal`, so it can return control to the
caller even if the underlying host Promise remains unsettled. Each evaluation
can override `timeout` and `maxSteps` and supply a `signal` without mutating the
instance defaults.

### No asynchronous escape in synchronous mode

`evaluateSync` rejects any Promise-like value returned by any method, function, or transform
with a typed error, so asynchronous or uninterruptible work cannot be smuggled
into the synchronous path. Use `evaluate` when extensions are genuinely async.

### Determinism

The language exposes no clock, randomness, or I/O of its own, so for a given
context and a given set of registered extensions, the same expression always
produces the same result. (The evaluator reads `Date.now` internally only to
enforce the timeout deadline; expressions cannot observe it.) Determinism is a
property of the core language; registered extensions can introduce
non-determinism if you let them.

## Recommended configuration for untrusted input

The defaults are tuned for trusted-but-careful use. When the expression author
is untrusted, harden the policy:

- **Set a `timeout` and pass an `AbortSignal`.** The timeout is off by default;
  the signal lets request or worker cancellation propagate into evaluation.
- **Consider `allowedProperties`** to restrict traversal to the fields you
  intend to expose, rather than the whole reachable object graph.
- **Lower structural, depth, step, array, and string limits** toward what your
  expression product actually needs.
- **Register the minimum surface.** Every function and transform you add is host
  capability an expression can reach. Prefer passing plain data as context over
  exposing behavior.
- **Pass plain data as context.** Own getters and Proxies placed in the context
  run host code when an expression reads them; Bonsai cannot tell them apart
  from data. Serialize ORM models and reactive objects to plain objects and
  arrays at the expression boundary if executing their accessors on the
  expression author's schedule is a concern.

## Explicit non-guarantees

Stated plainly so they are not assumed:

- **Registered extensions and the context are not sandboxed.** Their safety is
  yours to ensure (see Trust boundaries).
- **Own getters and Proxies in the context are host code.** Reading them runs
  their host-defined getter or trap; place them at the expression boundary only
  if that is acceptable.
- **Application-wide primordial mutation is trusted host behavior.** Bonsai
  captures allowed method implementations, but the host must not install
  numeric properties or constructor/species hooks on `Array.prototype`,
  `Object.prototype`, or `Array` itself. Isolate code that mutates primordials.
- **No global memory cap.** Limits are per-construct (depth, array length,
  string length), not a total heap budget. An expression that stays within each
  limit can still allocate.
- **The timeout is cooperative, not pre-emptive.** It cannot interrupt a single
  blocking host-function call or native method mid-execution.
- **Output is not encoded or escaped.** Rendering a result into HTML, SQL, a
  shell, or another interpreter is your injection boundary, not Bonsai's.
- **No defense against side channels.** Timing, cache, and speculative-execution
  side channels are out of scope.

## Assurance

How the controls above are kept honest:

- **Security-property tests** (`tests/security-property.test.ts`) assert sandbox
  invariants over generated inputs, for example that dangerous-key access is
  always blocked across both evaluation walks.
- **Parity tests** keep the synchronous and asynchronous walks behaviorally
  identical, so a guard cannot be enforced in one and silently missing in the
  other.
- **Mutation testing** (`stryker.config.json`, scoped to the correctness and
  security core) verifies that the test suite actually kills injected faults in
  the guards, not merely that the lines execute. A weekly run enforces a score
  floor.
- **Scheduled fuzzing** (`.github/workflows/fuzz.yml`) exercises the parser,
  prototype-key escape surface, spread, method boundary, sync/async parity, and
  checker/schema robustness while proving static checking never invokes host
  extensions.
- **Browser-targeted execution** (`tests/browser-runtime.test.ts`) bundles the
  root, stdlib, checker, and autocomplete surfaces and executes them in an
  isolated realm without Node globals.
- **CodeQL and OpenSSF Scorecard** run on the repository, complementing the
  language-specific tests with static and supply-chain checks.
- **Zero runtime dependencies** keep the audited surface to this repository.

Mutation and fuzzing are scheduled drift detectors; their workflow artifacts
remain the source for individual survivors and shrunk counterexamples. The CI
performance gates (`bench:gate`, `bench:compare`) keep the hardening above from
silently taxing the hot path.
