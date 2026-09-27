# Static Checking

Every expression is checked before it is evaluated. With declared variables the checker knows the shape of your data and reports mistakes with a code, a message, and a source range. Without declarations it still catches syntax errors, unknown functions, and misuse of literals.

## Gradual typing

Checking is gradual. A value whose type is unknown has type `any`, which is compatible with everything and is checked at run time instead. Values are `any` when they come from:

- a variable in an open environment (no `variables` declared), or an undeclared variable in a non-strict environment;
- a field of an open record (`t.record(...)`) or a field declared `t.any()`.

Declare more to catch more. `strict: true` turns every undeclared variable into an error.

```ts
import { bonsai, t, formatType, type BonsaiError } from 'bonsai-js'

const open = bonsai()
formatType(open.check('price * qty').type!) // => "any"
open.check('price * qty').ok // => true

const env = bonsai({
  variables: {
    user: t.object({
      plan: t.enum('free', 'pro'),
      age: t.optional(t.number()),
      email: t.optional(t.string()),
    }),
    items: t.list(t.object({ price: t.number(), qty: t.number() })),
  },
  strict: true,
})
formatType(env.check('items.map(.price * .qty).sum()').type!) // => "number"
env.check('itemz.length').diagnostics[0].message // => 'Unknown variable "itemz"; did you mean "items"?'
```

## Errors

An expression with errors does not compile: `env.compile()` throws a `BonsaiCheckError` whose `diagnostics` list every finding, and `env.check()` returns `ok: false`.

| Code | Meaning |
| --- | --- |
| `SYNTAX` | The text is not valid syntax (reported by `check()`). |
| `LIMIT` | A parse limit was exceeded (reported by `check()`). |
| `UNKNOWN_VARIABLE` | An undeclared variable in a strict environment. |
| `UNKNOWN_PROPERTY` | A field that a closed record or map literal does not have. |
| `UNKNOWN_FUNCTION` | A call to a function that does not exist. |
| `NO_OVERLOAD` | A call whose arguments match no signature. |
| `TYPE_ERROR` | An operator applied to incompatible types. |
| `NULLABLE_RECEIVER` | A possibly-null value where `null` is not accepted, such as a method call without `?.`. |
| `INVALID_LAMBDA` | `.` outside a function argument, `.` inside an explicit lambda, or a spread into a function that takes a lambda. |
| `BLOCKED_PROPERTY` | A blocked key (`__proto__`, `constructor`, `prototype`) as a static computed key. |
| `EXPECTED_TYPE` | The result does not match the type passed as `expect`. |

<!-- continue -->
```ts
env.check('user.email.endsWith("@example.com")').diagnostics[0].code // => "NULLABLE_RECEIVER"
env.check('user.email?.endsWith("@example.com")').ok // => true
env.check('user.age + 1').diagnostics[0].message // => 'An operand of "+" may be null; use ?? to supply a default'
env.check('(user.age ?? 0) + 1').ok // => true
env.check('items.map(.price).sum().toUpperCase()').diagnostics[0].code // => "NO_OVERLOAD"
env.check('items.length', { expect: t.boolean() }).diagnostics[0].code // => "EXPECTED_TYPE"
```

Each diagnostic has `start` and `end` offsets into the source, and `BonsaiCheckError.formatted` renders the first one with a code frame:

<!-- continue -->
```ts
try {
  env.compile('user.agee > 18')
} catch (error) {
  console.log((error as BonsaiError).formatted)
  // Property "agee" does not exist on { plan: "free" | "pro", age: number | null, email: string | null }; did you mean "age"?
  // 1 | user.agee > 18
  //   | ^^^^^^^^^
}
```

## Warnings

Warnings do not stop compilation. They point at expressions that are valid but probably not what the author meant. `env.check()` returns them among the diagnostics with `severity: "warning"`, and a compiled program lists them in `program.warnings`.

- a comparison that can never hold, such as comparing an enum with a value it cannot have;
- an ordering comparison with a value that may be `null` (it is `false` when the value is `null`);
- `??` on a value that is never `null`;
- a lambda that may return `null` where a boolean is expected.

<!-- continue -->
```ts
const premium = env.check('user.plan == "premium"')
premium.ok // => true
premium.diagnostics[0].severity // => "warning"
premium.diagnostics[0].message // => 'This comparison is always false: "free" | "pro" and "premium" have no values in common'

env.compile('user.age > 18').warnings[0].message // => "This value may be null, and a comparison with null is false; check it first (x != null && ...) or use ??"
```

Warnings currently use the `TYPE_ERROR` code; distinguish them by `severity`.

## Overloads and `any`

When several overloads could match because an argument is `any`, the result type is `any` unless every candidate agrees, and the runtime dispatches on the actual kind of the argument.

<!-- continue -->
```ts
formatType(open.check('x.slice(1)').type!) // => "any"
formatType(open.check('x.toUpperCase()').type!) // => "string"
```

## Expected types

`compile(source, { expect })` and `check(source, { expect })` require the result to be assignable to a type. A rule that must produce a boolean should always be compiled with `expect: t.boolean()`: it rejects expressions like `user.plan` that would otherwise compile and return a string, and it types the program's result in TypeScript.
