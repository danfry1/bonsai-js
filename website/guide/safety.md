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
  allowedProperties: ['user', 'name', 'plan']
})

expr.evaluateSync('user.name', {
  user: { name: "Alice", plan: "pro", secret: "xyz" }
}) // "Alice"

expr.evaluateSync('user.secret', {
  user: { secret: "xyz" }
}) // Error: "secret" is not in allowed properties
```

If you want to permit `user.name`, you must allow both `user` and `name` as member names. Root identifiers like `user` in `evaluateSync('user.name', { user })` are always accessible - the allow/deny lists only restrict what comes after the dot. Use an allowlist for user-authored expressions whenever possible.

## Defense-in-depth hardening

Beyond the configurable property restrictions, Bonsai applies several layers of protection automatically:

| Protection | What it does |
| --- | --- |
| Own-property-only lookup | Root identifiers are resolved via `Object.hasOwn()`, so context prototype chains cannot leak inherited properties into expressions. |
| Null-prototype object literals | Objects created inside expressions (e.g., `{ a: 1 }`) use `Object.create(null)`, preventing prototype pollution through expression-constructed objects. |
| Receiver-aware method validation | Method calls validate that the receiver is a safe type (string, number, array, or plain object). Calling methods on unexpected receiver types throws a `BonsaiTypeError`. |
| Numeric index bypass | Canonical numeric array indices (e.g., `items[0]`) automatically bypass allow/deny lists, so you don't need to whitelist numeric strings. |
| Sync Promise guard | `evaluateSync()` detects `Promise` return values from transforms, functions, and methods, and throws an actionable `BonsaiTypeError` naming the offending call and suggesting `evaluate()`. |

## Recommended deployment profiles

| Scenario | Recommended posture |
| --- | --- |
| Trusted internal expressions | Defaults are often fine, but still keep custom plugins small and explicit. |
| User-authored business rules | Use an allowlist, set all resource limits, validate before save, and compile only accepted expressions. |
| Higher-risk multi-tenant environments | Use the Bonsai limits plus worker/process isolation for stronger containment. |

## Resource limits

Protect against resource exhaustion with `timeout`, `maxDepth`, and `maxArrayLength`.

```ts
const expr = bonsai({
  timeout: 50,          // cooperative timeout in ms
  maxDepth: 50,         // max nesting depth
  maxArrayLength: 10000 // max array size
})
```

## What Bonsai does not do

| Concern | What to know |
| --- | --- |
| Custom transforms/functions | They run as normal host JavaScript. Bonsai does not sandbox code you register yourself. |
| Timeouts | Timeout checks are cooperative during evaluator traversal. They do not forcibly interrupt arbitrary synchronous host code. |
| Async callbacks | Async time is checked at awaited boundaries, not by cancellation of the underlying I/O. |
| Hard isolation | If you need a stronger boundary, run evaluation in a worker or separate process. |

> **Tip:** For user-authored expressions, start with a minimal context object, use `allowedProperties`, set all three limits, and treat every custom plugin as trusted application code.
