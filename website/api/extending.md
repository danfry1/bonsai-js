# Extending

Extend Bonsai with your own transforms, functions, and plugins when you need domain-specific behavior.

| If you need... | Use... | Example |
|---|---|---|
| A value flowing through a pipeline | `defineTransform()` | `price \|> usd` |
| A named operation with peer arguments | `defineFunction()` | `discount(price, 20)` |
| A reusable package of related behavior | `use(plugin)` | `expr.use(currency)` |

## Transforms

Transforms are used with `|>` and receive the piped value as their first argument.

```ts
type TransformFn = (value: unknown, ...args: unknown[]) => unknown | Promise<unknown>
```

```ts
import { bonsai, t } from 'bonsai-js'

expr.defineTransform({
  name: 'cents',
  inputType: t.number(),
  returnType: t.number(),
  description: 'Convert currency units to integer cents',
  evaluate: (value) => Math.round(Number(value) * 100)
})
expr.defineTransform({
  name: 'capAt',
  inputType: t.number(),
  parameters: [{ name: 'max', type: t.number() }],
  returnType: t.number(),
  evaluate: (value, max) => Math.min(Number(value), Number(max))
})

expr.evaluateSync('price |> cents', { price: 19.99 })              // 1999
expr.evaluateSync('requestedDiscount |> capAt(25)', {
  requestedDiscount: 40
})       // 25
```

## Functions

Functions are called directly by name in the expression.

```ts
type FunctionFn = (...args: unknown[]) => unknown | Promise<unknown>
```

```ts
expr.defineFunction({
  name: 'discount',
  parameters: [
    { name: 'price', type: t.number() },
    { name: 'percent', type: t.number() },
  ],
  returnType: t.number(),
  evaluate: (price, pct) => Number(price) * (1 - Number(pct) / 100)
})
expr.defineFunction({
  name: 'between',
  parameters: [
    { name: 'value', type: t.number() },
    { name: 'min', type: t.number() },
    { name: 'max', type: t.number() },
  ],
  returnType: t.boolean(),
  evaluate: (value, min, max) =>
    Number(value) >= Number(min) && Number(value) <= Number(max)
})

expr.evaluateSync('discount(listPrice, 20)', {
  listPrice: 100
})         // 80

expr.evaluateSync('between(order.total, 50, 200)', {
  order: { total: 120 }
})     // true
```

## Context-aware functions

Some functions need to read the evaluation context directly (think auth, permissions, personalization). Register them with `addContextFunction`: the function receives the evaluation context (typed read-only) as its first parameter, followed by the call's arguments.

```ts
type ContextFunctionFn<TCtx> =
  (context: Readonly<TCtx>, ...args: unknown[]) => unknown | Promise<unknown>
```

```ts
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
  ctx.perms.includes(String(action))
)

await app.evaluate(
  'lookupCurrentUserTier() == "pro" && hasPermission("admin")',
  { currentUserId: 'u_123', perms: ['admin', 'write'] }
)
```

Pure functions and context-aware functions share a single namespace. Duplicate
registration throws. Use `replaceFunction()` or `replaceContextFunction()` when
replacement is deliberate, and `isContextFunction(name)` for introspection.

::: warning Context is passed by reference, not deep-frozen
The `Readonly<TCtx>` parameter type flags top-level reassignment, but Bonsai does not deep-freeze the context. Nested mutation and writes from untyped JavaScript reach the object you passed in. Pass a fresh context per evaluation if you need isolation.
:::

::: tip Type the instance with bonsai&lt;AppContext&gt;() for end-to-end context safety
`AppContext` propagates through every method that touches context: `evaluate`, `evaluateSync`, `compile`, and `addContextFunction` are all checked against the same shape. If your context type has required fields, the context argument becomes required at call sites.
:::

## Plugins

```ts
import { t, type BonsaiPlugin } from 'bonsai-js'

const currency: BonsaiPlugin = (registrar) => {
  registrar.defineTransform({
    name: 'usd',
    inputType: t.number(),
    returnType: t.string(),
    evaluate: (value) => `$${Number(value).toFixed(2)}`
  })
  registrar.defineFunction({
    name: 'discount',
    parameters: [
      { name: 'price', type: t.number() },
      { name: 'percent', type: t.number() },
    ],
    returnType: t.number(),
    evaluate: (price, pct) => Number(price) * (1 - Number(pct) / 100)
  })
}

bonsai().use(currency).seal()
```

Plugin application is transactional: if any registration fails or the plugin
throws, the registry returns to its prior revision. Transforms have their own
namespace; pure and context-aware functions share one. Duplicate names are
rejected unless you call an explicit `replace*()` method.

Plugins can also be typed against a minimal context they require: `BonsaiPlugin<{ tenantId: string }>` applies cleanly to any instance whose context extends `{ tenantId: string }`.

::: warning Custom extensions run as trusted host code
Keep transforms small and predictable, validate their inputs, and reserve async behavior for cases where you genuinely need I/O. Bonsai does not sandbox registered transforms or functions.
:::

::: tip Prefer declarative definitions and seal after setup
`defineTransform()`, `defineFunction()`, and `defineContextFunction()` attach
static output/input metadata for autocomplete and other tools without executing
your code. Once startup registration is complete, `seal()` prevents later drift.
:::
