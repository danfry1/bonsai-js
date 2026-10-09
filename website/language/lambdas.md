# Lambdas

Some built-in parameters are functions: the predicate of `filter`, the transform of `map`, the key of `sortBy`, and so on. The argument for such a parameter is a lambda. Lambdas exist only as arguments: they cannot be stored in a variable, put in a list, or returned.

<!-- context: { users: [{ name: "Ada", age: 36, score: 12, bonus: 5, suspended: false }, { name: "Bo", age: 15, score: 20, bonus: 30, suspended: false }, { name: "Cy", age: 51, score: 8, bonus: 2, suspended: true }], orders: [{ id: "A1", promoSku: "X", lines: [{ sku: "X" }, { sku: "Y" }] }, { id: "B2", promoSku: "Z", lines: [{ sku: "Y" }] }], groups: [{ name: "a", users: [{ active: true }, { active: false }] }, { name: "b", users: [{ active: true }] }], rows: [[1, 2], [3, 4]], xs: [5, 12, 20] } -->

## Arrow lambdas

Arrow lambdas look like JavaScript arrow functions with an expression body. Lambdas for list functions receive the item and its index.

```bonsai
users.filter(u => u.age >= 18).map(u => u.name) // => ["Ada", "Cy"]
users.map((u, i) => `${i + 1}. ${u.name}`) // => ["1. Ada", "2. Bo", "3. Cy"]
users.reduce((total, u) => total + u.score, 0) // => 40
```

## The implicit `.` lambda

`.` is shorthand for the current item. An argument that uses a free `.` becomes a one-parameter lambda, so `.age >= 18` means `u => u.age >= 18`:

```bonsai
users.filter(.age >= 18 && !.suspended).map(.name) // => ["Ada"]
users.map({ name: .name, adult: .age >= 18 }).first() // => { name: "Ada", adult: true }
users.sortBy(.age, "desc").map(.name) // => ["Cy", "Ada", "Bo"]
xs.filter(10 < .) // => [12, 20]
xs.map(. * 2) // => [10, 24, 40]
rows.map(.[0]) // => [1, 3]
```

`.` is only allowed where the lambda's first parameter is the current item. In `reduce` the first parameter is the accumulator, so `.` there is a check error; name both parameters instead:

```bonsai
xs.reduce(. + 10, 0) // error: CHECK
xs.reduce((total, x) => total + x, 0) // => 37
```

## How `.` binds

`.` binds to the **nearest enclosing argument whose parameter is a function**, skipping arguments of ordinary parameters. The binding is decided by the declared parameter types, not by syntax, which is what makes these work:

```bonsai
users.filter(.score > max(.bonus, 10)).map(.name) // => ["Ada"]
groups.map(.users.filter(.active).length) // => [1, 1]
groups.map(filter(.users, .active).length) // => [1, 1]
```

- In the first line, `max` takes ordinary numbers, so `.bonus` still belongs to the `filter` lambda: each user's score is compared with the larger of their bonus and 10.
- In the second, `.users` is the group (the `map` lambda) and `.active` is a user (the inner `filter` lambda).
- The third is the same call in prefix form.

## Naming the outer item

To use an outer item inside an inner lambda, name it with an arrow lambda. Inside the arrow lambda's body, `.` may still be used in a nested function argument:

```bonsai
orders.filter(o => o.lines.some(.sku == o.promoSku)).map(.id) // => ["A1"]
```

## Rules

- `.` directly inside an explicit lambda body is an error: use the parameter instead.
- `.` outside any function argument is an error.
- A lambda anywhere other than a function argument is a syntax error.
- A lambda whose parameter must return a boolean (as in `filter`) may return `null`, which counts as `false`. Any other non-boolean result is a type error.

```bonsai
.age // error: INVALID_LAMBDA
users.map(u => .age) // error: INVALID_LAMBDA
[x => x] // error: SYNTAX
users.filter(.nickname).length // => 0
users.filter(.age) // error: TYPE_ERROR
```

## Evaluation

Higher-order functions call their lambda sequentially, in list order, and stop as soon as the result is known: `some` stops at the first `true`, `every` and `none` at the first counterexample, `find` and `findIndex` at the first match. Each lambda call counts against the step budget.

The functions that take lambdas are `map`, `filter`, `find`, `findIndex`, `some`, `every`, `none`, `count`, `flatMap`, `reduce`, `sortBy`, and `groupBy`. Host functions do not take lambdas.
