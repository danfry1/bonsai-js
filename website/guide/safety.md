# Safety

Bonsai is designed to evaluate expression text written by people you do not fully trust (customers, admins, rule authors) against data and functions you do trust. This page summarizes what an expression can and cannot do, and what remains your responsibility. The full threat model is in [docs/threat-model.md](https://github.com/danfry1/bonsai-js/blob/main/docs/threat-model.md).

## Trust boundaries

| Party | Trusted? | Notes |
| --- | --- | --- |
| Expression text | No | May be arbitrary and adversarial. |
| Context data you pass in | Yes | Its getters and Proxies are your code and run when read. |
| Host functions you declare | Yes | They run with full privileges. |
| The Bonsai package | Yes | Zero runtime dependencies. |

## What an expression cannot do

**Run code.** There is no `eval`, `new Function`, or generated code. The only callable things are built-in functions and the host functions you declared. A function value found in data can be compared but never called, and `x.f()` always resolves `f` among the declared functions, never on `x`.

**Reach prototypes or globals.** A property read returns an own property of a plain map. Inherited members, class methods, and prototype getters never resolve. `__proto__`, `constructor`, and `prototype` are rejected as syntax, as computed keys, and in keys spread from host data. Maps created by expressions have a null prototype.

<!-- context: { user: { name: "Ada" } } -->
```bonsai
user.__proto__ // error: SYNTAX
user["constructor"] // error: BLOCKED_PROPERTY
user.toString // => null
```

**Trigger conversion hooks.** Templates, comparisons, keys, and arithmetic never call `valueOf`, `toString`, `toJSON`, or `Symbol.toPrimitive`. Built-ins use their own loops, never the receiver's methods, iterators, or `Symbol.species`.

**Mutate your data.** No operator or built-in modifies its input. `sort` and `reverse` return new lists.

**Exhaust resources.** Every expression terminates. Straight-line code is bounded by the parse limits, and anything proportional to data (lambda calls, equality, membership, concatenation, spread, templates, built-ins) charges a step budget. Produced strings and lists are size-checked before they are allocated, and cyclic data fails closed on the depth limit. See [Limits](/api/limits).

**Escape into async work.** A host function must be declared `async: true` to be awaited. `evaluateSync()` rejects an expression that calls one before any host code runs. A promise returned from a function not declared async is an error, a thenable in the context is inert data, and `evaluate()` refuses to return a promise-like value.

## What remains your responsibility

- **Host functions are your code.** Validate their inputs if they reach sensitive systems and give them their own timeouts. A synchronous host function that is already running cannot be interrupted.
- **Getters and Proxies run when read.** Pass plain data when the context contains anything sensitive or expensive to compute.
- **Only put in the context what expressions may see.** Every own property of the context is readable. Build a dedicated context object rather than passing a whole database row or request.
- **Set a timeout on interactive paths.** The step budget bounds work deterministically but not wall-clock time spent inside host functions.
- **Bonsai is not a process boundary.** If your host functions or context data are themselves untrusted, evaluate in a worker or a separate process.

## A hardened setup

```ts
import { bonsai, t } from 'bonsai-js'

const env = bonsai({
  variables: {
    account: t.object({ plan: t.enum('free', 'pro'), seats: t.number() }),
  },
  strict: true, // undeclared variables are errors
  limits: { maxSourceLength: 2_000, maxSteps: 50_000, timeout: 50 },
})

const source = 'account.plan == "pro" && account.seats > 5' // from a user
const result = env.check(source, { expect: t.boolean() })
result.ok // => true

// Save only expressions that pass the check, then evaluate the saved text:
const rule = env.compile(source, { expect: t.boolean() })
const controller = new AbortController()
rule.evaluateSync({ account: { plan: 'pro', seats: 10 } }, { signal: controller.signal }) // => true
```

Checking at save time rejects typos and type errors before they reach production:

<!-- continue -->
```ts
env.check('account.billingEmail').diagnostics[0].code // => "UNKNOWN_PROPERTY"
```

::: warning Types are not access control
A closed `t.object` type stops `account.billingEmail` from checking, but it does not hide data. A computed index with a dynamic key (`account[key]`) and `keys()`, `values()`, or `entries()` read every own property of the value you pass at run time, declared or not. The context you pass is the only boundary on what an expression can read.
:::

<!-- context: { account: { plan: "pro", seats: 10, internalNotes: "do not show" } } -->
```bonsai
account.keys() // => ["plan", "seats", "internalNotes"]
```
