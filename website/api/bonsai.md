# bonsai(options?)

Create one configured evaluator instance and reuse it anywhere you need expression execution, validation, or compiled rules.

```ts
import { bonsai } from 'bonsai-js'

// Default instance
const expr = bonsai()

// Restricted instance for user-authored expressions
const safe = bonsai({
  timeout: 50,
  maxDepth: 50,
  maxArrayLength: 10000,
  allowedProperties: ['user', 'age', 'country', 'plan']
})
```

## Choose the right API

| If you need... | Use... |
|---|---|
| Repeated evaluations with custom options, plugins, or cache reuse | `bonsai()` |
| A quick one-off evaluation with default behavior | `evaluateExpression()` |
| A reusable hot-path rule object | `compile()` |
| Syntax checks and reference extraction before execution | `validate()` |
| Async transforms or async functions | `evaluate()` |
| Lowest-overhead sync execution | `evaluateSync()` |

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | number | 0 | Evaluation timeout in milliseconds. `0` disables timeout checks. |
| `maxDepth` | number | 100 | Maximum traversal depth before a `MAX_DEPTH` security error is thrown. |
| `maxArrayLength` | number | 100000 | Maximum array literal or expanded spread size. |
| `cacheSize` | number | 256 | Per-instance cache size for compiled expressions and parsed AST reuse. |
| `allowedProperties` | string[] | - | Allowlist checked against every accessed identifier and member name. |
| `deniedProperties` | string[] | - | Denylist checked against every accessed identifier and member name. |

Blocked names like `__proto__`, `constructor`, and `prototype` are always denied. If you want to allow `user.name`, you must allow both `user` and `name`.

## Common setups

| Scenario | Suggested approach |
|---|---|
| App-owned expressions in trusted code | Use `bonsai()` with defaults and load only the stdlib/plugins you need. |
| User-authored rules in an admin UI | Set `timeout`, `maxDepth`, `maxArrayLength`, and an `allowedProperties` allowlist. |
| Large catalog of repeated expressions | Reuse one instance and consider increasing `cacheSize` if you have many distinct expression strings. |

> **Tip:** Create the instance once at startup and reuse it. Recreating instances on every request throws away the cache and defeats most of the performance work.
