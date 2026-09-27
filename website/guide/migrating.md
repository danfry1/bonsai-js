# Migrating from 0.x

Bonsai 1.0 is a redesign. The expression syntax is still JavaScript-like, but the language now has a static checker, a single function namespace with every built-in included, strict booleans, one absent value (`null`), and value equality. The JavaScript API is built around an immutable environment instead of a mutable instance with plugins.

Most expressions need small, mechanical changes. This page lists them.

## Expressions

| 0.x | 1.x | Notes |
| --- | --- | --- |
| `name \|> trim \|> upper` | `name.trim().toUpperCase()` | `\|>` is reserved and is a syntax error in 1.x. |
| `a \|> f(b)` | `a.f(b)` or `f(a, b)` | Every function is also a method. |
| `upper`, `lower` | `toUpperCase`, `toLowerCase` | JavaScript names. |
| `flatten` | `flat` | |
| `isString(x)`, `isNumber(x)`, `isArray(x)` | `type(x) == "string"`, `"number"`, `"list"` | `type()` returns the kind of any value. |
| `isNull(x)` | `x == null` | Also true when `x` is missing. |
| `toBool(x)` | an explicit test, for example `x != ""` or `x > 0` | Booleans are strict. |
| `diffDays(a, b)` | `inDays(a - b)` | Subtracting timestamps gives a duration. `abs(...)` for an absolute value. |
| `now()` (milliseconds) | `now()` (a timestamp) | Compare with `now() - t > days(30)`. |
| `formatDate(ts, "YYYY-MM-DD")` | `formatDate(t, "yyyy-MM-dd")` | Tokens are `yyyy MM dd HH mm ss SSS`, and an optional time zone argument is accepted. |
| `undefined` | `null` | There is no `undefined` literal. |
| `substring`, `charAt`, `concat` | `slice`, `at`, `+` | |
| `toSorted()`, `toReversed()` | `sort()`, `reverse()` | They never mutate, so the `to` prefix is not needed. |
| `+x` (unary plus) | `toNumber(x)` | There is no unary plus. |

## Semantics that changed

**`== null` includes missing values.** In 0.x `==` was JavaScript `===`, so a missing property (`undefined`) was not equal to `null`. Now every absent value is `null`:

<!-- context: { user: { name: "Ada" } } -->
```bonsai
user.middleName == null // => true
```

**`==` compares by value.** Lists and maps compare deeply; in 0.x they compared by reference.

<!-- context: {} -->
```bonsai
[1, 2] == [1, 2] // => true
```

**Booleans are strict.** `&&`, `||`, `!`, and `?:` accept booleans and `null` (as `false`). In 0.x they followed JavaScript truthiness and `a || b` returned `a` itself. Replace `name || "Anonymous"` with `name ?? "Anonymous"`, and `items.length && ...` with `items.length > 0 && ...`.

<!-- context: { name: null, items: [] } -->
```bonsai
name ?? "Anonymous" // => "Anonymous"
items.length > 0 && items[0] == 1 // => false
name || "Anonymous" // error: TYPE_ERROR
```

**No coercion.** `"a" + 1` and `null + 1` are errors. Use a template for text (`` `a${1}` ``) and `??` for defaults.

**No `NaN` or `Infinity`.** Division by zero is a `DIVISION_BY_ZERO` error instead of `Infinity`. Wrap with `try(expr, fallback)` if a default is wanted.

**Comparisons with `null` are `false`.** `null < 1` is `false`, not `true` as in JavaScript.

**Dates are timestamps.** A `Date` in the context is a timestamp, and arithmetic uses durations (`days(3)`, `hours(1)`). Numbers are not treated as dates; convert epoch milliseconds with `timestamp(ms)`.

**Lambdas are type-directed.** `.` binds to the nearest enclosing argument whose parameter is a function, so an expression such as `items.filter(.price > max(.bonus, 10))` now works: `.bonus` belongs to the item. In 0.x the shorthand could not be passed into another call.

## API

