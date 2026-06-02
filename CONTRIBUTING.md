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
| `bun run lint` | Lint with oxlint |
| `bun run typecheck` | Type-check with tsc |
| `bun run build` | Build with tsdown |
| `bun run bench` | Run benchmarks |
| `bun run bench:gate` | Run performance regression gate |

## Making Changes

1. Fork and create a branch from `main`.
2. Write or update tests for your change.
3. Run the full quality suite before pushing:
   ```bash
   bun run lint && bun run typecheck && bun test
   ```
4. Open a pull request against `main`.

## Code Style

- **TypeScript, ESM-only.** All source is in `src/`, tests in `tests/`.
- **Linting:** [oxlint](https://oxc.rs/) with strict rules. Run `bun run lint` and fix all errors.
- **Formatting:** [oxfmt](https://oxc.rs/) for consistent formatting.
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

## Project Structure

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
