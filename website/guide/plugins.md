# Writing Plugins

Plugins are the packaging layer for your expression API. Use them to ship a cohesive set of transforms and functions for one domain.

## Plugin structure

A plugin is a function that receives a Bonsai instance and registers whatever that domain needs.

```ts
import type { BonsaiPlugin } from 'bonsai-js'

const billingPlugin: BonsaiPlugin = (expr) => {
  expr.addTransform('usd', (value) =>
    `$${Number(value).toFixed(2)}`)
  expr.addFunction('discount', (price, pct) =>
    Number(price) * (1 - Number(pct) / 100))
}
```

## Registering plugins

Apply plugins during setup, not in the middle of request handling. That keeps the instance predictable and the caches warm.

```ts
const expr = bonsai()
expr.use(billingPlugin)

expr.evaluateSync('price |> usd', { price: 29.9 })        // "$29.90"
expr.evaluateSync('discount(price, 20)', { price: 100 })  // 80
```

| Good plugin habits | Why they matter |
| --- | --- |
| Keep a plugin focused on one domain | Easier to explain, test, and compose |
| Validate inputs inside transforms/functions | Expression authors get clearer runtime errors |
| Prefer stable names over clever names | Expressions become part of your product surface |
| Register plugins once at startup | Avoids behavioral drift across requests |

## Real-world example: currency plugin

Here is a practical plugin for formatting and calculating prices:

```ts
const currency: BonsaiPlugin = (expr) => {
  // Transforms for formatting
  expr.addTransform('usd', (val) =>
    `$${Number(val).toFixed(2)}`)
  expr.addTransform('eur', (val) =>
    `${Number(val).toFixed(2)} €`)

  // Function for discounts
  expr.addFunction('discount', (price, pct) =>
    price * (1 - pct / 100))
}

const expr = bonsai()
expr.use(currency)

expr.evaluateSync('price |> usd', { price: 29.9 })
// "$29.90"

expr.evaluateSync('discount(price, 20) |> usd', { price: 100 })
// "$80.00"
```

::: tip Treat plugin names as product API
If another team will read or author these expressions, bias toward boring, obvious names over DSL cleverness.
:::
