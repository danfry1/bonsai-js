# The Bonsai Expression Language (v1)

This is the normative reference for the Bonsai language. The executable
conformance corpus in `tests/conformance.test.ts` is the tie-breaker: when this text
and a conformance case disagree, one of them is a bug.

Bonsai is a small, total expression language for evaluating untrusted
expression text against host data. Every expression terminates: there are no
loops, no recursion, and no assignment. An expression reaches host code only
through functions the host declared, and through host data the host chose to
put in the context (see §10).

## 1. Lexical structure

- Whitespace (space, tab, CR, LF) separates tokens.
- Comments: `// to end of line` and `/* block */` (no nesting).
- Identifiers: `[A-Za-z_$][A-Za-z0-9_$]*`.
- Reserved words: `true false null let in not`. After `.` any identifier or
  reserved word is a property name (`obj.in`).
- Numbers: `42`, `3.14`, `1e-3`, `1_000`, `0xff`, `0b101`, `0o17`. A number
  starts with a digit (`.5` is not a number). `_` only between digits.
- Strings: `"..."` or `'...'`; escapes `\n \t \r \0 \\ \' \" \` \$ \xHH \uHHHH \u{H...}`.
- Templates: `` `text ${expr} text` ``.
- `|>` is reserved for a future release and is currently a syntax error.

## 2. Values

| Kind | Notes |
|---|---|
| `null` | The single absent value. A missing property, a missing variable, and a host `undefined` all read as `null`. |
| boolean | `true`, `false` |
| number | IEEE-754 double. Operations that would produce `NaN` or `±Infinity` are errors. Host values that are already non-finite can be read and compared. |
| string | UTF-16 text. `length` and indices count UTF-16 code units. |
| list | A host array or a produced list. Lists are never mutated. |
| map | Any other host object, read through its **own** properties; object literals. |
| timestamp | A valid host `Date`, or one produced by `timestamp()`/`now()`. An invalid `Date` is an error when used. |
| duration | A span of time, produced by `days(3)`, `hours(1)`, `t1 - t2`, ... |

Functions, symbols, bigints, and other exotic host values are **opaque**: they
can be compared with `==` (by identity or primitive equality) and passed to
host functions, but reading a property of one is an error.

## 3. Operators

From loosest to tightest:

| Level | Operators | Notes |
|---|---|---|
| 1 | `let x = e; body` | prefix form |
| 2 | `c ? a : b` | right-associative |
| 3 | `??` | |
| 4 | `\|\|` | |
| 5 | `&&` | |
| 6 | `==` `!=` | does not chain |
| 7 | `<` `<=` `>` `>=` `in` `not in` | does not chain |
| 8 | `+` `-` | |
| 9 | `*` `/` `%` | |
| 10 | `**` | right-associative |
| 11 | `!` `-` (prefix) | |
| 12 | `.` `?.` `[]` `?.[]` calls | |

Parse errors instead of silent groupings: `??` mixed with `&&`/`||` without
parentheses; a prefix operator directly left of `**` (`-x ** 2`); chained
comparisons (`a < b < c`, `a == b == c`).

### Equality

`==`/`!=` compare by value:

- primitives by strict equality (`1 == "1"` is `false`, `0 == -0` is `true`,
  host `NaN` is not equal to itself);
- lists element-wise; maps by the same set of own enumerable keys with equal
  values, in any order;
- timestamps by instant; durations by length;
- values of different kinds are unequal (never an error).

Absence is `null`, so `user.middleName == null` holds whether the key is missing
or explicitly `null`.

### Ordering

`<`, `<=`, `>`, `>=` accept two numbers, two strings (code-unit order), two
timestamps, or two durations. **If either side is `null` the result is
`false`**, so `users.filter(.age >= 18)` skips users without an `age` instead of
failing. Any other mix of kinds is a type error.

### Arithmetic

