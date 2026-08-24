# Operators

Operators cover math, comparison, branching, and membership tests. The syntax
is familiar, but Bonsai deliberately avoids JavaScript's implicit object and
mixed-type coercion.

| If you want to... | Use | Example |
|---|---|---|
| Do math | `+ - * / % **` | `subtotal + shippingFee` |
| Compare values | `== != < > <= >=` | `order.total >= freeShippingThreshold` |
| Branch or provide defaults | `?:`, `??`, `\|\|`, `&&` | `customer.nickname ?? customer.firstName` |
| Test membership | `in`, `not in` | `"pro" in plans` |

## Arithmetic

`+` accepts either two numbers or two strings. The other arithmetic operators
accept two numbers. Mixed operands such as `"5" + 1` are typed errors rather
than surprising concatenation, and objects are never coerced through
`valueOf()` or `Symbol.toPrimitive`.

| Expression | Result | Context / Note |
|---|---|---|
| `basePrice + addOnPrice * seats` | `85` | `{ basePrice: 49, addOnPrice: 12, seats: 3 }` (`*` runs before `+`) |
| `2 ** 10` | `1024` | exponentiation |

## Comparison & equality

`==` and `!=` are strict identity comparisons (equivalent to JavaScript `===`
and `!==`). Ordered comparisons accept two numbers or two strings of the same
type.

| Expression | Result | Context / Note |
|---|---|---|
| `order.total >= minimumOrder` | `true` | `{ order: { total: 149 }, minimumOrder: 100 }` |
| `1 == "1"` | `false` | strict - no type coercion, ever |

## Conditional logic

Use `??` for nullish defaults, `||` for falsy defaults, and the ternary operator when you need an explicit if/else branch.

| Expression | Result | Note |
|---|---|---|
| `order.total >= freeShippingThreshold ? "free" : "paid"` | `"free"` | return a shipping label directly from the rule |
| `customer.nickname ?? customer.firstName` | `"Alicia"` | `??` falls back only for `null` or `undefined` |
| `couponCode \|\| "no-code"` | `"no-code"` | `\|\|` also falls back for empty strings and other falsy values |

## Membership

`in` and `not in` use strict membership for arrays. For substring checks, both
operands must be strings.

| Expression | Result | Context / Note |
|---|---|---|
| `"pro" in plans` | `true` | `{ plans: ["starter", "pro", "enterprise"] }` |
| `"invoice-" in fileName` | `true` | also works as a substring check on strings |

### More precedence and edge cases

| Expression | Result | Note |
|---|---|---|
| `(subtotal + shippingFee) * taxMultiplier` | `129.6` | parentheses make billing logic explicit |
| `remainingSeats % seatsPerRow` | `2` | remainder is useful for layout and batching rules |
| `order.paid && order.fulfilled` | `true` | |
| `!user.suspended` | `true` | boolean negation |
| `nickname ?? "Guest"` | `""` | `??` preserves empty strings and other defined falsy values |
| `"legacy" not in enabledFeatures` | `true` | |

**Guideline:** when an expression becomes important business logic, add parentheses even when precedence would make it unnecessary. Stored rules are easier to review when grouping is explicit.
