# Stability Policy

Bonsai follows Semantic Versioning for its four package entrypoints:

- `bonsai-js`
- `bonsai-js/lite`
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
- **Error codes.** The error class and code an expression and input produce
  do not change in a minor release, except that an error reported as
  `HOST_ERROR` or `TYPE_ERROR` may get a more specific code. Where the
  specification does not fix which of several errors is reported (a limit and
  a runtime error in the same evaluation, say), the one reported may change.
- **Default limits.** The default values in `limits` are part of the API: a
  minor release does not lower one except to fix a security problem, and may
  raise one. Set limits explicitly to pin them.
- **Offsets.** Spans and offsets (`start`, `end`, `nameStart`, `nameEnd`,
  `span`) count UTF-16 code units. A `position` is 1-based: `line` counts line
  feeds (`\n`, so `\r\n` ends one line and a lone `\r` does not end a line),
  and `column` counts UTF-16 code units from the start of the line.
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
  - An artifact (`toArtifact()`) in format version 1 loads in every 1.x
    `bonsai-js/runtime` whose definitions reproduce its digest, and evaluates
    as the program it was made from. The format is not changed in place: a
    change that older runtimes would misread is a new format version, which
    they refuse with `ARTIFACT` (`reason: 'version'`). Artifacts are bound to
    the definitions they were made with, built-in signatures included, so a
    minor release that changes a built-in's signature makes artifacts calling
    it fail to load (`reason: 'digest'`) until they are made again; release
    notes list such changes. Keep each artifact's source, which every release
    can compile again.
- **Context validation.** `validateContext` may get stricter in a minor
  release only to reject values the language cannot represent (as it rejects
  `NaN` for a declared number).
- **Runtimes.** The Node.js versions in the release's `engines` field (Node.js
  22 and newer for 1.0), current Bun, and modern ESM browsers with ES2022 and
  `Intl.DateTimeFormat` time zone support. The type declarations need
  TypeScript 5.0 or newer.

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
  Existing syntax node types may gain fields; a field added to an existing
  node type is optional in the trees you pass to `print()` and `mapChildren()`.
- **New variants in exported unions.** This covers syntax node types,
  `BinaryOperator` and `UnaryOperator`, `Type` kinds, `ErrorCode`,
  `BonsaiErrorName` (a new error class), `DiagnosticCode`, a diagnostic's
  `severity`, `LimitName`, `CompletionKind`,
  a `Trace`'s `kind`, partial evaluation's `status`, the query `ColumnType` and
  `SQLParam`, `CallStyle`, and the kinds of value a literal node holds. Avoid
  exhaustive switches without a default branch.
- **More precise static types.** A result type may become narrower when
  inference improves (for example `any` becoming `number`). New warnings may
  appear. New errors appear only for expressions that could not have
  evaluated successfully. One result depends on inference: `sum` of an empty
  list is a zero duration when the checker knows the list holds durations and
  the number `0` otherwise, so where better inference proves a list holds
  durations, an empty one sums to a duration instead of `0`. For data that
  matches its declared types, this is the only such case; 2.0 removes it.
  `isAssignable` follows the checker, so its answer for a pair of types may
  change when the checker improves.
- **TypeScript types.** The minimum TypeScript version may be raised in a minor
  release. Declarations that make inferred types more precise (`Infer`,
  context types, option types) may report new compile errors in code that was
  already wrong.
- **Runtime support.** Support for a Node.js release line may be dropped in a
  minor release once that line has reached its end of life; the `engines`
  field says which versions a release supports.
- **Messages, display text, and performance.** Error and diagnostic wording,
  `formatType()` output, `String(explanation)`, the `formatted` code frame,
  benchmark numbers, and internal modules under `src/`. Compare types with
  `isAssignable`, not by their formatted text. A diagnostic's `suggestion` may
  name a different (better) candidate.
- **Editor results.** The language service's completion items, their details,
  and their order are not covered; they may change to give better suggestions.
- **Partial-evaluation output.** The residual a `partial()` call produces may
  get simpler, and the names of its bindings (`__known1`) may change. A stored
  residual stays valid as long as its `source` and `bindings` are stored and
  used together, which is the only supported way to store one. The offsets of
  a residual's nodes, trace entries, and errors refer to the original
  expression and may become more precise.
- **Step costs.** The number of steps an operation charges may be adjusted to
  follow its real cost, so an expression close to its `maxSteps` budget may
  start or stop hitting it. Leave headroom in the budgets you set. Within one
  release the count is deterministic. The default host function `cost` (32
  steps) follows the same rule.

## Release discipline

- Public API additions require tests; language additions require conformance
  cases.
- Removals and behavior changes require a major release and a changelog entry
  explaining the migration.