| Expression | Operands | Result |
|---|---|---|
| `a + b` | numbers / strings / lists / durations | sum or concatenation |
| `t + d`, `d + t`, `t - d` | timestamp and duration | timestamp |
| `t1 - t2` | timestamps | duration |
| `d1 - d2` | durations | duration |
| `d * n`, `n * d`, `d / n` | duration and number | duration |
| `d1 / d2` | durations | number |
| `- * / % **` | numbers | number |

No other combination is valid: `null + 1`, `"a" + 1`, and `t + 30` are type
errors (use `??`, a template, and `days(30)` respectively). Division or
remainder by zero, and any non-finite result, are errors.

### Logic

`!`, `&&`, `||`, and a ternary test accept booleans and `null` (read as
`false`); anything else is a type error. `&&` and `||` short-circuit left to
right and produce a boolean. `a ?? b` evaluates `b` only when `a` is `null`.

### Membership

`x in list`: `==` against each element. `s in str`: substring test (both
strings). `k in map`: own-key test (`k` a string, or a number converted to its decimal text). `x in null` is `false`.
`x not in y` is `!(x in y)`.

## 4. Names, members, and indexing

- A variable reads the host context. An undeclared variable is a check error
  in a strict environment; otherwise it reads the context, `null` when absent.
- `a.b` reads the own property `b` of a map. Reading a property of `null` is
  `null`. Strings and lists have exactly one property, `length`; any other
  property read on a string, number, boolean, list, timestamp, duration, or
  opaque value is a type error.
- `a[k]`: string keys on maps (a number key is converted to its decimal text, so `counts[id]` works for numeric ids); integer indices on lists and strings (a position
  that does not exist, including negative and fractional ones, is `null`; use `at(-1)` or `last()`); a `null`
  receiver or a `null` key gives `null`; anything else is a type error.
- `?.` is accepted and equals `.` for reads. For calls it short-circuits that
  one call: `a.trim()` with `a == null` is an error, `a?.trim()` is `null`. It
  does not skip the rest of the chain, so write `a?.trim()?.toUpperCase()`.
- Calling a function with `null` as its first argument, when no overload
  accepts `null` there, is a `NULL_RECEIVER` error in either call form.
- `__proto__`, `constructor`, and `prototype` are never readable, never valid
  literal keys, and produced maps never contain them.
- `has(a.b)` is `true` when `a` is a map with own property `b` (even if its
  value is `null`). `has(a[k])` likewise; for lists it tests the index.

## 5. Functions and calls

There is one function namespace. `f(x, a)` and `x.f(a)` are the same call:
calling a "method" never runs anything stored in the value; `f` always resolves
in the function namespace.

- Built-in functions are overloaded on parameter types. The overload is chosen
  statically when argument types are known and by the runtime kinds of the
  arguments otherwise. A `null` argument selects an overload whose parameter
  accepts `null`; if none does, it is a type error (or `null`, for a `?.` call).
- Host functions are declared on the environment with typed parameters. A host
  function with the same name as a built-in replaces the built-in for that
  environment, so adding built-ins in a minor release never changes an existing
  host's expressions.
- Variables and functions are separate namespaces; call syntax decides.

Passing `null` for an optional parameter uses its default.

`try(expr, fallback)` evaluates `expr` and, if it fails with an evaluation
error (type error, invalid argument, host function failure), evaluates
`fallback` instead. Limit errors (steps, size, timeout, cancellation) are never
caught.

## 6. Lambdas

Some parameters are declared as functions (`map`, `filter`, `sortBy`, ...).
The argument for such a parameter is a lambda:

```
users.filter(u => u.age >= 18)
orders.map((o, i) => `${i}: ${o.id}`)
```

**The implicit parameter `.`** is shorthand for the current item. The argument
for a function parameter that uses a free `.` becomes a one-parameter lambda.
`.` binds to the **nearest enclosing argument whose parameter is a function**,
skipping arguments of ordinary parameters:

```
users.filter(.age >= 18 && !.suspended)
users.filter(.score > max(.bonus, 10))        // .bonus is the user's
users.map({ name: .name, adult: .age >= 18 })
groups.map(.users.filter(.active).length)     // .users: group, .active: user
groups.map(filter(.users, .active))           // same meaning, prefix form
xs.filter(10 < .)
rows.map(.[0])
```

