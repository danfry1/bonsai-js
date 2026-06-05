# Math

Load the math stdlib for rounding, clamping, and summarizing numeric values in pipelines.

```ts
import { math } from 'bonsai-js/stdlib'
expr.use(math)
```

## Transforms

| Transform | Example | Result |
|---|---|---|
| `round` | `averageRating \|> round` | `4` |
| `floor` | `monthlySeats \|> floor` | `3` |
| `ceil` | `storageUnits \|> ceil` | `4` |
| `abs` | `balanceDelta \|> abs` | `42` |
| `sum` | `orderTotals \|> sum` | `60` |
| `avg` | `orderTotals \|> avg` | `20` |
| `clamp(min, max)` | `requestedDiscount \|> clamp(0, 25)` | `25` |

## Functions

| Function | Example | Result |
|---|---|---|
| `min(a, b)` | `min(order.total, budgetCap)` | smaller value |
| `max(a, b)` | `max(order.total, minimumBillable)` | larger value |

Common patterns:

```ts
products |> map(.price) |> avg |> round
// average price, rounded
// 25
```

```ts
orders |> map(.total) |> sum
// sum all order totals
// 347.5
```

**Keep the types clean:** math transforms expect numbers, and `sum`/`avg` expect arrays of numbers. If your input is textual, convert it first with `toNumber` or a custom transform.
