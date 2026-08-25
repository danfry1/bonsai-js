# Bonsai Language Semantics

Status: v1 candidate contract. The executable source of truth is
`tests/fixtures/v1-semantics.json`; every fixture runs through one-shot,
compiled, synchronous, and asynchronous evaluation. The fixture corpus uses
JSON contexts, so it covers the plain-data subset of these rules; the
host-object rules (own getters, subclassed arrays, Proxies) are pinned in
`tests/data-only.test.ts` and `tests/adversarial.test.ts`.

## Design principles

Bonsai is an expression language, not a JavaScript subset. Familiar syntax is
kept where its behavior is deterministic over plain data. JavaScript behaviors
that let expression text reach application code implicitly (prototype lookup,
custom iterators, conversion hooks, and unapproved callbacks) are intentionally
not part of the language. The context is the host's trusted container: what
the host places in it (including its own getters or Proxies) is the host's
responsibility, and expression text can only read what is there.

The core value vocabulary is `undefined`, `null`, booleans, finite or
non-finite JavaScript numbers, strings, arrays, and records. Registered
extensions may return other values, but the core language treats those values
as opaque identities: it does not navigate inherited state or coerce objects.

## Operators

- `==` and `!=` are strict identity comparisons, equivalent to JavaScript
  `===` and `!==`. There is no loose equality.
- `+` accepts two numbers or two strings. Mixed-type concatenation is a typed
  error (use a template literal to build text from mixed values).
- `-`, `*`, `/`, `%`, and `**` accept two numbers.
- `<`, `>`, `<=`, and `>=` accept two numbers or two strings of the same type.
- Unary `-` accepts a number. Unary `+` performs primitive-only number
  conversion. Objects are rejected without calling `valueOf` or
  `Symbol.toPrimitive`.
- `!`, `&&`, `||`, and `?:` use JavaScript truthiness and preserve operand
  values. Truthiness never invokes conversion hooks.
- `??` evaluates its right side only when the left side is `null` or
  `undefined`.
- Two ambiguous forms are parse errors, as in JavaScript: a unary operator
  directly on the left of `**`, and `??` mixed with `&&`/`||` without
  parentheses. Refusing them today is additive to relax later; committing to a
  precedence is not. The full precedence table is published in the operator
  documentation.
- `in` and `not in` perform strict array membership, or substring membership
  when both operands are strings.

## Names and properties

- A missing root identifier evaluates to `undefined`.
- Property access reads **own** properties only (enumerable or not). Inherited
  members, including prototype getters and class methods, never resolve; they
  read as `undefined`. An own getter defined by the host is read like any other
  own property.
- `__proto__`, `prototype`, and `constructor` are blocked at every navigation
  boundary.
- A missing property on a non-null receiver evaluates to `undefined`.
- A member read on `null` or `undefined` evaluates to `undefined`, so
  `user.address.city` over sparse data does not throw. `?.` is equivalent for
  property reads; it matters for method calls, where `a.b.trim()` on a nullish
  `a.b` is a typed error and `a.b?.trim()` is `undefined`.
- Computed keys accept primitive values only. Object conversion hooks never run.
- Object literals have a null prototype.

## Arrays, methods, and callbacks

- Spread accepts arrays only. It copies elements by index, ignores a custom
  iterator, and materializes holes as `undefined`.
- Method calls dispatch to an audited intrinsic captured when Bonsai is loaded;
  receiver method overrides and later method monkey-patches are ignored.
  Subclassed arrays and ordinary arrays with own `constructor` or
  `Symbol.isConcatSpreadable` hooks are copied into a neutral array first, so
  receiver-provided species/spreadability code does not run.
- Mutating methods are not available.
- Built-in arity and parameter types are language rules enforced by both the
  runtime and checker; native JavaScript's missing-argument and coercion behavior
  is not part of Bonsai's contract.
- Invalid `toFixed` precision, numeric `toString` radix, and `Array.with`
  indices throw a Bonsai typed error rather than leaking a host-specific
  `RangeError`. Native `flat` depth is bounded by `maxDepth`.
- Higher-order methods accept only lambdas created by the Bonsai evaluator.
  Context-supplied host functions are data, never executable callbacks.
- `find`, `some`, and `every` short-circuit in both method and bundled-transform
  syntax. Bundled transforms await async callbacks sequentially by default.
- The lambda accessor shorthand (`.field`) and member chains inside a lambda
  follow the same nullish-read and computed-key rules as normal member access,
  including optional computed access such as `.child?.[key]`.
- `join` and `toSorted` accept only elements with primitive string
  representations; objects in the array are a typed error rather than an
  implicit `toString` call.
- `evaluateSync` rejects any Promise-like result and identifies the extension
  that requires asynchronous evaluation. `evaluate` awaits at extension and
  lambda boundaries.
- Promise-like values in the context are inert data to `evaluateSync`; reading
  one during `evaluate` is a typed error, because JavaScript assimilation would
  otherwise invoke its host `then` (an ORM query object would execute; a
  never-settling thenable would hang). Resolve promises before building the
  context. Extensions returning Promises are unaffected — awaiting those is the
  purpose of `evaluate`.
- A transform whose metadata declares `parameters` rejects surplus arguments at
  the call site; a surplus argument would otherwise be silently ignored
  (`total |> round(2)` returning the unrounded integer). Transforms registered
  without declared parameters accept any arguments, as before.

## Strings and conversion

Template interpolation, computed keys, built-in method arguments, and bundled string-conversion helpers
accept only strings, numbers, booleans, `null`, and `undefined`. Objects,
functions, symbols, and bigints are rejected rather than invoking host
conversion behavior.

Every string and array an expression _produces_ (literals, spread, operators,
method, transform, and function results) is checked against its configured
size limit. Context data read back unchanged is never rejected for its size.

## Extensions and time

Registered transforms and functions are trusted host code. They can perform
I/O, mutate objects they close over, and block the JavaScript thread. Bonsai
checks their returned values and async boundaries, but cooperative timeouts
cannot interrupt synchronous host code already running.

A compiled expression binds to the immutable extension-registry revision that
existed at compile time. Later explicit replacements affect one-shot evaluation
and newly compiled expressions, never an existing compiled expression. Calling
`seal()` permanently prevents registry mutation.

## Compatibility rule

After v1, changing any behavior in this document or an existing executable
fixture requires a major version. Additive syntax may be introduced in a minor
release only when old expressions retain the same parse tree meaning and
result.
