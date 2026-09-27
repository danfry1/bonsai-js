# Property Access

<!-- context: { user: { name: "Ada", nickname: null, tags: ["admin", "beta"], address: { city: "London" } }, counts: { "7": 3 }, id: 7, key: "name" } -->

## Variables

A name reads a variable from the context. In an open environment (no declared variables), an unknown name reads as `null`; in a strict environment it is a check error. Variables and functions are separate namespaces: `sum` as a variable and `sum(...)` as a call do not conflict.

## Members: `a.b`

`a.b` reads the own property `b` of a map. Reading a missing property gives `null`, and reading any property of `null` gives `null`, so chains of reads never fail on missing data:

```bonsai
user.name // => "Ada"
user.address.city // => "London"
user.profile.avatar // => null
user.profile.avatar ?? "default.png" // => "default.png"
```

Strings and lists have exactly one property, `length`. Reading any other property of a string, number, boolean, list, timestamp, duration, or opaque value is a type error. Functions are called, not read: write `user.name.toUpperCase()`, not `user.name.toUpperCase`.

```bonsai
user.name.length // => 3
user.tags.length // => 2
user.name.first // error: TYPE_ERROR
```

## Indexing: `a[k]`

| Receiver | Key | Result |
| --- | --- | --- |
| map | string | the own property, or `null` |
| map | number | the property named by its decimal text |
| list or string | integer | the item or character, or `null` when the position does not exist |
| `null` | anything | `null` |
| anything | `null` | `null` |

Negative and fractional positions do not exist, so they give `null`. Use `at(-1)` or `last()` to count from the end.

```bonsai
user["name"] // => "Ada"
user[key] // => "Ada"
counts[id] // => 3
user.tags[0] // => "admin"
user.tags[5] // => null
user.tags[-1] // => null
user.tags.at(-1) // => "beta"
"hello"[1] // => "e"
```

## Optional calls: `?.`

`?.` is accepted wherever `.` is and means the same for reads (which already give `null` on `null`). It matters for calls: a function call with a `null` receiver is an error, while `?.` makes that one call return `null` instead.

```bonsai
user.nickname.toUpperCase() // error: NULL_RECEIVER
user.nickname?.toUpperCase() // => null
user.nickname?.toUpperCase() ?? user.name // => "Ada"
```

Unlike JavaScript, `?.` short-circuits only its own call, not the rest of the chain. Write `?.` at every call that may receive `null`:

```bonsai
user.nickname?.trim()?.toUpperCase() // => null
```

With declared types, the checker reports a missing `?.` before evaluation (`NULLABLE_RECEIVER`). See [Static Checking](/language/checking).

## Presence: `has`

`has(a.b)` is `true` when `a` is a map with an own property `b`, even if its value is `null`. It distinguishes "present but null" from "missing", which `== null` does not. See [let, try, and has](/language/let-try-has).

```bonsai
has(user.nickname) // => true
has(user.middleName) // => false
user.nickname == null && user.middleName == null // => true
```

## Blocked names

`__proto__`, `constructor`, and `prototype` are never readable. As a literal property name they are a syntax error; as a computed key they are a runtime `BLOCKED_PROPERTY` error.

```bonsai
user.__proto__ // error: SYNTAX
user["constructor"] // error: BLOCKED_PROPERTY
```

Only own properties are visible. Inherited members such as `toString` or `hasOwnProperty` are not properties of a map:

```bonsai
user.hasOwnProperty // => null
```
