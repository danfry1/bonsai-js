# Partial Evaluation

`partial()` evaluates an expression with only some of its data. It returns the answer when the data you have already decides it, or a simplified expression (the residual) that needs only the missing data.

```ts
import { bonsai, t } from 'bonsai-js'

const env = bonsai({
  variables: {
    user: t.object({ plan: t.enum('free', 'pro') }),
    order: t.object({ total: t.number() }),
    limits: t.object({ minTotal: t.number() }),
  },
})
const rule = env.compile('user.plan == "pro" && order.total > limits.minTotal')

rule.partial({ user: { plan: 'free' }, limits: { minTotal: 100 } })
// { status: 'value', value: false }

const result = rule.partial({ user: { plan: 'pro' }, limits: { minTotal: 100 } })
result.status // 'residual'
if (result.status === 'residual') {
  result.source // 'order.total > 100'
  result.dependsOn // ['order.total']
  result.evaluateSync({ order: { total: 150 } }) // true
}
```

## Uses

- **Decide early.** A `value` result means no value of the missing data changes the outcome (a free user never passes this rule). With `validateContext`, data that is never read is never validated, so a decided value (or a residual on the full context) does not check it either.
- **Precompute.** Evaluate the per-tenant or per-user part of a rule once, keep the result, and evaluate only the per-request part later. A residual does less work than the original program and evaluates faster.
- **Push filters down.** [`toSQL` and `toMongo`](./query) run this partial evaluation for you: pass the original program with the known values in `known`, and the part that reads the record becomes a database query.

## Results

| `status` | Meaning |
|---|---|
| `value` | The known data decides the result: `value` |
| `error` | Evaluation fails whatever the unknown data is: `error` |
| `residual` | `residual` (syntax tree), `source`, `bindings`, `dependsOn` (the context paths the residual reads; for `x.length`, the path of `x`), `hostFunctions` (host functions the residual still calls), `readsContext` (whether one of them is declared `call: true`, so it reads the whole context you pass, not only `dependsOn`), and `evaluateSync(context, options?)` / `evaluate(context, options?)`, which take the same evaluation options as a program (`timeout`, `maxSteps`, `signal`, `now`); `context` is typed as any part of the program's context, so a misspelled variable does not compile. `explainSync(context, options?)` / `explain(context, options?)` [explain](/api/explain) the residual the same way: each trace node's text is the residual's own (printed) text, and its offsets refer to the original expression (0 for values filled in from the known data) |

The residual is exact: evaluating it with the full data gives the same value or error as evaluating the original expression with the full data. Simplifications that would change a result (for example turning `x && false` into `false` when `x` could fail) are not made.

## Bindings

Short primitives (numbers, booleans, `null`, strings up to 16 characters) are written into the residual. Other known values, such as longer strings, lists, maps, dates, and durations, are kept in `result.bindings` (the values you passed, not copies; see below) and named in the residual (`order.sku in __known1`); a value used in several places is bound once. `result.evaluateSync(context)` and `result.evaluate(context)` supply the bindings for you; to store a residual instead, see Storing a residual below.

## Options

