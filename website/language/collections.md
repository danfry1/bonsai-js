# Collections

Collections let you build structured results directly inside an expression. Use them when the result should be data, not just a boolean or string.

| Pattern | Use it for |
|---|---|
| `[1, 2, 3]` | Create a new array value |
| `[...items, extra]` | Combine iterable values |
| `{ name, age }` | Build an object from context values |
| `{ [key]: value }` | Create an object with a computed key |
| `value.slice(0, 3)` | Call one of the safe built-in methods |

## Array literals

| Expression | Result | Note |
|---|---|---|
| `["starter", "analytics", "priority-support"]` | `["starter", "analytics", "priority-support"]` | |
| `[plan, ...addons, "priority-support"]` | `["starter", "analytics", "exports", "priority-support"]` | spread accepts iterable values |

## Object literals

| Expression | Result | Note |
|---|---|---|
| `{ plan: "pro", seats: 5 }` | `{ plan: "pro", seats: 5 }` | |
| `{ plan, seats }` | `{ plan: "growth", seats: 12 }` | shorthand - take values from context |
| `{ [metric]: value }` | `{ mrr: 1299 }` | computed keys are supported |

## Method calls

Core method-call support is intentionally small. Bonsai allows a safe subset of built-in string, array, and number methods such as `slice`, `includes`, `startsWith`, `repeat`, `trimStart`, `at`, and `toFixed`.

| Expression | Result | Context |
|---|---|---|
| `invoiceId.startsWith("inv_")` | `true` | `{ invoiceId: "inv_1042" }` |
| `selectedRegions.includes("gb")` | `true` | `{ selectedRegions: ["us", "gb", "de"] }` |
| `invoiceFile.slice(0, 7)` | `"invoice"` | `{ invoiceFile: "invoice-1042.pdf" }` |
| `orderTotal.toFixed(2)` | `"129.90"` | `{ orderTotal: 129.9 }` |

**Methods vs pipes:** many string operations are available both as method calls and as pipe transforms (via the stdlib). For example, `name.startsWith("inv_")` and `name |> startsWith("inv_")` do the same thing. Use method calls for simple, one-off checks. Use pipes when chaining multiple steps -- `name |> trim |> lower |> startsWith("inv_")` reads more clearly than nested method calls.
