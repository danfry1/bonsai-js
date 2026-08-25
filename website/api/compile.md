# compile & validate

Use `compile()` for repeated execution and `validate()` for syntax/reference
checks. Use the [static checker](/api/checker) when you need binding and
type validation.

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

rule.ast    // deeply frozen optimized AST
rule.source // original source string
```

Compiled expressions stay associated with the instance that created them and
capture the immutable extension-registry revision present at compile time.
Later explicit replacements affect one-shot evaluation and newly compiled
rules, not an existing compiled rule. Safety policy remains instance-owned, and
`rule.evaluate*()` accepts the same per-run timeout, step, and signal options as
one-shot evaluation. The exposed AST is deeply frozen so tooling can inspect it
without being able to mutate the compiled artifact or the instance's cache.

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

`references` lists the identifiers, transforms, and functions mentioned in the
expression. `validate()` does not execute the expression and does not verify
that those transforms/functions are registered.

| Field | What it tells you |
|---|---|
| `valid` | Whether parsing succeeded |
| `errors` | Formatted parse problems when `valid` is `false` |
| `ast` | The parsed syntax tree when validation succeeds |
| `references` | Identifiers, transforms, and functions mentioned by the expression |

> **Tip:** A production flow is: `validate()` for immediate syntax feedback, `check()` against your schema, then `compile()` once you accept the expression.
