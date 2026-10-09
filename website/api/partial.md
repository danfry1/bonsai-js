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

- **Decide early.** A `value` result means the missing data cannot change the outcome (a free user never passes this rule).
- **Precompute.** Evaluate the per-tenant or per-user part of a rule once, keep the result, and evaluate only the per-request part later. A residual does less work than the original program and evaluates faster.
- **Push filters down.** The residual refers only to the unknown data, so it can be translated to a database query.

## Results

| `status` | Meaning |
|---|---|
| `value` | The known data decides the result: `value` |
| `error` | Evaluation fails whatever the unknown data is: `error` |
| `residual` | `residual` (syntax tree), `source`, `bindings`, `dependsOn`, `hostFunctions` (host functions the residual still calls), and `evaluateSync(context, options?)` / `evaluate(context, options?)`, which take the same evaluation options as a program (`timeout`, `maxSteps`, `signal`); `context` is typed as any part of the program's context, so a misspelled variable does not compile |

The residual is exact: evaluating it with the full data gives the same value or error as evaluating the original expression with the full data. Simplifications that would change a result (for example turning `x && false` into `false` when `x` could fail) are not made.

## Bindings

Short primitives (numbers, booleans, `null`, strings up to 200 characters) are written into the residual. Other known values, such as lists, maps, dates, and durations, are kept by reference in `result.bindings` and named in the residual (`order.sku in __known1`). `result.evaluateSync(context)` and `result.evaluate(context)` supply the bindings for you; to store a residual instead, see Storing a residual below.

## Options

| Option | Default | Effect |
|---|---|---|
| `unknown` | variables missing from `known` | Variables or dotted paths (`order`, `user.riskScore`) to treat as unknown; unknown wins over a value you passed |
| `callHostFunctions` | `false` | Call host functions whose inputs are known (only synchronous ones); otherwise they stay in the residual |
| `now` | none | The time `now()` returns; otherwise `now()` stays in the residual (the environment's `clock` is not used, so a stored residual reads the time when it is evaluated) |

Limit errors (steps, time) are thrown from `partial()` rather than guessed. Every sub-expression evaluated during one `partial()` call shares one step budget. Options follow the same rules as everywhere else: an unknown option or a wrong type is a `TypeError`. With `validateContext`, the variables in `known` are validated as evaluation validates them (a mismatch is an `INVALID_CONTEXT` result), so a known object must have all its declared fields; a missing field would otherwise be read as `null`. To leave part of an object unknown, list its path in `unknown` (`user.riskScore`): a variable with an unknown path inside it is not validated.

## Details

- **Evaluate the residual with the full context.** A known part that fails (say, a division by zero in a branch that may not run) stays in the residual so the error can still happen, and it reads the known variables again.
- **Known parts of every branch are evaluated**, including branches the unknown data may never choose. They count toward the step budget, and context getters they read run during `partial()`.
- **Host functions** are called only with `callHostFunctions: true`, never when they are async, and functions declared `call: true` only when you also pass `unknown: []`, since they can read variables the expression does not name.
- **With an explicit `unknown` list**, a variable that is neither in `known` nor listed reads as `null`, as it would in normal evaluation.
- **`expect` still applies.** A program compiled with `expect` checks a decided `value` against it (a mismatch is a `TYPE_ERROR` result), and its residual checks results the same way.
- **The residual reads your context as it is.** The bindings are compiled into the residual, so evaluating it copies nothing: getters run on your own object, and host functions declared `call: true` receive it as `call.context`, as they do in evaluation.
- **Storing a residual.** `result.evaluateSync` and `result.evaluate` are the reliable way to run it; keep the result in memory where you can. If you store `source` and `bindings` and compile them yourself, use a non-strict environment (the binding names are not declared variables) and pass the bindings in the context. Bindings are live values: JSON turns a date or a duration into ISO-8601 text, so restore dates with `new Date(text)` (or store bindings in a format that keeps them) before evaluating. Inlined values can also make a type error in an untaken branch visible to the checker.

