# Limits

Every limit is on by default except `timeout`. The `limits` option of `bonsai()` changes the budgets. For `timeout` and `maxSteps`, `0` means no limit. `timeout` is a number of milliseconds and may be fractional; every other limit must be a positive integer, and `bonsai()` throws a `RangeError` for an invalid value or a `TypeError` for an unknown limit name.

| Limit | Default | Bounds |
| --- | --- | --- |
| `maxSourceLength` | 100000 | Expression length in UTF-16 code units. |
| `maxDepth` | 128 | Syntactic nesting depth. Runs of `&&`, `\|\|`, and `??` are balanced and use few levels; other chains use a level per link (`a + b + c + ...`, `a ? x : b ? y : ...`, runs of `let`). For long lookup ladders, use a map: `{gold: 0.2, silver: 0.1}[tier] ?? 0`. At most 256. |
| `maxNodes` | 20000 | Syntax tree size (tokens are bounded at four times this). Checking and compiling are charged against this budget too. |
| `maxSteps` | 1000000 | Work per evaluation. See [Steps](#steps). |
| `maxStringLength` | 100000 | Length of any string an expression produces. |
| `maxListLength` | 100000 | Length of any list an expression produces. |
| `maxValueDepth` | 64 | Nesting of lists and maps an expression builds, and of values walked by equality, templates, `unique`, and `validateContext`. Cyclic data fails here (`VALUE_DEPTH_LIMIT`) instead of looping. At most 1,024. |
| `maxPatternLength` | 4096 | Length of a regular expression pattern passed to `matches` (`PATTERN_LIMIT`). |
| `timeout` | 0 (none) | Wall-clock milliseconds per evaluation. |

The program cache is not a limit: its size is the top-level [`cacheSize`](/api/environment#options) option.

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

## Steps

The step budget is the main guarantee against expensive expressions. Every operation charges steps in proportion to its real worst-case cost, before it runs:

- lambda calls, and every element touched by equality, membership, concatenation, spread, and templates;
- characters scanned by text functions (`includes`, `indexOf`, `split`, `replace`, comparisons, and sorting of text), including the pattern and text of a search;
- regular expressions, charged for compiling the pattern and for every step of the match;
- sorting, charged per comparison and by the size of what is compared;
- calendar and time zone functions (`startOfDay`, `addMonths`, `formatDate`, ...), which cost more than arithmetic;
- the size of lists and maps an expression builds;
- the length of every string an expression produces (concatenation, templates, `repeat`, `padStart`, `replace`, `formatDate`, ...), at 1 step per 32 characters, so the default budget bounds the text an evaluation builds to about 32 million characters (to build long text in a loop, use `join` rather than appending in `reduce`);
- every runtime error, at 64 steps, so errors caught by `try()` are not free;
- resources such as a compiled pattern or a time zone, charged before they are created, whether or not creating them succeeds.

No single operation can do unbounded work between checks, so the budget bounds time as well as work. At the default budget of 1,000,000 steps, ordinary expressions finish in about 40 ms of work per million steps on Node, and the slowest expressions we know of finish or fail within about 150 ms (measured on Node 24; most within 100 ms).

The step count is deterministic: the same expression over the same data always uses the same number of steps, whatever the machine or its load. That makes `maxSteps` the right limit for rejecting expensive expressions consistently. `timeout` is wall-clock time and varies with load; use it to bound time spent in your own host functions.

## Parse limits and evaluation limits

Parse limits (`maxSourceLength`, `maxDepth`, `maxNodes`) are enforced before anything runs, and they also bound the work of checking and compiling. `env.check()` reports them as a `LIMIT` diagnostic; `compile()` and `evaluate*()` throw a `BonsaiLimitError`.

`maxDepth` and `maxValueDepth` are capped (a larger value is a `RangeError`) at about half the depth at which the smallest JavaScript call stack measured (Node 22) runs out, so every stage stays inside the stack. If the stack still runs out (a host with a smaller stack, or deep host data), the error is a `BonsaiLimitError` with code `TOO_DEEP`, never a raw `RangeError`.

Evaluation limits are enforced while an expression runs. Sizes are checked before a string or list is allocated, so an expression cannot allocate a large value and fail afterwards. The one exception is case conversion: `toUpperCase` and `toLowerCase` can lengthen text (`"ß"` becomes `"SS"`, `"ﬃ"` becomes `"FFI"`), so their result, at most three times the length of a string that was itself within the limit, is checked as soon as it is made.

## What limits do not cover

- **Host functions.** A synchronous host function that is already running cannot be interrupted; the timeout is checked when it returns. Give slow functions their own limits, and set `timeout` when expressions call them.
- **Waiting on async host functions.** The timeout and signal stop the evaluation while it waits, but the underlying work (a network request, a query) continues unless your function cancels it. Each host call costs its function's `cost` in steps (default 32), so at the default budget an expression can make at most about 31,000 calls to a default-cost function: batch expensive lookups in the host, declare a higher `cost` for functions that do I/O, or lower `maxSteps` for expressions that call them.
- **Getters and Proxies in the context.** They are your code and run when read.

Limit errors are never caught by `try(...)` in an expression.
