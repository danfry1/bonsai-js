# Static Checker

Use `bonsai-js/checker` to catch expression mistakes before evaluation. The
checker consumes an explicit schema, the instance's extension metadata, and the
AST. It never evaluates expressions or invokes transforms, functions, getters,
or other host code.

```ts
import { bonsai } from 'bonsai-js'
import { strings } from 'bonsai-js/stdlib'
import { createChecker, t } from 'bonsai-js/checker'

const expr = bonsai().use(strings).seal()
const checker = createChecker(expr, {
  schema: t.object({
    user: t.object({
      name: t.string(),
      age: t.number(),
      plan: t.enum('free', 'pro'),
      nickname: t.optional(t.string()),
    }),
  }),
})

checker.check('user.age >= 18', { expectedType: t.boolean() })
// valid: true; inferred type: boolean

checker.check('user.agge >= 18')
// valid: false; UNKNOWN_PROPERTY at the exact source range

checker.check('user.plan == "prem"')
// valid: false; TYPE_MISMATCH: comparison is always false ("free" | "pro" vs "prem")

checker.check('user.nickname.trim()')
// valid: false; NULLABLE_ACCESS: use user.nickname?.trim()
```

## Type builders

| Builder | Meaning |
|---|---|
| `t.string()` | String |
| `t.number()` | JavaScript number |
| `t.boolean()` | Boolean |
| `t.null()` / `t.undefined()` | Nullish primitives |
| `t.unknown()` | Dynamic value; decisions defer to runtime |
| `t.literal(value)` | Exactly one string, number, or boolean value |
| `t.enum(...values)` | Union of literals, for closed sets such as plans or statuses |
| `t.array(element)` | Homogeneous array |
| `t.object(properties, options?)` | Structural record |
| `t.record(value)` | Object with no fixed keys whose values share one type |
| `t.union(...members)` | Normalized union |
| `t.optional(type)` | Union with `undefined` |
| `t.nullable(type)` | Union with `null` |

Schemas are frozen, JSON-serializable descriptors. Open records can declare
`additionalProperties`:

```ts
t.object(
  { known: t.string() },
  { additionalProperties: t.unknown() },
)
```

Literal types stay precise while checking (so enum typos and impossible strict
comparisons are caught) and widen in the reported result type: `[1, 2]` checks
as `number[]`, not `(1 | 2)[]`.

## Nullable values

The runtime reads a property from `null`/`undefined` as `undefined`, so
`user.nickname.length` is valid and infers `number | undefined`. Calling a
method on a nullable value throws at runtime, so `user.nickname.trim()` reports
`NULLABLE_ACCESS`; write `user.nickname?.trim()` (inferred `string | undefined`).

## Diagnostics

`check()` returns every non-cascading diagnostic with a stable `code`, message,
severity, and zero-based `start`/`end` source range.

| Code | Meaning |
|---|---|
| `SYNTAX_ERROR` | Parsing failed |
| `RESOURCE_LIMIT` | The instance's source/token/AST structural policy rejected the expression |
| `UNKNOWN_IDENTIFIER` / `UNKNOWN_PROPERTY` | Schema lookup failed (including `.count` on an array or a lambda `.field` on a non-object element) |
| `UNKNOWN_FUNCTION` / `UNKNOWN_TRANSFORM` | Binding is not registered |
| `TYPE_MISMATCH` | Operator, input, argument, spread, template, or element type is invalid; also an `==`/`!=` whose sides can never overlap |
| `ARGUMENT_COUNT` | Declared extension or built-in method arity does not match |
| `METHOD_NOT_ALLOWED` | Method is not available for the receiver type |
| `NULLABLE_ACCESS` | A method is called on a nullable value without `?.` |
| `EXPECTED_RESULT` | Inferred result does not match `expectedType` |
| `PROPERTY_NOT_ALLOWED` | The instance security policy blocks the member |

Built-in string, number, and array methods are checked for arity and parameter
types (`text.slice("a")`, `text.padStart(10, 5)`, `tags.with(0, 5)` on
`string[]`), and `join`/`toSorted` require elements with primitive string
representations, matching the runtime.

## Declarative signatures

`defineTransform()`, `defineFunction()`, and `defineContextFunction()` accept
`inputType`, `parameters`, and `returnType`. Array transforms can additionally
declare `arrayTypeRule` when their result depends on the input element type.
The registry validates and freezes that metadata. The bundled standard library
declares its signatures too.

```ts
expr.defineTransform({
  name: 'truncate',
  inputType: t.string(),
  parameters: [{ name: 'length', type: t.number() }],
  returnType: t.string(),
  description: 'Limit text to a maximum length',
  evaluate: (value, length) =>
    String(value).slice(0, Number(length)),
})
```

Generic stdlib transforms preserve precise element types: `first`/`last`
produce the optional element, `reverse`/`sort`/`unique` preserve the array,
`flatten` removes one array layer, and higher-order transforms infer their
lambda. These relationships come from `arrayTypeRule`, not reserved transform
names, so a custom transform called `map` keeps its own declared signature.

`checkExpression(instance, source, options)` is the one-shot equivalent of a
reused checker. `formatType()` formats descriptors for diagnostics and UI;
`isAssignable()` exposes the structural compatibility rule.

::: tip Share one schema with autocomplete
Pass the same descriptor as `createAutocomplete(expr, { schema })` to get
property, method, pipe, and lambda completions without supplying representative
live values.
:::
