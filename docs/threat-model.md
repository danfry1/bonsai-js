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

- A property read returns an **own** property of a map. Inherited members,
  class methods, and prototype getters never resolve.
- `__proto__`, `constructor`, and `prototype` are rejected wherever they appear:
  as syntax, as computed keys, and in keys spread from host data.
- Produced maps never contain `__proto__`, `constructor`, or `prototype` keys, even when spread from host data parsed with `JSON.parse`.
- `matches()` uses a linear-time regular expression engine, so a user-written pattern cannot cause catastrophic backtracking.
- Templates, comparisons, keys, and arithmetic never call `valueOf`,
  `toString`, `toJSON`, or `Symbol.toPrimitive`.
- Built-ins use their own loops, never the receiver's methods, iterators, or
  `Symbol.species`, and never mutate their inputs.

### Resource limits

Every limit is on by default (see the README for defaults):

| Stage | Limits |
|---|---|
| Parsing | source length, nesting depth, node count |
| Evaluation | step budget, produced string and list sizes, value nesting depth, optional timeout, `AbortSignal` |

Every expression terminates. There are no loops or recursion, straight-line
code is bounded by the node limit, and anything proportional to data charges
steps: lambda calls, equality, membership, concatenation, spread, templates,
and built-ins. Sizes are checked before allocation. Cyclic data fails closed on
the depth limit.

### Async isolation

- A host function must be declared `async` to be awaited.
- `evaluateSync` rejects an expression that calls one before any host code runs.
- A promise from an undeclared function is an error.
- A thenable in the context is inert data. It is never awaited, and
  `evaluate()` refuses to return one.
- Waiting on an async host function honors the timeout and abort signal.

### Determinism

- Given the same context, host functions, and clock, an expression's result is
  deterministic.
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
- Set a `timeout` for interactive paths. The step budget bounds work
  deterministically but not wall-clock time spent inside host functions.

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
