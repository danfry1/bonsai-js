# Install

Bonsai is published to npm as an ESM-only package with TypeScript types included. It has no runtime dependencies.

::: code-group
```bash [npm]
npm install bonsai-js
```
```bash [bun]
bun add bonsai-js
```
```bash [pnpm]
pnpm add bonsai-js
```
```bash [yarn]
yarn add bonsai-js
```
:::

Upgrading from 0.x? The [migration guide](/guide/migrating) covers every change.

## Entry points

| Import | Contents |
| --- | --- |
| `bonsai-js` | `bonsai()`, `fn()`, the type builders `t`, error classes, and types |
| `bonsai-js/lite` | The same, without explaining and partial evaluation, for smaller browser bundles (see [the lite entry point](/api/environment#the-lite-entry-point)) |
| `bonsai-js/runtime` | `runtime()`, which loads and evaluates rules compiled elsewhere with `toArtifact()`, without the type checker (see [Runtime](/api/runtime)) |
| `bonsai-js/runtime/core` | The same `runtime()` with only the built-in functions you pass, for the smallest browser bundles |
| `bonsai-js/builtins` | Each built-in function as its own export, for `runtime/core` and the `builtins` option |
| `bonsai-js/service` | `createLanguageService()` for editor completions, hover, and diagnostics |
| `bonsai-js/query` | `toSQL()` and `toMongo()`, which translate a filter to a SQL `WHERE` clause or a MongoDB filter |

## Runtimes

- Node.js 22 and newer, current Bun, and modern browsers with ES2022 and `Intl.DateTimeFormat` time zone support.
- The package is ESM. On Node, `require('bonsai-js')` also works from CommonJS where Node can load ES modules synchronously (22.12 and newer).
- The same code runs everywhere: there are no Node-specific APIs and no generated code, so Bonsai works under a Content Security Policy that forbids `eval`.

### TypeScript settings

- The type declarations use `const` type parameters (TypeScript 5.0 or newer) and are tested with TypeScript 5.9 and 7.0.
- They resolve under every `moduleResolution` setting, including the legacy `node` (node10) for the `bonsai-js/lite`, `bonsai-js/runtime`, `bonsai-js/runtime/core`, `bonsai-js/builtins`, `bonsai-js/service`, and `bonsai-js/query` entry points.
- Projects compiling to CommonJS should use `"module": "node20"` or `"nodenext"`. The older `"node16"` setting does not know `require()` can load ES modules and reports TS1479; use `await import('bonsai-js')` there.

## Bundle size

In a browser bundle, evaluating rules that were checked and compiled on a server adds about 29 KB minified and gzipped, from `bonsai-js/runtime/core` with only the built-in functions your rules call (`bonsai-js/runtime`, with all of them, is about 43 KB). Checking rules in the browser too adds about 69 KB: the parser, type checker, compiler, and built-in library, with explaining and partial evaluation included. From `bonsai-js/lite`, which leaves those two out, it adds about 57 KB. The `query` and `service` entry points are separate; the language service on its own is about 47 KB, since it includes the type checker. Unused modules are tree-shaken: importing only `t` adds under 1 KB, and all the error classes about 1.6 KB. CI enforces these budgets.

## First evaluation

```ts
import { bonsai } from 'bonsai-js'

const env = bonsai()
env.evaluateSync('order.total >= threshold', { order: { total: 120 }, threshold: 100 }) // => true
```

Next: the [Quick Start](/guide/quick-start) adds types, checking, and compiled programs.
