# compile & validate

Use `compile()` for repeated execution and `validate()` before you store or accept user-authored expressions.

## compile(expression)

Compile once and keep the returned `CompiledExpression` around for repeated execution.

```ts
const rule = expr.compile('order.total >= freeShippingThreshold')

rule.evaluateSync({
  order: { total: 129 },
  freeShippingThreshold: 100
}) // true

rule.evaluateSync({
  order: { total: 49 },
  freeShippingThreshold: 100
}) // false

await rule.evaluate({
  order: { total: 220 },
  freeShippingThreshold: 150
}) // true

rule.ast    // optimized AST
rule.source // original source string
```

Compiled expressions stay associated with the instance that created them, so they continue to use that instance's safety settings and currently registered transforms/functions.

## validate(expression)

Parse without executing. This is useful for editors, validation UIs, and preflight checks before persisting an expression.

```ts
expr.validate('order.total >= freeShippingThreshold')
// {
//   valid: true,
//   errors: [],
//   ast: {...},
//   references: {
//     identifiers: ["order", "freeShippingThreshold"],
//     transforms: [],
//     functions: []
//   }
// }

expr.validate('1 +')
// {
//   valid: false,
//   errors: [{
//     message: "Expected expression",
//     position: {...},
//     formatted: "1 +\n    ^ Expected expression"
//   }]
// }
```

`references` lists the identifiers, transforms, and functions mentioned in the expression. `validate()` does not execute the expression and does not verify that those transforms/functions are currently registered.

| Field | What it tells you |
|---|---|
| `valid` | Whether parsing succeeded |
| `errors` | Formatted parse problems when `valid` is `false` |
| `ast` | The parsed syntax tree when validation succeeds |
| `references` | Identifiers, transforms, and functions mentioned by the expression |

> **Tip:** A common production flow is: `validate()` when the user edits the expression, then `compile()` once when you accept it.
