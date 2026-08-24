# Writing Plugins

Plugins are the packaging layer for your expression API. Use them to ship a cohesive set of transforms and functions for one domain.

## Plugin structure

A plugin is a function that receives the registry surface—not evaluation
methods—and registers whatever that domain needs.

```ts
import { t, type BonsaiPlugin } from 'bonsai-js'

const billingPlugin: BonsaiPlugin = (registrar) => {
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
```

## Registering plugins

Apply plugins during setup, not in the middle of request handling. That keeps the instance predictable and the caches warm.

```ts
const expr = bonsai().use(billingPlugin).seal()

expr.evaluateSync('price |> usd', { price: 29.9 })        // "$29.90"
expr.evaluateSync('discount(price, 20)', { price: 100 })  // 80
```

| Good plugin habits | Why they matter |
| --- | --- |
| Keep a plugin focused on one domain | Easier to explain, test, and compose |
| Validate inputs inside transforms/functions | Expression authors get clearer runtime errors |
| Prefer stable names over clever names | Expressions become part of your product surface |
| Register plugins once at startup | Avoids behavioral drift across requests |
| Prefer declarative definitions | Static metadata powers editor tooling without running plugin code |
| Seal after registration | Prevents request-time mutation of the expression API |

## Real-world example: currency plugin

Here is a practical plugin for formatting and calculating prices:

```ts
const currency: BonsaiPlugin = (expr) => {
  // Transforms for formatting
  expr.defineTransform({
    name: 'usd', inputType: t.number(), returnType: t.string(),
    evaluate: (val) => `$${Number(val).toFixed(2)}`
  })
  expr.defineTransform({
    name: 'eur', inputType: t.number(), returnType: t.string(),
    evaluate: (val) => `${Number(val).toFixed(2)} €`
  })

  // Function for discounts
  expr.defineFunction({
    name: 'discount',
    parameters: [{ name: 'price', type: t.number() }, { name: 'percent', type: t.number() }],
    returnType: t.number(),
    evaluate: (price, pct) => Number(price) * (1 - Number(pct) / 100)
  })
}

const expr = bonsai().use(currency).seal()

expr.evaluateSync('price |> usd', { price: 29.9 })
// "$29.90"

expr.evaluateSync('discount(price, 20) |> usd', { price: 100 })
// "$80.00"
```

::: tip Treat plugin names as product API
If another team will read or author these expressions, bias toward boring, obvious names over DSL cleverness.
:::

Plugin application is transactional. A thrown error or duplicate name rolls
back everything that plugin registered. Duplicate names fail closed; use an
explicit `replace*()` method only when changing behavior is intentional.
