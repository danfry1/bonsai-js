# Threat Model

## Purpose

Bonsai evaluates expression text written by people you do not fully trust
(customers, admins, rule authors) against data and functions you do trust. This
document states what an expression author can and cannot do, and what remains
your responsibility.

## Trust boundaries

| Party | Trusted? | Notes |
|---|---|---|
| Expression text | **No** | May be arbitrary and adversarial. |
| Context data you pass in | Yes | Its getters, Proxies, and thenables are your code. |
| Host functions you declare | Yes | They run with full privileges. |
| The Bonsai package | Yes | Zero runtime dependencies. |

## Attacker model

The attacker controls the expression text and nothing else. Goals Bonsai
defends against:

- executing JavaScript or reaching globals, modules, constructors, or prototypes;
- calling a function other than a declared host function or a built-in;
- mutating host data or polluting prototypes;
- exhausting CPU or memory, or hanging the caller;
- escaping a synchronous evaluation into asynchronous work.

## Controls

### No code execution

There is no `eval`, `new Function`, or generated code: expressions compile to
closures built from a fixed set of node implementations. Only these can be
called:

- built-in functions;
- host functions declared on the environment.

A function value found in data can be read and compared, but it cannot be
called or used as a lambda. Calling `x.f()` always resolves `f` among the
declared functions, never on `x`.

### Navigation is data-only

- A property read returns an **own** property of a plain object or class
  instance. Inherited members, class methods, and prototype getters never
  resolve. Built-in host objects (`Map`, `Set`, `WeakMap`, `WeakSet`,
  `RegExp`, promises and thenables, `ArrayBuffer` and typed arrays, errors,
  boxed primitives, functions) are opaque: reading into them is a type error.
- `__proto__`, `constructor`, and `prototype` are rejected wherever they appear:
  as syntax, as computed keys, and in keys spread from host data.
- Produced maps never contain `__proto__`, `constructor`, or `prototype` keys, even when spread from host data parsed with `JSON.parse`.
- `matches()` uses a linear-time regular expression engine (JavaScript syntax
  without backreferences or lookaround), so a user-written pattern cannot
  cause catastrophic backtracking. Pattern length is limited by
  `maxPatternLength`, compiling and matching are charged to the step budget,
  and compiled patterns are cached per environment within a bounded total
  size, so one tenant's patterns cannot exhaust another's memory.
- Templates, comparisons, keys, and arithmetic never call `valueOf`,
  `toString`, `toJSON`, or `Symbol.toPrimitive`.
- Built-ins read host lists by index into their own copy and use their own
  loops. They never call the receiver's methods, iterators, or
  `Symbol.species`, even for an array subclass, and never mutate their inputs.

### Resource limits

Every limit is on by default (see the README for defaults):

| Stage | Limits |
|---|---|
| Parsing | source length, nesting depth, node count |
| Checking and compiling | bounded by the parse limits; close to linear in the source |
| Evaluation | step budget, produced string and list sizes, value nesting depth, regular expression pattern length, optional timeout, `AbortSignal` |

Every expression terminates. There are no loops or recursion, and straight-line
code is bounded by the node limit. Every operation charges the step budget for
its real worst-case cost before it runs: lambda calls, equality, membership,
concatenation, spread, templates, characters scanned by text search and
comparison, regular expression compilation and matching, sorting, calendar and
time zone calculations, and the size of lists and maps an expression builds. A
single native operation never runs unbounded between budget checks, so the
budget bounds wall-clock time as well as work: at the default budget, any
expression finishes or fails within about 100 ms on Node.
Sizes are checked before allocation. Values an expression builds are limited to
`maxValueDepth` levels, so a result is bounded in size and safe for the host to
serialize. Cyclic data fails closed on the depth limit.

### Async isolation

- A host function must be declared `async` to be awaited.
- `evaluateSync` rejects an expression that calls one before any host code runs.
- A promise from an undeclared function is an error.
- A thenable in the context is opaque data. It is never awaited, and
  `evaluate()` refuses to return one.
- A host function whose result does not match its declaration (checked
  deeply) or that returns a promise without `async: true` fails with
  `HOST_CONTRACT`, which `try()` cannot catch.
- Waiting on an async host function honors the timeout and abort signal.

### Error hygiene

- Checking and evaluating only ever throw `BonsaiError`s with stable codes.
- Exceptions from host code (a host function, a getter or Proxy trap in the
  context, a `then` or species hook) are wrapped as `HOST_ERROR`, with the
  original error as `cause`. `HOST_ERROR` messages include the host error's
  message; do not show them to expression authors if your host errors carry
  sensitive detail.

### Determinism

- Given the same context, host functions, and clock, an expression's result is
  deterministic, and so is the number of steps it uses.
- `now()` is read once per evaluation from the environment clock, which you can
  inject.
- Calendar functions default to UTC.

## Your responsibilities

- Host functions are your code. Validate their inputs if they reach sensitive
  systems, and give them their own timeouts. A running synchronous function
  cannot be interrupted.
- Getters and Proxies in the context run when an expression reads them. Pass
  plain data when the context contains anything sensitive or expensive.
- Bonsai is not a process, memory, or CPU isolation boundary. If your host
  functions or context are themselves untrusted, run evaluation in a worker or
  separate process.
- Set a `timeout` when expressions call slow host functions. The step budget
  bounds Bonsai's own work deterministically, but not wall-clock time spent
  inside host functions. Each host call costs 32 steps, so an expression can
  still call a host function tens of thousands of times; batch or rate-limit
  expensive calls in the host.

## Assurance

- `tests/security.test.ts` covers sandbox escapes, conversion hooks, species,
  pollution, and thenables.
- `tests/limits.test.ts` covers every limit, including growth attacks and cyclic
  data.
- `tests/conformance.test.ts` runs every language case through the sync,
  async, and compiled paths.
- `scripts/fuzz.ts` generates random expressions and checks that no non-Bonsai
  error escapes, that the evaluation paths agree, and that checked expressions
  hold their types.