| Option | Default | Effect |
|---|---|---|
| `unknown` | variables and fields missing from `known`, and objects read whole | Variables or dotted paths (`order`, `user.riskScore`) to treat as unknown; unknown wins over a value you passed |
| `callHostFunctions` | `false` | Call host functions whose inputs are known (only synchronous ones); otherwise they stay in the residual |
| `now` | none | The time `now()` returns; otherwise `now()` stays in the residual (the environment's `clock` is not used, so a stored residual reads the time when it is evaluated) |
| `maxSteps` | the environment's | Step budget for the whole partial evaluation (`0` for none) |
| `timeout` | the environment's | Wall-clock budget in milliseconds for the whole partial evaluation (`0` for none) |
| `signal` | none | Cancels the partial evaluation with an `ABORTED` error |

Limit errors (steps, time, cancellation) are thrown from `partial()` rather than guessed. Every sub-expression evaluated during one `partial()` call shares one step budget and one deadline. `env.partial(source, known, options?)` compiles through the environment's cache and does the same. Options follow the same rules as everywhere else: an unknown option or a wrong type is a `TypeError`. With `validateContext`, the variables in `known` are validated as evaluation validates them (a mismatch is an `INVALID_CONTEXT` result), so a known object must have all its declared fields. To leave part of an object unknown, list its path in `unknown` (`user.riskScore`): everything under a listed path is skipped, and the rest of that variable is still validated, so all the data the residual has folded in has been checked.

## Details

- **Evaluate the residual with the full context.** A known part that fails (say, a division by zero in a branch that may not run) stays in the residual so the error can still happen, and it reads the known variables again.
- **Known parts of every branch are evaluated**, including branches the unknown data may never choose. They count toward the step budget, and context getters they read run during `partial()`.
- **Host functions** are called only with `callHostFunctions: true`, never when they are async, and functions declared `call: true` only when you also pass `unknown: []`, since they can read variables the expression does not name.
- **Missing data is unknown by default.** Without an `unknown` list, `partial()` decides only from data you passed, at any depth and however the expression reads it. A variable missing from `known` and a field missing from a known object (`cart.items` when `known` has `cart: {}`) both stay unknown, and their paths appear in `dependsOn`. A field is the same path however it is named: `cart["items"]` is `cart.items`, and `tiers[level]` with `level` known to be `"gold"` reads `tiers.gold`. A known object read whole (`cart == saved`, `{...cart}`, `cart.keys()`, `cart.values()`, `cart[key]` with `key` unknown, or a `let` that holds it) stays unknown too, in typed and open environments alike: the object you passed may be only part of it (an optional field, or an extra key, may still come), and a whole read would see the difference. A key that holds `undefined` counts as missing, so it is unknown too (evaluation reads it as null); pass `null` for a value that is known to be absent. Lists, dates, durations, and strings are values: a known list is taken as given, and `length` reads it.
- **Pass an `unknown` list to decide whole reads.** It says the rest of `known` is complete, so a known object read whole is decided.
- **With an explicit `unknown` list**, nothing else is guessed: a variable or field that is neither in `known` nor listed reads as `null`, as it would in normal evaluation. A listed path also says that the objects above it exist: with `unknown: ["cart.items"]` and no `cart` in `known`, all of `cart` is unknown (so `cart.coupon` is not read as `null`). When `known` does give `cart`, only `cart.items` is unknown and its other fields are taken as given.
- **`expect` still applies.** A program compiled with `expect` checks a decided `value` against it (a mismatch is a `TYPE_ERROR` result), and its residual checks results the same way.
- **The residual reads your context as it is.** The bindings are compiled into the residual, so evaluating it copies nothing: variables and getters read your own object, and only the ones the residual reads. When `readsContext` is `false`, pass at least every path in `dependsOn`; a part that always fails stays in the residual and reads the known variables again (see the first point).
- **Bindings are shared with `known`.** `partial()` reads `known` when it is called, and the values it binds are your own objects, not copies (so class instances, `Map`s, and arrays keep what they are). Do not change the known data afterwards: a residual whose decision used `config.threshold` and whose binding is `config.allowed` would mix the old threshold with the new list. When the data changes, call `partial()` again; to change it in place safely, pass `structuredClone(config)` or a deep-frozen copy, and key cached residuals by the configuration's version. Host functions must not change their arguments either: a residual reuses its bound values on every evaluation.
- **`call: true` functions read the context you pass** (`readsContext` is `true`). `call.context` is exactly that object, as in a program evaluation, so pass the full context, known values included. Their reads are not visible in `dependsOn`, so a context missing a variable that `known` gave (and `unknown` did not list whole; in a strict environment, only declared variables count) is an `INVALID_CONTEXT` error before anything runs. A variable you pass only part of is read as you pass it, as a program would read it.
- **With `validateContext`, a residual validates what it reads.** Everything the residual folded in was validated by `partial()`. When `readsContext` is `false`, the residual validates each path in `dependsOn` step by step, each step against its own declared type: an absent or `null` value passes only where that type allows `null` (a required object that is missing fails, and so does a missing required field of an object that is present), a key an object type does not declare and a record entry that is absent end the check, and the value at the end of the path is checked whole. Fields the path does not name are not checked, so a context holding exactly `dependsOn` passes. When `readsContext` is `true`, it validates the whole context, as a program does.
- **Explaining a residual explains the residual.** Its trace and `reasons()` cover the residual's own conditions, with known values shown as the `__known` names of their bindings; the conditions the known data decided are gone. For a screen that answers "why did this user get this result", explain the full program with the full context instead.
- **Residual size is limited.** Printing the residual counts toward the step budget, and a residual longer than the environment's `maxSourceLength` is a `SOURCE_TOO_LONG` limit error thrown from `partial()`.
- **Storing a residual.** `result.evaluateSync` and `result.evaluate` are the reliable way to run it; keep the result in memory where you can. If you store `source` and `bindings` and compile them yourself, use a non-strict environment (the binding names are not declared variables) and pass the bindings in the context. Bindings are your known values: JSON turns a date or a duration into ISO-8601 text, so restore dates with `new Date(text)` (or store bindings in a format that keeps them) before evaluating. Inlined values can also make a type error in an untaken branch visible to the checker.

