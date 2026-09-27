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
| `cause` | `unknown` | For `HOST_ERROR`, the error your host function threw. |

`isBonsaiError(value)` is a type guard for `BonsaiError`. Any error that is not a `BonsaiError` escaping from Bonsai is a bug, apart from `TypeError`s thrown synchronously by `bonsai()` and `fn()` for invalid configuration (an invalid limit, a duplicate function name).

## Classes and codes

| Class | Code | Meaning |
| --- | --- | --- |
| `BonsaiSyntaxError` | `SYNTAX` | The text is not valid Bonsai. |
| `BonsaiCheckError` | `CHECK` | Static checking failed; see `.diagnostics`. |
| `BonsaiLimitError` | `SOURCE_TOO_LONG` | The source exceeds `maxSourceLength`. |
| | `TOO_DEEP` | The syntax nests deeper than `maxDepth`, or equality walked values deeper than `maxValueDepth` (for example cyclic data). |
| | `TOO_MANY_NODES` | The syntax tree exceeds `maxNodes`. |
| | `STEP_LIMIT` | Evaluation exceeded the step budget. |
| | `STRING_LIMIT` | A produced string would exceed `maxStringLength`. |
| | `LIST_LIMIT` | A produced list would exceed `maxListLength`. |
| | `TIMEOUT` | Evaluation exceeded the timeout. |
| | `ABORTED` | The `AbortSignal` was aborted. |
| `BonsaiRuntimeError` | `TYPE_ERROR` | An operator or property read on values of the wrong kind. |
| | `NO_OVERLOAD` | A call's arguments match no signature at run time. |
| | `NULL_RECEIVER` | A function received `null` as its first argument without `?.`. |
| | `DIVISION_BY_ZERO` | Division or remainder by zero. |
| | `NON_FINITE` | A result would be `NaN` or infinite. |
| | `BLOCKED_PROPERTY` | A computed key is `__proto__`, `constructor`, or `prototype`. |
| | `INVALID_ARGUMENT` | An argument has the right type but an invalid value (an unparsable timestamp, an unknown time zone, a non-integer count), or the context is not an object. |
| | `ASYNC_IN_SYNC` | `evaluateSync()` on an expression that calls an async host function, or a host function not declared async returned a promise. |
| | `HOST_ERROR` | A host function threw, or returned a value that does not match its declared result type. |
| | `INVALID_CONTEXT` | With `validateContext`, the context does not match the declared variable types. |

`try(expr, fallback)` in an expression catches `BonsaiRuntimeError`s. It never catches syntax, check, or limit errors.

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

| Diagnostic code | Meaning |
| --- | --- |
| `SYNTAX` | A syntax error, reported by `check()` instead of thrown. |
| `LIMIT` | A parse limit, reported by `check()` instead of thrown. |
| `UNKNOWN_VARIABLE` | An undeclared variable in a strict environment. |
| `UNKNOWN_PROPERTY` | A field a closed record or map literal does not have. |
| `UNKNOWN_FUNCTION` | A call to a function that does not exist. |
| `NO_OVERLOAD` | Arguments that match no signature. |
| `TYPE_ERROR` | Operands of incompatible types. Also the code of every warning. |
| `NULLABLE_RECEIVER` | A possibly-null value where `null` is not accepted. |
| `INVALID_LAMBDA` | A misplaced `.` or lambda. |
| `BLOCKED_PROPERTY` | A blocked key used as a static key. |
| `EXPECTED_TYPE` | The result does not match `expect`. |
| `INVALID_ARGUMENT` | A literal argument with an invalid value, such as an unknown `formatDate` pattern letter. |
| `DUPLICATE_BINDING` | Reserved. Rebinding a name currently fails as a syntax error. |

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
  (error as BonsaiCheckError).diagnostics.length // => 1
}
```

## Displaying errors to users

`formatted` is suitable for logs and terminals. In a UI, use `span` (or a diagnostic's `start` and `end`) to underline the range in the editor, and show `message` as text. Messages quote parts of the expression, so insert them with `textContent` rather than as HTML.
