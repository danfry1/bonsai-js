# evaluateSync & evaluate

Use the sync path by default. Switch to the async path only when a registered transform or function may return a promise.

## Signatures

```ts
expr.evaluateSync<T = unknown>(expression, context?)
expr.evaluate<T = unknown>(expression, context?)
```

Both methods treat the `context` object as the variable scope for the expression. There is no global scope and no hidden runtime state.

| API | Returns | Use it when |
|---|---|---|
| `evaluateSync()` | `T` | All registered transforms/functions are synchronous. |
| `evaluate()` | `Promise<T>` | Any transform/function may await I/O or return a promise. |

## evaluateSync(expression, context?)

Evaluate immediately and return the result. The context is a plain object whose properties become identifiers in the expression.

```ts
expr.evaluateSync('order.total >= freeShippingThreshold', {
  order: { total: 129 },
  freeShippingThreshold: 100
}) // true

expr.evaluateSync('subtotal + shippingFee', {
  subtotal: 89,
  shippingFee: 12
}) // 101

expr.evaluateSync('customer.country == "GB" && customer.emailVerified', {
  customer: { country: 'GB', emailVerified: true }
}) // true

expr.evaluateSync('customer?.email ?? "missing@example.com"', {
  customer: null
}) // "missing@example.com"
```

## evaluate(expression, context?)

Return a promise and await async extensions during evaluation.

```ts
expr.addFunction('lookupTier', async (userId) => {
  const row = await db.users.findById(String(userId))
  return row?.tier ?? 'free'
})

const isPro = await expr.evaluate(
  'lookupTier(userId) == "pro"',
  { userId: 'u_123' }
)
```

## Typed generics

Both entrypoints accept an optional generic for result typing:

```ts
const qualifiesForFreeShipping = expr.evaluateSync<boolean>('order.total >= freeShippingThreshold', {
  order: { total: 129 },
  freeShippingThreshold: 100
})

const tier = await expr.evaluate<string>('lookupTier(userId)', {
  userId: "u_123"
})
```

The instance itself can also be generic over the context type. Pass `bonsai<AppContext>()` and the context shape is checked end-to-end through `evaluate`, `evaluateSync`, `compile`, and `addContextFunction`:

```ts
interface AppContext { userId: string; perms: readonly string[] }

const app = bonsai<AppContext>()

await app.evaluate('userId == "u_1"', { userId: 'u_1', perms: [] })  // ✓
await app.evaluate('userId == "u_1"', { foo: 'bar' })                // ✗ TS error
```

When `AppContext` has required fields, the `context` argument becomes required at every call site; when fields are optional (or the default `Record<string, unknown>`), it stays optional, preserving the untyped ergonomics.

> **Tip:** If any registered transform, function, or method returns a `Promise`, `evaluateSync()` will throw a `BonsaiTypeError` identifying the offending call and suggesting `evaluate()` instead. Use `evaluate()` or compiled `.evaluate()` for async extensions.
