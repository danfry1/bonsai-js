# Overview and Values

Bonsai is a small, total expression language: every expression terminates, and there are no loops, recursion, or assignment. An expression reaches host code only through functions the host declared and through data the host put in the context.

These pages describe the language. The normative reference is [docs/language.md](https://github.com/danfry1/bonsai-js/blob/main/docs/language.md), backed by an executable conformance suite.

## The language in one screen

<!-- context: { user: { name: "Ada", firstName: "Ada", age: 36, country: "GB", address: { city: "London" }, email: null, createdAt: new Date("2025-06-01T00:00:00Z") }, cart: { items: [{ name: "Pen", price: 2, qty: 3 }, { name: "Bag", price: 30, qty: 1 }] }, orders: [{ lines: [{ sku: "A" }], promo: "A" }], stats: { visits: 10, days: 0 }, order: { placedAt: new Date("2026-01-15T10:30:00Z") } } -->
```bonsai
user.age >= 18 && user.country in ["GB", "IE"]              // => true
user.nickname ?? user.firstName                             // => "Ada"
user.address?.city                                          // => "London"
`Hello ${user.name}, you have ${cart.items.length} items`   // => "Hello Ada, you have 2 items"
cart.items.filter(.price > 10).map(.name)                   // => ["Bag"]
cart.items.map(.price * .qty).sum()                         // => 36
orders.filter(o => o.lines.some(.sku == o.promo)).length    // => 1
let total = cart.items.map(.price).sum(); total > 30 ? total * 0.9 : total // => 28.8
has(user.email)                                             // => true
try(stats.visits / stats.days, 0)                           // => 0
now() - user.createdAt > days(30)                           // => true
startOfDay(order.placedAt, "Europe/Berlin")                 // => 2026-01-14T23:00:00.000Z
// comments work too
1 + 1                                                       // => 2
```

The examples on these pages run with the clock fixed at `2026-01-15T10:30:00Z`.

## Values

| Kind | Examples | Notes |
| --- | --- | --- |
| `null` | `null` | The single absent value. A missing property, a missing variable, and a host `undefined` all read as `null`; a map key holding `undefined` counts as absent (`==`, `keys`, `has`, `in`). |
| boolean | `true`, `false` | |
| number | `42`, `3.14`, `1e-3`, `0xff` | IEEE-754 doubles. Operations that would produce `NaN` or `Infinity` are errors. |
| string | `"text"`, `'text'` | UTF-16 text. `length` and positions count code units, as in JavaScript. |
| list | `[1, 2, 3]` | A host array or a list an expression produced. Lists are never mutated. |
| map | `{ a: 1 }` | A plain object or class instance, read through its own properties, and object literals. |
| timestamp | `now()`, `timestamp("2026-01-01")` | A host `Date`, or one produced by `timestamp()` or `now()`. An invalid `Date` is an error when used. |
| duration | `days(3)`, `hours(1)` | A span of time. Also the result of subtracting two timestamps. |

Functions, symbols, bigints, and built-in host objects such as `Map`, `Set`, `RegExp`, promises, typed arrays, and errors are **opaque**: they can be compared with `==` and passed to host functions, but reading a property of one is an error. Plain objects and class instances are maps: an expression sees only their own properties, never members inherited from a prototype such as class methods.

`type(x)` returns the kind of any value as a string:

<!-- context: { when: new Date("2026-01-01T00:00:00Z") } -->
```bonsai
[type(null), type(true), type(1), type("a"), type([]), type({}), type(when), type(days(1))] // => ["null", "boolean", "number", "string", "list", "map", "timestamp", "duration"]
```

## Pages

- [Literals and Comments](/language/literals): numbers, strings, lists, maps, spread, comments.
- [Operators](/language/operators): precedence, equality, ordering, arithmetic, logic, membership.
- [Property Access](/language/property-access): `.`, `?.`, indexing, blocked names.
- [Functions and Calls](/language/functions): the single function namespace, overloads, `null` arguments.
- [Lambdas](/language/lambdas): implicit `.` lambdas and arrow lambdas.
- [let, try, and has](/language/let-try-has): bindings, error recovery, presence tests.
- [Templates](/language/templates): template literals and how values render.
- [Time](/language/time): timestamps, durations, calendars, and time zones.
- [Static Checking](/language/checking): types, errors, and warnings before evaluation.
