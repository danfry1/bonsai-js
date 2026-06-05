# Lambda Predicates

Lambdas are Bonsai's shorthand for "do this to each item" inside array transforms like `map`, `filter`, `find`, `some`, and `every`.

| Shorthand | Meaning | Typical use |
|---|---|---|
| `.id` | Read the current item's `id` | `orders \|> map(.id)` |
| `.price < 100` | Test the current item's property | `products \|> filter(.price < 100)` |
| `. > 2` | Compare the current item itself | `[1,2,3,4].filter(. > 2)` |
| `.email.endsWith("@acme.com")` | Use member access and safe method calls on the current item | `users \|> some(.email.endsWith("@acme.com"))` |

## Property extraction

A dot prefix like `.name` means "read this property from each item". You do not declare a parameter name; the current array item is implied.

| Expression | Result | Context |
|---|---|---|
| `orders \|> map(.id)` | `["INV-1001", "INV-1002"]` | `{ orders: [{ id: "INV-1001" }, { id: "INV-1002" }] }` |
| `stores \|> map(.address.city)` | `["London", "Paris"]` | `{ stores: [{ address: { city: "London" } }, { address: { city: "Paris" } }] }` |

## Predicate filtering

Add a condition after the accessor when you want a boolean test for each item.

| Expression | Result | Context |
|---|---|---|
| `products \|> filter(.price < 100)` | `[{ name: "Keyboard", price: 89 }]` | `{ products: [{ name: "Keyboard", price: 89 }, { name: "Monitor", price: 249 }] }` |
| `members \|> filter(.active && .verified)` | `[{ name: "Alicia", active: true, verified: true }]` | `{ members: [{ name: "Alicia", active: true, verified: true }, { name: "Ben", active: true, verified: false }] }` |

### More array transforms: find, some, every

| Expression | Result | Note |
|---|---|---|
| `orders \|> find(.status == "failed")` | `{ id: "INV-1002", status: "failed" }` | first match |
| `orders \|> some(.overdue)` | `true` | at least one match |
| `deployments \|> every(.successful)` | `false` | not all match |

## Compound lambdas

Lambdas support nested property access, logic operators, and the same safe method-call surface available elsewhere in the language.

| Expression | Result | Context |
|---|---|---|
| `users \|> filter(.email.endsWith("@acme.com"))` | `[{ email: "alice@acme.com" }]` | `{ users: [{ email: "alice@acme.com" }, { email: "ben@example.com" }] }` |

## Bare dot identity

Use a bare `.` followed by an operator to refer to the current item itself -- useful for arrays of primitives.

| Expression | Result |
|---|---|
| `[1, 2, 3, 4].filter(. > 2)` | `[3, 4]` |
| `[1, 2, 3].map(. * 10)` | `[10, 20, 30]` |

## JS-style method chaining

Array methods `filter`, `map`, `find`, `some`, and `every` work as native method calls with lambda arguments -- no stdlib import required.

| Expression | Result | Context |
|---|---|---|
| `users.filter(.age >= 18).map(.name)` | `["Alice"]` | `{ users: [{ name: "Alice", age: 25 }, { name: "Bob", age: 15 }] }` |
| `[1, 2, 3].some(. > 2)` | `true` | |
| `[1, 2, 3].find(. > 1)` | `2` | |

**Pipes vs methods:** Both `users |> filter(.age >= 18) |> map(.name)` and `users.filter(.age >= 18).map(.name)` produce the same result. Use whichever reads better for your use case. Method chaining is built in; pipe transforms require the stdlib `arrays` plugin but offer additional transforms like `count`, `unique`, `sort`, and `flatten`.

## Built-in safe methods

These methods work via native `.method()` syntax without any imports. Mutating methods (`reverse`, `sort`, `push`, `pop`, `splice`, etc.) are blocked to prevent context mutation.

### String methods

| Method | Example |
|---|---|
| `trim`, `trimStart`, `trimEnd` | `"  hi  ".trim()` -> `"hi"` |
| `toLowerCase`, `toUpperCase` | `"Hello".toLowerCase()` -> `"hello"` |
| `startsWith`, `endsWith` | `"hello".startsWith("hel")` -> `true` |
| `includes`, `indexOf`, `lastIndexOf` | `"hello".includes("ell")` -> `true` |
| `slice`, `substring`, `at` | `"hello".slice(1, 3)` -> `"el"` |
| `replace`, `replaceAll` | `"abc".replace("a", "x")` -> `"xbc"` |
| `split` | `"a,b,c".split(",")` -> `["a", "b", "c"]` |
| `padStart`, `padEnd` | `"5".padStart(3, "0")` -> `"005"` |
| `charAt`, `charCodeAt`, `repeat`, `concat` | `"ab".repeat(2)` -> `"abab"` |

### Array methods (with lambda support)

| Method | Example |
|---|---|
| `filter` | `[1,2,3].filter(. > 1)` -> `[2, 3]` |
| `map` | `[1,2,3].map(. * 10)` -> `[10, 20, 30]` |
| `find`, `findIndex` | `[1,2,3].find(. > 1)` -> `2` |
| `some`, `every` | `[1,2,3].some(. > 2)` -> `true` |
| `flatMap` | `[1,2,3].flatMap(. * 2)` -> `[2, 4, 6]` |

### Array methods (non-callback)

| Method | Example |
|---|---|
| `join` | `[1,2,3].join(", ")` -> `"1, 2, 3"` |
| `includes`, `indexOf`, `lastIndexOf` | `[1,2,3].includes(2)` -> `true` |
| `slice`, `at`, `concat`, `flat` | `[1,2,3].concat([4])` -> `[1, 2, 3, 4]` |
| `toReversed`, `toSorted`, `toSpliced`, `with` | `[3,1,2].toSorted()` -> `[1, 2, 3]` |

### Number methods

| Method | Example |
|---|---|
| `toFixed` | `(3.14159).toFixed(2)` -> `"3.14"` |
| `toString` | `(42).toString()` -> `"42"` |

**Pipe-only transforms** (require stdlib import): `count`, `first`, `last`, `reverse`, `flatten`, `unique`, `sort`, `upper`, `lower`, `sum`, `avg`, `clamp`, and more. See the [Standard Library](/stdlib/all) section for the full list.
