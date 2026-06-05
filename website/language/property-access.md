# Property Access

Use property access to read nested objects, array elements, and dynamic keys from the context object. Missing values resolve to `undefined`, which makes `??` defaults very natural.

| Pattern | Use it for |
|---|---|
| `user.name` | Read a known property |
| `items[0]` | Read an array element |
| `record[key]` | Use a dynamic property name from context |
| `user?.profile?.avatar ?? "default.png"` | Make the null-tolerant path explicit and provide a fallback |

## Dot & bracket notation

| Expression | Result | Note |
|---|---|---|
| `customer.name` | `"Alicia"` | |
| `order.items[0].sku` | `"SKU-001"` | |
| `profile["first-name"]` | `"Alicia"` | brackets for keys with special characters |

## Optional chaining

Use `?.` when you want to say, directly in the expression, that a missing branch is expected and should quietly produce `undefined`.

| Expression | Result | Note |
|---|---|---|
| `customer?.billing?.country` | `undefined` | `{ customer: null }` (no error thrown) |
| `customer?.billing?.country ?? "GB"` | `"GB"` | combine with `??` for fallbacks |
| `messages?.[locale] ?? messages?.en` | `"Bonjour"` | optional chaining also works with computed keys |

**Security note:** allowlists and denylists apply to root identifiers and member names. If `user.secret` should be blocked, `secret` must stay out of `allowedProperties`.
