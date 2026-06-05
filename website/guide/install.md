# Installation

Install Bonsai with your preferred package manager. The package is ESM-only with TypeScript types included.

```bash
$ bun add bonsai-js
```

```bash
$ npm install bonsai-js
```

Then import and start evaluating:

```ts
import { bonsai } from 'bonsai-js'

const expr = bonsai()
const qualifiesForFreeShipping = expr.evaluateSync(
  'order.total >= freeShippingThreshold',
  { order: { total: 120 }, freeShippingThreshold: 100 }
)
console.log(qualifiesForFreeShipping) // true
```

**Most applications start with the same pattern:** create one shared instance, load only the stdlib modules you need, use `evaluateSync()` for sync paths, and use `compile()` for repeated rules.
