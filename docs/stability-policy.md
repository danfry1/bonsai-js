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

## AST Contract

`validate().ast` is a supported
advanced API, but new syntax can add new AST node variants in minor releases.
Consumers should avoid exhaustive switches without a default branch if they
want forward compatibility.

## Release Discipline

- Public API additions require tests.
- Public API removals or semantic changes require a major version bump.
- Any change to documented syntax, options, or exports must update `README.md`, `CHANGELOG.md`, and relevant package smoke tests.
