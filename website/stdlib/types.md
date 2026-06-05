# Types

Load the types stdlib when the input shape is mixed and you need defensive checks or simple conversions.

```ts
import { types } from 'bonsai-js/stdlib'
expr.use(types)
```

| Transform | Example | Result |
|---|---|---|
| `isString` | `customer.email \|> isString` | `true` |
| `isNumber` | `order.total \|> isNumber` | `true` |
| `isArray` | `cart.items \|> isArray` | `true` |
| `isNull` | `customer.nickname \|> isNull` | `true` |
| `toBool` | `featureFlag \|> toBool` | `true` |
| `toNumber` | `"42.50" \|> toNumber` | `42.5` |
| `toString` | `invoiceNumber \|> toString` | `"1042"` |

Type checks are useful when the same field may arrive in different shapes:

```ts
// Accept both numeric totals and totals sent as strings
(order.total |> isNumber)
  ? order.total
  : (order.total |> toNumber |> round)
```

**Use sparingly:** if every expression in your system needs the same coercion step, it is usually cleaner to normalize the data before evaluation and keep the expressions simpler.
