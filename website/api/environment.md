# bonsai() and Environment

<!-- no-run -->
```ts
import { bonsai } from 'bonsai-js'

const env = bonsai(options?)
```

`bonsai()` creates an **environment**: the variables, functions, and limits that expressions are checked and evaluated against. Environments are immutable and safe to share. Create one per configuration and reuse it; it owns a cache of compiled programs.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `variables` | `Record<string, Type>` | none | Declared context variables and their [types](/api/types). Also types the context argument in TypeScript. |
| `strict` | `boolean` | `true` with `variables`, `false` without | Report undeclared variables as errors. With `strict: false`, an undeclared variable reads the context and has type `any`. |
| `functions` | `Record<string, HostFunction>` | none | [Host functions](/api/host-functions) by name, created with `fn()`. A host function replaces a built-in of the same name. |
| `libraries` | `Library[]` | none | Bundles of host functions and variables. A function name defined twice is an error. |
| `limits` | `Limits` | all on | Resource limits. See [Limits](/api/limits). |
| `cacheSize` | `number` | `256` | Compiled programs kept for `env.evaluate*(source)`, by source text. `0` disables the cache. |
| `clock` | `() => Date` | system clock | The source of `now()`, read once per evaluation. |
| `validateContext` | `boolean` | `false` | Check the context against the declared variable types before every evaluation. |

Without `variables` an environment is **open**: every identifier reads the context and is typed `any`. With `variables`, the environment is **strict**: the checker knows the declared types and rejects any other name. Set `strict: false` to declare some variables and still let undeclared names read the context as `any`.

Unknown option names and invalid values (a limit out of range, a type that is not a `t` type, a malformed host function) make `bonsai()` throw a `TypeError` or `RangeError` immediately.

```ts
import { bonsai, t } from 'bonsai-js'

const open = bonsai()
open.evaluateSync('a + b', { a: 1, b: 2 }) // => 3

const typed = bonsai({
  variables: { a: t.number(), b: t.number() },
  strict: true, // the default when variables are declared
  clock: () => new Date('2026-01-15T10:30:00Z'),
})
typed.evaluateSync('a + b', { a: 1, b: 2 }) // => 3
typed.evaluateSync('now()') // => 2026-01-15T10:30:00.000Z
typed.check('c').ok // => false
```

## Validating the context

The checker trusts the declared types: it assumes the context you pass matches them. A declared object type lists the fields expressions may use, and the value may have more keys (a row with extra columns is valid); the checker accounts for that, and validation accepts extra keys. If the context comes from somewhere you do not control (a JSON body, a database column), set `validateContext: true`. Every evaluation then checks the declared variables deeply before running and fails with `INVALID_CONTEXT`, naming the first path that does not match. The check is proportional to the size of the data, so leave it off when the context is built by your own typed code.

<!-- continue -->
```ts
const validated = bonsai({
  variables: { user: t.object({ age: t.number(), tags: t.list(t.string()) }) },
  validateContext: true,
})
const input = JSON.parse('{ "user": { "age": "36", "tags": [] } }')
validated.evaluateSync('user.age >= 18', input) // throws: INVALID_CONTEXT
```

Without validation, the same mismatch surfaces as a runtime `TYPE_ERROR` where the value is used, or not at all.

## env.check(source, options?)

Parses and checks without evaluating. Never throws for a bad expression: syntax errors, limit errors, and check findings are all returned as diagnostics.

<!-- no-run -->
```ts
check(source: string, options?: { expect?: Type }): CheckResult

type CheckResult =
  | { ok: true; type: Type; diagnostics: Diagnostic[] }
  | { ok: false; type: Type | undefined; diagnostics: Diagnostic[] }
```

`ok` is `false` when any diagnostic has `severity: "error"`. Warnings can appear either way. `type` is the inferred result type (undefined when the expression did not parse). See [Static Checking](/language/checking) and [Errors](/api/errors) for the `Diagnostic` shape.

