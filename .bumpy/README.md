# 🐸 Bumpy

This directory is used by [bumpy](https://bumpy.varlock.dev) to manage versioning and changelogs.

Bumpy is a modern versioning tool for JavaScript/TypeScript projects (monorepos and single packages). It uses **bump files** — small markdown files in this directory — to declare pending version changes. These files are consumed during the release process to compute version bumps, update changelogs, and publish packages.

## How it works

1. When you make a change that should trigger a release, create a bump file (typically one per PR)
2. Bump files accumulate on your main branch until you're ready to release
3. At release time `bun run bump:version` merges all pending bumps, updating `version` in `package.json` and `CHANGELOG.md`. Publishing stays on this repo's tag-driven staged-publish flow (see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing)), not bumpy.

## Creating bump files

> This repo pins bumpy as a devDependency. Invoke it through the `bun run`
> script wrappers below, never `bunx bumpy` — `bunx` falls back to fetching the
> latest version from the registry when the package is not installed locally,
> which would diverge from the pinned version CI enforces.

### Interactive

```bash
bun run bump
```

### Non-interactive (useful for AI-assisted development)

```bash
bun run bump -- --packages "package-name:minor,other-package:patch" --message "Description of changes" --name "my-change"
```

### By hand

Create a `.md` file in this directory with YAML frontmatter mapping package names to bump levels (`major`, `minor`, `patch`, or `none`), and a markdown body for the changelog entry:

```markdown
---
'package-name': minor
---

Added a new feature.
```

### From conventional commits

```bash
bun run bump:generate
```

### Empty bump files

For PRs that intentionally don't need a release (docs, CI, etc.):

```bash
bun run bump -- --empty --name "docs-update"
```

## Keeping bump files up to date

As a PR evolves, make sure its bump file stays in sync. If the scope of changes grows (e.g., a patch becomes a new feature), update the bump level and description to match. Reviewers and AI assistants should treat the bump file as part of the PR — just like tests and docs.

## Files in this directory

- `_config.json` — bumpy configuration
- `README.md` — this file
- `*.md` (other than README.md) — pending bump files

📖 Full documentation: https://bumpy.varlock.dev
