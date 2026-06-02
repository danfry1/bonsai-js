# Contributing to Bonsai

Thanks for your interest in contributing. This guide covers the development setup, workflow, and quality expectations.

## Setup

```bash
git clone https://github.com/danfry1/bonsai-js.git
cd core
bun install
```

Requires [Bun](https://bun.sh/) and Node.js 22+.

## Development Commands

| Command | What it does |
|---------|-------------|
| `bun test` | Run all tests |
| `bun test:watch` | Run tests in watch mode |
| `bun run test:coverage` | Run tests with coverage and enforce thresholds (also runs in CI) |
| `bun run lint` | Lint with oxlint |
| `bun run format` | Format with oxfmt |
| `bun run format:check` | Check formatting without writing |
| `bun run typecheck` | Type-check with tsc |
| `bun run build` | Build with tsdown |
| `bun run bench` | Run benchmarks |
| `bun run bench:gate` | Run performance regression gate |

## Making Changes

1. Fork and create a branch from `main`.
2. Write or update tests for your change.
3. Run the full quality suite before pushing:
   ```bash
   bun run format:check && bun run lint && bun run typecheck && bun test
   ```
4. Open a pull request against `main`.

## Code Style

- **TypeScript, ESM-only.** All source is in `src/`, tests in `tests/`.
- **Linting:** [oxlint](https://oxc.rs/) with strict rules. Run `bun run lint` and fix all errors.
- **Formatting:** [oxfmt](https://oxc.rs/) for consistent formatting. Run `bun run format` before committing (CI runs `bun run format:check`).
- **No runtime dependencies.** Do not add `dependencies` to package.json.

## Testing

We use [Vitest](https://vitest.dev/) with `bun test`.

- Every bug fix needs a regression test.
- Every new feature needs tests covering the happy path and error cases.
- Tests live in `tests/` and mirror the source structure.

## Performance

A performance gate runs on every release. If your change touches the evaluator hot path:

- Run `bun run bench` to check impact.
- Run `bun run bench:gate` to verify no regressions below the minimum thresholds.

## Pull Request Guidelines

- Keep PRs focused. One feature or fix per PR.
- Write a clear title and description explaining what and why.
- Ensure CI passes (lint, typecheck, test, build, perf gate).

## Releasing

Releases are driven by a Git tag and use npm **staged publishing** over OIDC trusted publishing. No npm tokens are involved, and every release requires a human 2FA approval before the version becomes installable.

### 1. Cut the release

Bump `version` in `package.json` and update `CHANGELOG.md` in a PR titled `chore: release X.Y.Z`, and merge it to `main`. Then tag that commit and push the tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`.

### 2. CI stages the release (automatic)

The release workflow runs the full gate (lint, typecheck, test, build, performance gate, package checks), then runs `npm stage publish`. This authenticates via OIDC (no token), attaches provenance, and uploads the tarball to npm's **stage queue**. The version is **not installable yet**. CI also creates the GitHub Release.

### 3. Approve the staged version (required, manual)

The staged version waits in the queue until a maintainer approves it with a 2FA proof of presence. From a trusted device with npm CLI `>= 11.15.0` (run `npm login` first):

```bash
npm stage list bonsai-js      # find the stage-id
npm stage view <stage-id>     # inspect the staged version (optional)
npm stage approve <stage-id>  # 2FA prompt; makes the version live
```

Alternatively, approve from the **Staged Packages** tab on the package page at npmjs.com. After approval the version is published with provenance and becomes installable. If no one approves, the version never ships, by design: a compromised CI run or credential can only queue a release, not publish it.

### npm configuration (one-time, already set)

- Trusted publisher `danfry1/bonsai-js` via `release.yml`, with `npm stage publish` in its allowed actions.
- Publishing access set to "Require two-factor authentication and disallow tokens", so only OIDC plus a human 2FA approval can publish.

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together (the
lexer to parser to compiler to evaluator pipeline, the deliberate sync/async
split, caching, and the security model). A quick file map:

```
src/
  index.ts          # Public API: bonsai(), evaluateExpression()
  types.ts          # TypeScript types and interfaces
  errors.ts         # Error classes: ExpressionError, BonsaiTypeError, etc.
  lexer.ts          # Tokenizer
  parser.ts         # Recursive descent parser
  compiler.ts       # AST optimizer (constant folding, dead branch elimination)
  evaluator.ts      # Synchronous evaluator
  evaluator-async.ts # Asynchronous evaluator
  eval-ops.ts       # Shared evaluation helpers
  execution-context.ts # Security policy and per-evaluation state
  plugins.ts        # Plugin registry
  cache.ts          # LRU cache
  stdlib/           # Standard library modules (strings, arrays, math, types, dates)
tests/              # Test files
benchmarks/         # Performance benchmarks
```

## Stability Policy

See [docs/stability-policy.md](./docs/stability-policy.md) for what is considered public API and what may change in minor releases.
