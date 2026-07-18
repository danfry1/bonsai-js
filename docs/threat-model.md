# Threat Model

This document states what the Bonsai sandbox does and does not protect, the
trust boundaries it assumes, and how each guarantee is enforced and verified. It
is intended for engineers deciding whether Bonsai is safe for a given use, and
for security reviewers auditing the sandbox.

It describes current, shipped behavior. To report a vulnerability, see
[SECURITY.md](../SECURITY.md). For what is covered by semver, see
[stability-policy.md](./stability-policy.md).

## Purpose

Bonsai evaluates expression *text* that may come from a source you do not fully
trust: end users, admin tooling, configuration, a database, a CMS, or a language
model. The goal is to run that text usefully while guaranteeing it cannot escape
into arbitrary host behavior. Bonsai is an interpreter over a parsed AST; it
never compiles expressions to JavaScript and never calls `eval` or `new
Function`. An expression's only reach into the host is the data and extensions
the host explicitly provides.

## Trust boundaries

The single most important thing to understand: **Bonsai sandboxes the expression
text, not the host code you connect to it.**

| Component | Trust | Notes |
| --- | --- | --- |
| Expression text | Untrusted | The thing the sandbox is designed to contain. |
| `SecurityPolicy` / `BonsaiOptions` | Trusted | You configure the limits and allow/deny lists. |
| Registered functions and transforms (`use()`, `addFunction`, `addTransform`) | Trusted | Run with full host privilege when the expression calls them. |
| Context object values | Trusted input | Read as-is; Bonsai does not sanitize them. |
| The evaluation result | Trusted to Bonsai, your boundary downstream | Bonsai does not encode or escape output. |

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
- **Application availability.** Bounded recursion, allocation, and (when
  configured) wall-clock time, so an expression cannot trivially hang or exhaust
  the process.
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
autocomplete catalog so the two cannot drift). Mutating methods (`push`, `sort`,
`splice`, `reverse`, and so on) are absent by design; their immutable
counterparts (`toSorted`, `toReversed`, `toSpliced`, `with`) are included.
Methods on arbitrary objects and functions are not callable at all.

### Method-argument hardening

Allow-listed methods that could be abused are constrained:

- `replace` / `replaceAll` reject function arguments (no callback injection),
  `RegExp` arguments (no catastrophic-backtracking denial of service), and
  object arguments. Only string replacement is permitted.
- `repeat`, `padStart`, and `padEnd` cap the requested size before allocation,
  so a single native call cannot amplify a small input into a huge string.
- Higher-order methods (`map`, `filter`, `find`, and so on) require a function
  callback and reject a non-function first argument with a typed error.

### Resource limits

| Limit | Option | Default | Bounds |
| --- | --- | --- | --- |
| Expression depth | `maxDepth` | 100 | Recursion / call-stack growth. |
| Array length | `maxArrayLength` | 100,000 | Array literals, spread sources, and array-returning methods. |
| String length | `maxStringLength` | 100,000 | String-producing methods, plus pre-checks on `repeat`/`padStart`/`padEnd`. |
| Step budget | `maxSteps` | 1,000,000 | Accounted evaluator steps (AST-walk nodes, bonsai-lambda callback invocations, spread/literal-loop elements). Excludes opaque host/native work. |
| Wall-clock time | `timeout` | 0 (off) | Total evaluation time, checked cooperatively. |

Depth, the array/string ceilings, and `maxSteps` are enforced by default. The
timeout is **opt-in**: with no `timeout` set there is no wall-clock bound.
Both `maxSteps` and the timeout are *cooperative* and sampled (checked as the
interpreter steps), so they bound the interpreter loop rather than any single
native call. A "step" is an evaluator-driven operation, so `maxSteps` bounds the
AST walk and bonsai-lambda-driven iteration (`items.map(.x)` over a large
context array) but **not** work inside an opaque host function or a native
method driven by a host-function callback — the receiver of a native array
method is not size-capped either (`maxArrayLength` caps produced arrays, not a
context-array receiver). Sync and async consume identical step budgets (the
async evaluator reimplements higher-order methods to await async callbacks while
matching native per-method semantics — argument passing, sparse-hole handling,
and overridden-method deference). That is why the size caps above exist: they
stop the amplifiers that a sampled bound could not interrupt mid-call.

### No asynchronous escape in synchronous mode

`evaluateSync` rejects a `Promise` returned by any method, function, or transform
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

- **Set a `timeout`.** It is off by default and is your only wall-clock bound.
- **Consider `allowedProperties`** to restrict traversal to the fields you
  intend to expose, rather than the whole reachable object graph.
- **Lower `maxDepth`, `maxArrayLength`, and `maxStringLength`** toward what your
  expressions actually need.
- **Register the minimum surface.** Every function and transform you add is host
  capability an expression can reach. Prefer passing plain data as context over
  exposing behavior.
- **Pass plain data as context.** A context object whose properties are getters
  or proxies will run that code when the expression reads them; Bonsai reads
  context values, it does not sanitize the container.

## Explicit non-guarantees

Stated plainly so they are not assumed:

- **Registered extensions and the context are not sandboxed.** Their safety is
  yours to ensure (see Trust boundaries).
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
- **Zero runtime dependencies** keep the audited surface to this repository.

### Roadmap

Planned hardening, tracked here so the assurance story is explicit about what is
not yet in place:

- **Continuous fuzzing** of the parser and the escape surface (prototype keys,
  the method allow-list, spread, and the synchronous/asynchronous boundary),
  run on a schedule with a seed corpus.
- **A published assurance summary** (mutants killed, fuzz hours, escapes found)
  as a durable trust artifact.
