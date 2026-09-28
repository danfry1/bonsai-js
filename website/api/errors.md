# Errors

Every error Bonsai throws is a `BonsaiError` with a stable, machine-readable `code`. Messages are for people and may change between releases; codes are part of the API (adding a code is a minor change, renaming one is major).

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
| `formatted` | `string` | The message followed by a code frame, when a span is known. |
| `cause` | `unknown` | For `HOST_ERROR`, the error your host function (or a getter or Proxy in the context) threw. |

`isBonsaiError(value)` is a type guard for `BonsaiError`. Checking and evaluating an expression only ever throw `BonsaiError`s, including when your own code fails: a host function that throws (even a `BonsaiError`, for example from an evaluation it runs itself), or a getter, Proxy trap, or `then` hook in the context that throws when read (including while `validateContext` or an `expect` check reads it), becomes a `HOST_ERROR` with the original error as its `cause`. Any other error escaping from Bonsai is a bug. Invalid configuration is reported differently, as a `TypeError` or `RangeError` thrown synchronously: by `bonsai()`, `extend()`, or `fn()` (an unknown option or limit, a limit out of range, a malformed parameter list, a duplicate or invalid name), by `evaluate()` and `evaluateSync()` for invalid per-evaluation options (an unknown key, a negative `maxSteps`, a `signal` that is not an `AbortSignal`), and by `print()` for a tree the parser could not have produced.

## Classes and codes

| Class | Code | Meaning |
| --- | --- | --- |
| `BonsaiSyntaxError` | `SYNTAX` | The text is not valid Bonsai. |
| `BonsaiCheckError` | `CHECK` | Static checking failed; see `.diagnostics`. |
| `BonsaiLimitError` | `SOURCE_TOO_LONG` | The source exceeds `maxSourceLength`. |
| | `TOO_DEEP` | The syntax nests deeper than `maxDepth`, or equality walked values deeper than `maxValueDepth` (for example cyclic data). |
| | `TOO_MANY_NODES` | The syntax tree exceeds `maxNodes`. |
| | `TOO_COMPLEX` | Checking the expression would take too long (its types grow too large), even within the parse limits. |
| | `STEP_LIMIT` | Evaluation exceeded the step budget. |
| | `STRING_LIMIT` | A produced string would exceed `maxStringLength`. |
| | `LIST_LIMIT` | A produced list would exceed `maxListLength`. |
| | `PATTERN_LIMIT` | A regular expression pattern passed to `matches` exceeds `maxPatternLength`. |
| | `TIMEOUT` | Evaluation exceeded the timeout. |
| | `ABORTED` | The `AbortSignal` was aborted. |
| `BonsaiRuntimeError` | `TYPE_ERROR` | An operator or property read on values of the wrong kind. |
| | `NO_OVERLOAD` | A call's arguments match no signature at run time. |
| | `NULL_RECEIVER` | A function received `null` as its first argument without `?.`. |
| | `DIVISION_BY_ZERO` | Division or remainder by zero. |
| | `NON_FINITE` | A result would be `NaN` or infinite. |
| | `BLOCKED_PROPERTY` | A computed key is `__proto__`, `constructor`, or `prototype`. |
| | `INVALID_ARGUMENT` | An argument has the right type but an invalid value (an unparsable timestamp, an unknown time zone, a non-integer count, a regular expression the engine does not support), or the context is not an object. |
| | `ASYNC_IN_SYNC` | `evaluateSync()` on an expression that calls a host function declared `async: true`. |
| | `HOST_ERROR` | A host function threw (anything, including a `BonsaiError` from a nested evaluation), or reading the context ran host code (a getter or Proxy) that threw. |
| | `HOST_CONTRACT` | A host function broke its declaration: it returned a value that does not match `returns` (checked deeply), or returned a promise without `async: true`. |
| | `INVALID_CONTEXT` | With `validateContext`, the context does not match the declared variable types. |

`try(expr, fallback)` in an expression catches `BonsaiRuntimeError`s except `HOST_CONTRACT`, which is a bug in host code rather than a condition an expression should recover from. It never catches syntax, check, or limit errors.

## Diagnostics

`env.check()` returns, and `BonsaiCheckError.diagnostics` carries, a list of findings:

<!-- no-run -->
```ts
interface Diagnostic {
  code: DiagnosticCode
  message: string
  severity: 'error' | 'warning'
  start: number // UTF-16 offset
  end: number
}
```

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
| `NEVER_NULL` | warning | `??` applied to a value that is never `null`. |
| `MAYBE_NULL` | warning | An ordering comparison on a value that may be `null` (it is `false` when it is), or a lambda that may return `null` where a boolean is expected. |

The same mistake can surface statically or at run time depending on what the checker knows. With declared types, `"a" + price` is a `TYPE_ERROR` diagnostic and the expression does not compile. With an untyped `price`, it compiles and fails at run time with `TYPE_ERROR`.

<!-- continue -->
```ts
import { BonsaiCheckError, t } from 'bonsai-js'

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
