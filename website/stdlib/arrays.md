# Arrays

Load the array stdlib when your expressions need collection work: counting, searching, projection, deduping, and simple aggregation.

```ts
import { arrays } from 'bonsai-js/stdlib'
expr.use(arrays)
```

## Basic transforms

| Transform | Example | Result |
|---|---|---|
| `count` | `selectedRegions \|> count` | `3` |
| `first` | `planTiers \|> first` | `"starter"` |
| `last` | `releaseStages \|> last` | `"production"` |
| `reverse` | `approvalSteps \|> reverse` | `["legal", "finance", "ops"]` |
| `flatten` | `tagGroups \|> flatten` | `["billing", "finance", "ops"]` |
| `unique` | `regions \|> unique` | `["gb", "us", "de"]` |
| `join(sep)` | `invoiceIds \|> join(", ")` | `"INV-1, INV-2"` |
| `sort` | `priorityScores \|> sort` | `[1, 2, 3]` |

`sort` sorts numbers numerically and falls back to string comparison for other values.

## Higher-order transforms

These accept [lambda predicates](/language/lambdas) as arguments for filtering, mapping, and searching.

`find`, `some`, and `every` stop as soon as the result is known. During async
evaluation, higher-order transforms await callbacks sequentially by default, so
side effects stay ordered and a large collection does not create unbounded
concurrent work.

| Transform | Example | Result |
|---|---|---|
| `filter(pred)` | `users \|> filter(.age >= 18)` | Array of matching items |
| `map(fn)` | `users \|> map(.name)` | Array of extracted values |
| `find(pred)` | `users \|> find(.age >= 18)` | First matching item |
| `some(pred)` | `users \|> some(.age >= 18)` | `true` if any match |
| `every(pred)` | `users \|> every(.age >= 18)` | `true` if all match |

Practical examples:

```ts
users |> filter(.age >= 18) |> map(.name)
// get names of adult users
// ["Alice", "Charlie"]
```

```ts
orders |> some(.total > 100)
// check if any order exceeds $100
// true
```

```ts
products |> map(.category) |> unique |> sort
// deduplicate and sort categories
// ["electronics", "food", "toys"]
```

**Most array errors are type mismatches:** these transforms expect arrays. If the input might be nullable or mixed, normalize it before you reach the expression or guard it with your own custom transform.
