# Feature Flag Targeting

This recipe is for products where people outside engineering decide who sees a feature: a product manager writes `user.plan != "free" || bucket(user.id, 100) < 20`, and the service evaluates it on every request. It builds a small flag service that checks rules when they are saved, compiles them once, evaluates them per request within a budget, and tells a bad rule apart from a bug in your own code.

## Declare what a rule can read

Declare the request context once with `t`. The declaration drives checking, editor completions, the TypeScript type of the context, and validation of request data. Limits bound the work any one rule can do, since the rules are written by people you do not fully trust; see [A hardened setup](/guide/safety#a-hardened-setup).

```ts
import { bonsai, fn, t, type InferVariables } from 'bonsai-js'

const variables = {
  user: t.object({
    id: t.string(),
    plan: t.enum('free', 'pro', 'enterprise'),
    country: t.string(),
    createdAt: t.timestamp(),
    zone: t.optional(t.string()),
  }),
  request: t.object({ path: t.string(), at: t.timestamp() }),
}
type FlagContext = InferVariables<typeof variables>

const flags = bonsai({
  variables,
  validateContext: true,
  limits: { maxSourceLength: 2_000, maxSteps: 20_000, timeout: 10 },
  functions: {
    // A stable bucket from 0 to n - 1 for an id, for percentage rollouts.
    bucket: fn({
      params: [t.string(), t.number()],
      returns: t.number(),
      description: 'A stable bucket from 0 to n - 1 for an id.',
      cost: 2,
      run: (id, n) => {
        let hash = 0
        for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
        return hash % n
      },
    }),
  },
})
```

`bucket` is cheap and pure, so it declares a low `cost` instead of the default 32 steps. The same id always lands in the same bucket, so a user stays in or out of a 20% rollout from one request to the next.

## Check a rule when it is saved

`check()` never evaluates and never throws for a bad expression. Show its diagnostics to the person editing the flag, and save the rule only when `ok` is `true`. `expect: t.boolean()` rejects a rule that does not produce a yes or no.

<!-- continue -->
```ts
const draft = flags.check('user.plann == "pro"', { expect: t.boolean() })
draft.ok // => false
draft.diagnostics.map((d) => [d.code, d.message, d.position.line, d.position.column]) // => [["UNKNOWN_PROPERTY", "Property \"plann\" does not exist on user; did you mean \"plan\"?", 1, 6]]
draft.diagnostics[0]?.suggestion // => "plan"

flags.check('user.plan', { expect: t.boolean() }).diagnostics[0]?.code // => "EXPECTED_TYPE"
flags.check('user.plan != "free" || bucket(user.id, 100) < 20', { expect: t.boolean() }).ok // => true
```

Each diagnostic has `start` and `end` offsets to underline the problem, and `formatted`, the message with a code frame. For completions and hover in the editor, see [Editor Support](/guide/editor-support).

## Compile once, evaluate per request

Compile each flag when it is loaded and keep the program. A program checks, compiles, and caches its source once; evaluating it is cheap.

<!-- continue -->
```ts
import type { Program } from 'bonsai-js'

const saved: Record<string, string> = {
  newCheckout: 'user.plan != "free" || bucket(user.id, 100) < 20',
  euPricing: 'user.country in ["DE", "FR", "NL"]',
  weekendSale: 'dayOfWeek(request.at, user.zone ?? "UTC") >= 6',
}
const programs = new Map<string, Program<FlagContext, boolean>>()
for (const [key, source] of Object.entries(saved)) {
  programs.set(key, flags.compile(source, { expect: t.boolean() }))
}
```

Request data usually arrives as JSON, where dates are text. Revive the fields declared as timestamps while parsing; `validateContext` then rejects anything that still does not match the declaration, with the path of the bad field (see [Context validation](/api/environment)).

<!-- continue -->
```ts
const timestampFields = new Set(['createdAt', 'at'])
function parseContext(body: string): FlagContext {
  return JSON.parse(body, (key, value: unknown) =>
    timestampFields.has(key) && typeof value === 'string' ? new Date(value) : value,
  ) as FlagContext
}

const context = parseContext(`{
  "user": { "id": "u42", "plan": "free", "country": "DE", "createdAt": "2024-01-01T00:00:00Z", "zone": "Europe/Berlin" },
  "request": { "path": "/checkout", "at": "2026-10-17T09:00:00Z" }
}`)

programs.get('euPricing')?.evaluateSync(context) // => true
programs.get('weekendSale')?.evaluateSync(context) // => true
```

## Percentage rollouts

`bucket(user.id, 100) < 20` puts a fixed 20% of users in the rollout. Raising the number to 50 keeps everyone who was already in, because each id keeps its bucket.

<!-- continue -->
```ts
const twenty = flags.compile('bucket(user.id, 100) < 20', { expect: t.boolean() })
const fifty = flags.compile('bucket(user.id, 100) < 50', { expect: t.boolean() })
const users = Array.from({ length: 1_000 }, (_, i) => ({ ...context, user: { ...context.user, id: `user-${i}` } }))

const inTwenty = users.filter((u) => twenty.evaluateSync(u))
inTwenty.length > 150 && inTwenty.length < 250 // => true
inTwenty.every((u) => fifty.evaluateSync(u)) // => true
```

To roll out per flag rather than for every flag at once, hash the flag key with the id: `bucket(user.id + ":newCheckout", 100) < 20`.

## Time windows and time zones

Calendar functions take an IANA time zone, so a rule can follow the user's local time: `dayOfWeek(request.at, user.zone ?? "UTC") >= 6` is the weekend where the user is.

<!-- continue -->
```ts
const lunch = flags.compile('hour(request.at, user.zone ?? "UTC") >= 11 && hour(request.at, user.zone ?? "UTC") < 14', {
  expect: t.boolean(),
})
lunch.evaluateSync(context) // => true
lunch.evaluateSync({ ...context, user: { ...context.user, zone: null } }) // => false
```

A zone that is not an IANA name (`"EST"`, `"+02:00"`) is an `INVALID_ARGUMENT` error when the rule runs. Compiling a rule loads the time zone data it needs, so the first request does not spend its `timeout` on it; a zone that comes from data is loaded on first use, and a service with a tight `timeout` can evaluate its rules once at startup with the zones it expects (see [Limits](/api/limits)).

## Fallbacks

`try(expr, fallback)` recovers from runtime errors inside a rule, for example a host function that calls a service that is down: `try(segment(user.id) == "beta", false)`. It turns the failure into `false` silently, so log host failures inside the function and rethrow them, as in [Logging failures](/api/host-functions#logging-failures). Limit errors are never caught by `try()`, so a rule cannot hide that it ran out of budget.

## Tell rule mistakes from bugs

Every error is a `BonsaiError` with a stable `code`. Sort them by who has to act:

<!-- continue -->
```ts
import { BonsaiLimitError, isBonsaiError } from 'bonsai-js'

type Outcome = { on: boolean } | { off: true; fault: 'rule' | 'data' | 'host' | 'budget'; code: string }

function decide(key: string, input: FlagContext): Outcome {
  const program = programs.get(key)
  if (program === undefined) return { off: true, fault: 'rule', code: 'UNKNOWN_FLAG' }
  try {
    return { on: program.evaluateSync(input) }
  } catch (error) {
    if (!isBonsaiError(error)) throw error
    if (error instanceof BonsaiLimitError) return { off: true, fault: 'budget', code: error.code }
    if (error.code === 'INVALID_CONTEXT') return { off: true, fault: 'data', code: error.code }
    if (error.code === 'HOST_ERROR' || error.code === 'HOST_CONTRACT') return { off: true, fault: 'host', code: error.code }
    return { off: true, fault: 'rule', code: error.code }
  }
}

decide('euPricing', context) // => { on: true }
decide('euPricing', parseContext('{ "user": { "id": "u1" }, "request": {} }')) // => { off: true, fault: "data", code: "INVALID_CONTEXT" }
decide('weekendSale', { ...context, user: { ...context.user, zone: 'EST' } }) // => { off: true, fault: "rule", code: "INVALID_ARGUMENT" }
```

- **Rule mistakes** (`TYPE_ERROR`, `INVALID_ARGUMENT`, `NULL_RECEIVER`, ...) belong to the flag's author: show them next to the flag, with `error.formatted`.
- **Bad data** (`INVALID_CONTEXT`) is the caller's request; the message names the field.
- **Host bugs** (`HOST_ERROR`, `HOST_CONTRACT`) are your code: `error.cause` holds what your function threw.
- **Budget** (`STEP_LIMIT`, `TIMEOUT`, ...) means the rule is too expensive for the limits you set; `error.limit` names the limit.

`JSON.stringify(error)` gives one documented shape for logs ([Errors](/api/errors)).

## Performance

Compiling is the expensive step, so do it once per saved rule, as above; `flags.evaluateSync(source, context)` also caches compiled programs by source. Evaluating a compiled flag takes under a microsecond for rules like these on current hardware; `validateContext` adds a walk of the context to every evaluation, which costs more than the rule itself. When one request evaluates many flags, validate it once with the first flag and pass `{ validateContext: false }` to the rest:

<!-- continue -->
```ts
const results: Record<string, boolean> = {}
let validated = false
for (const [key, program] of programs) {
  results[key] = program.evaluateSync(context, { validateContext: !validated })
  validated = true
}
results // => { newCheckout: false, euPricing: true, weekendSale: true }
```

See [Performance](/guide/performance) for budgets and measurements.
