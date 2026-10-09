# Errors

Every error Bonsai throws is a `BonsaiError` with a stable, machine-readable `code`. Messages are for people and may change between releases; codes are part of the API (adding a code is a minor change, renaming one is major). Because codes can be added, a `switch` over `ErrorCode` (or `DiagnosticCode`, or a diagnostic's `severity`) needs a `default` branch: an exhaustiveness check against `never` would stop compiling when a minor release adds a member.

```ts
import { bonsai, BonsaiError, BonsaiRuntimeError, isBonsaiError } from 'bonsai-js'

const env = bonsai()

try {
  env.evaluateSync('1 / (count - 3)', { count: 3 })
} catch (error) {
  if (isBonsaiError(error)) {
    error.code // => "DIVISION_BY_ZERO"
    error instanceof BonsaiRuntimeError // => true
    error.message // => "Division by zero"
    error.position // => { line: 1, column: 1 }
    console.log(error.formatted)
    // Division by zero
    // 1 | 1 / (count - 3)
    //   | ^^^^^^^^^^^^^^^
  }
}
```

## BonsaiError

| Property | Type | Description |
| --- | --- | --- |
| `code` | `ErrorCode` | The stable error code. |
| `message` | `string` | A human-readable message. |
| `source` | `string \| undefined` | The expression text, when known. |
| `span` | `{ start, end } \| undefined` | UTF-16 offsets of the offending part of the source. |
| `position` | `{ line, column } \| undefined` | 1-based position of `span.start`. |
| `formatted` | `string` | The message followed by a code frame, when a span is known. The frame shows at most 120 columns of the line around the span, with `...` where the line is cut. |
| `cause` | `unknown` | For `HOST_ERROR`, the error your host function (or a getter or Proxy in the context) threw. |

`isBonsaiError(value)` is a type guard for `BonsaiError`. Checking and evaluating an expression only ever throw `BonsaiError`s, including when your own code fails: a host function that throws (even a `BonsaiError`, for example from an evaluation it runs itself), or a getter, Proxy trap, or `then` hook in the context that throws when read (including while `validateContext` or an `expect` check reads it), becomes a `HOST_ERROR` with the original error as its `cause`. Any other error escaping from Bonsai is a bug. Invalid configuration is reported differently, as a `TypeError` or `RangeError` thrown synchronously: by `bonsai()`, `extend()`, or `fn()` (an unknown option or limit, a limit out of range, a malformed parameter list, a duplicate or invalid name), for invalid per-evaluation options and a context that is not an object (an unknown key, a negative `maxSteps`, a `signal` that is not an `AbortSignal`, a `Map` or a string as the context: `evaluateSync()` throws, and `evaluate()` returns a rejected promise), and by `print()` for a tree the parser could not have produced.

## JSON form

`JSON.stringify(error)` gives the same shape wherever an error is serialized: thrown, in an explanation's JSON, or in a partial result. It holds `name`, `code`, `message`, and, when known, `span` and `position`; a limit error adds `limit`, and a check error adds `diagnostics`. The source text and the `cause` are left out (the cause can be any value your host code threw), so store the source alongside the error if you need it. The `BonsaiErrorJSON` type describes the shape.

<!-- continue -->
```ts
let caught: unknown
try {
  env.evaluateSync('1 / (count - 3)', { count: 3 })
} catch (error) {
  caught = error
}
JSON.parse(JSON.stringify(caught)).code // => "DIVISION_BY_ZERO"
JSON.parse(JSON.stringify(caught)).position // => { line: 1, column: 1 }
```

The error classes are for `instanceof` checks and reading fields. Their constructors are not public API: Bonsai creates its errors, and the constructor parameters may change in a minor release.

## Classes and codes

| Class | Code | Meaning |
| --- | --- | --- |
| `BonsaiSyntaxError` | `SYNTAX` | The text is not valid Bonsai. |
| `BonsaiCheckError` | `CHECK` | Static checking failed; see `.diagnostics`. |
| `BonsaiLimitError` | `SOURCE_TOO_LONG` | The source exceeds `maxSourceLength`. |
| | `TOO_DEEP` | The syntax nests deeper than `maxDepth`. |
| | `TOO_MANY_NODES` | The syntax tree exceeds `maxNodes`. |
| | `TOO_COMPLEX` | Checking the expression would take too long (its types grow too large), even within the parse limits. |
| | `STEP_LIMIT` | Evaluation exceeded the step budget. |
| | `STRING_LIMIT` | A produced string would exceed `maxStringLength`. |
| | `LIST_LIMIT` | A produced list would exceed `maxListLength`. |
| | `VALUE_DEPTH_LIMIT` | A value nests deeper than `maxValueDepth`: one an expression builds, one equality, templates, or `unique` walk (for example cyclic data), or the context `validateContext` checks. |
| | `PATTERN_LIMIT` | A regular expression pattern passed to `matches` exceeds `maxPatternLength`. |
| | `TIMEOUT` | Evaluation exceeded the timeout. |
| | `ABORTED` | The `AbortSignal` was aborted. |
| `BonsaiRuntimeError` | `TYPE_ERROR` | An operator or property read on values of the wrong kind. |
| | `NO_OVERLOAD` | A call's arguments match no signature at run time. |
| | `NULL_RECEIVER` | A function received `null` as its first argument without `?.`. |
| | `DIVISION_BY_ZERO` | Division or remainder by zero. |
| | `NON_FINITE` | A result would be `NaN` or infinite. |
| | `BLOCKED_PROPERTY` | A map literal writes a computed key that is `__proto__`, `constructor`, or `prototype` (reading one is `null`). |
| | `INVALID_ARGUMENT` | An argument has the right type but an invalid value (an unparsable timestamp, an unknown time zone, a non-integer count, a regular expression the engine does not support). |
| | `ASYNC_IN_SYNC` | `evaluateSync()` (or `explainSync()`) on an expression that calls a host function declared `async: true`. |
| | `HOST_ERROR` | A host function threw (anything, including a `BonsaiError` from a nested evaluation), or reading the context ran host code (a getter or Proxy) that threw. |
| | `HOST_CONTRACT` | Host code broke its contract: a host function returned a value that does not match `returns` (checked deeply) or a promise without `async: true`, or the `clock` returned something other than a valid `Date`. |
| | `INVALID_CONTEXT` | With `validateContext`, the context does not match the declared variable types. |
| `BonsaiTranslationError` | `UNTRANSLATABLE` | From `bonsai-js/query`: part of a filter has no exact SQL or MongoDB equivalent. See [Database Filters](./query). |

`try(expr, fallback)` in an expression catches `BonsaiRuntimeError`s except `HOST_CONTRACT`, which is a bug in host code rather than a condition an expression should recover from. It never catches syntax, check, or limit errors.

A `BonsaiLimitError` also names the option that bounds it in `limit`, so you can tell which one to raise: `'maxSourceLength'`, `'maxDepth'`, `'maxNodes'`, `'maxSteps'`, `'maxStringLength'`, `'maxListLength'`, `'maxValueDepth'`, `'maxPatternLength'`, `'timeout'`, or `'signal'` (for `ABORTED`). It is `undefined` for a fixed internal bound: `TOO_COMPLEX`, and `TOO_DEEP` from template nesting. The `LimitName` type lists the values; like codes, values may be added in a minor release.

<!-- continue -->
```ts
import { BonsaiLimitError } from 'bonsai-js'

let limitName: string | undefined
try {
  bonsai({ limits: { maxSteps: 5 } }).evaluateSync('[1, 2, 3, 4, 5, 6].map(x => x)')
} catch (error) {
  if (error instanceof BonsaiLimitError) limitName = error.limit
}
limitName // => "maxSteps"
```

## Diagnostics

`env.check()` returns, and `BonsaiCheckError.diagnostics`, `program.warnings`, and the language service carry, a list of findings. Each one locates itself the way a `BonsaiError` does:

<!-- no-run -->
```ts
interface Diagnostic {
  code: DiagnosticCode
  message: string
  severity: 'error' | 'warning'
  start: number // UTF-16 offset (the same as span.start)
  end: number
  span: { start: number; end: number }
  position: { line: number; column: number } // 1-based, of start
  formatted: string // the message and a code frame; an accessor: not in the JSON form, not copied by spread
  suggestion?: string // for UNKNOWN_VARIABLE, UNKNOWN_PROPERTY, UNKNOWN_FUNCTION: the name to use instead
}
```

An admin screen can show `formatted` as it is, and an editor quick-fix can replace the range with `suggestion`: for these codes the range is the misspelled name itself (for `order.totl`, only `totl`). A name the source does not spell out plainly, such as an escaped key in `x["..."]`, has no `suggestion`:

<!-- continue -->
```ts
import { t } from 'bonsai-js'

const shop = bonsai({ variables: { order: t.object({ total: t.number() }) } })
const [finding] = shop.check('ordr.total > 100').diagnostics
finding?.position // => { line: 1, column: 1 }
finding?.suggestion // => "order"
console.log(finding?.formatted)
// Unknown variable "ordr"; did you mean "order"?
// 1 | ordr.total > 100
//   | ^^^^
```

`DiagnosticCode` and `severity` may gain members in a minor release, so a `switch` over them needs a `default` branch.

Errors have `severity: "error"` and make `check()` return `ok: false`. Warnings (`severity: "warning"`) point at expressions that are valid but probably wrong; they appear in `check().diagnostics` and in `program.warnings` without stopping compilation.

| Diagnostic code | Severity | Meaning |
| --- | --- | --- |
| `SYNTAX` | error | A syntax error, reported by `check()` instead of thrown. |
| `LIMIT` | error | A parse or checking limit, reported by `check()` instead of thrown. |
| `UNKNOWN_VARIABLE` | error | An undeclared variable in a strict environment. |
| `UNKNOWN_PROPERTY` | error | A field a declared object type or map literal does not have. |
| `UNKNOWN_FUNCTION` | error | A call to a function that does not exist. |
| `NO_OVERLOAD` | error | Arguments that match no signature. |
| `TYPE_ERROR` | error | Operands of incompatible types. |
| `NULLABLE_RECEIVER` | error | A possibly-null value where `null` is not accepted. |
| `INVALID_LAMBDA` | error | A misplaced `.` or lambda. |
| `BLOCKED_PROPERTY` | error | A blocked key used as a static key. |
| `EXPECTED_TYPE` | error | The result does not match `expect`. |
| `INVALID_ARGUMENT` | error | A literal argument with an invalid value, such as an unknown `formatDate` pattern letter. |
| `ALWAYS_FALSE` | warning | A comparison or membership test that can never hold, such as `plan == "premium"` when `plan` is `"free" \| "pro"`. |
| `ALWAYS_TRUE` | warning | The negation of one: `!=` or `not in` that always holds, such as `plan != "premium"`. |
| `NEVER_NULL` | warning | `??` applied to a value that is never `null`. |
| `MAYBE_NULL` | warning | A value that may be `null` where it decides something: an ordering comparison (it is `false`), the operand of `!`, `&&`, or `\|\|`, a `?:` condition, or what a lambda returns where a boolean is expected (null counts as `false`, which `!` turns into `true`). |
| `UNSAFE_INTEGER` | warning | A number literal past 2^53, where neighbouring integers are not all distinct: `9007199254740993` reads as `9007199254740992`. |

The same mistake can surface statically or at run time depending on what the checker knows. With declared types, `"a" + price` is a `TYPE_ERROR` diagnostic and the expression does not compile. With an untyped `price`, it compiles and fails at run time with `TYPE_ERROR`.

<!-- continue -->
```ts
import { BonsaiCheckError } from 'bonsai-js'

const typed = bonsai({ variables: { price: t.number() } })
typed.check('"a" + price').diagnostics[0].code // => "TYPE_ERROR"
typed.evaluateSync('"a" + price', { price: 1 }) // throws: CHECK
env.evaluateSync('"a" + price', { price: 1 }) // throws: TYPE_ERROR

try {
  typed.compile('"a" + price')
} catch (error) {
  error instanceof BonsaiCheckError // => true
  const checkError = error as BonsaiCheckError
  checkError.diagnostics.length // => 1
}
```

## Displaying errors to users

`formatted` is suitable for logs and terminals. In a UI, use `span` (or a diagnostic's `start` and `end`) to underline the range in the editor, and show `message` as text. Messages quote parts of the expression, so insert them with `textContent` rather than as HTML.
