# Strings

Load the string stdlib when you need text cleanup, normalization, search, and formatting inside pipelines.

```ts
import { strings } from 'bonsai-js/stdlib'
expr.use(strings)
```

| Transform | Example | Result |
|---|---|---|
| `upper` | `"enterprise" \|> upper` | `"ENTERPRISE"` |
| `lower` | `"Enterprise" \|> lower` | `"enterprise"` |
| `trim` | `"  Alicia  " \|> trim` | `"Alicia"` |
| `split(sep)` | `"admin,billing,ops" \|> split(",")` | `["admin", "billing", "ops"]` |
| `replace(s, r)` | `"VAT 20%" \|> replace("20", "5")` | `"VAT 5%"` |
| `replaceAll(s, r)` | `"Acme Billing Docs" \|> replaceAll(" ", "-")` | `"Acme-Billing-Docs"` |
| `startsWith(s)` | `"invoice-1042" \|> startsWith("invoice-")` | `true` |
| `endsWith(s)` | `"alice@acme.com" \|> endsWith("@acme.com")` | `true` |
| `includes(s)` | `"priority-support" \|> includes("support")` | `true` |
| `padStart(len, fill)` | `"42" \|> padStart(6, "0")` | `"000042"` |
| `padEnd(len, fill)` | `"SKU" \|> padEnd(6, "_")` | `"SKU___"` |

Common patterns:

```ts
customerName |> trim |> lower
// { customerName: "  Alicia Smith  " } → "alicia smith"
// clean and normalize input
```

```ts
articleTitle |> lower |> replaceAll(" ", "-")
// { articleTitle: "Shipping Policy Update" } → "shipping-policy-update"
// build a URL slug
```

**Good fit for string transforms:** normalization, slug building, padding, and search checks. If you only need a couple of built-in methods like `slice()` or `includes()`, you can also use the core method-call syntax shown earlier.
