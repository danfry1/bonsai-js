# Runtime

`bonsai-js/runtime` evaluates rules that were checked and compiled somewhere else, without bundling the checker. Check and compile where the full toolchain runs (a server, CI, an admin backend), turn each program into an artifact with `toArtifact()`, ship the artifacts, and evaluate them in the browser with exactly the results the compiled programs give.

| Entry | Browser size (min+gzip) |
| --- | --- |
| `bonsai-js` | about 68 KB |
| `bonsai-js/lite` | about 56 KB |
| `bonsai-js/runtime` | about 44 KB |

## Example

Declare the variables and host functions once, in a module both sides import:

```ts
import { bonsai, fn, t, toArtifact } from 'bonsai-js'
import { runtime } from 'bonsai-js/runtime'

const variables = { user: t.object({ age: t.number(), plan: t.enum('free', 'pro') }) }
const functions = {
  tier: fn({ params: [t.number()], returns: t.string(), run: (age) => (age >= 65 ? 'senior' : 'adult') }),
}

// Where rules are saved: check, compile, and store the artifact.
const env = bonsai({ variables, functions })
const rule = env.compile('user.age >= 18 && (user.plan == "pro" || tier(user.age) == "senior")', {
  expect: t.boolean(),
})
const stored = JSON.stringify(toArtifact(rule))

// In the browser: load and evaluate.
const rt = runtime({ variables, functions })
const loaded = rt.load(JSON.parse(stored), { expect: t.boolean() })
loaded.evaluateSync({ user: { age: 30, plan: 'pro' } }) // => true
loaded.evaluateSync({ user: { age: 16, plan: 'pro' } }) // => false
```

## Artifacts

`toArtifact(program)` (from `bonsai-js` and `bonsai-js/lite`) returns a frozen plain object you can store as JSON:

<!-- no-run -->
```ts
interface Artifact {
  readonly bonsai: 1 // the format version
  readonly by: string // the bonsai-js version that made it
  readonly source: string
  readonly plans: readonly Plan[] // the checker's overload choices, where it narrowed them
  readonly expect?: Type // the type the program was compiled to produce
  readonly guard: boolean // whether the result is checked against expect at run time
  readonly async: boolean
  readonly digest: string
}
```

The source stays the record: it is the rule as written, and a full environment can always compile it again. The rest is what evaluating it needs without the checker:

- **Overload choices.** Static types can decide which overload of a built-in a call uses. On an empty list typed as durations, `xs.sum()` is a zero duration; untyped, it is the number `0`. The artifact records each choice the checker made, so the runtime gives the same result.
- **The digest** covers every field, every function the expression calls (its signatures, and whether it is a host function or a built-in), and the declared type of every variable it reads. A runtime whose definitions differ in any of those refuses the artifact rather than evaluating it differently. Definitions the expression does not use do not matter.

`toArtifact` takes any program an environment compiled, including `env.check(source).program`. It returns the same object on every call for the same program and evaluates nothing. It reads the program's expected type, and the declared types of the variables it reads, as they are when it is called, so pass types built with `t` (which are frozen) rather than objects that change. It throws a `RangeError` when the expected type holds more than 100,000 type nodes. It is a function rather than a method so bundles that never make artifacts leave it out.

## runtime(options)

`runtime()` takes the same options as `bonsai()`: `variables`, `functions`, `libraries`, `limits`, `clock`, `validateContext`, `cacheSize`, and `strict`. `strict` has the same default (true when `variables` is declared) and should match the producing environment's: a strict runtime refuses an artifact that reads a variable it does not declare, as a strict checker refuses the source, so a forged artifact cannot read context keys beyond the declared ones. `fn`, `withContext`, and `t` are exported from `bonsai-js/runtime` too.

## Only the built-ins your rules call

`bonsai-js/runtime` carries every built-in function. `bonsai-js/runtime/core` is the same runtime with only the built-ins you pass in `builtins`, so a browser bundle carries just the functions its rules call:

<!-- no-run -->
```ts
// definitions.ts, shared by the server and the browser
import * as b from 'bonsai-js/builtins'
export const builtins = [b.includes, b.toLowerCase, b.some, b.now, b.days]

// server
const env = bonsai({ variables, builtins })

// browser
import { runtime } from 'bonsai-js/runtime/core'
const rt = runtime({ variables, builtins })
```

| Bundle (minified and gzipped) | Size |
| --- | --- |
| `bonsai-js/runtime/core`, a rule that calls no function | about 30 KB |
| `bonsai-js/runtime/core` with the five built-ins above | about 30 KB |
| `bonsai-js/runtime/core` with every built-in, or `bonsai-js/runtime` | about 44 KB |

- `bonsai-js/builtins` exports each built-in under its name. Import it as a namespace (`import * as b`), so names such as `map`, `keys`, and `round` do not clash with your own; bundlers keep only the members you use. Choosing them by a computed name (`b[name]`) keeps them all.
- `runtime/core` has no built-ins unless you pass them. An artifact that calls one it lacks is refused with reason `function`.
- Pass the same list to the `bonsai()` that checks the rules. A rule that calls a built-in left out is then a `CHECK` error when it is saved (`trim is a built-in this environment does not include`), not a refusal in a browser later.
- `extend({ builtins })` adds to a runtime's or an environment's built-ins.
- `builtins` takes only values from `bonsai-js/builtins`, from the same copy of the package as the runtime. A host function of a built-in's name still replaces it.

