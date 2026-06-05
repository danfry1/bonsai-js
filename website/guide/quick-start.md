# Quick Start

This is the default setup pattern for most applications: one shared instance, a small stdlib import, sync evaluation by default, and compiled rules when expressions repeat.

## 1. Create one instance and load what you need

```ts
import { bonsai } from 'bonsai-js'
import { strings, arrays, math } from 'bonsai-js/stdlib'

const expr = bonsai()
  .use(strings)
  .use(arrays)
  .use(math)
```

Reuse this instance instead of recreating it. That keeps the cache warm and gives you one place to register custom functions or safety settings.

## 2. Pass data in through the context object

| Expression | Result | Context |
|---|---|---|
| `subtotal + shippingFee` | `101` | `{ subtotal: 89, shippingFee: 12 }` |
| `order.total >= freeShippingThreshold` | `true` | `{ order: { total: 129 }, freeShippingThreshold: 100 }` |
| `customer.country == "GB" && customer.emailVerified` | `true` | `{ customer: { country: "GB", emailVerified: true } }` |

## 3. Use pipes for readable transformations

The pipe operator reads left to right. It is the simplest way to express cleanup, filtering, mapping, and formatting work.

| Expression | Result | Context |
|---|---|---|
| `customerName \|> trim \|> upper` | `"ACME LTD"` | `{ customerName: "  Acme Ltd  " }` |
| `orders \|> filter(.status == "paid") \|> map(.id) \|> join(", ")` | `"INV-1001, INV-1003"` | `{ orders: [{ id: "INV-1001", status: "paid" }, { id: "INV-1002", status: "draft" }, { id: "INV-1003", status: "paid" }] }` |

## 4. Compile expressions that repeat

```ts
const qualifiesForFreeShipping = expr.compile('order.total >= freeShippingThreshold')

qualifiesForFreeShipping.evaluateSync({
  order: { total: 129 },
  freeShippingThreshold: 100
}) // true

qualifiesForFreeShipping.evaluateSync({
  order: { total: 49 },
  freeShippingThreshold: 100
}) // false
```

**Use `evaluate()` only when you need async host code.** If your transforms and functions are synchronous, `evaluateSync()` is the simpler and faster default.

Next: [Mental Model](/guide/mental-model) explains the four ideas behind every Bonsai expression.
