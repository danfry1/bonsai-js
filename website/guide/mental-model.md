# Mental Model

Bonsai reads like JavaScript, so most expressions do what you expect. This page covers the ideas behind the language and the few rules that differ from JavaScript.

## An expression is text plus an environment

You store expression text (in a database, a config file, a form field) and evaluate it against a context object. The environment decides what the text may refer to: the declared variables, the built-in functions, and your host functions. There is nothing else in scope: no globals, no `Math`, no `Date`, no `window`.

<!-- context: { order: { total: 129, country: "GB" }, threshold: 100 } -->
```bonsai
order.total >= threshold && order.country in ["GB", "IE"] // => true
```

## One kind of absent value: `null`

A missing property, a missing variable, and a host `undefined` all read as `null`. There is no `undefined` in the language, so `x == null` means "missing or null".

<!-- context: { user: { name: "Ada", middleName: null } } -->
```bonsai
user.middleName == null // => true
user.nickname == null // => true
user.address.city // => null
user.nickname ?? user.name // => "Ada"
```

Reading a property of `null` gives `null` rather than an error, so `?.` is only needed for calls: `user.nickname?.toUpperCase()`.

## Values compare by value, with no coercion

`==` compares lists and maps deeply and never converts between types. Operators that would silently coerce in JavaScript are errors instead.

<!-- context: {} -->
```bonsai
[1, [2, 3]] == [1, [2, 3]] // => true
{ a: 1, b: 2 } == { b: 2, a: 1 } // => true
1 == "1" // => false
"total: " + 5 // error: TYPE_ERROR
`total: ${5}` // => "total: 5"
```

## Booleans are booleans

`&&`, `||`, `!`, and the test of `?:` take booleans. `null` counts as `false`; anything else (a number, a string, a list) is an error rather than being "truthy". Use `??` for defaults and explicit comparisons for tests.

<!-- context: { count: 0, name: "", flag: null } -->
```bonsai
count > 0 || name != "" // => false
!flag // => true
count && true // error: TYPE_ERROR
```

## Comparisons with `null` are false

`<`, `<=`, `>`, `>=` return `false` when either side is `null`, so a filter skips items that lack the field instead of failing:

<!-- context: { users: [{ name: "Ada", age: 36 }, { name: "Bo" }, { name: "Cy", age: 12 }] } -->
```bonsai
users.filter(.age >= 18).map(.name) // => ["Ada"]
```

## Arithmetic never produces `NaN` or `Infinity`

Division by zero and any other non-finite result are errors. `try(expr, fallback)` recovers from evaluation errors when you want a default.

<!-- context: { visits: 10, days: 0 } -->
```bonsai
visits / days // error: DIVISION_BY_ZERO
try(visits / days, 0) // => 0
```

## Every function is also a method

There is one function namespace. `f(x, a)` and `x.f(a)` are the same call, and the name always resolves to a built-in or a host function, never to something stored in the data. That is why methods chain on any value the function accepts:

<!-- context: { items: [{ price: 2, qty: 3 }, { price: 12, qty: 1 }] } -->
```bonsai
sum(map(items, .price * .qty)) // => 18
items.map(.price * .qty).sum() // => 18
```

## `.` is the current item

Inside an argument that the function treats as a lambda (`filter`, `map`, `sortBy`, ...), a leading `.` refers to the current item. When items nest, name the outer item with an arrow lambda. See [Lambdas](/language/lambdas).

## Expressions always terminate

There are no loops, recursion, or assignment. Work proportional to data is counted against a step budget, and produced strings and lists are size-limited, so a hostile expression cannot hang your process. See [Safety](/guide/safety) and [Limits](/api/limits).

## Check first, then run

Declare your data with `t` and the checker reports typos, type errors, and possible nulls before an expression runs. Without declarations everything is typed `any` and checked at run time instead, so you can adopt types gradually. See [Static Checking](/language/checking).
