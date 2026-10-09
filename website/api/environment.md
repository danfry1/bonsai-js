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
| `cacheSize` | `number` | `256` | Compiled programs kept for `env.evaluate*(source)`, by source text. `0` disables the cache. The cache also holds at most 256K characters of source in total and never caches a source longer than 16K characters, so its memory stays bounded. |
| `clock` | `() => Date` | system clock | The source of `now()`, read once per evaluation. A result that is not a valid `Date` fails the evaluation with `HOST_CONTRACT`; a clock that throws gives `HOST_ERROR`. |
| `validateContext` | `boolean` | `false` | Check the context against the declared variable types before every evaluation. |

Without `variables` an environment is **open**: every identifier reads the context and is typed `any`. With `variables` (even `variables: {}`), or with a library that declares variables, the environment is **strict**: the checker knows the declared types and rejects any other name. A library that adds a variable therefore changes what its users may write, so adding one is a breaking change for that library. Set `strict: false` to declare some variables and still let undeclared names read the context as `any`. Variable names must be identifiers other than the keywords `true`, `false`, `null`, `let`, `in`, and `not`, and other than `__proto__`, `constructor`, and `prototype`; declaring the same variable in two libraries, or in a library and `variables`, throws a `TypeError`, as does listing a library twice.

Unknown option names and invalid values (a limit out of range, a type that is not a `t` type, a malformed host function) make `bonsai()` throw a `TypeError` or `RangeError` immediately.

```ts
import { bonsai, t } from 'bonsai-js'

const open = bonsai()
open.evaluateSync('a + b', { a: 1, b: 2 }) // => 3

const typed = bonsai({
  variables: { a: t.number(), b: t.number() },
  clock: () => new Date('2026-01-15T10:30:00Z'),
})
typed.strict // => true
typed.evaluateSync('a + b', { a: 1, b: 2 }) // => 3
typed.evaluateSync('now()', { a: 1, b: 2 }) // => 2026-01-15T10:30:00.000Z
typed.check('c').ok // => false
```

## Validating the context

The checker trusts the declared types: it assumes the context you pass matches them. A declared object type lists the fields expressions may use, and the value may have more keys (a row with extra columns is valid); the checker accounts for that, and validation accepts extra keys. If the context comes from somewhere you do not control (a JSON body, a database column), set `validateContext: true`. Every evaluation then checks the declared variables deeply before running and fails with `INVALID_CONTEXT`, naming the first path that does not match. `explain()` reports the failure in its result, and [`partial()`](/api/partial) validates the variables in `known` (except one with an unknown path inside it, which is incomplete by design). The check is proportional to the size of the data, so leave it off when the context is built by your own typed code.

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
check<E extends Type>(source: string, options?: { expect?: E }): CheckResult<Context, Infer<E>>

type CheckResult<Context, Result> = (
  | { ok: true; type: Type; diagnostics: Diagnostic[]; program: Program<Context, Result> }
  | { ok: false; type: Type | undefined; diagnostics: Diagnostic[] }
) & {
  ast: Node | undefined
  typeOf(node: Node): Type | undefined
}
```

`ok` is `false` when any diagnostic has `severity: "error"`. Warnings can appear either way. `type` is the inferred result type (undefined when the expression did not parse). See [Static Checking](/language/checking) and [Errors](/api/errors) for the `Diagnostic` shape, which includes the line, column, and a code frame of each finding.

When `ok`, `program` is the compiled expression: the same program `compile()` returns, built from this check when first read, so a rule editor that validates a rule and then saves or runs it parses and checks it once. `ast` is the checked tree and `typeOf(node)` the inferred type of any of its nodes (see [Types of nodes](/api/syntax-tree#types-of-nodes)). `program`, `ast`, and `typeOf` are not part of the JSON form, which stays `{ ok, type, diagnostics }`.

<!-- continue -->
```ts
const result = typed.check('a +')
result.ok // => false
result.diagnostics[0].code // => "SYNTAX"
result.type // => undefined

const valid = typed.check('a + 1', { expect: t.number() })
valid.ok // => true
const program = valid.ok ? valid.program : undefined
program?.evaluateSync({ a: 2, b: 0 }) // => 3
```

## env.compile(source, options?)

Parses, checks, and compiles. Returns a [Program](/api/programs). Throws `BonsaiSyntaxError`, `BonsaiCheckError`, or `BonsaiLimitError`.

<!-- no-run -->
```ts
compile<E extends Type>(source: string, options?: { expect?: E }): Program<Context, Infer<E>>
```

`expect` requires the result type and sets the program's TypeScript result type. `expect` is the only option; an unknown key (such as a misspelled `expected`) or an `expect` that is not a type built with `t` is a `TypeError`, from `check()` as well. When the checker cannot prove the result type statically (part of it is `any`, as with untyped variables or `values()` of a declared object), the result is checked at run time instead, and a mismatch is a `TYPE_ERROR`. That check walks the result, so it costs time and steps in proportion to the result's size (about 7 steps per record for a list of small maps); declare variable types to let the checker prove the result instead.

The checker proves results from the declared variable types, which describe the data you pass but are not checked against it unless `validateContext` is on. With `validateContext: true` (or data that is already known to match the declarations), the TypeScript result type always holds. Without it, a context that breaks its declarations (a string where a number is declared) can produce a result of a different type.

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

The context must be a plain object or class instance (or omitted when no variable is required); anything else, such as a `Map` or an array, is a `TypeError`, like invalid options. Its own properties are the variables. In an open environment the context's TypeScript type is `object`, so a value typed by an interface is accepted as is. A function that takes any environment, whatever its context type, can declare its parameter as a bare `Environment`. `options` are per-evaluation overrides, validated like `limits` (an unknown key or invalid value makes `evaluateSync()` throw a `TypeError` or `RangeError`, and `evaluate()` reject with one):

| Option | Type | Description |
| --- | --- | --- |
| `timeout` | `number` | Wall-clock budget in milliseconds for this evaluation (`0` for none). |
| `maxSteps` | `number` | Step budget for this evaluation, replacing the environment's (`0` for none). |
| `signal` | `AbortSignal` | Cancels the evaluation with an `ABORTED` error. |

<!-- continue -->
```ts
typed.evaluateSync('a + b', { a: 1, b: 2 }, { timeout: 50, maxSteps: 10_000 }) // => 3
```

## env.explain(source, context?, options?) and env.explainSync(source, context?, options?)

Compile through the cache and [explain](/api/explain) the result: `explain()` returns a promise, like `evaluate()`, and rejects for syntax and check errors; `explainSync()` returns the explanation and throws them.

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
