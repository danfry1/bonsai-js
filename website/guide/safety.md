# Safety & Sandboxing

Bonsai constrains the expression language. It is suitable for safe expression evaluation, but your own registered extensions still run as normal host JavaScript.

## What Bonsai blocks by default

Expressions cannot access the global scope, import modules, or reach dangerous prototype properties.

```ts
"hello".__proto__          // Error: Access to __proto__ is not allowed
constructor                  // Error: Access to constructor is not allowed
```

## Property restrictions

`allowedProperties` and `deniedProperties` apply to **member access** (`obj.name`) and **method calls** (`str.slice()`), not root identifiers (`name`) or object-literal keys (`{ name: value }`). Numeric array indices (e.g., `items[0]`) bypass allow/deny lists automatically.

```ts
const expr = bonsai({
  allowedProperties: ['name', 'plan']
})

expr.evaluateSync('user.name', {
  user: { name: "Alice", plan: "pro", secret: "xyz" }
}) // "Alice"

expr.evaluateSync('user.secret', {
  user: { secret: "xyz" }
}) // Error: "secret" is not in allowed properties
```

For `user.name`, only `name` is a member name; `user` is a root identifier. A
deeper path such as `account.user.name` requires `user` and `name`.

::: warning Root identifiers are always accessible
`allowedProperties` and `deniedProperties` only restrict member access after the dot. Root identifiers (the top-level keys in your context object) are never filtered. Pass a minimal context object rather than relying on property lists to hide top-level data.
:::

::: tip Use an allowlist for user-authored expressions
`allowedProperties` is the single most effective control for expressions you did not write yourself. Prefer it over a denylist, which requires anticipating every sensitive name.
:::

## Defense-in-depth hardening

Beyond the configurable property restrictions, Bonsai applies several layers of protection automatically:

| Protection | What it does |
| --- | --- |
| Own-property lookup | Root identifiers and members read own properties only. Prototype chains are never walked, so inherited members and a polluted `Object.prototype` cannot surface as values. |
| Null-prototype object literals | Objects created inside expressions (e.g., `{ a: 1 }`) use `Object.create(null)`, preventing prototype pollution through expression-constructed objects. |
| Captured safe intrinsics | Only audited string, number, and array methods are callable. Bonsai invokes captured built-ins, so receiver overrides and later prototype monkey-patches are ignored. |
| Data-only arrays | Spread copies elements by index and never consults a custom iterator; it accepts arrays only. Subclasses and arrays with own constructor/spreadability hooks are neutralized before species-producing methods run. Bundled transforms use captured operations too. |
| Branded callbacks | Higher-order methods accept only Bonsai-created lambdas, never context-supplied host callbacks. |
| Primitive-only conversion | Operators, templates, computed keys, and method arguments cannot invoke object conversion hooks. |
| Numeric index bypass | Canonical numeric array indices (e.g., `items[0]`) automatically bypass allow/deny lists, so you don't need to whitelist numeric strings. |
| Sync Promise-like guard | `evaluateSync()` detects cross-realm and custom Promise-like results and throws an actionable `BonsaiTypeError`. |

## Recommended deployment profiles

| Scenario | Recommended posture |
| --- | --- |
| Trusted internal expressions | Defaults are often fine, but still keep custom plugins small and explicit. |
| User-authored business rules | Use an allowlist, set all resource limits, validate before save, and compile only accepted expressions. |
| Higher-risk multi-tenant environments | Use the Bonsai limits plus worker/process isolation for stronger containment. |

## Resource limits

Protect against resource exhaustion before and during evaluation with structural,
depth, output-size, and work limits, plus optional time and cancellation controls.

```ts
const expr = bonsai({
  timeout: 50,                // cooperative timeout in ms (opt-in)
  maxSourceLength: 10000,     // input before tokenization
  maxTokens: 2500,            // lexical tokens
  maxAstNodes: 2000,          // syntax-tree size
  maxObjectProperties: 500,   // one object literal
  maxCallArguments: 100,      // per call, before and after spread expansion
  maxDepth: 50,               // nesting depth
  maxArrayLength: 10000,      // every produced array
  maxStringLength: 10000,     // every produced string
  maxSteps: 500000            // evaluator work (default 1,000,000)
}).seal()
```

`maxSteps` is on by default and bounds evaluator-driven work (the AST walk,
bonsai-lambda iteration, spread and literal loops, plus receiver-length charges
for linear native methods) even with
no `timeout` set. It does not count work inside an opaque host extension.

Each evaluation may override `timeout` and `maxSteps`, and may accept an
`AbortSignal`, without changing instance defaults:

```ts
await expr.evaluate(source, context, {
  timeout: 25,
  signal: request.signal
})
```

## What Bonsai does not do

| Concern | What to know |
| --- | --- |
| Custom transforms/functions | They run as normal host JavaScript. Bonsai does not sandbox code you register yourself. |
| Timeouts | Timeout checks are cooperative during evaluator traversal. They do not forcibly interrupt arbitrary synchronous host code. |
| Async cancellation | Async waits race the deadline and signal, but underlying I/O continues unless the extension cancels it. |
| Proxies | JavaScript reflection can execute Proxy traps. Pass plain data when trap execution is outside your trust boundary. |
| Hard isolation | If you need a stronger boundary, run evaluation in a worker or separate process. |

::: warning Timeouts do not interrupt host code
The `timeout` limit is cooperative: it is checked between evaluator steps. A custom transform or function that blocks synchronously for a long time will not be interrupted mid-execution. If you need hard preemption, run evaluation in a worker or separate process.
:::

::: tip For user-authored expressions
Start with a minimal plain-data context, use `allowedProperties`, tighten the
resource limits for your domain, pass request cancellation, seal the configured
instance, and treat every custom plugin as trusted application code.
:::
