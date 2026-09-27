# Limits

Every limit is on by default except `timeout`. The `limits` option of `bonsai()` changes the budgets. For `timeout` and `maxSteps`, `0` means no limit, and for `cacheSize` it disables the cache; for the other limits `0` rejects everything they bound.

| Limit | Default | Bounds |
| --- | --- | --- |
| `maxSourceLength` | 100000 | Expression length in UTF-16 code units. |
| `maxDepth` | 128 | Syntactic nesting depth. |
| `maxNodes` | 20000 | Syntax tree size (tokens are bounded at four times this). |
| `maxSteps` | 1000000 | Work per evaluation: lambda calls and every element touched by equality, membership, concatenation, spread, templates, and built-ins. |
| `maxStringLength` | 100000 | Length of any string an expression produces. |
| `maxListLength` | 100000 | Length of any list an expression produces. |
| `maxValueDepth` | 64 | Nesting walked by equality and templates. Cyclic data fails here instead of looping. |
| `timeout` | 0 (none) | Wall-clock milliseconds per evaluation. |
| `cacheSize` | 256 | Compiled programs kept per environment for `env.evaluate*(source)`. `0` disables the cache. |

```ts
import { bonsai } from 'bonsai-js'

const env = bonsai({
  limits: { maxSourceLength: 2_000, maxSteps: 50_000, maxListLength: 10_000, timeout: 100 },
})

env.evaluateSync('xs.map(. * 2).sum()', { xs: [1, 2, 3] }) // => 12
env.evaluateSync('xs.map(. * 2)', { xs: Array.from({ length: 20_000 }, (_, i) => i) }) // throws: LIST_LIMIT
```

<!-- continue -->
```ts
env.evaluateSync('xs.filter(. > 5).length', { xs: Array.from({ length: 60_000 }, (_, i) => i) }) // throws: STEP_LIMIT
env.evaluateSync('"x".padStart(200000)') // throws: STRING_LIMIT
env.evaluateSync('1'.padEnd(3000, ' + 1')) // throws: SOURCE_TOO_LONG
```

`timeout` and `maxSteps` can also be set per evaluation, together with an `AbortSignal`, without changing the environment:

<!-- continue -->
```ts
const controller = new AbortController()
await env.evaluate('xs.length', { xs: [] }, { timeout: 25, maxSteps: 1_000, signal: controller.signal }) // => 0
```

## Parse limits and evaluation limits

Parse limits (`maxSourceLength`, `maxDepth`, `maxNodes`) are enforced before anything runs. `env.check()` reports them as a `LIMIT` diagnostic; `compile()` and `evaluate*()` throw a `BonsaiLimitError`.

Evaluation limits are enforced while an expression runs. Sizes are checked before a string or list is allocated, so an expression cannot allocate a large value and fail afterwards. The step budget is deterministic: the same expression over the same data always uses the same number of steps, whatever the machine.

## What limits do not cover

- **Host functions.** A synchronous host function that is already running cannot be interrupted; the timeout is checked when it returns. Give slow functions their own limits.
- **Waiting on async host functions.** The timeout and signal stop the evaluation while it waits, but the underlying work (a network request, a query) continues unless your function cancels it.
- **Getters and Proxies in the context.** They are your code and run when read.

Limit errors are never caught by `try(...)` in an expression.