<!-- continue -->
```ts
const result = typed.check('a +')
result.ok // => false
result.diagnostics[0].code // => "SYNTAX"
result.type // => undefined
```

## env.compile(source, options?)

Parses, checks, and compiles. Returns a [Program](/api/programs). Throws `BonsaiSyntaxError`, `BonsaiCheckError`, or `BonsaiLimitError`.

<!-- no-run -->
```ts
compile<E extends Type>(source: string, options?: { expect?: E }): Program<Context, Infer<E>>
```

`expect` requires the result type and sets the program's TypeScript result type. When the checker cannot prove the result type statically (part of it is `any`, as with untyped variables or `values()` of a declared object), the result is checked at run time instead, and a mismatch is a `TYPE_ERROR`, so the TypeScript result type always holds.

<!-- continue -->
```ts
const sum = typed.compile('a + b', { expect: t.number() })
sum.evaluateSync({ a: 2, b: 3 }) // => 5
typed.compile('a + b', { expect: t.string() }) // throws: CHECK
```

## env.evaluateSync(source, context?, options?)

Compiles (through the cache) and evaluates synchronously. Throws if the expression calls an `async` host function (`ASYNC_IN_SYNC`, before any host code runs).

## env.evaluate(source, context?, options?)

Compiles (through the cache) and evaluates, returning a promise. Required when an expression calls an `async` host function; otherwise it runs the synchronous path and resolves with the result. Errors, including syntax and check errors, reject the promise.

<!-- continue -->
```ts
await typed.evaluate('a * b', { a: 3, b: 4 }) // => 12
await typed.evaluate('a *', { a: 3, b: 4 }) // throws: SYNTAX
```

The context must be an object (or omitted when no variable is required). Its own properties are the variables. `options` are per-evaluation overrides:

| Option | Type | Description |
| --- | --- | --- |
| `timeout` | `number` | Wall-clock budget in milliseconds for this evaluation. |
| `maxSteps` | `number` | Step budget for this evaluation, replacing the environment's. |
| `signal` | `AbortSignal` | Cancels the evaluation with an `ABORTED` error. |

<!-- continue -->
```ts
typed.evaluateSync('a + b', { a: 1, b: 2 }, { timeout: 50, maxSteps: 10_000 }) // => 3
```

## env.extend(options)

Returns a new environment with more variables, functions, or libraries, and optionally different `strict`, `limits`, or `clock`. The original is unchanged. Adding a function that the base environment already defines as a host function replaces it; defining the same name twice within one `extend()` call is an error.

<!-- continue -->
```ts
const withTax = typed.extend({ variables: { rate: t.number() } })
withTax.evaluateSync('(a + b) * (1 + rate)', { a: 50, b: 50, rate: 0.2 }) // => 120
typed.check('rate').ok // => false
```

## env.listFunctions() and env.describeFunction(name)

`listFunctions()` returns every callable function, host functions first, then built-ins. `describeFunction(name)` returns one, or `undefined`. Use them to build documentation or custom tooling; the [built-in reference](/functions/) on this site is generated from `listFunctions()`.

<!-- no-run -->
```ts
interface FunctionInfo {
  name: string
  description: string
  host: boolean // declared by the host rather than built in
  async: boolean
  signatures: { params: Type[]; required: number; rest?: Type; returns: Type }[]
}
```

<!-- continue -->
```ts
const round = typed.describeFunction('round')!
round.description // => "Rounds half away from zero, optionally to a number of decimal digits."
round.signatures[0].required // => 1
typed.describeFunction('nope') // => undefined
```

## env.parse(source)

Parses without checking and returns the syntax tree (`Node`). Nodes are plain JSON-serializable objects with `start` and `end` offsets. Treat node types as an open set: new ones may be added in minor releases.

<!-- continue -->
```ts
typed.parse('a + 1').type // => "Binary"
```

## env.variables and env.strict

The declared variables (or `undefined` for an open environment) and the strict flag.
