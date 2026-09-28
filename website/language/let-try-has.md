# let, try, and has

<!-- context: { order: { items: [{ price: 20, qty: 3 }, { price: 45, qty: 1 }] }, user: { name: "Ada", email: null, prefs: { theme: "dark" } }, stats: { visits: 120, days: 0 }, input: "12.5", tags: ["a", "b"] } -->

## let

`let name = value; body` binds a name for the rest of the expression. Use it to name an intermediate result instead of computing it twice.

```bonsai
let total = order.items.map(.price * .qty).sum();
total > 100 ? total * 0.9 : total // => 94.5
```

Bindings can build on earlier ones:

```bonsai
let subtotal = order.items.map(.price * .qty).sum();
let shipping = subtotal >= 100 ? 0 : 4.99;
subtotal + shipping // => 105
```

A binding is visible in its body only. A binding or lambda parameter may shadow a context variable, but not another binding or parameter in scope:

```bonsai
let user = "shadowed"; user // => "shadowed"
let a = 1; let a = 2; a // error: SYNTAX
```

`let` is the loosest construct, so its body extends as far right as possible. Inside an argument, the body ends at the argument:

```bonsai
order.items.map(let line = .price * .qty; line > 50 ? "large" : "small") // => ["large", "small"]
```

## try

`try(expr, fallback)` evaluates `expr` and, if it fails with an evaluation error, evaluates `fallback` instead. Evaluation errors are type errors, invalid arguments, division by zero, non-finite results, null receivers, and host functions that throw (`HOST_ERROR`).

```bonsai
try(stats.visits / stats.days, 0) // => 0
try(input.toNumber(), 0) // => 12.5
try("abc".toNumber(), 0) // => 0
try(timestamp("not a date"), now()) // => 2026-01-15T10:30:00.000Z
```

`try` does not catch:

- **syntax and check errors**, which are reported before evaluation starts;
- **limit errors** (step budget, string and list sizes, timeout, cancellation), so a hostile expression cannot use `try` to keep running past its budget;
- **`HOST_CONTRACT` errors**, raised when a host function returns a value that does not match its declared type or returns a promise without `async: true`. They are bugs in host code, so they surface instead of being hidden by a fallback.

```bonsai
try(1 + "a", 0) // error: TYPE_ERROR
```

<!-- env: { limits: { maxSteps: 500 } } -->
<!-- context: { big: Array.from({ length: 1000 }, (_, i) => i) } -->

With `maxSteps` set to 500:

```bonsai
try(big.map(. * 2).sum(), 0) // error: STEP_LIMIT
```

<!-- env: {} -->
<!-- context: { order: { items: [{ price: 20, qty: 3 }, { price: 45, qty: 1 }] }, user: { name: "Ada", email: null, prefs: { theme: "dark" } }, stats: { visits: 120, days: 0 }, input: "12.5", tags: ["a", "b"] } -->

Prefer `??` when the only problem is a missing value: `try` is for operations that can fail on present values.

## has

`has(a.b)` is `true` when `a` is a map with an own property `b`, even when its value is `null`. It never reads the value. `has(a[k])` works the same way with a computed key; for a list it tests whether the index exists.

```bonsai
has(user.email) // => true
user.email == null // => true
has(user.phone) // => false
has(user.prefs["theme"]) // => true
has(user.address.city) // => false
has(tags[1]) // => true
has(tags[2]) // => false
```

`has` takes a property path; anything else is a syntax error:

```bonsai
has(user) // error: SYNTAX
```

Use `has` when "explicitly set to null" and "not set" mean different things, for example a user preference that can be cleared. Otherwise `x == null` or `x ?? default` is simpler.
