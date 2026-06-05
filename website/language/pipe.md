# Pipe Operator

Pipes are how you build readable data flow. They take a value on the left and pass it into a transform on the right, which makes cleanup and collection logic much easier to scan.

## Basic pipe

`|>` passes the left-hand value as the first argument to the transform on the right.

| Expression | Result | Context |
|---|---|---|
| `status \|> upper` | `"PENDING"` | `{ status: "pending" }` |

## Chaining

Each stage receives the previous result, so the expression reads in the same order as the transformation itself.

| Expression | Result | Context |
|---|---|---|
| `companyName \|> trim \|> upper` | `"ACME LABS"` | `{ companyName: "  Acme Labs  " }` |

## Pipes with arguments

The piped value is always the first argument. Any extra arguments go in parentheses after the transform name. When there are no extra arguments, parentheses are optional -- `name |> trim` and `name |> trim()` are identical.

| Expression | Result | Context |
|---|---|---|
| `roleCsv \|> split(",")` | `["admin", "billing", "ops"]` | `{ roleCsv: "admin,billing,ops" }` |
| `requestedDiscount \|> clamp(0, maxDiscount)` | `25` | `{ requestedDiscount: 35, maxDiscount: 25 }` |

## Complex pipelines

Most real application rules end up looking like this: filter a collection, project the values you care about, then format the result.

| Expression | Result | Context |
|---|---|---|
| `orders \|> filter(.status == "paid") \|> map(.id) \|> join(", ")` | `"INV-1001, INV-1003"` | `{ orders: [{ id: "INV-1001", status: "paid" }, { id: "INV-1002", status: "draft" }, { id: "INV-1003", status: "paid" }] }` |

**Choose the readable form:** if one value is flowing through a sequence of steps, use pipes. If you are combining peer values like `min(a, b)` or `discount(price, pct)`, a function call is usually clearer.
