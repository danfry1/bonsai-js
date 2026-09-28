# Editor Support

When users write expressions in your product, they need the same help a code editor gives: completions, types on hover, and errors underlined as they type. `bonsai-js/service` provides these from the environment's static information. It never evaluates an expression and never calls a host function, so it is safe to run on every keystroke, in the browser or on a server.

## Create a service

```ts
import { bonsai, t } from 'bonsai-js'
import { createLanguageService } from 'bonsai-js/service'

const env = bonsai({
  variables: {
    user: t.object({ name: t.string(), email: t.optional(t.string()) }),
    orders: t.list(t.object({ id: t.string(), total: t.number(), paid: t.boolean() })),
  },
  strict: true,
})

const service = createLanguageService(env)
```

The service reads the environment's variables, built-ins, and host functions, including their descriptions. Create it once per environment.

## Completions

`complete(source, offset)` returns the items that fit at a cursor position (a UTF-16 offset) and the range `start`..`end` that accepting an item should replace (an item with its own `range` replaces that instead). Items are ranked by how well they match what has been typed, and member completions are type-aware: after a list you get list functions, after a map its fields.

<!-- continue -->
```ts
const afterDot = service.complete('orders.filter(.', 15)
afterDot.items.map((item) => item.label).slice(0, 3) // => ["id", "paid", "total"]

const partial = service.complete('user.na', 7)
partial.start // => 5
partial.items[0].label // => "name"
partial.items[0].insertText // => "name"
```

Each item has a `label`, a `kind` (`variable`, `local`, `property`, `function`, `method`, or `keyword`), a `detail` (a type or signature), an optional `documentation` string, and the `insertText` to insert. Functions insert an opening parenthesis, for example `sum()` or `filter(`.

## Hover

`hover(source, offset)` returns the type of the innermost expression under the cursor, or the signature and description when the cursor is on a function name.

<!-- continue -->
```ts
service.hover('orders.map(.total)', 2)?.detail // => "{ id: string, total: number, paid: boolean }[]"
service.hover('orders.map(.total)', 8)?.detail // => "map(T[], (T, number) => U): U[]"
service.hover('orders.map(.total)', 8)?.documentation // => "Transforms each item."
```

## Diagnostics

`diagnostics(source)` returns every syntax and check finding with its range. It is the same list as `env.check(source).diagnostics` and never throws.

<!-- continue -->
```ts
const [problem] = service.diagnostics('user.emial')
problem.code // => "UNKNOWN_PROPERTY"
problem.severity // => "error"
problem.start // => 0
problem.end // => 10
```

Map `start` and `end` to your editor's positions to underline the range. Warnings (`severity: "warning"`) point out expressions that are valid but probably wrong, such as a comparison that can never be true.

## Wiring it to an editor

Any editor component that can ask for completions at an offset works. The pattern is the same for CodeMirror, Monaco, or a plain `<textarea>`:

<!-- no-run -->
```ts
textarea.addEventListener('input', () => {
  const source = textarea.value
  const offset = textarea.selectionStart
  const { start, end, items } = service.complete(source, offset)
  showMenu(items, (item) =>
    replaceRange(item.range?.start ?? start, item.range?.end ?? end, item.insertText),
  )
  showProblems(service.diagnostics(source))
})
```

The [Playground](/playground) uses exactly this pattern; its source is in the repository under `website/.vitepress/theme/components/Playground.vue`.

When you render labels, details, and messages, insert them as text (for example with `textContent`), not as HTML. Diagnostic messages quote parts of the expression, which the user controls.

See the [Language Service API](/api/service) for the full types.
