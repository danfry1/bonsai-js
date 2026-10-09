# Types (t)

The `t` builders describe the data expressions run against. They serve three purposes at once: the checker uses them to catch mistakes, `Infer` derives TypeScript types from them, and `validateContext` checks incoming data against them.

```ts
import { bonsai, t, formatType, type Infer } from 'bonsai-js'

const Customer = t.object({
  id: t.string(),
  tier: t.enum('standard', 'gold'),
  email: t.optional(t.string()),
  tags: t.list(t.string()),
  signedUp: t.timestamp(),
  attributes: t.record(t.string()),
})

type Customer = Infer<typeof Customer>
// {
//   readonly id: string
//   readonly tier: 'standard' | 'gold'
//   readonly tags: readonly string[]
//   readonly signedUp: Date
//   readonly attributes: { readonly [key: string]: string }
//   readonly email?: string | null | undefined
// }

formatType(Customer) // => '{ id: string, tier: "standard" | "gold", email: string | null, tags: string[], signedUp: timestamp, attributes: { [key: string]: string } }'
```

## Builders

| Builder | Bonsai type | TypeScript type |
| --- | --- | --- |
| `t.string()` | `string` | `string` |
| `t.number()` | `number` | `number` |
| `t.boolean()` | `boolean` | `boolean` |
| `t.null()` | `null` | `null` |
| `t.timestamp()` | `timestamp` | `Date` |
| `t.duration()` | `duration` | `Duration` |
| `t.literal(v)` | the single value `v` | the literal type |
| `t.enum(a, b, ...)` | a union of literals | `'a' \| 'b' \| ...` |
| `t.list(T)` | `T[]` | `readonly T[]` |
| `t.object({ ... })` | a closed record with known fields | a readonly object type |
| `t.record(V)` | an open record: any key, values of type `V` | `{ readonly [key: string]: V }` |
| `t.optional(T)` | `T \| null` | `T \| null`, and the property becomes optional |
| `t.union(A, B, ...)` | `A \| B \| ...` | the union |
| `t.opaque(name)` | a host value expressions cannot navigate | `unknown` |
| `t.any()` | anything, checked at run time | `unknown` |
| `t.never()` | no value | `never` |

## Closed and open records

`t.object` is closed: reading a field it does not declare is a check error (`UNKNOWN_PROPERTY`), which catches typos. Closed describes what expressions may name, not what the value holds: at run time the object may have more keys (a database row with extra columns), so `values()`, `entries()`, and computed-key reads on it include values of unknown type, and a closed object is not accepted where a `t.record` is expected. `t.record` is open: any key may be read, and the result is `V | null` because the key may be missing.

<!-- continue -->
```ts
const env = bonsai({ variables: { customer: Customer } })
env.check('customer.tier').ok // => true
env.check('customer.teir').ok // => false
formatType(env.check('customer.attributes.region').type!) // => "string | null"
```

A closed type is a checking aid, not access control: see [Safety](/guide/safety#what-remains-your-responsibility).

For untyped JSON, such as a request body whose shape is not declared, use `t.any()` rather than `t.record(t.any())`. Every read of a record may be missing, so it is typed `any | null`, and the checker then asks for `??` or `?.` at each use; `t.any()` is checked at run time instead:

<!-- continue -->
```ts
const untyped = bonsai({ variables: { body: t.any() } })
untyped.check('body.total * 2').ok // => true
bonsai({ variables: { body: t.record(t.any()) } }).check('body.total * 2').ok // => false
```

## Optional values

`t.optional(T)` is `T | null`. Because absent keys read as `null`, it also marks a field that may be missing. The checker then requires `?.` for calls and `??` for arithmetic on it:

<!-- continue -->
```ts
env.check('customer.email.endsWith("@example.com")').diagnostics[0].code // => "NULLABLE_RECEIVER"
env.check('customer.email?.endsWith("@example.com") ?? false').ok // => true
```

Optional parameters of host functions must also be declared with `t.optional`.

## Opaque values

`t.opaque(name)` declares a host value that expressions may hold, compare with `==`, and pass to host functions, but not read properties of. Use it for handles such as a database client or a class instance you pass through to your own functions. For a class instance the restriction is static: at run time it is still read as a map of its own properties. Built-in host objects such as `Map`, `Set`, `RegExp`, and promises are opaque at run time too, whatever their declared type.

## Helpers

| Export | Description |
| --- | --- |
| `formatType(type)` | Renders a type as text, as in diagnostics and hovers. |
| `isAssignable(source, target)` | Whether a value of type `source` is accepted where `target` is expected. |
| `Infer<typeof type>` | The TypeScript type of values described by a Bonsai type. |
| `InferVariables<typeof variables>` | The TypeScript type of a context for a `variables` record. |

<!-- continue -->
```ts
import { isAssignable } from 'bonsai-js'

isAssignable(t.literal('gold'), t.string()) // => true
isAssignable(t.string(), t.enum('standard', 'gold')) // => false
isAssignable(t.optional(t.number()), t.number()) // => false
```

## Types are data

Types are plain, frozen, JSON-serializable objects, so a schema can be stored, sent to a browser-based editor, or generated from another schema language (a JSON Schema, a database schema, or a form definition):

<!-- continue -->
```ts
JSON.stringify(t.optional(t.number())) // => '{"kind":"union","types":[{"kind":"number"},{"kind":"null"}]}'
```

The `kind` values are `any`, `never`, `null`, `boolean`, `number`, `string`, `timestamp`, `duration`, `literal`, `list`, `map`, `union`, and `opaque`, plus `function` and `var`, which appear only in built-in signatures. New kinds may be added in minor releases.
