# Quick Start

This page walks through the usual setup: one environment that declares your data, expressions checked when they are saved, and compiled programs evaluated on the hot path.

## 1. Create an environment

An environment holds everything expressions are checked and evaluated against: declared variables, host functions, and limits. Create it once and reuse it.

```ts
import { bonsai, formatType, t } from 'bonsai-js'

const env = bonsai({
  variables: {
    customer: t.object({
      name: t.string(),
      tier: t.enum('standard', 'gold'),
      country: t.string(),
      email: t.optional(t.string()),
    }),
    cart: t.object({
      items: t.list(t.object({ sku: t.string(), price: t.number(), qty: t.number() })),
    }),
  },
})
```

`t.optional(T)` means the value may be `null` or missing. Because variables are declared, the environment is strict: any variable you did not declare is an error.

## 2. Check expressions before saving them

`check()` never throws and never evaluates. It reports every problem with a code, a message, and a source range you can underline in an editor.

<!-- continue -->
```ts
const typo = env.check('customer.teir == "gold"')
typo.ok // => false
typo.diagnostics[0].code // => "UNKNOWN_PROPERTY"
typo.diagnostics[0].message // => 'Property "teir" does not exist on { name: string, tier: "standard" | "gold", country: string, email: string | null }; did you mean "tier"?'

const nullable = env.check('customer.email.endsWith("@example.com")')
nullable.diagnostics[0].code // => "NULLABLE_RECEIVER"

const good = env.check('cart.items.map(.price * .qty).sum()')
good.ok // => true
formatType(good.type) // => "number"
```

`formatType` is exported from `bonsai-js` and renders a type as text.

## 3. Compile and evaluate

`compile()` checks the expression and returns a program you can evaluate many times. Pass `expect` to require a result type: a rule that must produce a boolean fails to compile if it could produce anything else.

<!-- continue -->
```ts
const freeShipping = env.compile(
  'customer.tier == "gold" || cart.items.map(.price * .qty).sum() >= 50',
  { expect: t.boolean() },
)

freeShipping.evaluateSync({
  customer: { name: 'Ada', tier: 'standard', country: 'GB' },
  cart: { items: [{ sku: 'A1', price: 20, qty: 3 }] },
}) // => true
```

The context argument is typed from the declaration, and the result is typed as `boolean` because of `expect`.

## 4. Evaluate one-off expressions

`env.evaluateSync(source, context)` compiles, caches, and evaluates in one call. Repeated sources reuse the cached program.

<!-- continue -->
```ts
const context = {
  customer: { name: 'Ada', tier: 'gold' as const, country: 'GB' },
  cart: { items: [] },
}
env.evaluateSync('`Hello ${customer.name}, you have ${cart.items.length} items`', context) // => "Hello Ada, you have 0 items"
env.evaluateSync('customer.email ?? "no email"', context) // => "no email"
```

## 5. Use `evaluate()` for async host functions

If an expression calls a host function declared with `async: true`, evaluate it with `await env.evaluate(...)` or `await program.evaluate(...)`. `evaluateSync()` rejects such an expression before any host code runs. See [Host Functions](/api/host-functions).

Next: the [Mental Model](/guide/mental-model) covers the rules that differ from JavaScript.
