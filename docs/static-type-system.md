# Static Type System Design

Status: v1 candidate design.

## Contract

The checker is optional and never changes runtime evaluation. It consumes an
explicit schema, the instance's declarative extension metadata, and the parsed
AST; it never evaluates an expression or calls host code. It lives at
`bonsai-js/checker` so applications that only evaluate expressions do not pay
its bundle cost.

Static operator rules mirror `docs/language-semantics.md`: arithmetic is
number-only except same-type string/number `+`; ordered comparisons require two
numbers or two strings; equality is strict; string membership requires two
strings. Dynamic or unknown types defer a decision to runtime without causing
cascading diagnostics.

## Type vocabulary

The public vocabulary is JSON-serializable: `unknown`, primitive types, literal
types (one string/number/boolean value; unions of literals model enums),
homogeneous arrays, records, and normalized unions. Optional properties are
represented as a union with `undefined`. Mixed array literals infer a union
element type. Objects are structurally typed; undeclared properties are errors
unless the schema declares an `additionalProperties` type.

Literal types are precise during inference (so `plan == "prem"` against an
enum, or `tier == "1"` against a number, is reported as an always-false strict
comparison) and widen to their base kind in the reported result type and in
array literals. A literal beside its base kind in a union collapses to the base
kind.

Property reads on nullable types widen with `undefined` instead of erroring,
matching the runtime; `NULLABLE_ACCESS` is reserved for method calls on a
nullable receiver without `?.`, which the runtime rejects. Built-in methods
carry arity and parameter signatures (`src/checker/checker.ts`,
`METHOD_SIGNATURES`); element-typed positions (`with`, `toSpliced`) check
against the receiver's element type.

The root context is a `BonsaiObjectType`; nested fields may use any
`BonsaiType`. This mirrors the runtime's record-shaped context and makes a
scalar root schema a TypeScript error.

Extension definitions declare `inputType`, `parameters`, and `returnType` in
this one vocabulary (the `t` builder is exported from both `bonsai-js` and
`bonsai-js/checker`). `arrayTypeRule` describes generic element-preserving,
flattening, element-returning, and lambda-driven array transforms. Autocomplete
derives the coarse runtime kinds it needs from the same metadata, so there is no
second, parallel type vocabulary to keep in sync. Missing metadata produces
`unknown`, never execution-based inference.

## Diagnostics and scope

Checking returns every non-cascading diagnostic with a stable code and source
range. The current dot-lambda receives the surrounding array element type.
Future named lambdas will introduce a lexical binding in the same internal
scope stack; they will not require a second checker. Shadowing will be lexical,
with the innermost binding winning.

The checker infers the result type at check time. TypeScript cannot prove a
runtime string's result type, so generic result annotations remain host
assertions; generated or stored checked artifacts will carry the inferred type
and environment fingerprint rather than pretending a type-level parser exists.

## Deferred without blocking the first checker

- type variables ("returns the input's element type"), so generic stdlib
  transforms such as `first`, `reverse`, `sort`, and `unique` currently return
  `unknown`; the `map`/`filter`/`find`/`some`/`every` transforms are inferred
  from the lambda by name as an interim measure;
- overload resolution and user-defined nominal types;
- comments/trivia and formatting;
- named-lambda syntax;
- serializable checked artifacts and environment fingerprints.

Those additions must extend this vocabulary and scope model without changing
the meaning of already-valid expressions.
