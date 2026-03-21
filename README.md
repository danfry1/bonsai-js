<p align="center">
  <img src="https://raw.githubusercontent.com/danfry1/bonsai-js/main/website/logo.png" alt="bonsai-js" width="120" />
</p>

<h1 align="center">bonsai-js</h1>

[![npm version](https://img.shields.io/npm/v/bonsai-js)](https://www.npmjs.com/package/bonsai-js)
[![npm downloads](https://img.shields.io/npm/dm/bonsai-js)](https://www.npmjs.com/package/bonsai-js)
[![CI](https://github.com/danfry1/bonsai-js/actions/workflows/ci.yml/badge.svg)](https://github.com/danfry1/bonsai-js/actions/workflows/ci.yml)
[![CodeQL](https://github.com/danfry1/bonsai-js/actions/workflows/codeql.yml/badge.svg)](https://github.com/danfry1/bonsai-js/actions/workflows/codeql.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/bonsai-js)](https://bundlephobia.com/package/bonsai-js)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/bonsai-js)
[![node](https://img.shields.io/node/v/bonsai-js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-typed-blue)](https://www.typescriptlang.org)
[![license](https://img.shields.io/npm/l/bonsai-js)](https://github.com/danfry1/bonsai-js/blob/main/LICENSE)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12173/badge)](https://www.bestpractices.dev/projects/12173)

A safe expression language for rules, filters, templates, and user-authored logic. Runs in any JavaScript runtime.

Bonsai gives you a constrained expression language with caching, typed errors, pluggable transforms/functions, and safety controls. It is designed for cases where `eval()` would be inappropriate: business rules, formula fields, admin-defined filters, template helpers, and product configuration.

## Install

```bash
bun add bonsai-js
# or
npm install bonsai-js
```

[npm](https://www.npmjs.com/package/bonsai-js) · [Playground](https://danfry1.github.io/bonsai-js/playground.html) · [Docs](https://danfry1.github.io/bonsai-js/docs.html)

## When to use it

- Evaluate expressions from config, database records, or admin tools.
- Let users define filters, conditions, or formatting rules without executing arbitrary JavaScript.
- Build reusable compiled rules for hot paths.
- Add a small expression language to a product without shipping a large runtime dependency tree.

## Quick Start

```ts
import { bonsai } from 'bonsai-js'
import { arrays, math, strings } from 'bonsai-js/stdlib'

const expr = bonsai()
  .use(strings)
  .use(arrays)
  .use(math)

expr.evaluateSync('1 + 2 * 3') // 7

expr.evaluateSync('user.age >= 18', {
  user: { age: 25 },
}) // true

expr.evaluateSync('name |> trim |> upper', {
  name: '  dan  ',
}) // 'DAN'

expr.evaluateSync('users |> filter(.age >= 18) |> map(.name)', {
  users: [
    { name: 'Alice', age: 25 },
    { name: 'Bob', age: 15 },
  ],
}) // ['Alice']

// JS-style method chaining works too
expr.evaluateSync('users.filter(.age >= 18).map(.name)', {
  users: [
    { name: 'Alice', age: 25 },
    { name: 'Bob', age: 15 },
  ],
}) // ['Alice']

expr.evaluateSync('[1, 2, 3, 4].filter(. > 2)') // [3, 4]

expr.evaluateSync('user?.profile?.avatar ?? "default.png"', {
  user: null,
}) // 'default.png'
```

## Choose the Right API

| Need | API |
| --- | --- |
| Repeated evaluations with caching, plugins, or safety options | `bonsai()` |
| One-off evaluation with default behavior | `evaluateExpression()` |
| Hot-path reuse of the same expression | `compile()` |
| Syntax checks and reference extraction before execution | `validate()` |
| Async transforms or async functions | `evaluate()` / compiled `.evaluate()` |
| Sync-only execution | `evaluateSync()` / compiled `.evaluateSync()` |

## Real-world Patterns

### Rule engine

```ts
import { bonsai } from 'bonsai-js'

const expr = bonsai({
  timeout: 50,
  maxDepth: 50,
  allowedProperties: ['user', 'age', 'country', 'plan'],
})

const isEligible = expr.compile('user.age >= 18 && user.country == "GB" && user.plan == "pro"')

isEligible.evaluateSync({
  user: { age: 25, country: 'GB', plan: 'pro' },
}) // true
```

### Async enrichment

```ts
import { bonsai } from 'bonsai-js'

const expr = bonsai()

expr.addFunction('lookupTier', async (userId) => {
  const row = await db.users.findById(String(userId))
  return row?.tier ?? 'free'
})

await expr.evaluate('lookupTier(userId) == "pro"', { userId: 'u_123' })
```

### Editor validation

```ts
const result = expr.validate('user.name |> upper')

if (result.valid) {
  result.references.identifiers // ['user']
  result.references.transforms  // ['upper']
} else {
  console.error(result.errors[0]?.formatted)
}
```

## Array Methods and Lambdas

Bonsai supports two styles for working with arrays: **pipe transforms** and **JS-style method chaining**. Both use the same lambda shorthand.

### Lambda shorthand

Inside array methods, `.` refers to the current item:

- `.property` — access a property on each item (e.g., `.age`, `.name`)
- `. > value` — compare each item directly (e.g., `. > 2`, `. == "x"`)

Compound predicates work too: `.age >= 18 && .active`

### Pipe transforms (via stdlib)

```ts
import { arrays } from 'bonsai-js/stdlib'

const expr = bonsai().use(arrays)

expr.evaluateSync('users |> filter(.age >= 18) |> map(.name)', {
  users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }],
}) // ['Alice']

expr.evaluateSync('[1, 2, 3, 4] |> filter(. > 2)') // [3, 4]
```

### JS-style method chaining

No stdlib import required — `filter`, `map`, `find`, `some`, and `every` work as native array methods:

```ts
const expr = bonsai()

expr.evaluateSync('users.filter(.age >= 18).map(.name)', {
  users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }],
}) // ['Alice']

expr.evaluateSync('[1, 2, 3, 4].filter(. > 2)') // [3, 4]
expr.evaluateSync('[1, 2, 3].map(. * 10)') // [10, 20, 30]
expr.evaluateSync('[1, 2, 3].find(. > 1)') // 2
expr.evaluateSync('[1, 2, 3].some(. > 2)') // true
expr.evaluateSync('[1, 2, 3].every(. > 0)') // true
```

Both styles support async evaluation via `evaluate()`.

### Built-in safe methods

These methods work via native `.method()` syntax without any imports. Mutating methods (`reverse`, `sort`, `push`, `pop`, `splice`, etc.) are blocked to prevent context mutation.

**String methods:**

| Method | Example |
| --- | --- |
| `trim`, `trimStart`, `trimEnd` | `"  hi  ".trim()` → `"hi"` |
| `toLowerCase`, `toUpperCase` | `"Hello".toLowerCase()` → `"hello"` |
| `startsWith`, `endsWith` | `"hello".startsWith("hel")` → `true` |
| `includes`, `indexOf`, `lastIndexOf` | `"hello".includes("ell")` → `true` |
| `slice`, `substring`, `at` | `"hello".slice(1, 3)` → `"el"` |
| `replace`, `replaceAll` | `"abc".replace("a", "x")` → `"xbc"` |
| `split` | `"a,b,c".split(",")` → `["a", "b", "c"]` |
| `padStart`, `padEnd` | `"5".padStart(3, "0")` → `"005"` |
| `charAt`, `charCodeAt`, `repeat`, `concat` | `"ab".repeat(2)` → `"abab"` |

**Array methods (with lambda support):**

| Method | Example |
| --- | --- |
| `filter` | `[1,2,3].filter(. > 1)` → `[2, 3]` |
| `map` | `[1,2,3].map(. * 10)` → `[10, 20, 30]` |
| `find`, `findIndex` | `[1,2,3].find(. > 1)` → `2` |
| `some`, `every` | `[1,2,3].some(. > 2)` → `true` |
| `flatMap` | `[[1],[2,3]].flatMap(.)` |

**Array methods (non-callback):**

| Method | Example |
| --- | --- |
| `join` | `[1,2,3].join(", ")` → `"1, 2, 3"` |
| `includes`, `indexOf`, `lastIndexOf` | `[1,2,3].includes(2)` → `true` |
| `slice`, `at`, `concat`, `flat` | `[1,2,3].concat([4])` → `[1, 2, 3, 4]` |
| `toReversed`, `toSorted`, `toSpliced`, `with` | `[3,1,2].toSorted()` → `[1, 2, 3]` |

**Number methods:** `toFixed`, `toString`

**Pipe-only transforms** (require stdlib import): `count`, `first`, `last`, `reverse`, `flatten`, `unique`, `sort`, `upper`, `lower`, `trim`, `sum`, `avg`, `clamp`, and more. See [Standard Library](#standard-library) for the full list.

## API Reference

### `bonsai(options?)`

Creates a reusable evaluator instance with its own extension registry and caches.

```ts
import { bonsai } from 'bonsai-js'

const expr = bonsai(options?: BonsaiOptions)
```

`BonsaiOptions`:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `timeout` | `number` | `0` | Evaluation timeout in milliseconds. `0` disables the timeout check. |
| `maxDepth` | `number` | `100` | Maximum evaluation depth before throwing `BonsaiSecurityError('MAX_DEPTH', ...)`. |
| `maxArrayLength` | `number` | `100000` | Maximum array literal or expanded spread size. |
| `cacheSize` | `number` | `256` | Per-instance cache size for compiled expressions and parsed AST reuse. |
| `allowedProperties` | `string[]` | `undefined` | Whitelist of allowed member/method names. Does not apply to root identifiers or object-literal keys. |
| `deniedProperties` | `string[]` | `undefined` | Denylist of blocked member/method names. Does not apply to root identifiers or object-literal keys. |

Important notes:

- `allowedProperties` and `deniedProperties` apply to **member access** (`obj.name`) and **method calls** (`str.slice()`), not root identifiers (`name`) or object-literal keys (`{ name: value }`).
- If you whitelist `user.name`, you must allow both `user` and `name` as member names.
- Numeric array indices (e.g., `items[0]`) bypass allow/deny lists automatically.
- `__proto__`, `constructor`, and `prototype` are always blocked at every access level, even if you include them in an allowlist.

### `evaluateSync<T>(expression, context?)`

Runs an expression synchronously and returns its result immediately.

```ts
const result = expr.evaluateSync<number>('price * quantity', {
  price: 9.99,
  quantity: 3,
})
```

Use this when:

- your transforms and functions are synchronous
- you want the lowest overhead path
- the caller is already synchronous

If any registered transform, function, or method returns a `Promise`, `evaluateSync()` will throw an `BonsaiTypeError` identifying the offending call and suggesting `evaluate()` instead.

### `evaluate<T>(expression, context?)`

Runs an expression asynchronously and returns a `Promise<T>`.

```ts
const tier = await expr.evaluate<string>('userId |> fetchTier', {
  userId: 'u_123',
})
```

Use this when:

- any transform or function is async
- you need to await host I/O during evaluation

### `compile(expression)`

Compiles an expression once and returns a reusable `CompiledExpression`.

```ts
const compiled = expr.compile('user.age >= minAge')

compiled.evaluateSync({ user: { age: 25 }, minAge: 18 }) // true
compiled.evaluateSync({ user: { age: 15 }, minAge: 18 }) // false
await compiled.evaluate({ user: { age: 21 }, minAge: 21 }) // true
```

Use `compile()` when the same expression will run many times with different contexts. This avoids repeated parse/compile work and gives you an explicit object to keep in memory.

Notes:

- compiled expressions stay tied to the instance that created them
- compiled evaluation uses that instance's current transforms/functions and safety options
- `compiled.ast` exposes the optimized AST for advanced tooling/debugging

### `validate(expression)`

Parses an expression without evaluating it.

```ts
const result = expr.validate('user.name |> upper')

if (result.valid) {
  result.ast
  result.references.identifiers // ['user']
  result.references.transforms // ['upper']
  result.references.functions // []
}
```

When invalid, `validate()` returns formatted errors:

```ts
const invalid = expr.validate('1 + * 2')

if (!invalid.valid) {
  invalid.errors[0]?.message
  invalid.errors[0]?.formatted
}
```

`validate()` is useful for:

- form validation
- editor integrations
- autocomplete/reference extraction
- preflight checks before storing expressions

Important note: `validate()` checks syntax and extracts references. It does not execute the expression and it does not verify that referenced transforms/functions are currently registered.

### `evaluateExpression<T>(expression, context?)`

Convenience helper for one-off evaluation without manually creating an instance.

```ts
import { evaluateExpression } from 'bonsai-js'

evaluateExpression('1 + 2') // 3
evaluateExpression<number>('x * 2', { x: 21 }) // 42
```

`evaluateExpression()` uses a lazily created shared default instance. It is useful for quick scripts, tests, and simple one-off calls, but it does not let you configure safety options or register custom transforms/functions.

## Instance Methods

```ts
interface BonsaiInstance {
  use(plugin: BonsaiPlugin): this
  addTransform(name: string, fn: TransformFn): this
  addFunction(name: string, fn: FunctionFn): this
  removeTransform(name: string): boolean
  removeFunction(name: string): boolean
  hasTransform(name: string): boolean
  hasFunction(name: string): boolean
  listTransforms(): string[]
  listFunctions(): string[]
  clearCache(): void
  compile(expression: string): CompiledExpression
  evaluate<T = unknown>(expression: string, context?: Record<string, unknown>): Promise<T>
  evaluateSync<T = unknown>(expression: string, context?: Record<string, unknown>): T
  validate(expression: string): ValidationResult
}
```

Method notes:

- `use()` runs a plugin immediately and returns the same instance.
- `addTransform()` and `addFunction()` overwrite any existing registration with the same name.
- `listTransforms()` and `listFunctions()` return the currently registered names.
- `clearCache()` clears the internal AST cache and compiled-expression cache. It does not remove registered transforms/functions.

## Extending the Runtime

### Transforms

Transforms receive the piped value as their first argument.

```ts
expr.addTransform('repeat', (value, times) =>
  String(value).repeat(Number(times)),
)

expr.evaluateSync('"ha" |> repeat(3)') // 'hahaha'
```

`TransformFn`:

```ts
type TransformFn = (value: unknown, ...args: unknown[]) => unknown | Promise<unknown>
```

### Functions

Functions are called directly by name inside expressions.

```ts
expr.addFunction('clamp', (value, min, max) =>
  Math.min(Math.max(Number(value), Number(min)), Number(max)),
)

expr.evaluateSync('clamp(score, 0, 100)', { score: 150 }) // 100
```

`FunctionFn`:

```ts
type FunctionFn = (...args: unknown[]) => unknown | Promise<unknown>
```

### Plugins

Plugins are just functions that receive an `BonsaiInstance`.

```ts
import type { BonsaiPlugin } from 'bonsai-js'

const currency: BonsaiPlugin = (expr) => {
  expr.addTransform('usd', (value) => `$${Number(value).toFixed(2)}`)
  expr.addFunction('discount', (price, pct) => Number(price) * (1 - Number(pct) / 100))
}

const expr = bonsai().use(currency)

expr.evaluateSync('discount(price, 20) |> usd', { price: 100 }) // '$80.00'
```

Important note: custom transforms, functions, and plugins run as normal host JavaScript. Bonsai constrains the expression language, not the code you register into it.

## Standard Library

Import only what you need:

```ts
import { arrays, dates, math, strings, types } from 'bonsai-js/stdlib'
```

Or load everything:

```ts
import { all } from 'bonsai-js/stdlib'

const expr = bonsai().use(all)
```

Modules:

| Module | Includes |
| --- | --- |
| `strings` | `upper`, `lower`, `trim`, `split`, `replace`, `replaceAll`, `startsWith`, `endsWith`, `includes`, `padStart`, `padEnd` |
| `arrays` | `count`, `first`, `last`, `reverse`, `flatten`, `unique`, `join`, `sort`, `filter`, `map`, `find`, `some`, `every` |
| `math` | transforms `round`, `floor`, `ceil`, `abs`, `sum`, `avg`, `clamp`; functions `min`, `max` |
| `types` | `isString`, `isNumber`, `isArray`, `isNull`, `toBool`, `toNumber`, `toString` |
| `dates` | function `now`; transforms `formatDate`, `diffDays` |
| `all` | registers every stdlib module above |

## Error Handling

Runtime exports:

```ts
import {
  ExpressionError,
  BonsaiReferenceError,
  BonsaiSecurityError,
  BonsaiTypeError,
  formatError,
  formatBonsaiError,
} from 'bonsai-js'
```

Error classes:

| Error | When | Useful fields |
| --- | --- | --- |
| `ExpressionError` | parse/syntax errors | `source`, `start`, `end`, `suggestion?` |
| `BonsaiTypeError` | wrong runtime value type or sync/async mismatch | `transform`, `expected`, `received`, `location?`, `formatted?` |
| `BonsaiReferenceError` | unknown transform/function/method | `kind`, `identifier`, `suggestion?`, `location?`, `formatted?` |
| `BonsaiSecurityError` | blocked access or resource limit violation | `code`, `location?`, `formatted?` |

Example:

```ts
try {
  expr.evaluateSync('name |> unknownTransform', { name: 'Alice' })
} catch (error) {
  if (error instanceof BonsaiReferenceError) {
    console.error(error.identifier)
    console.error(error.suggestion)
    console.error(error.location)
    console.error(error.formatted ?? formatBonsaiError(error))
  }
}
```

`formatError()` formats a source span directly, and `formatBonsaiError()` formats a caught Bonsai runtime error using its attached location:

```ts
const parseMessage = formatError('Unexpected token "*"', {
  source: '1 + * 2',
  start: 4,
  end: 5,
})

try {
  expr.evaluateSync('count |> upper', { count: 42 })
} catch (error) {
  console.error(formatBonsaiError(error))
}
```

## Safety Model

Bonsai is designed to safely evaluate expressions, but it is not a process sandbox.

What Bonsai does:

- blocks access to `__proto__`, `constructor`, and `prototype` at every access level, even if explicitly allowed
- enforces `maxDepth`, `maxArrayLength`, and optional `timeout`
- lets you allowlist or denylist member/method names via `allowedProperties`/`deniedProperties`
- prevents expressions from reaching globals or importing modules
- looks up root identifiers via own-property checks only (`Object.hasOwn`), so context prototype chains cannot leak
- creates object literals with `null` prototypes, preventing prototype pollution through expression-constructed objects
- validates method call receivers against a safe allowlist of types (string, number, array, plain object) — array methods include `filter`, `map`, `find`, `some`, `every`, `includes`, `indexOf`, `slice`, `at`
- automatically bypasses allow/deny lists for canonical numeric array indices (e.g., `items[0]`)
- rejects `Promise` values in `evaluateSync()` with actionable errors that name the offending function/transform/method and suggest using `evaluate()` instead

Important operational caveats:

- `allowedProperties` and `deniedProperties` apply to member access (`obj.name`) and method calls (`str.slice()`), not root identifiers (`name`) or object-literal keys (`{ name: value }`)
- `timeout` is cooperative and checked during evaluator traversal; it cannot forcibly interrupt arbitrary synchronous code inside your own custom transforms/functions
- async transforms/functions are bounded only at awaited boundaries
- custom transforms/functions/plugins are trusted host code

Recommended configuration for untrusted expressions:

```ts
const expr = bonsai({
  timeout: 50,
  maxDepth: 50,
  maxArrayLength: 10000,
  allowedProperties: ['user', 'age', 'country', 'plan'],
})
```

Practical guidance:

- pass the smallest context object you can
- prefer `allowedProperties` over `deniedProperties` for user-authored expressions
- keep custom extensions small and deterministic
- if you need hard isolation from untrusted host code, run evaluation in a worker/process boundary

## Performance Guidance

Bonsai is optimized for repeated evaluation.

- Reuse an instance instead of recreating one per request.
- Use `compile()` when the same expression runs many times.
- Use `evaluateSync()` for sync-only runtimes.
- Import only the stdlib modules you need.
- Avoid calling `clearCache()` unless you truly need to drop cached expressions.

Benchmark guidance and current numbers live in the website docs and benchmark suite. Treat raw benchmark numbers as directional, not part of the API contract.

## Autocomplete

Bonsai ships a cursor-aware autocomplete engine at `bonsai-js/autocomplete`. It provides ranked, type-aware completion suggestions for any cursor position in an expression — designed for rule builders, expression editors, and admin tools. Tree-shakeable: if you don't import it, it's not in your bundle.

```ts
import { bonsai } from 'bonsai-js'
import { strings, arrays } from 'bonsai-js/stdlib'
import { createAutocomplete } from 'bonsai-js/autocomplete'

const expr = bonsai().use(strings).use(arrays)

const ac = createAutocomplete(expr, {
  context: { user: { name: 'Alice', age: 25 }, items: [1, 2, 3] },
})

ac.complete('user.', 5)
// [{ label: 'name', detail: 'string', kind: 'property' },
//  { label: 'age',  detail: 'number', kind: 'property' }, ...]

ac.complete('user.name.', 10)
// [{ label: 'trim', detail: 'string → string', insertText: 'trim()', cursorOffset: 5 },
//  { label: 'toUpperCase', detail: 'string → string' }, ...]

ac.complete('items |> ', 9)
// Only array-compatible transforms — string-only transforms automatically excluded.

ac.complete('users.filter(.', 14)
// [{ label: 'name', detail: 'string' }, { label: 'age', detail: 'number' }]
```

### What it provides

| Context | What you get |
|---|---|
| `user.` | Object properties with value types |
| `user?.name?.` | Optional chaining — same completions as dot access |
| `user.name.` | Type-appropriate methods with return types |
| `user.name.trim().` | Methods inferred through chained calls (eval-based) |
| `user.name.to` | Fuzzy-filtered methods via static type inference |
| `items \|> ` | Transforms filtered by inferred input type |
| `users.filter(.` | Lambda element properties with types |
| `users.filter(.name.` | Lambda member — methods for the element property type |
| `groups.map(.users.filter(.` | Nested lambda element inference |
| `us` | Context variables, functions, keywords |
| `name.tLC` | Fuzzy matching (camelCase-aware) |

### How to integrate

The API returns pure data — no DOM, no framework dependency. Wire it into any UI:

```ts
// Custom dropdown
textarea.addEventListener('input', () => {
  ac.setContext(getCurrentContext())
  const completions = ac.complete(textarea.value, textarea.selectionStart)
  showDropdown(completions)
})

// Monaco editor
const monacoKindMap = {
  variable: monaco.languages.CompletionItemKind.Variable,
  property: monaco.languages.CompletionItemKind.Property,
  method: monaco.languages.CompletionItemKind.Method,
  transform: monaco.languages.CompletionItemKind.Function,
  function: monaco.languages.CompletionItemKind.Function,
  keyword: monaco.languages.CompletionItemKind.Keyword,
}

monaco.languages.registerCompletionItemProvider('bonsai', {
  triggerCharacters: ['.', '|', '('],
  provideCompletionItems(model, position) {
    ac.setContext(getCurrentContext())
    const offset = model.getOffsetAt(position)
    return {
      suggestions: ac.complete(model.getValue(), offset).map(c => ({
        label: c.label,
        kind: monacoKindMap[c.kind],
        insertText: c.insertText ?? c.label,
        detail: c.detail,
      })),
    }
  },
})
```

Context can be updated dynamically — call `ac.setContext(newData)` whenever the user's data changes.

### Options

```ts
createAutocomplete(instance, {
  // Expression evaluation context — the data your users are writing expressions against
  context: { user: { name: 'Alice' }, items: [1, 2, 3] },

  // Explicit transform type map — skips auto-probing for better performance.
  // Keys are transform names, values are arrays of accepted input types.
  // When omitted, types are discovered automatically by probing each transform.
  transformTypes: {
    upper: ['string'],
    trim: ['string'],
    count: ['array'],
    sort: ['array'],
  },

  // Error callback for debugging missing or incorrect completions.
  // Only called for unexpected internal errors — not for expected parse/eval failures.
  onError: (error, phase) => console.warn(`[autocomplete] ${phase}:`, error),
})
```

### Security policy

Autocomplete respects the same `allowedProperties` and `deniedProperties` policy configured on the Bonsai instance. Completions are filtered to match what the evaluator would actually allow:

```ts
const expr = bonsai({ allowedProperties: ['name', 'age'] })
const ac = createAutocomplete(expr, {
  context: { user: { name: 'Alice', secret: 'hidden' } },
})

ac.complete('user.', 5)
// 'secret' is excluded — only 'name' and 'age' appear
```

This applies to all contexts: property access, lambda element properties, and nested chain resolution. Methods (`trim`, `filter`, etc.) are always shown for their applicable types — they are controlled by `deniedProperties`, not `allowedProperties`.

### Completion type

```ts
interface Completion {
  label: string        // Display text and default insert text
  kind: 'variable' | 'property' | 'method' | 'transform' | 'function' | 'keyword'
  detail?: string      // Type info: 'string', 'string → array', '"Alice"', 'array(3)'
  insertText?: string  // Override insert: 'trim()', 'filter(.)', 'min()'
  cursorOffset?: number // Cursor position in insertText (e.g., between parens)
  sortPriority: number // Lower = higher rank
}
```

### Error handling

`complete()` never throws — it always returns `Completion[]`. If an unexpected internal error occurs, it returns `[]` and reports the error via the `onError` callback. Expected errors (syntax errors from incomplete expressions, security policy blocks, type mismatches) are silently handled as part of normal autocomplete operation.

## Stability

Bonsai follows SemVer for the documented package entrypoints `bonsai-js`, `bonsai-js/stdlib`, and `bonsai-js/autocomplete`.

- Supported runtimes are Node 20+ and current Bun releases.
- The packed npm artifact is smoke-tested on Node 20 and 22.
- Internal modules under `src/*` are not public API.

See [stability policy](./docs/stability-policy.md) for the compatibility boundary and release rules.

## License

MIT
