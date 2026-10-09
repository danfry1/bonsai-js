# Syntax Tree Reference

`env.parse(source)` returns the syntax tree of an expression as plain, JSON-serializable objects. Every node has a `type`, and `start` and `end`: UTF-16 offsets into the source. `print(tree)` turns a tree back into source; see [Syntax Trees and print()](./printer).

Treat node types as an open set: a minor release may add node types (for new syntax) and fields, so give a `switch` over `node.type` a `default` branch.

## Node types

| `type` | Fields | Example source |
|---|---|---|
| `Literal` | `value`: `null`, a boolean, a number, or a string | `42`, `"pro"`, `null` |
| `Template` | `parts`: decoded text strings alternating with expression nodes | `` `Hi ${name}` `` |
| `Variable` | `name`: a context variable | `user` |
| `Local` | `name`: a `let` binding or an explicit lambda parameter | `x` in `items.map(x => x * 2)` |
| `It` | none: the implicit lambda parameter | `.` in `items.map(. * 2)` |
| `Member` | `object`, `name`, `optional` (`?.`), `nameStart` and `nameEnd` (the span of the name) | `user.name`, `user?.name` |
| `Index` | `object`, `index`, `optional` (`?.[ ]`) | `tags[0]`, `counts[key]` |
| `Call` | `name`, `args` (nodes or `Spread`), `style` (`'function'` or `'method'`), `optional` (`?.`), `nameStart` and `nameEnd` | `round(x, 2)`, `x.round(2)` |
| `Unary` | `operator` (`!` or `-`), `operand` | `!done`, `-x` |
| `Binary` | `operator` (`??`, `\|\|`, `&&`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not in`, `+`, `-`, `*`, `/`, `%`, `**`), `left`, `right` | `a + b` |
| `Conditional` | `test`, `then`, `otherwise` | `a ? b : c` |
| `List` | `items` (nodes or `Spread`) | `[1, ...rest]` |
| `Map` | `entries` (`Entry` or `Spread`); an `Entry` has `key` (a string, or a node for `[key]: value`) and `value` | `{plan: "pro", [k]: 1}` |
| `Spread` | `argument`; only inside a list, a map, or call arguments | `...rest` |
| `Lambda` | `params` (names), `implicit` (written with `.`), `body`; only as a call argument | `x => x * 2` |
| `Let` | `name`, `value`, `body` | `let total = a + b; total * 2` |
| `Has` | `target` (a `Member` or `Index` node) | `has(user.email)` |
| `Try` | `body`, `fallback` | `try(toNumber(s), 0)` |

A method call `x.f(a)` is a `Call` with `style: 'method'` whose receiver is `args[0]`: it is the same call as `f(x, a)`. In the tree `env.parse()` returns, an implicit lambda such as `.price * 2` is an `It` node inside the argument; the checked tree (`env.check(source).ast` and `program.ast`) wraps it in a `Lambda` node with `implicit: true`.

## Walking a tree

`forEachChild(node, visit)` calls `visit` with each direct child node (the contents of spreads and map entries, not the wrappers):

```ts
import { bonsai, forEachChild, type Node } from 'bonsai-js'

const env = bonsai()

function variables(node: Node, found = new Set<string>()): Set<string> {
  if (node.type === 'Variable') found.add(node.name)
  forEachChild(node, (child) => {
    variables(child, found)
  })
  return found
}

[...variables(env.parse('user.age > limits.min && user.plan == "pro"'))] // => ["user", "limits"]
```

## Transforming a tree

To rewrite expressions, such as renaming a field when a schema changes, edit the source text and use the checked tree to find what to change. The checker knows the type of every node, so the rename can be limited to one record type, and editing the text keeps comments and spacing. `nameStart` and `nameEnd` of a `Member` or `Call` cover just the name:

<!-- continue -->
```ts
import { formatType, t } from 'bonsai-js'

const order = t.object({ qty: t.number(), price: t.number() })
const shop = bonsai({ variables: { order, stock: t.object({ qty: t.number() }) } })
const source = 'order.qty * order.price + stock.qty // per line'
const checked = shop.check(source)

const edits: { start: number; end: number }[] = []
const collect = (node: Node): void => {
  if (node.type === 'Member' && node.name === 'qty' && node.nameStart !== undefined && node.nameEnd !== undefined) {
    const owner = checked.typeOf(node.object)
    if (owner && formatType(owner) === formatType(order)) edits.push({ start: node.nameStart, end: node.nameEnd })
  }
  forEachChild(node, collect)
}
if (checked.ast) collect(checked.ast)
let edited = source
for (const { start, end } of edits.sort((a, b) => b.start - a.start)) {
  edited = edited.slice(0, start) + 'quantity' + edited.slice(end)
}
edited // => "order.quantity * order.price + stock.qty // per line"
```

`mapChildren(node, map)` returns a shallow copy of `node` with each child replaced by `map(child)`, leaving the original tree unchanged. Applied recursively, it rewrites a whole tree. A rewrite like the one below is purely syntactic: it renames every field called `qty`, on any object, and printing the result drops comments and the original spacing. Use it for generated expressions, not for text people wrote:

<!-- continue -->
```ts
import { mapChildren, print } from 'bonsai-js'

function renameField(node: Node, from: string, to: string): Node {
  const mapped = mapChildren(node, (child) => renameField(child, from, to))
  return mapped.type === 'Member' && mapped.name === from ? { ...mapped, name: to } : mapped
}

print(renameField(env.parse('order.qty * stock.qty'), 'qty', 'quantity')) // => "order.quantity * stock.quantity"
```

To combine expressions, combine their trees (or print each and wrap it in parentheses), rather than joining source strings. A `//` comment runs to the end of the line, so `` `${a} && ${b}` `` with `a = 'x > 1 // minimum'` comments out `b`. Printing a parsed tree removes the comment, and `` `(${print(env.parse(a))}) && (${print(env.parse(b))})` `` is safe.


## Types of nodes

`env.check(source)` returns the checked tree as `ast` and the inferred type of any of its nodes through `typeOf(node)`, for tooling that needs the type at a node, such as a migration that renames a field only on one record type:

<!-- continue -->
```ts
const typed = bonsai({ variables: { order: t.object({ qty: t.number() }), tags: t.list(t.string()) } })
const result = typed.check('order.qty > tags.length')
const qty = result.ast?.type === 'Binary' ? result.ast.left : undefined
formatType(result.typeOf(qty as Node) ?? t.any()) // => "number"
```

`typeOf` answers for nodes of `result.ast` only (a node from `env.parse()` is a different object and gives `undefined`). When the check reports errors, the tree is still typed as far as the checker got; when the source does not parse, `ast` is `undefined`.

## Building trees by hand

`start` and `end` are required on every node, and `nameStart` and `nameEnd` on a `Call`. `print()` does not read them, so a tree built by hand can set them to `0`. `nameStart` and `nameEnd` are optional on a `Member`.
