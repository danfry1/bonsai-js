# Stability Policy

Bonsai follows Semantic Versioning for its two package entrypoints:

- `bonsai-js`
- `bonsai-js/service`

## What is covered

- **The language.** Everything in [language.md](./language.md) and every case in
  `tests/conformance.test.ts`. Changing the result of an expression that
  evaluates successfully, or making it fail, requires a major release.
- **The API.** Exported functions, classes, types, options, and error codes.
- **Runtimes.** Node.js 24 and newer, current Bun, and modern ESM browsers with
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
  an unknown function was previously an error.
- **New variants in exported unions.** This covers syntax node types, `Type`
  kinds, `ErrorCode`, `DiagnosticCode`, and `CompletionKind`. Avoid exhaustive
  switches without a default branch.
- **More precise static types.** A result type may become narrower when
  inference improves (for example `any` becoming `number`). New warnings may
  appear. New errors appear only for expressions that could not have evaluated
  successfully.
- **Messages and performance.** Error and diagnostic wording, benchmark
  numbers, and internal modules under `src/`.

## Release discipline

- Public API additions require tests; language additions require conformance
  cases.
- Removals and behavior changes require a major release and a changelog entry
  explaining the migration.
