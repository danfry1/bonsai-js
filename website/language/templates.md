# Template Literals

Template literals are for building display strings: messages, labels, emails, filenames, and user-facing output.

| Expression | Result | Context |
|---|---|---|
| `` `Welcome back, ${user.firstName}` `` | `"Welcome back, Alicia"` | `{ user: { firstName: "Alicia" } }` |
| `` `${cart.items.length} item${cart.items.length == 1 ? "" : "s"} in cart` `` | `"3 items in cart"` | `{ cart: { items: [{...}, {...}, {...}] } }` |
| `` `Plan: ${user?.plan ?? "free"}` `` | `"Plan: pro"` | `{ user: { plan: "pro" } }` |

**Keep the distinction clear:** template literals always produce strings. If you need structured output, build an array or object instead of interpolating JSON-like text.
