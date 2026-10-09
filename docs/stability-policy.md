# Stability Policy

Bonsai follows Semantic Versioning for its two package entrypoints:

- `bonsai-js`
- `bonsai-js/service`

## What is covered

- **The language.** Everything in [language.md](./language.md) and every case in
  `tests/conformance.test.ts`. Changing the result of an expression that
  evaluates successfully, or making it fail, requires a major release.
- **The API.** Exported functions, classes, types, options, and error codes.
- **Runtimes.** Node.js 22 and newer, current Bun, and modern ESM browsers with
  ES2022 and `Intl.DateTimeFormat` time zone support.

## What may change in a minor release

- **New syntax and functions.** An expression that is a syntax or check error
  today may become valid. The forms that are errors today to keep room for this
  include:
  - the reserved `|>`;
  - chained comparisons;
  - `??` mixed with `&&`/`||`;
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
- **New variants in exported unions.** This covers syntax node types, `Type`
  kinds, `ErrorCode`, `DiagnosticCode`, a diagnostic's `severity`,
  `CompletionKind`, a `Trace`'s `kind`, and partial evaluation's `status`.
  Avoid exhaustive switches without a default branch.
- **More precise static types.** A result type may become narrower when
  inference improves (for example `any` becoming `number`). New warnings may
  appear. New errors appear only for expressions that could not have evaluated
  successfully.
- **Messages and performance.** Error and diagnostic wording, benchmark
  numbers, and internal modules under `src/`. A diagnostic's `suggestion` may
  name a different (better) candidate.
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
