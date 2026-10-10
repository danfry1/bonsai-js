# Stability Policy

Bonsai follows Semantic Versioning for its three package entrypoints:

- `bonsai-js`
- `bonsai-js/service`
- `bonsai-js/query`

## What is covered

- **The language.** Everything in the language specification
  (`docs/language.md`) and every case in `tests/conformance.test.ts`, as they
  are at the release's tag: for version X.Y.Z,
  `https://github.com/danfry1/bonsai-js/blob/vX.Y.Z/docs/language.md` (the
  [latest specification](https://github.com/danfry1/bonsai-js/blob/main/docs/language.md)
  may describe unreleased changes). Changing the result of an expression that
  evaluates successfully, or making it fail, requires a major release.
- **The API.** Exported functions, classes, types, options, and error codes.
  - Error classes are covered for `instanceof` checks and for reading their
    fields, `name` included, and their JSON form. Their constructors are not
    public API: Bonsai creates its errors, and the constructor parameters may
    change.
  - A host function is a value returned by `fn()` (or by a `withContext()`
    builder). An object written by hand in the same shape is not supported,
    even when the `HostFunction` type accepts it.
  - `toSQL` and `toMongo` take compiled programs. The `Translatable` type
    describes what they read from one, and only a program from `env.compile`
    (or `env.check(...).program`) satisfies it.
  - The result type parameter of `env.evaluate`, `evaluateSync`, `explain`,
    `explainSync`, and `partial` (`env.evaluateSync<boolean>(...)`) is an
    unchecked assertion, like a cast. For a checked result type, compile with
    `expect`.
  - `partial()` is synchronous and keeps its name. An asynchronous variant, if
    one is added, gets a new name rather than changing this one.
- **SQL and MongoDB translation.** A filter that translates selects exactly
  the records Bonsai accepts. The generated text and parameter numbering may
  change in a minor release (for example to use an index), and a filter that
  is refused today may translate in a later one. A filter that translates
  today is not refused in a minor release, except to fix a translation that
  selected the wrong records.
- **Formats you may store.**
  - Printed source (`print()`) keeps its meaning: it evaluates as the tree
    does. Its text may change in a minor release (spacing, parentheses, how a
    number or string is written), so compare stored rules by meaning, not text.
  - The JSON shape of an explanation (`ExplanationJSON`) is stable. Text cuts,
    trace ids beyond their pre-order numbering, and which conditions
    `reasons()` selects may improve in a minor release.
  - A residual's `dependsOn` may only get more precise: it never misses a path
    the residual reads.
- **Context validation.** `validateContext` may get stricter in a minor
  release only to reject values the language cannot represent (as it rejects
  `NaN` for a declared number).
- **Runtimes.** Node.js 22 and newer, current Bun, and modern ESM browsers with
  ES2022 and `Intl.DateTimeFormat` time zone support.

## What may change in a minor release

- **New syntax and functions.** An expression that is a syntax or check error
  today may become valid. The forms that are errors today to keep room for this
  include:
  - the reserved `|>`;
  - chained comparisons;
  - `??` beside another binary operator without parentheses (`&&`, `||`,
    comparisons, arithmetic);
  - a prefix operator left of `**`.
- **New built-in functions.** Adding one never changes an existing environment's
  expressions, because a host function of the same name takes precedence and
  an unknown function was previously an error. New overloads of an existing
  built-in never take a lambda at an argument position that takes a value
  today: `.` binds to the nearest argument whose parameter is a function in any
  overload, so such an overload would silently re-bind `.` in stored
  expressions (`users.filter(.score > max(.bonus, .cap))`). That is a major
  change.
- **New fields in exported interfaces.** An options or input interface may gain
  optional fields, and a result interface may gain fields. Construct the
  limits and options objects you pass as literals of the documented fields
  rather than implementing exported interfaces (such as `Limits`) in full.
  `Environment`, `Program`, `Explanation`, `Trace`, and `LanguageService` are
  for using, not implementing: they may gain members in a minor release.
- **New variants in exported unions.** This covers syntax node types,
  `BinaryOperator` and `UnaryOperator`, `Type` kinds, `ErrorCode`,
  `DiagnosticCode`, a diagnostic's `severity`, `LimitName`, `CompletionKind`,
  a `Trace`'s `kind`, partial evaluation's `status`, the query `ColumnType` and
  `SQLParam`, `CallStyle`, and the kinds of value a literal node holds. Avoid
  exhaustive switches without a default branch.
- **More precise static types.** A result type may become narrower when
  inference improves (for example `any` becoming `number`). New warnings may
  appear. New errors appear only for expressions that could not have evaluated
  successfully.
- **Messages and performance.** Error and diagnostic wording, benchmark
  numbers, and internal modules under `src/`. A diagnostic's `suggestion` may
  name a different (better) candidate.
- **Editor results.** The language service's completion items, their details,
  and their order are not covered; they may change to give better suggestions.
- **Partial-evaluation output.** The residual a `partial()` call produces may
  get simpler, and the names of its bindings (`__known1`) may change. A stored
  residual stays valid as long as its `source` and `bindings` are stored and
  used together, which is the only supported way to store one.
- **Step costs.** The number of steps an operation charges may be adjusted to
  follow its real cost, so an expression close to its `maxSteps` budget may
  start or stop hitting it. Leave headroom in the budgets you set. Within one
  release the count is deterministic.

## Release discipline

- Public API additions require tests; language additions require conformance
  cases.
- Removals and behavior changes require a major release and a changelog entry
  explaining the migration.
