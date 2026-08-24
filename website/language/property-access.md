# Property Access

Use property access to read nested objects, array elements, and dynamic keys from the context object. A missing own property resolves to `undefined`, which makes `??` defaults very natural. Reading a property from a nullish receiver also yields `undefined`; only calling a method on a nullish receiver is an error (use `?.` there).

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

Plain `.` access is also null-tolerant for property reads: `customer.billing.country`
with `{ customer: null }` evaluates to `undefined` rather than throwing, so rules
over sparse data stay readable. Where `?.` makes a difference is method calls:
`customer.name.trim()` throws a typed error when `name` is nullish, while
`customer.name?.trim()` evaluates to `undefined`.

Property lookup reads own properties only, never the prototype chain: a class
getter or method defined on a prototype reads as `undefined`, and a polluted
`Object.prototype` cannot leak into results. Own getters defined by your host
objects are read like any other own property. Computed keys accept primitives
only, so object conversion hooks do not run.

**Security note:** allowlists and denylists apply to member and method names,
not root identifiers or object-literal keys. If `user.secret` should be blocked,
`secret` must stay out of `allowedProperties`; `user` is controlled by which
top-level values you put in the context.
