# bonsai(options?)

Create one configured evaluator instance and reuse it anywhere you need expression execution, validation, or compiled rules.

```ts
import { bonsai } from 'bonsai-js'

// Default instance
const expr = bonsai()

// Restricted instance for user-authored expressions
const safe = bonsai({
  timeout: 50,
  maxSourceLength: 10000,
  maxTokens: 2500,
  maxDepth: 50,
  maxArrayLength: 10000,
  maxSteps: 100000,
  allowedProperties: ['age', 'country', 'plan']
}).seal()
```

## Choose the right API

| If you need... | Use... |
|---|---|
| Repeated evaluations with custom options, plugins, or cache reuse | `bonsai()` |
| A quick one-off evaluation with default behavior | `evaluateExpression()` |
| A reusable hot-path rule object | `compile()` |
| Syntax checks and reference extraction before execution | `validate()` |
| Schema and extension type checking | `bonsai-js/checker` |
| Async transforms or async functions | `evaluate()` |
| Lowest-overhead sync execution | `evaluateSync()` |

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxSourceLength` | number | 100000 | Maximum UTF-16 source length before tokenization. |
| `maxTokens` | number | 25000 | Maximum lexical token count, excluding EOF. |
| `maxAstNodes` | number | 10000 | Maximum parser/compiler node count. |
| `maxObjectProperties` | number | 10000 | Maximum properties in one object literal. |
| `maxCallArguments` | number | 1000 | Maximum arguments in one call, checked syntactically and again after spread expansion. |
| `timeout` | number | 0 | Evaluation timeout in milliseconds. `0` disables timeout checks. |
| `maxDepth` | number | 100 | Maximum traversal depth before a `MAX_DEPTH` security error is thrown. |
| `maxArrayLength` | number | 100000 | Maximum array produced by the language, a method, transform, or function. |
| `maxStringLength` | number | 100000 | Maximum string produced by the language, a method, transform, or function. |
| `maxSteps` | number | 1000000 | Deterministic evaluator-work budget covering AST work, lambdas, spread/literal loops, and work estimates before linear native methods (receiver length, or the copied span for `slice`). Opaque extension work is excluded. `0` disables it. |
| `cacheSize` | number | 256 | Per-instance cache size for compiled expressions and parsed AST reuse. |
| `allowedProperties` | string[] | - | Allowlist for member and method names. Root identifiers and object keys are not filtered. |
| `deniedProperties` | string[] | - | Denylist for member and method names. Root identifiers and object keys are not filtered. |

Blocked names like `__proto__`, `constructor`, and `prototype` are always denied. For `user.name`, only `name` is a member name; `user` is a root identifier.

## Common setups

| Scenario | Suggested approach |
|---|---|
| App-owned expressions in trusted code | Use `bonsai()` with defaults and load only the stdlib/plugins you need. |
| User-authored rules in an admin UI | Tighten structural/runtime limits, pass an `AbortSignal`, use an `allowedProperties` allowlist, and seal the instance after setup. |
| Large catalog of repeated expressions | Reuse one instance and consider increasing `cacheSize` if you have many distinct expression strings. |

::: tip Create the instance once at startup and reuse it
Recreating instances on every request throws away the cache and defeats most of the performance work.
:::

::: tip Seal production instances after setup
`seal()` permanently prevents extension registration, replacement, and removal. This keeps a shared production instance deterministic after its plugins are loaded.
:::