`.` directly inside an explicit lambda body is an error (name the parameter
instead), and `.` with no enclosing function parameter is an error. To use an
outer item from an inner lambda, name it:
`orders.filter(o => o.lines.some(.sku == o.promoSku))`.

Lambdas are only valid as arguments for function parameters. A spread argument
cannot be used in a call to a function that takes a function parameter.

Higher-order functions invoke lambdas sequentially, in list order, and stop as
soon as the result is known (`some`, `every`, `find`, ...).

## 7. Let bindings

```
let total = order.items.map(.price * .qty).sum();
total > 100 ? total * 0.9 : total
```

A binding is visible in its body. A binding or lambda parameter may shadow a
context variable but not another binding or parameter.

## 8. Literals

- Lists: `[1, 2, ...rest]`; spread takes a list (or `null`, which adds nothing).
- Maps: `{ a: 1, "b-c": 2, [key]: 3, ...other, name }` (`name` alone means
  `name: name`). A map literal has a closed static type, so reading a key it
  does not define (`{a: 1}.b`) is a check error rather than `null`. Computed keys must be strings or numbers (numbers become their
  decimal text). Spread takes a map (or `null`, which adds nothing). A duplicate
  static key is a syntax error; later computed/spread keys win.
- Produced maps are ordinary objects with the keys in insertion order; blocked
  keys are never present.
- Templates render `null` as empty text, numbers in shortest round-trip form,
  timestamps as ISO-8601, durations as ISO-8601 (`PT1H30M`). Lists and maps are
  a type error.

## 9. Time

Timestamps are instants. Durations are exact lengths (a day is 24 hours).
Calendar operations take an optional IANA time zone and default to UTC:
`addMonths(t, 1, "Europe/Berlin")`, `startOfDay(t, tz)`, `year(t, tz)`, ...
`now()` is read once per evaluation from the environment clock.

## 10. Guarantees and trust boundary

- Evaluation terminates. Every operation that does work proportional to data
  (equality, membership, concatenation, spread, templates, built-ins, lambda
  calls) charges steps against `maxSteps`, and nesting is bounded by
  `maxDepth`, including when comparing cyclic host data.
- Produced strings and lists are checked against `maxStringLength` and
  `maxListLength` before they are allocated.
- Built-ins never mutate inputs and never call functions found in data.
- Asynchronous host functions must be declared `async`. `evaluateSync` rejects
  an expression that calls one at check time, before any host code runs.
- Property reads use the host object's own properties. A getter or Proxy the
  host put in the context is host code and runs when read; the language cannot
  create one.
- Evaluation within one run is sequential: operands, arguments, and lambda
  invocations run left to right, one at a time, including in async mode.

## 11. Static checking

Checking is gradual. A value whose type is unknown (an undeclared variable in a
non-strict environment, or data read from an open record) has type `any`, which
is compatible with everything and is checked at runtime instead.

- Errors: unknown variables (strict environments), unknown properties of closed
  records, unknown functions, calls that match no overload, operators applied to
  incompatible types, a nullable value used where `null` is not accepted (for
  example a method call without `?.`), lambdas in non-function positions, `.`
  with no enclosing function parameter, and a result that does not match the
  expected type.
- Warnings (codes `ALWAYS_FALSE`, `NEVER_NULL`, `MAYBE_NULL`): comparisons or
  memberships that can never hold (`plan == "premium"` when `plan` is
  `"free" | "pro"`), `??` on a value that is never null, ordering comparisons on
  a value that may be null (they are false when it is), and lambda results that
  may be `null` where a boolean is expected.
- Declared types describe data; they are not access control. Computed keys and
  `keys()`/`values()`/`entries()` read every own property the host passes in.

When several overloads could match because an argument is `any`, the call's
result is `any` unless every candidate agrees; the runtime then dispatches on
the argument's actual kind.
