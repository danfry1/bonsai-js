# Literals and Comments

<!-- context: { user: { name: "Ada", tags: ["admin", "beta"], address: { city: "London" } }, extra: null } -->

## Numbers

Numbers are IEEE-754 doubles, written as in JavaScript. `_` may separate digits, and hexadecimal, binary, and octal prefixes are supported. A number must start with a digit: write `0.5`, not `.5` (a leading `.` is the [current item](/language/lambdas)).

```bonsai
42 // => 42
3.14 // => 3.14
1e-3 // => 0.001
1_000_000 // => 1000000
0xff // => 255
0b101 // => 5
0o17 // => 15
.5 // error: SYNTAX
```

Doubles are binary floating point, so most decimal fractions are approximate, as in JavaScript. For money, keep amounts in integer cents (or the currency's smallest unit) and round only to display; `round(x, 2)` and `formatCurrency` round the value as written.

```bonsai
0.1 + 0.2 // => 0.30000000000000004
(10 + 20) / 100 // => 0.3
round(0.1 + 0.2, 2) // => 0.3
```

## Strings

Strings use double or single quotes. Escapes are `\n \t \r \0 \\ \' \" \` \$`, `\xHH`, `\uHHHH`, and `\u{H...}`.

```bonsai
"it's" // => "it's"
'say "hi"' // => "say \"hi\""
"tab\there" // => "tab\there"
"\x41B\u{43}" // => "ABC"
"😀".length // => 2
```

`length` counts UTF-16 code units, so an emoji outside the Basic Multilingual Plane has length 2, as in JavaScript. For interpolation, use a [template](/language/templates).

## Booleans and null

`true`, `false`, and `null`. There is no `undefined`: absent values are `null`.

## Lists

```bonsai
[1, 2, 3] // => [1, 2, 3]
[1, "two", [3]] // => [1, "two", [3]]
[1, ...[2, 3], 4] // => [1, 2, 3, 4]
[...user.tags, "new"] // => ["admin", "beta", "new"]
[1, ...extra] // => [1]
[1, 2,] // => [1, 2]
```

Spread takes a list, or `null`, which adds nothing. Spreading anything else is an error.

## Maps

Map literals use JavaScript object syntax: identifier or string keys, computed keys in brackets, shorthand properties, and spread.

```bonsai
{ a: 1, "b-c": 2 } // => { a: 1, "b-c": 2 }
{ ["key" + "1"]: true } // => { key1: true }
{ [42]: "answer" } // => { "42": "answer" }
let name = "Ada"; { name, admin: true } // => { name: "Ada", admin: true }
{ ...user.address, zip: "N1" } // => { city: "London", zip: "N1" }
{ a: 1, ...{ a: 2 } } // => { a: 2 }
```

- Computed keys must be strings or numbers; numbers become their decimal text.
- Spread takes a map, or `null`, which adds nothing.
- A duplicate static key is a syntax error. With computed keys and spread, later keys win.
- `__proto__`, `constructor`, and `prototype` are never valid keys, and maps an expression produces never contain them, even when spread from host data.
- Reserved words are valid keys and property names: `{ in: 1 }.in` is `1`.
- Keys keep JavaScript property order: integer-like keys (`"1"`, `"42"`) first in ascending order, then the other keys in the order they were added. `keys()`, `values()`, and `entries()` follow this order.

```bonsai
{ a: 1, a: 2 } // error: SYNTAX
{ [true]: 1 } // error: TYPE_ERROR
{ __proto__: 1 } // error: SYNTAX
{ in: 1 }.in // => 1
```

```bonsai
keys({ b: 1, "2": 2, "1": 3 }) // => ["1", "2", "b"]
```

A map literal has a closed static type, so reading a key it does not define is a check error rather than `null`:

```bonsai
{ a: 1 }.b // error: UNKNOWN_PROPERTY
```

## Comments

Line comments run to the end of the line; block comments do not nest.

```bonsai
1 + /* inline */ 2 // => 3
// a comment on its own line
let rate = 0.2; // tax
100 * (1 + rate) // => 120
```

## Reserved words

`true`, `false`, `null`, `let`, `in`, and `not` are reserved. `has` and `try` are special forms that look like calls. The token `|>` is reserved for a future release and is currently a syntax error.
