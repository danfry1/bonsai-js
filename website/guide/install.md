# Install

Bonsai is published to npm as an ESM-only package with TypeScript types included. It has no runtime dependencies.

::: code-group
```bash [npm]
npm install bonsai-js@next
```
```bash [bun]
bun add bonsai-js@next
```
```bash [pnpm]
pnpm add bonsai-js@next
```
```bash [yarn]
yarn add bonsai-js@next
```
:::

These docs describe 1.0, which is in release candidate on npm's `next` tag. Without `@next`, the commands above install 0.5.0 until 1.0.0 is released.

## Entry points

| Import | Contents |
| --- | --- |
| `bonsai-js` | `bonsai()`, `fn()`, the type builders `t`, error classes, and types |
| `bonsai-js/service` | `createLanguageService()` for editor completions, hover, and diagnostics |
| `bonsai-js/query` | `toSQL()` and `toMongo()`, which translate a filter to a SQL `WHERE` clause or a MongoDB filter |

## Runtimes

Node.js 22 and newer, current Bun, and modern browsers with ES2022 and `Intl.DateTimeFormat` time zone support. The package is ESM; on Node, `require('bonsai-js')` also works from CommonJS where Node can load ES modules synchronously (22.12 and newer). TypeScript projects compiling CommonJS should use `"module": "node20"` or `"nodenext"`; the older `"node16"` setting does not know `require()` can load ES modules and reports TS1479 (use `await import('bonsai-js')` there). The same code runs everywhere: there are no Node-specific APIs and no generated code, so Bonsai works under a Content Security Policy that forbids `eval`.

## First evaluation

```ts
import { bonsai } from 'bonsai-js'

const env = bonsai()
env.evaluateSync('order.total >= threshold', { order: { total: 120 }, threshold: 100 }) // => true
```

Next: the [Quick Start](/guide/quick-start) adds types, checking, and compiled programs.
