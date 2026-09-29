# Functions and Calls

<!-- context: { user: { name: "Ada", nickname: null }, prices: [4, 9, 2], items: [{ price: 2, qty: 3 }, { price: 12, qty: 1 }] } -->

## One namespace, two call forms

There is one function namespace, and `f(x, a)` and `x.f(a)` are the same call. The method form passes the receiver as the first argument. It never runs anything stored in the value: `f` always resolves to a built-in or a host function.

```bonsai
toUpperCase(user.name) // => "ADA"
user.name.toUpperCase() // => "ADA"
sum(prices) // => 15
prices.sum() // => 15
round(3.14159, 2) // => 3.14
(3.14159).round(2) // => 3.14
```

Chaining methods reads left to right, like the pipelines of other languages:

```bonsai
items.map(.price * .qty).sum().toFixed(2) // => "18.00"
```

`length` is a property, not a function; `has` and `try` are [special forms](/language/let-try-has). The full list of built-ins is in [Built-in Functions](/functions/).

## Overloads

Built-in functions are overloaded on parameter types. `includes` works on text and on lists; `min` takes a list or several numbers; `sum` adds numbers or durations. When argument types are known, the overload is chosen by the checker; otherwise it is chosen at run time from the kinds of the arguments.

```bonsai
"hello".includes("ell") // => true
[1, 2, 3].includes(2) // => true
min(4, 9, 2) // => 2
prices.min() // => 2
[hours(1), minutes(30)].sum() // => PT1H30M
```

A call that matches no overload is an error:

```bonsai
round("a") // error: NO_OVERLOAD
```

## Spread arguments

`...list` expands a list into arguments:

```bonsai
max(...prices) // => 9
max(1, ...prices, 20) // => 20
```

A spread argument cannot be used with a function that takes a lambda.

## `null` arguments

A `null` argument selects an overload whose parameter accepts `null`. If none does, the call is a `NULL_RECEIVER` error in either call form, or `null` when the call uses `?.`:

```bonsai
user.nickname.toUpperCase() // error: NULL_RECEIVER
toUpperCase(user.nickname) // error: NULL_RECEIVER
user.nickname?.toUpperCase() // => null
(user.nickname ?? "").toUpperCase() // => ""
isEmpty(user.nickname) // => true
```

Functions such as `isEmpty`, `toString`, and `type` accept `null`, and the calendar functions accept `null` as the time zone (meaning UTC).

## Host functions

The host can add functions with typed parameters. They are called exactly like built-ins, in either form. A host function with the same name as a built-in replaces the built-in for that environment, so built-ins added in future releases never change the meaning of an existing host's expressions. See [Host Functions](/api/host-functions).

## Evaluation order

Operands, arguments, and lambda invocations are evaluated left to right, one at a time, including in async mode. Higher-order built-ins call their lambda in list order and stop as soon as the result is known (`some`, `every`, `find`, ...).