<!-- no-run -->
```ts
interface Runtime<Context> {
  load(artifact: Artifact, options?: { expect?: Type }): RuntimeProgram<Context, Result>
  evaluate(artifact: Artifact, context?: Context, options?: EvaluateOptions): Promise<unknown>
  evaluateSync(artifact: Artifact, context?: Context, options?: EvaluateOptions): unknown
  extend(options: RuntimeOptions): Runtime<Context>
}

interface RuntimeProgram<Context, Result> {
  readonly source: string
  readonly async: boolean
  evaluate(context?: Context, options?: EvaluateOptions): Promise<Result>
  evaluateSync(context?: Context, options?: EvaluateOptions): Result
}
```

`load()` returns a program that evaluates as `Program` does: the same per-evaluation options, limits, and errors. The one difference comes from passing `expect` (below): every result is checked against it. That costs steps the compiled program spends only where the checker could not prove the type, so leave a little headroom in `maxSteps`. It also means a context that does not match the declared types (with `validateContext` off) can make the loaded program throw `TYPE_ERROR` where the compiled program returns a result of the wrong type. Load an artifact once and keep the program. `rt.evaluate(artifact, ...)` and `rt.evaluateSync(artifact, ...)` load through a cache keyed by every field of the artifact (`cacheSize` entries, as in `bonsai()`), for code that only has the artifact at hand.

There is no `compile(source)` in the runtime: without the checker it could not make the checker's overload choices, so it would give different results from `env.compile(source)` under the same name.

### The expected type

Pass `expect` to `load()` for the type your code relies on. The result is typed by it, the artifact must have been compiled for exactly that type, and every result is checked against it at run time, whatever the artifact says. An artifact comes from data your client cannot vouch for, so its own `expect` and `guard` fields are not enough.

<!-- continue -->
```ts
rt.load(JSON.parse(stored), { expect: t.number() }) // throws: ARTIFACT
```

Without `expect`, the result type is `unknown`, and the artifact's own run-time check applies as recorded.

## When an artifact is refused

`load()` throws a `BonsaiArtifactError` (code `ARTIFACT`) whose `reason` says what can help, and a `TypeError` when the value is not an artifact at all. Loading reads each property of the artifact once and runs no getter. A Proxy's traps do run, once per property, and anything they throw becomes a `TypeError` with the thrown value as its `cause`. The artifact is checked against the runtime's limits before anything is parsed.

| `reason` | Meaning | What helps |
| --- | --- | --- |
| `digest` | The artifact was made with different definitions: a changed host function or variable type, an override of a built-in on one side only, a different release with a changed built-in signature, or an edited field. | A fresh artifact from definitions that match this runtime. |
| `version` | A format version, or a field, this runtime does not know. | A newer runtime. |
| `syntax` | The source uses syntax this runtime does not know. | A newer runtime. |
| `function` | The expression calls a function this runtime does not define. | Defining it here (in `functions`, or in `builtins` for `bonsai-js/runtime/core`), or a newer runtime for a new built-in. |
| `variable` | The expression reads a variable this strict runtime does not declare. | Declaring it here, or `strict: false` if the producer was not strict. |
| `limit` | The source or its plans exceed this runtime's limits, or its expected type exceeds 100,000 type nodes. | Higher limits here, or a smaller expected type. |
| `shape`, `binding`, `plan` | The artifact is malformed, including an expected type nested more than 64 deep. | A fresh artifact. |
| `expect` | It was not compiled for the expected type passed to `load()`. | Compiling with that type. |

## Deploying artifacts

An artifact loads where the functions it calls and the variables it reads are defined exactly as where it was made, so:

- **Share the definitions.** Keep `variables`, `functions`, and `libraries` in one module that the producing environment and the runtime both import.
- **Pin both sides to the same bonsai-js minor version.** A minor release may change a built-in's signature (for example a more precise result type), which changes the digest of every artifact that calls it. The artifact's `by` field records which release made it. If clients update separately from the server (cached bundles, mobile apps), store artifacts per client version, or keep the source with each artifact so the server can make it again.
- **Have a fallback for `version`, `syntax`, and `function`.** A fresh artifact cannot help with those. Show the rule as unavailable, or load the full entry and compile the source on the client:

<!-- continue -->
```ts
import { BonsaiArtifactError, type Artifact } from 'bonsai-js/runtime'

// `compileOnClient` would `await import('bonsai-js')` in an app, so only clients
// that need it download the full entry.
const compileOnClient = (source: string) =>
  bonsai({ variables, functions }).compile(source, { expect: t.boolean() })

function loadRule(artifact: Artifact) {
  try {
    return rt.load(artifact, { expect: t.boolean() })
  } catch (error) {
    if (!(error instanceof BonsaiArtifactError) || error.reason === 'digest') throw error
    return compileOnClient(artifact.source)
  }
}

loadRule(toArtifact(rule)).evaluateSync({ user: { age: 70, plan: 'free' } }) // => true
loadRule(toArtifact(rule)).evaluateSync({ user: { age: 40, plan: 'free' } }) // => false
```

The runtime does not explain or partially evaluate. For a "why was this rejected" screen in the browser, use `bonsai-js` there, or explain on the server.
