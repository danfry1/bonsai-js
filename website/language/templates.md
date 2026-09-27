# Templates

<!-- context: { user: { name: "Ada", nickname: null, tags: ["admin", "beta"] }, order: { id: "A-1042", total: 129.5, placedAt: new Date("2026-01-14T09:00:00Z") }, cart: { items: [1, 2, 3] } } -->

Template literals work as in JavaScript: text in backticks with `${expression}` interpolations.

```bonsai
`Hello ${user.name}!` // => "Hello Ada!"
`Order ${order.id}: ${cart.items.length} items, ${order.total} total` // => "Order A-1042: 3 items, 129.5 total"
`${user.nickname ?? user.name} (${user.tags.join(", ")})` // => "Ada (admin, beta)"
```

Templates can span lines and nest, and `\${` writes a literal `${`:

```bonsai
`Dear ${user.name},
your order ${order.id} has shipped.` // => "Dear Ada,\nyour order A-1042 has shipped."
`a ${`b ${1 + 1}`} c` // => "a b 2 c"
`\${not interpolated}` // => "${not interpolated}"
```

## How values render

| Value | Rendered as |
| --- | --- |
| `null` | empty text |
| string | the string |
| boolean | `true` or `false` |
| number | shortest round-trip form, as JavaScript's `String(n)` |
| timestamp | ISO-8601, for example `2026-01-14T09:00:00.000Z` |
| duration | ISO-8601 duration, for example `PT1H30M` |
| list or map | a type error |

```bonsai
`[${user.nickname}]` // => "[]"
`${0.1 + 0.2}` // => "0.30000000000000004"
`${order.placedAt}` // => "2026-01-14T09:00:00.000Z"
`${hours(1.5)}` // => "PT1H30M"
`${user.tags}` // error: TYPE_ERROR
```

Lists and maps have no single obvious text form, so render them explicitly with `join`, a nested template, or a function such as `formatDate` or `toFixed`:

```bonsai
`Tags: ${user.tags.join(", ")}` // => "Tags: admin, beta"
`Placed ${order.placedAt.formatDate("dd/MM/yyyy")}` // => "Placed 14/01/2026"
`Total: ${order.total.toFixed(2)}` // => "Total: 129.50"
```

`toString(x)` renders a value the same way a template does.

Templates never call `toString`, `valueOf`, or `toJSON` on host objects, and the produced text counts against the `maxStringLength` limit.
