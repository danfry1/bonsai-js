# Autocomplete Setup

Add cursor-aware completions to any expression editor. The autocomplete engine is a separate subpath export with zero DOM dependencies.

## Install and import

Autocomplete ships with the main package. Import it from the `bonsai-js/autocomplete` subpath:

```ts
import { bonsai } from 'bonsai-js'
import { strings, arrays } from 'bonsai-js/stdlib'
import { createAutocomplete } from 'bonsai-js/autocomplete'
```

## Create an instance

Pass your existing Bonsai instance and a context object. The autocomplete engine uses the same transforms, functions, and security policy as your evaluator.

```ts
const expr = bonsai().use(strings).use(arrays)

const ac = createAutocomplete(expr, {
  context: {
    user: { name: 'Alice', age: 25, plan: 'pro' },
    items: [
      { title: 'Widget', price: 9.99 },
      { title: 'Gadget', price: 24.50 },
    ],
  },
})
```

For authoring before real data exists, pass the same static schema used by the
checker:

```ts
import { createChecker, t } from 'bonsai-js/checker'

const schema = t.object({
  user: t.object({ name: t.string(), age: t.number(), plan: t.string() }),
  items: t.array(t.object({ title: t.string(), price: t.number() })),
})

const ac = createAutocomplete(expr, { schema })
const checker = createChecker(expr, {
  schema,
  expectedType: t.boolean(),
})

const source = 'items.some(.price > 20)'
checker.check(source) // valid, inferred boolean
ac.complete('items.some(.', 12) // title and price, inferred from the same schema
```

This is the recommended authoring setup: the checker owns acceptance and exact
diagnostics, while autocomplete uses the same schema and extension metadata for
suggestions. Neither tool evaluates the expression or probes host values.

## Get completions

Call `complete(expression, cursor)` with the expression string and the cursor position (zero-based character offset). It returns an array of `Completion` objects sorted by relevance.

```ts
// Property completions with inferred types
ac.complete('user.', 5)
// [{label: 'name', detail: 'string', kind: 'property'},
//  {label: 'age',  detail: 'number', kind: 'property'},
//  {label: 'plan', detail: 'string', kind: 'property'}]

// Type-aware method suggestions
ac.complete('user.name.', 10)
// [{label: 'trim()',  detail: 'string → string', kind: 'method'},
//  {label: 'upper()', detail: 'string → string', kind: 'method'}, ...]

// Lambda property inference
ac.complete('items.filter(.', 14)
// [{label: 'title', detail: 'string', kind: 'property'},
//  {label: 'price', detail: 'number', kind: 'property'}]

// Pipe transforms filtered by inferred type
ac.complete('user.name |> ', 13)
// only string-compatible transforms (trim, upper, lower...)
// array transforms like filter and sort are excluded automatically
```

::: tip Call complete() on every keystroke
The autocomplete engine handles incomplete and mid-edit expressions gracefully. Parse errors during editing are silently absorbed and never bubble up to callers.
:::

Next: [Autocomplete API Reference](/guide/autocomplete-api) documents every option and method.
