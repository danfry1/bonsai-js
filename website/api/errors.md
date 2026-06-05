# Error Handling

Match on exported error classes and security codes instead of parsing message text.

## Runtime error classes

| Class | When | Key Properties |
|---|---|---|
| `ExpressionError` | Parse errors (invalid syntax) | `source`, `start`, `end`, `rawMessage`, `suggestion?` |
| `BonsaiTypeError` | Wrong runtime value type or sync/async mismatch | `transform`, `expected`, `received`, `location?`, `formatted?` |
| `BonsaiReferenceError` | Unknown transform, function, or method | `kind`, `identifier`, `suggestion?`, `location?`, `formatted?` |
| `BonsaiSecurityError` | Security violations | `code`, `location?`, `formatted?` |

Evaluation-time errors carry a `location` when the runtime can attach one, plus a preformatted `formatted` message for direct display. Parse errors expose `source`, `start`, `end`, and the raw (unformatted) `rawMessage` directly.

| Stage | Recommended handling |
|---|---|
| Authoring time | Run `validate()` and show the formatted parse error inline. |
| Execution time | Catch exported error classes and branch on the class or security `code`. |
| Logging/monitoring | Record the original source string and structured fields, not just the message text. |

## formatError(message, location, suggestion?) / formatBonsaiError(error)

```ts
import { formatError, formatBonsaiError } from 'bonsai-js'

formatError('Unexpected token "*"', {
  source: '1 + * 2',
  start: 4,
  end: 5,
})

try {
  expr.evaluateSync('customerName |> upper', {
    customerName: 42
  })
} catch (e) {
  console.log(formatBonsaiError(e))
}
```

## Security error codes

`BonsaiSecurityError` uses a `code` property to identify the type of violation:

| Code | Description |
|---|---|
| `TIMEOUT` | Expression exceeded the configured timeout |
| `BLOCKED_PROPERTY` | Access to `__proto__`, `constructor`, or `prototype` |
| `PROPERTY_NOT_ALLOWED` | Property not in `allowedProperties` allowlist |
| `PROPERTY_DENIED` | Property is in `deniedProperties` denylist |
| `METHOD_NOT_ALLOWED` | Method call not permitted by the security policy |
| `MAX_DEPTH` | Expression nesting exceeded `maxDepth` |
| `MAX_ARRAY_LENGTH` | Array size exceeded `maxArrayLength` |
| `MAX_STRING_LENGTH` | String size exceeded `maxStringLength` |

## Type guards

Bonsai exports two type guards for narrowing caught errors without relying on `instanceof`:

```ts
import { isBonsaiError, isBonsaiRuntimeError } from 'bonsai-js'
```

| Guard | Narrows to | Covers |
|---|---|---|
| `isBonsaiError(e)` | `BonsaiError` | All errors Bonsai throws (parse and runtime) |
| `isBonsaiRuntimeError(e)` | `BonsaiRuntimeError` | Runtime errors only (excludes `ExpressionError`) |

Use `isBonsaiError` in a `catch` to narrow `unknown` to `BonsaiError`, then switch on `error.name` or read the per-error fields:

```ts
import {
  isBonsaiError,
  isBonsaiRuntimeError,
  formatBonsaiError,
} from 'bonsai-js'

try {
  expr.evaluateSync('customerName |> unknownTransform', {
    customerName: "Alicia"
  })
} catch (e) {
  if (isBonsaiError(e)) {
    switch (e.name) {
      case 'BonsaiReferenceError':
        console.log(e.kind)       // "transform"
        console.log(e.identifier)  // "unknownTransform"
        console.log(e.suggestion)  // "upper" (if similar name exists)
        console.log(e.location)    // { start: 15, end: 31 }
        console.log(e.formatted)   // full source-highlighted message
        break
      case 'BonsaiSecurityError':
        console.log(e.code)        // "TIMEOUT", "BLOCKED_PROPERTY", etc.
        console.log(formatBonsaiError(e))
        break
      case 'ExpressionError':
        console.log(e.rawMessage)  // raw parse error description
        console.log(e.source)      // the original expression string
        break
    }
  }
}
```

## Catching errors

You can also match on error classes directly with `instanceof`:

```ts
import {
  ExpressionError,
  BonsaiTypeError,
  BonsaiReferenceError,
  BonsaiSecurityError,
  formatError,
  formatBonsaiError
} from 'bonsai-js'

try {
  expr.evaluateSync('customerName |> unknownTransform', {
    customerName: "Alicia"
  })
} catch (e) {
  if (e instanceof BonsaiReferenceError) {
    console.log(e.kind)       // "transform"
    console.log(e.identifier)  // "unknownTransform"
    console.log(e.suggestion)  // "upper" (if similar name exists)
    console.log(e.location)    // { start: 15, end: 31 }
    console.log(e.formatted)   // full source-highlighted message
  } else if (e instanceof BonsaiSecurityError) {
    console.log(e.code)        // "TIMEOUT", "BLOCKED_PROPERTY", etc.
    console.log(formatBonsaiError(e))
  } else if (e instanceof ExpressionError) {
    console.log(e.rawMessage)  // raw parse error description
    console.log(e.source)      // the original expression string
  }
}
```

::: tip Match on the error class or security code
Message text can change between releases. The exported error classes and the `BonsaiSecurityError.code` values are stable API.
:::