| 0.x | 1.x |
| --- | --- |
| `const expr = bonsai(options)` | `const env = bonsai({ variables, strict, functions, libraries, limits, clock })` |
| `expr.use(strings).use(arrays)`, `bonsai-js/stdlib` | Nothing to import: every built-in is always available. |
| `expr.addFunction('f', fn)` | `bonsai({ functions: { f: fn({ params, returns, run }) } })` |
| `expr.addContextFunction('f', (ctx, ...) => ...)` | `fn({ params, returns, context: true, run: (ctx, ...args) => ... })` |
| `expr.addTransform('f', fn)` | A host function. Call it as `x.f()`. |
| Plugins (`BonsaiPlugin`) | A `Library`: `{ name, functions }`, passed as `libraries: [lib]`. |
| `expr.evaluateSync(src, ctx)` | `env.evaluateSync(src, ctx)` (unchanged) |
| `expr.evaluate(src, ctx)` | `env.evaluate(src, ctx)`; async host functions must be declared `async: true`. |
| `expr.compile(src)` | `env.compile(src, { expect })` returns a checked `Program`. |
| `expr.validate(src)` | `env.check(src)` returns `{ ok, type, diagnostics }` and never throws. |
| `result.references.identifiers` | `program.references.variables` |
| `evaluateExpression(src, ctx)` | `bonsai().evaluateSync(src, ctx)` |
| `allowedProperties`, `deniedProperties` | Pass only the data expressions may read. Declare variables with `t` and `strict: true` to catch unknown names and fields at check time. |
| `timeout`, `maxDepth`, `maxSteps`, ... options | `limits: { timeout, maxDepth, maxSteps, ... }` (see [Limits](/api/limits)). |
| `cacheSize` option, `clearCache()` | `limits: { cacheSize }`. Environments are immutable; create a new one to start with an empty cache. |
| `expr.seal()` | Not needed: environments are immutable. `env.extend()` returns a new environment. |
| `listFunctions()`, `listTransforms()`, `hasFunction()` | `env.listFunctions()`, `env.describeFunction(name)` |
| `bonsai-js/autocomplete`, `createAutocomplete(expr)` | `bonsai-js/service`, `createLanguageService(env)`. Completions come from types, not from evaluating the context. |
| `bonsai-js/checker` | Built in: `env.check()` and `env.compile()`. |
| `tokenize`, `parse`, `compile` exports | `env.parse(src)` returns the syntax tree. |
| `ExpressionError` | `BonsaiSyntaxError` (code `SYNTAX`) |
| `BonsaiTypeError`, `BonsaiReferenceError` | `BonsaiCheckError` at compile time, `BonsaiRuntimeError` at run time |
| `BonsaiSecurityError` | `BonsaiLimitError` for limits; blocked properties are `SYNTAX` or `BLOCKED_PROPERTY` |
| `formatError(e)`, `formatBonsaiError(e)` | `error.formatted` |

## Host functions, before and after

```ts
import { bonsai, fn, t } from 'bonsai-js'

// 0.x:
//   const expr = bonsai()
//   expr.addFunction('discount', (total, rate) => total * (1 - rate))
//   expr.addContextFunction('hasPermission', (ctx, action) => ctx.perms.includes(action))

const env = bonsai({
  functions: {
    discount: fn({
      params: [t.number(), t.number()],
      returns: t.number(),
      run: (total, rate) => total * (1 - rate),
    }),
    hasPermission: fn({
      params: [t.string()],
      returns: t.boolean(),
      context: true,
      run: (ctx, action) => (ctx.perms as string[]).includes(action),
    }),
  },
})

env.evaluateSync('hasPermission("admin") ? total.discount(0.1) : total', {
  perms: ['admin'],
  total: 200,
}) // => 180
```

Declared parameter and result types mean the checker rejects `discount("a", 1)` before it runs, arguments are validated before your code is called, and a result of the wrong type is a `HOST_ERROR` instead of propagating.

## Suggested order

1. Replace the instance setup with `bonsai({ ... })` and move functions into `functions` with `fn`.
2. Run `env.check()` over your stored expressions. Syntax errors point at `|>` and removed names; check errors point at type problems.
3. Rewrite pipes as method calls and rename functions using the table above.
4. Review expressions that relied on truthiness (`||` for defaults, numbers or strings as conditions) and on `undefined`.
5. Add `variables` declarations with `t` to get type errors and editor completions.
