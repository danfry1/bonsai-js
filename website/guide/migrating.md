# Migrating from 0.x

Bonsai 1.0 is a redesign. The expression syntax is still JavaScript-like, but the language now has a static checker, a single function namespace with every built-in included, strict booleans, one absent value (`null`), and value equality. The JavaScript API is built around an immutable environment instead of a mutable instance with plugins.

Most expressions need small, mechanical changes, and the checker finds most of them for you. Some changes are silent: the expression still runs but gives a different result. They are listed in [Results that changed](#results-that-changed); review them before you switch.

## Before you start

- **Node.js 22 or newer.** The package is ESM. `require('bonsai-js')` works on Node versions that can load ES modules synchronously (22.12 and newer).
- **Every built-in is included.** Remove `bonsai-js/stdlib` imports and `.use(...)` calls.
- **Declaring variables makes the environment strict.** With `variables`, an undeclared name is a check error instead of reading the context. Pass `strict: false` to keep reading undeclared names as `any`, or declare everything the expressions read.

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
| `a \|> diffDays(b)` (epoch milliseconds) | `round(abs(inDays(timestamp(a) - timestamp(b))))` | Subtracting timestamps gives a signed, fractional duration. See [Results that changed](#results-that-changed). |
| `now()` (epoch milliseconds) | `now()` (a timestamp) | Compare with `now() - t > days(30)`. |
| `ts \|> formatDate("YYYY-MM-DD")` | `formatDate(t, "yyyy-MM-dd")` | Takes a timestamp, not epoch milliseconds. Tokens are `yyyy MM dd HH mm ss SSS` (and more); an optional time zone argument is accepted. |
| `xs \|> filter`, `xs \|> some`, `xs \|> every` (no argument, by truthiness) | `xs.filter(. != null)`, `flags.some(.)`, `flags.every(.)` | Lambdas are required. `.` alone works for lists of booleans; for other lists write the test. |
| `undefined` | `null` | There is no `undefined` literal. |
| `substring(i, j)` | `slice(i, j)` | The same for `0 <= i <= j`. `slice` does not swap reversed arguments and counts negative positions from the end. See [Results that changed](#results-that-changed). |
| `charAt(i)` | `at(i)` | `at` gives `null` past the end and counts negative positions from the end. |
| `concat` | `+` | |
| `toSorted()`, `toReversed()` | `sort()`, `reverse()` | They never mutate, so the `to` prefix is not needed. `sort()` orders numbers numerically. |
| `toSpliced(i, n)` | `xs.slice(0, i) + xs.slice(i + n)` | |
| `with(i, v)` | `xs.slice(0, i) + [v] + xs.slice(i + 1)` | |
| `charCodeAt(i)` | none | Declare a host function if you need code points. |
| `+x` (unary plus) | `toNumber(x)` | There is no unary plus. |

<!-- context: { a: 1767484800000, b: 1767229200000, xs: [1, 2, 3], flags: [false, true], items: [1, null, 2] } -->
```bonsai
round(abs(inDays(timestamp(a) - timestamp(b)))) // => 3
xs.slice(0, 1) + xs.slice(2) // => [1, 3]
xs.slice(0, 1) + [9] + xs.slice(2) // => [1, 9, 3]
flags.some(.) // => true
items.filter(. != null) // => [1, 2]
```

## Results that changed

These expressions run in both versions but give different results. The checker cannot flag them, so search stored expressions for the functions involved.

| Expression | 0.x | 1.x | To keep the old result |
| --- | --- | --- | --- |
| `round(-2.5)` | `-2` | `-3` | Halves round away from zero, as `toFixed` does. |
| `round(2.345, 2)` | `2` (digits ignored) | `2.35` | Drop the second argument. |
| `(1.005).toFixed(2)` | `"1.00"` | `"1.01"` | Rounds the decimal value as written, not its binary approximation. |
| `avg([])` | `0` | `null` | `avg(xs) ?? 0` |
| `unique` on lists of maps or lists | compares by reference | compares by value (`==`) | |
| `diffDays(a, b)` | whole days, always positive | `inDays(a - b)` is fractional and signed | `round(abs(inDays(a - b)))`. At exactly half a day this rounds up in both orders; 0.x rounded 3.5 days apart to 3 when `a` was earlier and to 4 when it was later. |
| `` `${x}` `` with `x` null | `"null"` | `""` | `` `${x ?? "null"}` `` |
| `` `${x}` `` with `x` undefined or missing | `"undefined"` | `""` | |
| `` `${date}` `` | local `Date.toString()` text | ISO-8601 in UTC | `formatDate(date, pattern, zone)` |
| `` `${list}` ``, `` `${map}` `` | `"1,2"`, `"[object Object]"` | `TYPE_ERROR` | `join(list, ",")` |
| `toString(null)` | `"null"` | `""` | |
| `toNumber("")` | `0` | `INVALID_ARGUMENT` | `try(toNumber(s), 0)` |
| `toNumber("abc")` | `null` | `INVALID_ARGUMENT` | `try(toNumber(s), null)` |
| `toNumber(true)`, `toNumber(null)` | `1`, `0` | check error | `b ? 1 : 0`, `x ?? 0` |
| `sort` on a list mixing numbers and text | sorted numbers first | `TYPE_ERROR` (a check error when the types are known) | Sort one kind at a time. |
| `x / 0`, `x % 0` | `Infinity`, `NaN` | `DIVISION_BY_ZERO` | `try(x / y, 0)` |
| `"a" + 1`, `null + 1` | `"a1"`, `1` | `TYPE_ERROR` | `` `a${1}` ``, `(x ?? 0) + 1` |
| `x == null` with `x` missing | `false` | `true` | |
| `[1] == [1]` | `false` | `true` | |
| `null < 1` | `true` | `false` | |
| `0 \|\| "d"` | `"d"` | `TYPE_ERROR` | `x ?? "d"` for defaults, or an explicit test |
| `nums.toSorted()` with `nums` = `[10, 9, 1, 100]` | `[1, 10, 100, 9]` (text order, as JavaScript) | `[1, 9, 10, 100]` | Sort text with `map(toString(.)).sort()`. |
| `ll.includes([1])`, `ll.indexOf([2])`, `[1] in ll`, `objs.includes({ a: 1 })` | `false`, `-1`, `false`, `false` (by reference) | `true`, `1`, `true`, `true` (by value) | |
| `d1 == d2`, two `Date`s at the same instant | `false` (different objects) | `true` | |
| `"abc".replace("b", "$&$&")` | `"abbc"` (`$&`, `$$`, and `` $` ``/`$'` patterns expand) | `"a$&$&c"` (replacement text is literal) | Build the text: `` s.replace("b", `${x}${x}`) `` |
| `"hello".substring(3, 1)` → `slice(3, 1)` | `"el"` (arguments swapped) | `""` | `slice(min(i, j), max(i, j))` |
| `"hello".substring(-2)` → `slice(-2)` | `"hello"` (negative treated as 0) | `"lo"` (counts from the end) | `slice(max(i, 0))` |
| `"hello".charAt(10)` → `at(10)` | `""` | `null` | `at(i) ?? ""` |
| `"hello".charAt(-1)` → `at(-1)` | `""` | `"o"` (counts from the end) | `i < 0 ? "" : at(i) ?? ""` |
| A host `Map`, `Set`, or `RegExp` in the context | read through its prototype: `m.size`, `re.source`, even `m.get` as a function | an opaque value; reading any property is a `TYPE_ERROR` | Pass plain objects, arrays, and values (`m.size` as a number). |

<!-- context: { x: null, xs: [], d: new Date("2026-01-02T03:04:05Z") } -->
```bonsai
round(-2.5) // => -3
round(2.345, 2) // => 2.35
(1.005).toFixed(2) // => "1.01"
avg(xs) ?? 0 // => 0
[{ a: 1 }, { a: 1 }].unique().length // => 1
`${x}` // => ""
`${d}` // => "2026-01-02T03:04:05.000Z"
try(toNumber(""), 0) // => 0
5 % 0 // error: DIVISION_BY_ZERO
```

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

**No `NaN` or `Infinity`.** Division and remainder by zero are `DIVISION_BY_ZERO` errors instead of `Infinity` and `NaN`, and any computation that would produce a non-finite number is a `NON_FINITE` error. Wrap with `try(expr, fallback)` if a default is wanted.

**Comparisons with `null` are `false`.** `null < 1` is `false`, not `true` as in JavaScript.

**Dates are timestamps.** A `Date` in the context is a timestamp, and arithmetic uses durations (`days(3)`, `hours(1)`). Numbers are not treated as dates; convert epoch milliseconds with `timestamp(ms)`.

**Lambdas are type-directed.** `.` binds to the nearest enclosing argument whose parameter is a function, so an expression such as `items.filter(.price > max(.bonus, 10))` now works: `.bonus` belongs to the item. In 0.x the shorthand could not be passed into another call.

**Only plain data is navigable.** Plain objects and class instances are read through their own enumerable properties. In 0.x, built-in objects were also read through their prototypes (`m.size`, `re.source`). Now `Map`, `Set`, `RegExp`, promises and other thenables, typed arrays, errors, and boxed primitives are opaque: they can be compared and passed to host functions, but reading a property of one is a `TYPE_ERROR`. Convert them to plain objects and arrays before evaluating.

## API

| 0.x | 1.x |
| --- | --- |
| `const expr = bonsai(options)` | `const env = bonsai({ variables, strict, functions, libraries, limits, cacheSize, clock, validateContext })` |
| `bonsai<AppCtx>()` | The context type is inferred from `variables`. Without `variables`, the context is any object, so a value typed by an interface (`const ctx: AppCtx = ...`) is accepted as is. |
| `expr.use(strings).use(arrays)`, `bonsai-js/stdlib` | Nothing to import: every built-in is always available. |
| `expr.addFunction('f', fn)` | `bonsai({ functions: { f: fn({ params, returns, run }) } })` |
| `expr.addContextFunction('f', (ctx, ...) => ...)` | `fn({ params, returns, context: true, run: (ctx, ...args) => ... })`, or `withContext<Ctx>()` for a typed context. |
| `expr.addTransform('f', fn)` | A host function. Call it as `x.f()`. |
| `expr.removeFunction()`, `expr.removeTransform()` | Environments are immutable: create an environment without the function. |
| Plugins (`BonsaiPlugin`) | A `Library`: `{ name, functions, variables }`, passed as `libraries: [lib]`. |
| `expr.evaluateSync(src, ctx)` | `env.evaluateSync(src, ctx)` (unchanged) |
| `expr.evaluate(src, ctx)` | `env.evaluate(src, ctx)`. Only functions declared `async: true` are awaited; any other function returning a promise is an error. |
| `expr.compile(src)` | `env.compile(src, { expect })` returns a checked `Program` with `source`, `ast`, `type`, `async`, `warnings`, and `references`. |
| `expr.validate(src)` returning `{ valid, errors, ast, references }` | `env.check(src)` returns `{ ok, type, diagnostics }` and never throws. Each diagnostic has `code`, `message`, `severity`, and `start`/`end` offsets instead of a line and column. For the syntax tree, call `env.parse(src)`; for references, `env.compile(src).references`. |
| `result.references.identifiers`, `.functions` | `program.references.variables`, `.functions`. `transforms` is gone: transforms are functions. |
| `evaluateExpression(src, ctx)` | `bonsai().evaluateSync(src, ctx)` |
| `allowedProperties`, `deniedProperties`, `getPolicy()` | Removed. Pass only the data expressions may read. Declare variables with `t` to catch unknown names and fields at check time. |
| `timeout`, `maxDepth`, `maxArrayLength`, `maxStringLength` options | `limits: { timeout, maxDepth, maxListLength, maxStringLength, ... }`. See [Limits](#limits). |
| `cacheSize` option, `clearCache()` | `cacheSize` option (unchanged). There is no `clearCache()`; create a new environment to start with an empty cache. |
| `listFunctions()`, `hasFunction()`, `listTransforms()`, `hasTransform()`, `isContextFunction()` | `env.listFunctions()` and `env.describeFunction(name)` (`undefined` when the function does not exist). |
| `bonsai-js/autocomplete`, `createAutocomplete(expr, { context })`, `complete()` returning `Completion[]` | `bonsai-js/service`, `createLanguageService(env)`. `complete(source, offset)` returns `{ start, end, items }`, computed from types rather than by evaluating a sample context. |
| `tokenize`, `parse`, `compile` exports | `env.parse(src)` returns the syntax tree; `print(tree)` turns it back into source. |
| `formatError(e)`, `formatBonsaiError(e)` | `error.formatted` |

### TypeScript types

| 0.x | 1.x |
| --- | --- |
| `BonsaiInstance` | `Environment` |
| `BonsaiOptions` | `EnvironmentOptions` |
| `CompiledExpression` | `Program` |
| `ValidationResult` | `CheckResult` |
| `FunctionFn`, `ContextFunctionFn`, `TransformFn` | `HostFunction`, created with `fn()` |
| `BonsaiPlugin` | `Library` |
| `ASTNode` | `Node` |
| `ExpressionReferences`, `PolicySnapshot`, `ResolveResult`, `Token`, `TokenType`, `InferredTypeName` | Removed. |

Syntax tree node types were renamed and regrouped. Code that walks trees needs updating:

| 0.x node | 1.x node |
| --- | --- |
| `NumberLiteral`, `StringLiteral`, `BooleanLiteral`, `NullLiteral` | `Literal` |
| `UndefinedLiteral`, `PipeExpression` | Removed. |
| `TemplateLiteral` | `Template` |
| `Identifier` | `Variable` (context variables), `Local` (`let` bindings and lambda parameters) |
| `MemberExpression`, `OptionalMemberExpression` | `Member` (`a.b`), `Index` (`a[k]`), each with an `optional` flag |
| `CallExpression` | `Call`, for both `f(x)` and `x.f()`, with the receiver as the first argument |
| `BinaryExpression`, `UnaryExpression`, `ConditionalExpression` | `Binary`, `Unary`, `Conditional` |
| `ArrayLiteral`, `ObjectLiteral`, `ObjectProperty`, `SpreadElement` | `List`, `Map`, `Entry`, `Spread` |
| `LambdaAccessor`, `LambdaIdentity`, `LambdaExpression` | `It` (the implicit `.`) and `Lambda` |
| none | `Let`, `Has`, `Try` |

### Limits

| 0.x | 1.x |
| --- | --- |
| `timeout` | `limits.timeout` |
| `maxDepth` (evaluation depth, default 100) | `limits.maxDepth` limits syntax nesting (default 128). Nesting of values is `limits.maxValueDepth` (default 64). |
| `maxArrayLength` | `limits.maxListLength` |
| `maxStringLength` | `limits.maxStringLength` |
| none | `maxSourceLength`, `maxNodes`, `maxSteps`, `maxPatternLength`. See [Limits](/api/limits). |

### Errors

Every error is a `BonsaiError` with a stable `code`, `source`, `span` (`{ start, end }`), 1-based `position`, and `formatted` text. Check `error.code` rather than the class.

| 0.x | 1.x |
| --- | --- |
| `ExpressionError` | `BonsaiSyntaxError` (code `SYNTAX`) |
| `BonsaiTypeError` | `BonsaiCheckError` (code `CHECK`, with `diagnostics`) at compile time, `BonsaiRuntimeError` (`TYPE_ERROR`, `NO_OVERLOAD`, ...) at run time |
| `BonsaiReferenceError` (unknown function) | an `UNKNOWN_FUNCTION` diagnostic in a `BonsaiCheckError` |
| `BonsaiSecurityError` `TIMEOUT` | `BonsaiLimitError` `TIMEOUT` |
| `BonsaiSecurityError` `MAX_DEPTH` | `BonsaiLimitError` `TOO_DEEP` |
| `BonsaiSecurityError` `MAX_ARRAY_LENGTH` | `BonsaiLimitError` `LIST_LIMIT` |
| `BonsaiSecurityError` `MAX_STRING_LENGTH` | `BonsaiLimitError` `STRING_LIMIT` |
| `BonsaiSecurityError` `BLOCKED_PROPERTY` | `SYNTAX` for a literal key, `BLOCKED_PROPERTY` for a computed one |
| `BonsaiSecurityError` `PROPERTY_NOT_ALLOWED`, `PROPERTY_DENIED`, `METHOD_NOT_ALLOWED` | Removed with the allow and deny lists. |
| `error.start`, `error.end`, `error.location` | `error.span` |
| `error.rawMessage` | `error.message` |
| `error.suggestion` | Included in `error.message` ("did you mean ...") |
| `transform`, `expected`, `received`, `identifier`, `kind` fields | Removed. The message names the function and the types. |

Two new runtime codes separate host failures: `HOST_ERROR` when your function throws (an expression may recover with `try`), and `HOST_CONTRACT` when it returns a value that does not match its declared type or returns a promise without `async: true` (never caught by `try`). See [Errors](/api/errors).

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

Declared parameter and result types mean the checker rejects `discount("a", 1)` before it runs, arguments are validated before your code is called, and a result of the wrong type is a `HOST_CONTRACT` error instead of propagating. In 0.x an async function could be called from `evaluate()` without being declared; in 1.x add `async: true`, and `evaluateSync()` rejects expressions that call it before any host code runs.

## Suggested order

1. Upgrade to Node.js 22 or newer.
2. Replace the instance setup with `bonsai({ ... })` and move functions into `functions` with `fn`.
3. Run `env.check()` over your stored expressions. Syntax errors point at `|>` and removed names; check errors point at type problems and undeclared names.
4. Rewrite pipes as method calls and rename functions using the tables above.
5. Review expressions that relied on truthiness (`||` for defaults, numbers or strings as conditions), on `undefined`, and on the [results that changed](#results-that-changed).
6. Add `variables` declarations with `t` to get type errors and editor completions, and `validateContext: true` if the context comes from outside your code.
