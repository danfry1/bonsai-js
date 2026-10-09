# Programs

`env.compile(source, options?)` returns a `Program`: a checked, compiled expression. Programs are immutable and safe to share and to evaluate concurrently. Keep one per rule and evaluate it as often as needed.

<!-- no-run -->
```ts
interface Program<Context, Result> {
  readonly source: string
  readonly ast: Node
  readonly type: Type
  readonly async: boolean
  readonly warnings: readonly Diagnostic[]
  readonly references: { readonly variables: readonly string[]; readonly functions: readonly string[] }
  evaluate(context?: Context, options?: EvaluateOptions): Promise<Result>
  evaluateSync(context?: Context, options?: EvaluateOptions): Result
  explain(context?: Context, options?: ExplainOptions): Promise<Explanation<Result>>
  explainSync(context?: Context, options?: ExplainOptions): Explanation<Result>
  partial(known: PartialData<Context>, options?: PartialOptions): PartialResult<Result, Context>
}
```

`explain` and `explainSync` are described in [Explaining Results](/api/explain), and `partial` in [Partial Evaluation](/api/partial); `known` may hold any part of the context, at any depth; a variable or field it leaves out is unknown unless you pass an `unknown` list. A program typed for one context can be stored as a bare `Program` (as in `Program[]` or `Map<string, Program>`), which accepts any context.

## Example

```ts
import { bonsai, fn, t, formatType } from 'bonsai-js'

const env = bonsai({
  variables: {
    user: t.object({ age: t.number(), plan: t.enum('free', 'pro') }),
    orders: t.list(t.object({ total: t.number(), paid: t.boolean() })),
  },
  functions: {
    fxRate: fn({ params: [t.string()], returns: t.number(), async: true, run: async () => 1.25 }),
  },
})

const rule = env.compile('user.age >= 18 && orders.some(.paid && .total > 100)', {
  expect: t.boolean(),
})

formatType(rule.type) // => "boolean"
rule.references.variables // => ["user", "orders"]
rule.references.functions // => ["some"]
rule.async // => false
rule.warnings.length // => 0

const context = {
  user: { age: 30, plan: 'pro' as const },
  orders: [{ total: 250, paid: true }],
}
rule.evaluateSync(context) // => true
await rule.evaluate(context) // => true
```

## Properties

| Property | Description |
| --- | --- |
| `source` | The expression text. |
| `ast` | The syntax tree, after implicit `.` lambdas have been made explicit. |
| `type` | The statically inferred result type. Render it with `formatType`. |
| `async` | Whether the expression calls an `async` host function. `evaluateSync` rejects such a program. |
| `warnings` | Non-fatal checker findings (errors prevent compilation). |
| `references.variables` | The context variables the expression reads, in order of first use. |
| `references.functions` | The functions it calls. |

`references` is useful for dependency tracking: load only the data a rule needs, or recompute a formula field only when its inputs change.

## evaluateSync(context?, options?)

Evaluates synchronously and returns the result. The context argument is required in TypeScript when the environment declares a variable that is not optional.

## evaluate(context?, options?)

Evaluates and returns a promise. Use it for programs whose `async` is `true`. For other programs it runs the synchronous path and resolves with the result.

<!-- continue -->
```ts
const converted = env.compile('orders.map(.total).sum() * fxRate("EUR")')
converted.async // => true
await converted.evaluate(context) // => 312.5
converted.evaluateSync(context) // throws: ASYNC_IN_SYNC
```

Both accept per-evaluation options:

| Option | Description |
| --- | --- |
| `timeout` | Wall-clock budget in milliseconds. Exceeding it is a `TIMEOUT` error. |
| `maxSteps` | Step budget, replacing the environment's `limits.maxSteps`. Exceeding it is a `STEP_LIMIT` error. |
| `signal` | An `AbortSignal`. Aborting stops the evaluation with an `ABORTED` error, including while waiting on an async host function. |

They are validated like `limits`: `timeout` and `maxSteps` must be non-negative integers (`0` turns the limit off), `signal` must be an `AbortSignal`, and an unknown key or invalid value throws a `TypeError` or `RangeError` before anything runs, so a miscalculated budget can never turn the limit off by accident.

<!-- continue -->
```ts
const controller = new AbortController()
controller.abort()
rule.evaluateSync(context, { signal: controller.signal }) // throws: ABORTED
rule.evaluateSync(context, { maxSteps: 2 }) // throws: STEP_LIMIT
```

## Result values

Results are plain JavaScript values: `null`, booleans, numbers, strings, arrays, and objects, plus `Date` for timestamps and `Duration` for durations. A host `undefined` is returned as `null`. Lists and maps an expression builds are new values; values read from the context are returned as they are (not copied).

`Duration` is exported from `bonsai-js`. It has a `ms` property with the length in milliseconds and renders as ISO-8601 through `toString()` and `toJSON()`.

<!-- continue -->
```ts
import { Duration } from 'bonsai-js'

const length = env.evaluateSync<Duration>('hours(1) + minutes(30)', context)
length instanceof Duration // => true
length.ms // => 5400000
String(length) // => "PT1H30M"
```
