# Stability Policy

Bonsai follows Semantic Versioning for the documented package entrypoints:

- `bonsai-js`
- `bonsai-js/stdlib`
- `bonsai-js/autocomplete`
- `bonsai-js/checker`

## Compatibility Guarantees

- Supported runtimes are Node.js 24 and newer, current Bun releases, and modern
  ESM browsers with ES2022 support. ES2023 copy-on-write array methods such as
  `toSorted()` require the corresponding host intrinsic.
- CI smoke-tests the packed npm artifact on Node 24 LTS.
- CI bundles every public surface for the browser and executes the result in an
  isolated realm without Node globals.
- The root runtime, stdlib, autocomplete, and checker subpath exports are stable public API.
- Documented expression syntax and evaluator behavior are covered by semver.
- The executable v1 semantics fixtures are the compatibility oracle for existing
  expression behavior. An incompatible fixture change requires a major release.

## Compatibility Boundaries

The following are not public API and may change in minor releases:

- Internal modules under `src/*`
- Build artifact filenames other than the documented package exports
- Benchmark numbers and internal performance heuristics
- Error message wording, unless code depends on a specific exported error class

## Namespace Growth

The bundled stdlib plugins may add new transform and function names in minor
releases. Because duplicate registration throws, register custom names after
applying the bundled plugins (a custom name then fails fast at startup on a
collision), or use `replaceTransform`/`replaceFunction` when shadowing a
bundled name is intentional. New allow-listed built-in methods may also appear
in minors; they only convert prior `METHOD_NOT_ALLOWED` errors into behavior.

## Closed Unions and Forward Compatibility

New variants may be added in minor releases to the exported closed unions:
AST node types, `Token`/`TokenType`, `BonsaiType` kinds,
`ArrayTransformTypeRule`, `BonsaiSecurityCode`, the checker's
`CheckDiagnosticCode`, and autocomplete's `Completion.kind`. Consumers should
avoid exhaustive switches without a default branch if they want forward
compatibility. Bonsai itself validates unknown vocabulary fail-closed at
runtime, so a same-version mismatch is impossible.

## AST Contract

`validate().ast` is a supported
advanced API, but new syntax can add new AST node variants in minor releases
(see Closed Unions above). `validate()` parses a fresh, unfrozen tree per
call; `compiled.ast` is a deep-frozen view. Grammar restrictions (forms
refused with a parse error, such as a unary base of `**` or unparenthesized
`??` beside `&&`/`||`) may be relaxed in minor releases; expressions that
parse today keep their meaning.

## Release Discipline

- Public API additions require tests.
- Public API removals or semantic changes require a major version bump.
- Any change to documented syntax, options, or exports must update `README.md`, `CHANGELOG.md`, and relevant package smoke tests.
