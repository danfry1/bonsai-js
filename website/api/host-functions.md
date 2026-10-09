# Host Functions

Host functions add capabilities the language does not have: looking up exchange rates, checking permissions, calling your domain logic. They are declared with `fn()` and passed to `bonsai({ functions })`. Expressions call them like built-ins, in either form: `hasRole("admin")` or `order.convert("EUR")`.

## fn(spec)

```ts
import { bonsai, fn, t } from 'bonsai-js'

const env = bonsai({
  functions: {
    discount: fn({
      params: [t.number(), t.number()],
      returns: t.number(),
      description: 'Applies a fractional discount to a price.',
      run: (price, rate) => price * (1 - rate),
    }),
  },
})

env.evaluateSync('discount(200, 0.1)') // => 180
env.evaluateSync('(200).discount(0.25)') // => 150
```

| Field | Type | Description |
| --- | --- | --- |
| `params` | `Type[]` | Parameter types, in order. The types of `run`'s arguments are inferred from them. |
| `returns` | `Type` | The declared result type. The result is checked deeply against it at run time. When it is nullable (`t.optional(...)`), `run` may also return `undefined`, which reads as `null`. |
| `run` | function | The implementation. |
| `required` | `number` | How many leading parameters are required (default: all). Missing optional arguments arrive as `null`, so optional parameters must be declared with `t.optional(...)`. |
| `rest` | `Type` | The type of further variadic arguments; `run`'s rest parameter is typed from it. |
| `async` | `boolean` | `run` returns a promise. The expression must be evaluated with `evaluate()`. |
| `call` | `boolean` | `run` receives a `{ context, signal }` call object before its arguments. See [The call](#the-call-context-and-cancellation). |
| `description` | `string` | Shown by `listFunctions()` and in editor completions and hover. |
| `cost` | `number` | Steps charged per call, a non-negative integer (default 32). Lower it for cheap pure helpers so they do not use up the budget; raise it for calls that reach a database or network. |

## What Bonsai guarantees around your function

- **Checked calls.** The checker rejects calls whose arguments do not match `params` (`NO_OVERLOAD`) before anything runs. At run time, arguments are validated before `run` is called, so `run` only ever receives values of the declared types.
- **Checked results.** A result that does not match `returns` (checked deeply, through lists and maps) is a `HOST_CONTRACT` error, so a bug in your function cannot leak an unexpected value into the expression. So is a promise returned by a function not declared `async`. `try(...)` never catches `HOST_CONTRACT`: it signals a bug in host code, not a condition the expression should hide.
- **Wrapped failures.** An exception thrown by `run` becomes a `BonsaiRuntimeError` with code `HOST_ERROR` and the original error as its `cause`, whatever was thrown, including a `BonsaiError` (for example a limit error from an evaluation `run` performs itself). Expressions can recover from it with `try(...)`.
- **A fixed cost per call.** Each call is charged `cost` steps (default 32) against the step budget, however long `run` takes. The budget therefore bounds how many calls one evaluation can make, not the time your function spends.

<!-- continue -->
```ts
env.check('discount("a", 1)').diagnostics[0].code // => "NO_OVERLOAD"

const guarded = bonsai({
  functions: {
    failing: fn({ params: [], returns: t.number(), run: () => { throw new Error('service down') } }),
  },
})
guarded.evaluateSync('failing()') // throws: HOST_ERROR
guarded.evaluateSync('try(failing(), -1)') // => -1
```

<!-- continue -->
```ts
const broken = bonsai({
  functions: {
    wrongType: fn({ params: [], returns: t.number(), run: () => 'oops' as unknown as number }),
    wrongShape: fn({ params: [], returns: t.list(t.number()), run: () => ['a'] as unknown as number[] }),
  },
})
broken.evaluateSync('wrongType()') // throws: HOST_CONTRACT
broken.evaluateSync('wrongShape()') // throws: HOST_CONTRACT
broken.evaluateSync('try(wrongType(), -1)') // throws: HOST_CONTRACT
```

## Optional and variadic parameters

<!-- continue -->
```ts
const text = bonsai({
  functions: {
    greet: fn({
      params: [t.string(), t.optional(t.string())],
      required: 1,
      returns: t.string(),
      run: (name, greeting) => `${greeting ?? 'Hello'}, ${name}`,
    }),
    total: fn({
      params: [],
      rest: t.number(),
      returns: t.number(),
      run: (...values) => values.reduce((sum, v) => sum + v, 0),
    }),
  },
})
text.evaluateSync('greet("Ada")') // => "Hello, Ada"
text.evaluateSync('"Ada".greet("Hi")') // => "Hi, Ada"
text.evaluateSync('total(1, 2, 3)') // => 6
```

## The call: context and cancellation

With `call: true`, `run` receives a frozen `call` object before the declared parameters: `call.context` is the evaluation context, and `call.signal` is an `AbortSignal` for this call. The context is your caller's own object (typed read-only, not copied or frozen), so do not change it: other parts of the evaluation, and your caller, see the same object. Expressions stay short, and the function reads what it needs:

<!-- continue -->
```ts
const auth = bonsai({
  functions: {
    hasRole: fn({
      params: [t.string()],
      returns: t.boolean(),
      call: true,
      run: (call, role) => (call.context.roles as string[]).includes(role),
    }),
  },
})
auth.evaluateSync('hasRole("admin")', { roles: ['admin', 'editor'] }) // => true
```

To type the context, create functions with `withContext<Context>()`. It returns an `fn` variant whose `run` receives the call with `call.context` typed as `Readonly<Context>`:

<!-- continue -->
```ts
import { withContext } from 'bonsai-js'

interface AppContext {
  user: { id: string; roles: string[] }
}
const contextFn = withContext<AppContext>()

const app = bonsai({
  functions: {
    userId: contextFn({ params: [], returns: t.string(), run: (call) => call.context.user.id }),
    can: contextFn({
      params: [t.string()],
      returns: t.boolean(),
      run: (call, role) => call.context.user.roles.includes(role),
    }),
  },
})
app.evaluateSync('can("admin") ? userId() : "anonymous"', { user: { id: 'u_1', roles: ['admin'] } }) // => "u_1"
```

The type parameter is a promise you make: Bonsai passes whatever context the evaluation received. Declare the same shape as `variables` with `validateContext: true` if the context is not built by your own typed code.

## Async functions

Declare `async: true` for a function that returns a promise. The expression must then be evaluated with `evaluate()`; `evaluateSync()` rejects it with `ASYNC_IN_SYNC` before any host code runs. Waiting on an async function honors the evaluation's timeout and `AbortSignal`: the evaluation stops waiting with `TIMEOUT` or `ABORTED`. To stop the function's own work too, declare it `call: true` and pass `call.signal` on: it aborts, with that error as its `reason`, when the evaluation stops waiting.

<!-- continue -->
```ts
const rates: Record<string, number> = { EUR: 1.1, GBP: 1.3 }
const fx = bonsai({
  functions: {
    fxRate: fn({
      params: [t.string()],
      returns: t.number(),
      async: true,
      run: async (currency) => rates[currency] ?? 1,
    }),
  },
})
await fx.evaluate('amounts.map(.value * fxRate(.currency)).sum()', {
  amounts: [{ value: 10, currency: 'EUR' }, { value: 10, currency: 'GBP' }],
}) // => 24
fx.evaluateSync('fxRate("EUR")') // throws: ASYNC_IN_SYNC
```

With `call: true`, an async function can stop its own work when the evaluation gives up on it, for example by passing the signal to `fetch(url, { signal: call.signal })`:

<!-- continue -->
```ts
const slow = bonsai({
  functions: {
    lookup: fn({
      params: [t.string()],
      returns: t.string(),
      async: true,
      call: true,
      run: (call, id) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve(id), 1000)
          call.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(call.signal.reason)
          })
        }),
    }),
  },
})
await slow.evaluate('lookup("a")', {}, { timeout: 50 }) // throws: TIMEOUT
```

Calls run one at a time, left to right, in async mode too: an expression cannot start several host calls concurrently. If a function reaches a network or database, prefetch the data into the context or batch inside your function.

A function that is not declared `async` must not return a promise; doing so is a `HOST_CONTRACT` error.

## Replacing built-ins

A host function with the same name as a built-in replaces it in that environment. This is also why adding built-ins in a minor release is safe: your own function keeps taking precedence.

<!-- continue -->
```ts
const shouting = bonsai({
  functions: {
    toUpperCase: fn({ params: [t.string()], returns: t.string(), run: (s) => `${s.toUpperCase()}!` }),
  },
})
shouting.evaluateSync('"hi".toUpperCase()') // => "HI!"
```

Names must be identifiers and cannot be `has`, `try`, or a reserved word.

## Libraries

A `Library` bundles functions (and optionally variable declarations) under a name, for sharing between environments or packages. Declare it with `satisfies Library` so its variables keep their types: they become part of the context type of every environment that lists the library (inline, or in an `as const` array), so a context missing them does not compile:

<!-- continue -->
```ts
import type { Library } from 'bonsai-js'

const money = {
  name: 'money',
  functions: {
    cents: fn({ params: [t.number()], returns: t.number(), run: (amount) => Math.round(amount * 100) }),
  },
  variables: { currency: t.string() },
} satisfies Library

const shop = bonsai({ libraries: [money] })
shop.evaluateSync('`${cents(12.34)} ${currency}`', { currency: 'EUR' }) // => "1234 EUR"
```

A name defined by two libraries, or by a library and `functions`, is an error when the environment is created. Use `env.extend({ functions })` to derive an environment that overrides a function.

## Security notes

Host functions are trusted code and run with full privileges. Limits cannot interrupt a synchronous function that is already running, so give slow functions their own timeouts, and validate inputs that reach sensitive systems. Arguments are Bonsai values: lists and maps may be your own context data, so do not mutate them.
