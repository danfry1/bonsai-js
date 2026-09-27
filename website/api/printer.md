# Syntax Trees and print()

`env.parse(source)` returns the syntax tree of an expression, and `print(tree)` turns a tree back into source. Together they let a visual editor treat rules as data: parse, edit the tree, print, and save the text.

```ts
import { bonsai, print } from 'bonsai-js'

const env = bonsai()
const tree = env.parse('trim(name).toUpperCase()')

print(tree)                        // 'trim(name).toUpperCase()'
print(tree, { calls: 'method' })   // 'name.trim().toUpperCase()'
print(tree, { calls: 'function' }) // 'toUpperCase(trim(name))'
```

## Guarantees

- The tree is plain JSON. Every node has `type`, `start`, and `end` (UTF-16 offsets into the source).
- Printing is deterministic. Parsing printed text and printing it again gives the same text.
- Printed text means the same as the tree: it evaluates to the same result or fails with the same error.
- Parentheses are added only where they change meaning, and where the language requires them (for example `(-2) ** 2` and `(a ?? b) || c`).
- Comments and original spacing are not part of the tree and are not printed.

## Options

| Option | Values | Effect |
|---|---|---|
| `calls` | `'preserve'` (default), `'method'`, `'function'` | How calls are written. `f(x, a)` and `x.f(a)` are the same call node; this only chooses the spelling. |

## Building rules from trees

A tree built by hand prints the same way as a parsed one, so an editor can construct nodes directly:

```ts
import { print } from 'bonsai-js'

const at = { start: 0, end: 0 }
print({
  type: 'Binary',
  operator: '>=',
  left: { type: 'Member', object: { type: 'Variable', name: 'user', ...at }, name: 'age', optional: false, ...at },
  right: { type: 'Literal', value: 18, ...at },
  ...at,
}) // 'user.age >= 18'
```

For the rest of an editor, `env.listFunctions()` lists every function with its signatures and description, `env.check()` reports diagnostics with source ranges, and the [language service](./service) returns completions and the type at any position.
