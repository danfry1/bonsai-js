# Operators

<!-- context: { user: { age: 36, country: "GB", roles: ["admin"], plan: "pro", verified: true }, price: 20, qty: 3, discount: null, stock: null } -->

## Precedence

From loosest to tightest:

| Level | Operators | Notes |
| --- | --- | --- |
| 1 | `let x = e; body` | prefix form, see [let](/language/let-try-has) |
| 2 | `c ? a : b` | right-associative |
| 3 | `??` | other binary operands need parentheses |
| 4 | `\|\|` | |
| 5 | `&&` | |
| 6 | `==` `!=` | does not chain |
| 7 | `<` `<=` `>` `>=` `in` `not in` | does not chain |
| 8 | `+` `-` | |
| 9 | `*` `/` `%` | |
| 10 | `**` | right-associative |
| 11 | `!` `-` (prefix) | |
| 12 | `.` `?.` `[]` `?.[]` calls | |

Some combinations that JavaScript accepts are syntax errors in Bonsai, because their grouping is easy to misread. Add parentheses instead.

```bonsai
1 + 2 * 3 // => 7
2 ** 3 ** 2 // => 512
-2 ** 2 // error: SYNTAX
(-2) ** 2 // => 4
1 < 2 < 3 // error: SYNTAX
(1 < 2) && (2 < 3) // => true
discount ?? 0 || true // error: SYNTAX
(discount ?? false) || true // => true
discount ?? 0 > 10 // error: SYNTAX
(discount ?? 0) > 10 // => false
discount ?? 0 + 5 // error: SYNTAX
(discount ?? 0) + 5 // => 5
```

`??` binds more loosely than every other binary operator, so `discount ?? 0 > 10` would mean `discount ?? (0 > 10)`. An operand of `??` that is itself a binary operation (other than another `??`) must be parenthesized, which makes the intended grouping explicit either way.

## Equality

`==` and `!=` compare by value and never error:

- primitives by strict equality: `1 == "1"` is `false`, and `0 == -0` is `true`;
- lists element by element, maps by the same set of own keys with equal values in any order;
- timestamps by instant, durations by length;
- values of different kinds are unequal.

```bonsai
1 == "1" // => false
[1, [2, 3]] == [1, [2, 3]] // => true
{ a: 1, b: 2 } == { b: 2, a: 1 } // => true
[1, 2] != [2, 1] // => true
days(1) == hours(24) // => true
user.nickname == null // => true
```

Absence is `null`, so `x == null` holds whether a key is missing or explicitly `null`. A `NaN` value from the host is not equal to itself.

## Ordering

`<`, `<=`, `>`, `>=` accept two numbers, two strings (compared by UTF-16 code unit, like JavaScript), two timestamps, or two durations. If either side is `null` the result is `false`. Any other mix of kinds is a type error. A non-finite number from the host compares as in JavaScript (`Infinity > 1` is `true`, and every comparison with `NaN` is `false`), while sorting it, or taking `min` or `max`, is a `NON_FINITE` error.

```bonsai
user.age >= 18 // => true
"apple" < "banana" // => true
"B" < "a" // => true
days(1) > hours(23) // => true
stock > 0 // => false
stock <= 0 // => false
1 < "2" // error: TYPE_ERROR
```

Because comparisons with `null` are `false`, `users.filter(.age >= 18)` skips users without an age instead of failing.

## Arithmetic

| Expression | Operands | Result |
| --- | --- | --- |
| `a + b` | numbers, strings, lists, or durations | sum or concatenation |
| `t + d`, `d + t`, `t - d` | timestamp and duration | timestamp |
| `t1 - t2` | timestamps | duration |
| `d1 - d2` | durations | duration |
| `d * n`, `n * d`, `d / n` | duration and number | duration |
| `d1 / d2` | durations | number |
| `-` `*` `/` `%` `**` | numbers | number |
| `-x` | number or duration | negation |

```bonsai
price * qty // => 60
7 / 2 // => 3.5
-7 % 3 // => -1
"con" + "cat" // => "concat"
[1] + [2, 3] // => [1, 2, 3]
days(1) + hours(12) // => P1DT12H
```

No other combination is valid. There is no implicit conversion. When the checker knows the operand types, a bad combination is a check error (`TYPE_ERROR`) before evaluation; when a value is untyped, it is a runtime `TYPE_ERROR`. Here `price` and `discount` come from an undeclared context, so the errors happen at run time:

```bonsai
"total: " + price // error: TYPE_ERROR
`total: ${price}` // => "total: 20"
price + discount // error: TYPE_ERROR
price * (1 - (discount ?? 0)) // => 20
now() + 30 // error: TYPE_ERROR
```

Division or remainder by zero, and any result that is not a finite number, are errors:

```bonsai
1 / 0 // error: DIVISION_BY_ZERO
10 ** 400 // error: NON_FINITE
```

## Logic

`!`, `&&`, `||`, and the test of `?:` accept booleans and `null` (read as `false`). Anything else is a type error: there is no truthiness. `&&` and `||` short-circuit left to right and always produce a boolean.

```bonsai
user.verified && user.age >= 18 // => true
!user.suspended // => true
user.plan == "pro" ? "Pro" : "Free" // => "Pro"
qty && true // error: TYPE_ERROR
```

`a ?? b` evaluates `b` only when `a` is `null`:

```bonsai
discount ?? 0 // => 0
false ?? true // => false
```

## Membership

| Form | Meaning |
| --- | --- |
| `x in list` | `x == item` for some item |
| `s in str` | substring test (both strings) |
| `k in map` | own-key test (`k` a string, or a number converted to its decimal text); a key holding a host `undefined` is absent |
| `x in null` | `false` |
| `x not in y` | `!(x in y)` |

```bonsai
user.country in ["GB", "IE"] // => true
"adm" in "admin" // => true
"plan" in user // => true
{ id: 1 } in [{ id: 1 }] // => true
"x" in null // => false
"guest" not in user.roles // => true
```
