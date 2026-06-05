# Autocomplete API Reference

Full reference for the autocomplete factory, instance methods, options, and the completion object shape.

## createAutocomplete(instance, options?)

Creates an autocomplete instance bound to a Bonsai evaluator. The returned instance shares the same transforms, functions, and security policy.

```ts
import { createAutocomplete } from 'bonsai-js/autocomplete'

const ac = createAutocomplete(expr, {
  context: { user: { name: 'Alice' } },
})
```

## AutocompleteOptions

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | The variable scope used for property lookups and type inference. Defaults to `{}`. |
| `transformTypes` | `Record<string, InferredTypeName[]>` | Explicit map of transform names to accepted input types (e.g., `{ upper: ['string'] }`). When omitted, the engine auto-probes type compatibility by calling each transform with sample values. Use this to skip the cold-start probe cost in large transform registries. |
| `onError` | `(error, phase) => void` | Called on unexpected internal errors during completion. Expected errors (syntax, security, type) are silently handled. Useful for debugging missing or incorrect suggestions. |

## complete(expression, cursor)

Returns completions for the given cursor position. Never throws. Returns `[]` if no completions are available or if an unexpected error occurs.

```ts
ac.complete('user.na', 7)
// [{label: 'name', detail: 'string', kind: 'property', sortPriority: -500}]
// Fuzzy matching: 'na' matches 'name' as a prefix
```

## setContext(context)

Replace the context object used for completions. Call this when the user's data changes and completions should reflect the new shape.

```ts
ac.setContext({
  order: { total: 129, status: 'pending' },
  customer: { tier: 'gold' },
})

ac.complete('order.', 6)
// [{label: 'total',  detail: 'number', kind: 'property'},
//  {label: 'status', detail: 'string', kind: 'property'}]
```

## Completion object

Each item returned by `complete()` has the following shape:

| Field | Type | Description |
| --- | --- | --- |
| `label` | `string` | Display text and default insert text (e.g., `"name"`, `"trim()"`). |
| `kind` | `string` | One of `'variable'`, `'property'`, `'method'`, `'transform'`, `'function'`, or `'keyword'`. |
| `detail` | `string?` | Type info. Properties show the inferred type (e.g., `'string'`, `'number'`). Methods show their signature (e.g., `'string → string'`). Root-level variables show a value preview (e.g., `'"Alice"'`, `'array(3)'`). |
| `insertText` | `string?` | Override text to insert instead of `label`. Used by methods that need parentheses or argument placeholders (e.g., `'filter(.)'`). |
| `cursorOffset` | `number?` | Where to place the cursor within `insertText` after insertion. For `'filter(.)'` with offset `8`, the cursor lands between the parentheses. |
| `sortPriority` | `number` | Lower values sort first. Fuzzy matching adjusts this so better matches rank higher. |

Next: [Editor Integration](/guide/autocomplete-editor) shows how to wire autocomplete into a real input or Monaco editor.
