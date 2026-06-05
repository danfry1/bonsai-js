# evaluateExpression

A convenience helper for one-off evaluations backed by a shared default instance.

```ts
import { evaluateExpression } from 'bonsai-js'

evaluateExpression('order.total >= 100', {
  order: { total: 129 }
}) // true

evaluateExpression<number>('subtotal + shippingFee', {
  subtotal: 89,
  shippingFee: 12
}) // 101
```

This helper is good for scripts, tests, and one-off evaluations. It uses one shared default instance behind the scenes, so it is intentionally minimal: no custom safety options, no custom plugins, and no lifecycle control.

> **Use it only for convenience:** if your application needs custom plugins, non-default safety settings, cache control, or a clear setup phase, create an instance with `bonsai()` instead.
