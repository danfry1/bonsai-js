# Types (t)

The `t` builders describe the data expressions run against. They serve three purposes at once: the checker uses them to catch mistakes, `Infer` derives TypeScript types from them, and `validateContext` checks incoming data against them. If your data already has a Zod, Valibot, ArkType, or JSON Schema schema, [`fromSchema`](#types-from-your-schemas) converts it instead.

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

Both `t.object` and `t.record` describe maps, the language's name for plain objects (their type's `kind` is `map`): `t.object` is a closed record with known fields, and `t.record` an open one with any key.

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

Types are plain, frozen, JSON-serializable objects, so a schema can be stored, sent to a browser-based editor, or generated from another schema language (a database schema or a form definition; for Zod or JSON Schema, see [below](#types-from-your-schemas)):

<!-- continue -->
```ts
JSON.stringify(t.optional(t.number())) // => '{"kind":"union","types":[{"kind":"number"},{"kind":"null"}]}'
```

The `kind` values are `any`, `never`, `null`, `boolean`, `number`, `string`, `timestamp`, `duration`, `literal`, `list`, `map`, `union`, and `opaque`, plus `function` and `var`, which appear only in built-in signatures. New kinds may be added in minor releases.

## Types from your schemas

If your app already describes its data with Zod, Valibot, ArkType, or JSON Schema, `fromSchema` turns that schema into a Bonsai type, so you don't write it twice:

```ts
import { z } from 'zod'
import { bonsai, formatType, fromSchema } from 'bonsai-js'

const User = z.object({
  age: z.number(),
  plan: z.enum(['free', 'pro']),
  nickname: z.string().optional(),
  joined: z.date(),
})

const env = bonsai({ variables: { user: fromSchema(User) } })
const user = User.parse({ age: 30, plan: 'pro', joined: new Date('2026-01-05') })
env.evaluateSync('user.age >= 18 && user.plan == "pro"', { user }) // => true
formatType(fromSchema(User)) // => '{ age: number, plan: "free" | "pro", nickname: string | null, joined: timestamp }'
```

The type describes what the schema's `parse` returns, and the context is typed as that output (`z.output<typeof User>` here). Elsewhere, such as a host function's parameters or a program's result, the value was only checked against the converted type, so it is `unknown`, and so is `Infer` of a converted type. Use the library's own type there. `fromSchema` accepts:

- **Zod 4 and ArkType** schemas, as they are.
- **Valibot** schemas wrapped with `toStandardJsonSchema` from `@valibot/to-json-schema`.
- **JSON Schema** objects (draft-07, 2020-12, or an OpenAPI 3.0 schema), with local `$ref`s.

Any library that implements [Standard JSON Schema](https://standardschema.dev) works the same way. Passing a schema straight into `variables` throws an error that says to use `fromSchema`.

Some parts have no shape Bonsai can read:

- **Transforms** (`.transform()`, a Valibot `transform`) throw an error that names their JSON pointer. Give those parts a type with the `types` option: `fromSchema(Order, { types: { '/properties/total': t.number() } })`. Inside a `$ref`, use the definition's pointer (`'/$defs/Money/properties/cents'`); a pointer the schema doesn't have is an error. Pointers follow the JSON Schema the library writes, which the error message names. Simple Valibot conversions such as `toNumber` and `toDate` are read as their result. ArkType doesn't report its morphs, so they convert to `t.any()`.
- **Recursive schemas** stop at their first repeat, which converts to `t.any()`.
- **Dates** from Zod, Valibot, and ArkType become `timestamp`. In a plain JSON Schema, a `format: "date-time"` string stays a `string`, because the data holds a string. Write `"x-bonsai-type": "timestamp"` in the schema when the value is a `Date`.
- **Maps, sets, bigints, and promises** become opaque types.
- **Tuples** become lists of any of their members: `[string, number]` is `(string | number)[]`.
- **ArkType's `object` domain** includes arrays, but its JSON Schema says `type: "object"`, so an index-signature type (`{ '[string]': 'number' }`) or a JSON keyword (`string.json.parse`) converts to a record. Give it `t.any()` with the `types` option if it may hold a list.

Objects stay closed even when the JSON Schema allows other keys, so a typo is still an error. A schema with `additionalProperties` or `patternProperties` gets those keys as an open record. Bonsai numbers are finite, so with `validateContext`, an `Infinity` that a schema allows is still rejected. A union of objects keeps each member's fields, but the checker doesn't narrow on a discriminant: in `shape.kind == "circle" ? shape.radius : 0`, `shape.radius` checks as `any`.

`fromSchema` may accept more schemas in minor releases. For a schema it already accepts, the type it produces won't get narrower, except to fix a type that rejects data the schema allows.

