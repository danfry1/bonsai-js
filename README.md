<p align="center">
  <img src="https://raw.githubusercontent.com/danfry1/bonsai-js/main/website/public/logo.png" alt="bonsai-js" width="120" />
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

A safe expression language for rules, filters, templates, and user-authored logic. Runs in modern JavaScript runtimes.

Bonsai gives you a constrained expression language with caching, typed errors, pluggable transforms/functions, and safety controls. It is designed for cases where `eval()` would be inappropriate: business rules, formula fields, admin-defined filters, template helpers, and product configuration.

## Install

```bash
bun add bonsai-js
# or
npm install bonsai-js
```

[npm](https://www.npmjs.com/package/bonsai-js) · [Playground](https://danfry1.github.io/bonsai-js/playground) · [Docs](https://danfry1.github.io/bonsai-js/guide/)

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
  .seal()

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
| Schema, binding, argument, and result type checks | `bonsai-js/checker` |
| Async transforms or async functions | `evaluate()` / compiled `.evaluate()` |
| Sync-only execution | `evaluateSync()` / compiled `.evaluateSync()` |

## Real-world Patterns

### Rule engine

```ts
import { bonsai } from 'bonsai-js'

const expr = bonsai({
  timeout: 50,
  maxDepth: 50,
  allowedProperties: ['age', 'country', 'plan'],
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

### Context-aware functions

Register functions that read the evaluation context directly. The function
receives the evaluation context as its first parameter (typed read-only), so
you can keep expressions terse and let the function pull what it needs:

```ts
import { bonsai } from 'bonsai-js'

interface AppContext {
  currentUserId: string
  perms: readonly string[]
}

const app = bonsai<AppContext>()

app.addContextFunction('lookupCurrentUserTier', async (ctx) => {
  const row = await db.users.findById(ctx.currentUserId)
  return row?.tier ?? 'free'
})

app.addContextFunction('hasPermission', (ctx, action) =>
  ctx.perms.includes(String(action)))

await app.evaluate(
  'lookupCurrentUserTier() == "pro" && hasPermission("admin")',
  { currentUserId: 'u_123', perms: ['admin', 'write'] },
)
```

The instance is generic over the context type (`bonsai<AppContext>()`), giving
you end-to-end type safety: `ctx` is typed inside the function, and the call
site is type-checked against the same shape. If your context type has required
fields, TypeScript also requires you to pass the `context` argument to
`evaluate`, `evaluateSync`, and compiled-expression evaluation.

The context is passed to your function by reference, not copied or frozen. The
`Readonly<TCtx>` parameter type signals that you should treat it as read-only:
TypeScript flags reassigning its top-level fields. Bonsai does not deep-freeze
it, so nested mutation and writes from untyped JavaScript reach the object you
passed in. If you need isolation between evaluations, pass a fresh context
object each time.

Pure functions (`addFunction`) and context-aware functions (`addContextFunction`)
share a single namespace. Duplicate registration throws instead of silently
changing behavior; use `replaceFunction()` or `replaceContextFunction()` when
replacement is intentional (and `isContextFunction(name)` when the kind
matters). Functions registered with `addFunction` never receive the context;
reach for `addContextFunction` when a function needs it. A plugin applies to any
instance whose context provides what the plugin requires (see
[Plugins](#plugins)); a context-agnostic plugin applies anywhere, whether your
context generic is declared with `type` or `interface`.

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

A lambda is built from the accessor plus operators, member access, function calls, and methods. `map(myFn(.x))` eagerly evaluates `myFn` while constructing the callback; it does not mean `map(item => myFn(item.x))`. Put the call inside the lambda expression instead, for example `items.map(.price + tax())`. Higher-order methods accept only lambdas created by Bonsai—context-supplied JavaScript functions are data and are never executed as callbacks.

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

Arity and parameter types are part of the Bonsai language and are enforced at
runtime as well as by the checker. Bonsai does not inherit native JavaScript's
implicit method-argument coercions: for example, `text.slice("1")` and
`text.at()` are typed errors.

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
| `maxSourceLength` | `number` | `100000` | Maximum UTF-16 source length before tokenization. |
| `maxTokens` | `number` | `25000` | Maximum lexical token count, excluding EOF. |
| `maxAstNodes` | `number` | `10000` | Maximum parser/compiler node count. |
| `maxObjectProperties` | `number` | `10000` | Maximum properties in one object literal. |
| `maxCallArguments` | `number` | `1000` | Maximum arguments in one call, checked syntactically and again after spread expansion. |
| `timeout` | `number` | `0` | Evaluation timeout in milliseconds. `0` disables the timeout check. |
| `maxDepth` | `number` | `100` | Maximum evaluation depth before throwing `BonsaiSecurityError('MAX_DEPTH', ...)`. |
| `maxArrayLength` | `number` | `100000` | Maximum array size produced during evaluation, including array literals, expanded spread, and array-returning methods (`split`, `map`, `flat`, `concat`, ...). Exceeding it throws `BonsaiSecurityError('MAX_ARRAY_LENGTH', ...)`. |
| `maxStringLength` | `number` | `100000` | Maximum string size produced by a string-returning method (`padStart`, `padEnd`, `repeat`, `join`, `concat`, `slice`, ...). Applies to the produced length (e.g. `arr.join(sep)` is bounded by its full output, not just the inputs). Exceeding it throws `BonsaiSecurityError('MAX_STRING_LENGTH', ...)`. |
| `maxSteps` | `number` | `1000000` | Deterministic evaluator-work budget. It charges AST work, lambda calls, spread/literal loops, and work estimates before linear native methods (receiver length, or the copied span for `slice`). Opaque registered-extension work is excluded. Exceeding it throws `BonsaiSecurityError('MAX_STEPS', ...)`. `0` disables it. |
| `cacheSize` | `number` | `256` | Per-instance cache size for compiled expressions and parsed AST reuse. `0` disables caching. |
| `allowedProperties` | `string[]` | `undefined` | Whitelist of allowed member/method names. Does not apply to root identifiers or object-literal keys. |
| `deniedProperties` | `string[]` | `undefined` | Denylist of blocked member/method names. Does not apply to root identifiers or object-literal keys. |

Important notes:

- Options are validated at construction: out-of-range values (a negative `cacheSize`, a non-positive `maxDepth`, a negative size limit, a negative/non-finite `timeout`) throw a `RangeError`/`TypeError` immediately rather than failing silently later.
- `allowedProperties` and `deniedProperties` apply to **member access** (`obj.name`) and **method calls** (`str.slice()`), not root identifiers (`name`) or object-literal keys (`{ name: value }`).
- For `user.name`, only `name` is a member name; `user` is a root identifier. For `account.user.name`, allow both `user` and `name`.
- Numeric array indices (e.g., `items[0]`) bypass allow/deny lists automatically.
- `__proto__`, `constructor`, and `prototype` are always blocked at every access level, even if you include them in an allowlist.

### `evaluateSync<T>(expression, context?, options?)`

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

### `evaluate<T>(expression, context?, options?)`

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
- compiled evaluation captures the immutable transform/function registry revision
  that existed at compile time; later replacements affect one-shot and newly
  compiled expressions only
- compiled evaluation uses the instance's safety policy, with optional per-run overrides
- `compiled.ast` exposes a deeply frozen optimized AST for advanced tooling/debugging;
  it cannot be mutated to alter the compiled artifact or poison the instance cache

### Per-evaluation controls

One-shot and compiled evaluation accept the same final `EvaluationOptions`
argument. `timeout` and `maxSteps` override the instance defaults for that run;
`signal` propagates cancellation. Async waits are raced against the deadline and
signal, while synchronous work samples them cooperatively.

```ts
const controller = new AbortController()

await expr.evaluate('lookupTier(userId)', { userId: 'u_123' }, {
  timeout: 100,
  maxSteps: 50_000,
  signal: controller.signal,
})

compiled.evaluateSync(context, { maxSteps: 10_000 })
```

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

Important note: `validate()` checks syntax and extracts references. It does not
execute the expression or verify that referenced transforms/functions are
registered.

Use the optional [static checker](#static-checking) when you also need binding,
property, operator, signature, or result-type validation.

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
type EvaluationContextArgs<TCtx extends object = Record<string, unknown>> =
  {} extends TCtx ? [context?: TCtx] : [context: TCtx]

interface BonsaiInstance<TCtx extends object = Record<string, unknown>> {
  use(plugin: BonsaiPlugin<TCtx>): this
  addTransform(name: string, fn: TransformFn, metadata?: TransformMetadata): this
  replaceTransform(name: string, fn: TransformFn, metadata?: TransformMetadata): this
  defineTransform(definition: TransformDefinition): this
  addFunction(name: string, fn: FunctionFn, metadata?: FunctionMetadata): this
  replaceFunction(name: string, fn: FunctionFn, metadata?: FunctionMetadata): this
  defineFunction(definition: FunctionDefinition): this
  addContextFunction(name: string, fn: ContextFunctionFn<TCtx>, metadata?: FunctionMetadata): this
  replaceContextFunction(name: string, fn: ContextFunctionFn<TCtx>, metadata?: FunctionMetadata): this
  defineContextFunction(definition: ContextFunctionDefinition<TCtx>): this
  removeTransform(name: string): boolean
  removeFunction(name: string): boolean
  hasTransform(name: string): boolean
  hasFunction(name: string): boolean
  isContextFunction(name: string): boolean
  listTransforms(): string[]
  getTransformMetadata(name: string): TransformMetadata | undefined
  listFunctions(): string[]
  getFunctionMetadata(name: string): FunctionMetadata | undefined
  seal(): this
  isSealed(): boolean
  clearCache(): void
  compile(expression: string): CompiledExpression<TCtx>
  evaluate<T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>): Promise<T>
  evaluateSync<T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>): T
  validate(expression: string): ValidationResult
}
```

Method notes:

- `use()` applies a plugin transactionally and returns the same instance. If the plugin throws, all registrations made by that plugin are rolled back.
- `add*()` and `define*()` reject duplicate or invalid names. `replace*()` makes intentional replacement explicit and throws when the target does not exist. Pure and context-aware functions share one namespace.
- `defineTransform()`, `defineFunction()`, and `defineContextFunction()` are the preferred self-describing forms. Their static metadata powers autocomplete and other tooling without executing extension code.
- `seal()` permanently closes the registry after startup configuration. It is idempotent; every later registration, replacement, removal, or plugin application throws.
- `addContextFunction()` registers a function that receives the live evaluation context as its first argument (typed read-only; passed by reference, not copied or frozen). See [Context-aware functions](#context-aware-functions).
- `isContextFunction()` returns `true` if the named function was registered via `addContextFunction()`.
- `listTransforms()` and `listFunctions()` return the currently registered names. `listFunctions()` includes both pure and context-aware functions.
- `clearCache()` clears the internal AST cache and compiled-expression cache. It does not remove registered transforms/functions.
- Pass a context type generic to `bonsai<MyContext>()` for end-to-end type safety: `evaluate`, `evaluateSync`, `addContextFunction`, `compile`, and `use` all propagate the type. If `MyContext` has required fields, TypeScript requires a context argument when evaluating.

## Extending the Runtime

### Transforms

Transforms receive the piped value as their first argument.

```ts
import { bonsai, t } from 'bonsai-js'

expr.defineTransform({
  name: 'repeat',
  inputType: t.string(),
  parameters: [{ name: 'times', type: t.number() }],
  returnType: t.string(),
  description: 'Repeat a string a requested number of times',
  evaluate: (value, times) => String(value).repeat(Number(times)),
})

expr.evaluateSync('"ha" |> repeat(3)') // 'hahaha'
```

The type metadata is optional and JSON-serializable (`t.string()` is just
`{ kind: 'string' }`). It never affects evaluation; autocomplete uses it to
filter and continue `|>` suggestions and the checker uses it for exact
signature checks.

For a transform whose output depends on an input array's element type, declare
`arrayTypeRule` (`preserve`, `optional-element`, `flatten`, `map`, `filter`,
`find`, `some`, or `every`). This keeps generic array and lambda inference tied
to explicit metadata instead of a transform's name. The implementation remains
responsible for matching the declared relationship.

`TransformFn`:

```ts
type TransformFn = (value: unknown, ...args: unknown[]) => unknown | Promise<unknown>
```

### Functions

Functions are called directly by name inside expressions.

```ts
expr.defineFunction({
  name: 'clamp',
  parameters: [
    { name: 'value', type: t.number() },
    { name: 'min', type: t.number() },
    { name: 'max', type: t.number() },
  ],
  returnType: t.number(),
  description: 'Clamp a number to an inclusive range',
  evaluate: (value, min, max) =>
    Math.min(Math.max(Number(value), Number(min)), Number(max)),
})

expr.evaluateSync('clamp(score, 0, 100)', { score: 150 }) // 100
```

`FunctionFn`:

```ts
type FunctionFn = (...args: unknown[]) => unknown | Promise<unknown>
```

### Plugins

A plugin is a function that receives a `PluginRegistrar`: the registration surface
(`use`, `addTransform`, `addFunction`, `addContextFunction`, and the `has`/`list`/`remove`
helpers). It does not receive the evaluation methods, so a plugin cannot evaluate
against a context it did not supply.

```ts
import { t, type BonsaiPlugin } from 'bonsai-js'

const currency: BonsaiPlugin = (registrar) => {
  registrar.defineTransform({
    name: 'usd',
    inputType: t.number(),
    returnType: t.string(),
    evaluate: (value) => `$${Number(value).toFixed(2)}`,
  })
  registrar.defineFunction({
    name: 'discount',
    parameters: [
      { name: 'price', type: t.number() },
      { name: 'percent', type: t.number() },
    ],
    returnType: t.number(),
    evaluate: (price, pct) => Number(price) * (1 - Number(pct) / 100),
  })
}

const expr = bonsai().use(currency).seal()

expr.evaluateSync('discount(price, 20) |> usd', { price: 100 }) // '$80.00'
```

A plugin's type parameter is the context it _requires_. It defaults to `object` (no
requirement), so a context-agnostic plugin like the one above, and every stdlib plugin,
applies to any instance regardless of its context type. A plugin that reads context via
`addContextFunction` declares the fields it needs, and `.use()` accepts it only on
instances whose context provides them. This is checked without casts whether your
context is declared with `type` or `interface`:

```ts
import { arrays } from 'bonsai-js/stdlib'

interface AppContext {
  items: number[]
}

bonsai<AppContext>().use(arrays) // ok: arrays requires no context

// A plugin that reads `tenantId` only applies where the context provides it.
const tenantRules: BonsaiPlugin<{ tenantId: string }> = (r) =>
  r.addContextFunction('tenant', (ctx) => ctx.tenantId)

bonsai<{ tenantId: string; userId: string }>().use(tenantRules) // ok
// bonsai<AppContext>().use(tenantRules)                         // type error: no tenantId
```

Important note: custom transforms, functions, and plugins run as normal host JavaScript. Bonsai constrains the expression language, not the code you register into it.

Duplicate names fail closed, plugin application rolls back on error, and
compiled expressions retain the extension revision they were created with.
Configure the instance during startup and call `seal()` before accepting
untrusted expressions.

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

Notes on stdlib semantics:

- **`sort`** orders strings by code point (not locale), so results are deterministic across runtimes and locales. Numbers sort numerically.
- **`find`/`some`/`every` short-circuit**, including in pipeline form. Async higher-order transforms await callbacks sequentially by default, preserving order without unbounded I/O fan-out.
- **`now()` uses the host clock** in the default `dates`/`all` plugins. For
  deterministic rules, use `createDates({ now: () => fixedTimestamp })` and
  install that plugin instead of `dates`.
- **`min`/`max`** validate that every argument is a number and return `undefined` for no arguments (rather than `Infinity`/`-Infinity`). **`clamp`** requires finite bounds with `min <= max`.
- **`NaN` is passed through** by the numeric transforms (`sum`, `avg`, `round`, etc.): a `NaN` input yields a `NaN` result (which serializes to `null` in JSON). Validate inputs upstream if you need to reject non-finite numbers.

## Error Handling

Runtime exports:

```ts
import {
  ExpressionError,
  BonsaiReferenceError,
  BonsaiSecurityError,
  BonsaiTypeError,
  isBonsaiError,
  isBonsaiRuntimeError,
  formatError,
  formatBonsaiError,
} from 'bonsai-js'

import type {
  BonsaiError,
  BonsaiRuntimeError,
  BonsaiSecurityCode,
  ErrorLocation,
} from 'bonsai-js'
```

Error classes:

| Error | `name` | When | Useful fields |
| --- | --- | --- | --- |
| `ExpressionError` | `'ExpressionError'` | parse/syntax errors | `source`, `start`, `end`, `suggestion?` |
| `BonsaiTypeError` | `'BonsaiTypeError'` | wrong runtime value type or sync/async mismatch | `transform`, `expected`, `received`, `location?`, `formatted?` |
| `BonsaiReferenceError` | `'BonsaiReferenceError'` | unknown transform/function/method | `kind`, `identifier`, `suggestion?`, `location?`, `formatted?` |
| `BonsaiSecurityError` | `'BonsaiSecurityError'` | blocked access or resource limit violation | `code` (`BonsaiSecurityCode`), `location?`, `formatted?` |

Every class carries a literal `name`, so `isBonsaiError()` narrows a caught
`unknown` to the `BonsaiError` union and you can switch on `name` exhaustively,
with each branch narrowed to its specific fields:

```ts
try {
  expr.evaluateSync(storedRule, ctx)
} catch (error) {
  if (!isBonsaiError(error)) throw error // not ours: rethrow
  switch (error.name) {
    case 'ExpressionError':
      return reportSyntax(error.formatted) // start, end, source available
    case 'BonsaiReferenceError':
      return reportTypo(error.identifier, error.suggestion) // "did you mean?"
    case 'BonsaiSecurityError':
      return reportBlocked(error.code) // 'TIMEOUT' | 'BLOCKED_PROPERTY' | ...
    case 'BonsaiTypeError':
      return reportType(error.transform, error.expected, error.received)
  }
}
```

`isBonsaiRuntimeError()` narrows to the runtime subset (everything except
parse-time `ExpressionError`). `BonsaiSecurityCode` is the closed set of reasons a
`BonsaiSecurityError` can fire: `BLOCKED_PROPERTY`, `PROPERTY_NOT_ALLOWED`,
`PROPERTY_DENIED`, `METHOD_NOT_ALLOWED`, `MAX_SOURCE_LENGTH`, `MAX_TOKENS`, `MAX_AST_NODES`, `MAX_DEPTH`,
`MAX_ARRAY_LENGTH`, `MAX_STRING_LENGTH`, `MAX_OBJECT_PROPERTIES`,
`MAX_CALL_ARGUMENTS`, `MAX_STEPS`, `TIMEOUT`, `ABORTED`.

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
- enforces structural input limits, `maxDepth`, produced array/string limits, a default-on `maxSteps` budget, and optional timeout/cancellation
- bounds parser recursion so pathologically nested input fails closed with a typed `ExpressionError` instead of overflowing the call stack
- lets you allowlist or denylist member/method names via `allowedProperties`/`deniedProperties`
- prevents expressions from reaching globals or importing modules
- reads root identifiers and members as own properties only, so prototype chains (and a polluted `Object.prototype`) can never leak into results
- creates object literals with `null` prototypes, preventing prototype pollution through expression-constructed objects
- invokes an audited set of captured string, number, and array intrinsics; receiver method overrides are ignored, and subclasses or arrays with own constructor/spreadability hooks are neutralized before species-producing calls
- enforces one shared built-in arity/type catalog in both the evaluator and checker
- spreads arrays by index (never through a custom iterator) and accepts arrays only
- accepts only Bonsai-created lambdas as higher-order callbacks; host functions supplied in context remain data
- rejects implicit object conversion hooks in operators, templates, computed keys, and method arguments
- automatically bypasses allow/deny lists for canonical numeric array indices (e.g., `items[0]`)
- rejects cross-realm and user-defined Promise-like values in `evaluateSync()` with actionable errors that name the offending function/transform/method and suggest using `evaluate()` instead

Important operational caveats:

- `allowedProperties` and `deniedProperties` apply to member access (`obj.name`) and method calls (`str.slice()`), not root identifiers (`name`) or object-literal keys (`{ name: value }`)
- `timeout`, `maxSteps`, and synchronous cancellation are cooperative; they cannot interrupt arbitrary synchronous code already running inside a custom extension
- async waits are raced against the deadline and `AbortSignal`, but cancellation cannot stop underlying work that the registered extension does not itself cancel
- own getters and Proxies placed in the context are host code: reading them runs their getter or trap, so serialize ORM models and reactive objects to plain data at the expression boundary if that matters to you
- application-wide mutation of `Array`/`Array.prototype`/`Object.prototype` primordials is trusted host behavior; do not install numeric prototype properties or constructor/species hooks in a process evaluating untrusted expressions
- custom transforms/functions/plugins are trusted host code

Recommended configuration for untrusted expressions:

```ts
const expr = bonsai({
  timeout: 50,
  maxSourceLength: 10_000,
  maxTokens: 2_500,
  maxAstNodes: 2_000,
  maxObjectProperties: 500,
  maxCallArguments: 100,
  maxDepth: 50,
  maxArrayLength: 10_000,
  maxStringLength: 10_000,
  maxSteps: 100_000,
  allowedProperties: ['age', 'country', 'plan'],
}).seal()
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

## Static Checking

The optional `bonsai-js/checker` subpath checks expressions against an explicit,
JSON-serializable context schema and declarative extension signatures. It never
evaluates the expression or calls host code.

```ts
import { createChecker, t } from 'bonsai-js/checker'

const schema = t.object({
  user: t.object({
    name: t.string(),
    age: t.number(),
    plan: t.enum('free', 'pro'),
    nickname: t.optional(t.string()),
  }),
})

const checker = createChecker(expr, { schema })

checker.check('user.age >= 18', { expectedType: t.boolean() })
// { valid: true, type: { kind: 'boolean' }, diagnostics: [], ast: ... }

checker.check('user.agge >= 18')
// { valid: false, diagnostics: [{ code: 'UNKNOWN_PROPERTY', ... }], ... }

checker.check('user.plan == "prem"')
// { valid: false, diagnostics: [{ code: 'TYPE_MISMATCH', message: 'Comparison is always false: ...' }] }
```

The checker reports stable diagnostic codes and source ranges for unknown
bindings/properties, operator, argument, and built-in method signature
mismatches, impossible strict comparisons, method calls on nullable values
without `?.`, disallowed methods/properties, and expected-result mismatches.
`t.array()`, `t.object()`, `t.record()`, `t.union()`, `t.optional()`,
`t.nullable()`, `t.literal()`, and `t.enum()` cover structured data. Unknown
types deliberately defer to runtime instead of producing cascaded errors.

Declare precise extension signatures once and the same metadata powers checking
and autocomplete:

```ts
expr.defineFunction({
  name: 'between',
  parameters: [
    { name: 'value', type: t.number() },
    { name: 'min', type: t.number() },
    { name: 'max', type: t.number() },
  ],
  returnType: t.boolean(),
  evaluate: (value, min, max) =>
    Number(value) >= Number(min) && Number(value) <= Number(max),
})
```

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
| `user.name.trim().` | Methods inferred through the static return-type catalog |
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

  // Or provide the same static schema used by the checker. No live values needed.
  schema,

  // Transforms registered with defineTransform() metadata are filtered and
  // continued automatically. For transforms registered without metadata,
  // declare the runtime kinds here (entries override registry metadata).
  transformSignatures: {
    slug: { input: ['string'], output: 'string' },
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

This applies to property access, methods, lambda element properties, and nested
chain resolution. Autocomplete snapshots own data properties and uses static
method/extension metadata; it never evaluates an expression or calls a
transform, function, or property accessor while the user is typing. As with
evaluation, do not pass Proxies if host trap execution is outside your trust
boundary.

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

Bonsai follows SemVer for the documented package entrypoints `bonsai-js`, `bonsai-js/stdlib`, `bonsai-js/autocomplete`, and `bonsai-js/checker`.

- Supported runtimes are Node 24+, current Bun releases, and modern ESM browsers
  with ES2022 support. ES2023 methods such as `toSorted()` require host support.
- The packed npm artifact is smoke-tested on Node 24 LTS.
- Every public surface is browser-bundled and executed without Node globals in CI.
- Internal modules under `src/*` are not public API.

See the [v1 contract](./docs/v1-contract.md) for the complete 1.0 promise and the
[stability policy](./docs/stability-policy.md) for compatibility and release rules.

## License

MIT
