# Explaining Results

`explain()` evaluates an expression and records the value of every sub-expression. Use it to show why a rule passed or failed: in a support tool, an audit log, or next to the rule in an editor.

```ts
import { bonsai } from 'bonsai-js'

const env = bonsai()
const rule = env.compile('user.age >= 18 && user.plan == "pro"')
const explanation = rule.explainSync({ user: { age: 25, plan: 'free' } })

explanation.ok // true
if (explanation.ok) explanation.value // false
String(explanation)
// user.age >= 18 && user.plan == "pro"  → false
// ├─ user.age >= 18  → true
// │  └─ user.age  → 25
// └─ user.plan == "pro"  → false
//    └─ user.plan  → "free"
```

## Reasons

`explanation.reasons()` returns only the conditions that decided the result: it follows `&&`, `||`, and `!` down to the comparisons and values (or the error) behind the outcome.

By default `&&` stops at the first false condition, so there is one reason. Pass `exhaustive: true` to evaluate the remaining conditions for the explanation, and every failing one is listed. Those parts are marked `extra: true`, and an error in them (a failing comparison, a throwing getter) is ignored, so the result does not change. The extra work counts toward the step budget and other limits, so a limit error there does fail the explanation. Host functions on those parts do run.

```ts
import { bonsai } from 'bonsai-js'

const rule = bonsai().compile('user.age >= 18 && user.plan == "pro" && user.verified')
const user = { age: 16, plan: 'free', verified: true }

rule.explainSync({ user }).reasons().map((r) => r.text)
// ['user.age >= 18']
rule.explainSync({ user }, { exhaustive: true }).reasons().map((r) => r.text)
// ['user.age >= 18', 'user.plan == "pro"']
```

## The trace

`explanation.trace` is plain data, ready to send to a UI:

| Field | Meaning |
|---|---|
| `id` | Stable id of the syntax node, shared by every run of it (for example in each iteration) |
| `kind` | Syntax node type: `Binary`, `Member`, `Call`, ... |
| `operator` | For `Binary` and `Unary` nodes |
| `text`, `start`, `end` | The source text of the sub-expression (at most 120 characters, then `...`) and its offsets, to highlight it; slice the source with `start` and `end` for the full text |
| `evaluated` | `false` when short-circuiting skipped it (`false && x`, the untaken branch of `?:`) |
| `value` | What it produced |
| `error` | `{ code, message }` when it failed |
| `children` | Its sub-expressions, in source order |
| `extra` | `true` when it was evaluated only because of `exhaustive` |
| `iterations` | For calls that take a lambda: `{ index, item, result or error, trace }` for each item the lambda ran on (reduce adds `accumulator`) |
| `omittedIterations` | Lambda runs beyond `maxIterations`, counted but not recorded |

Values in `trace` are the live values from your context, not copies. To send an explanation to a browser or store it, use `JSON.stringify(explanation)` (or `explanation.toJSON()`): values become bounded, cycle-safe copies (at most 10,000 values in total, however often a value recurs), getters are never run, host collections such as typed arrays and `Map` are summarized by type, and a value that throws when read becomes `"[unreadable]"`.

## Errors

`explain()` never rejects for evaluation errors (and `explainSync()` never throws for them). It returns `{ ok: false, error }` and marks the node that failed, so you can show where a rule broke; a context that fails `validateContext` is returned the same way, as an `INVALID_CONTEXT` error. Invalid options and a context that is not an object are your own mistakes: `explain()` rejects and `explainSync()` throws, as `evaluate()` and `evaluateSync()` do:

```ts
import { bonsai } from 'bonsai-js'

const explanation = bonsai().explainSync('stats.visits / stats.days', { stats: { visits: 10, days: 0 } })
explanation.ok // false
String(explanation)
// stats.visits / stats.days  → error DIVISION_BY_ZERO: Division by zero
// ├─ stats.visits  → 10
// └─ stats.days  → 0
```

Syntax and check errors reject from `env.explain(source)` and throw from `env.explainSync(source)`, as they do for `env.evaluate` and `env.evaluateSync`.

## Options

`explain(context, options)` accepts the evaluation options (`timeout`, `maxSteps`, `signal`) plus:

| Option | Default | Effect |
|---|---|---|
| `maxIterations` | 20 | Lambda runs recorded per call |
| `maxTraceNodes` | 10,000 | Sub-expressions recorded in total; the result stays exact and `truncated` is set |
| `exhaustive` | `false` | Evaluate every condition of `&&` and `||` so `reasons()` lists them all |

Like `evaluate()` and `evaluateSync()`, `explain()` returns a promise (and supports async host functions) and `explainSync()` returns the explanation directly; `explainSync()` on an expression that calls an async host function returns an `ASYNC_IN_SYNC` error. Explaining uses a separately compiled program, so evaluating the same program normally is not slowed down.
