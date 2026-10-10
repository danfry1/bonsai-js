# Language Service

```ts
import { createLanguageService } from 'bonsai-js/service'
```

`createLanguageService(env)` returns editor features computed from an environment's static information: declared variables, built-ins, host functions, and their types and descriptions. Nothing in the service evaluates an expression or calls a host function. For a guided introduction, see [Editor Support](/guide/editor-support).

<!-- no-run -->
```ts
function createLanguageService(env: Environment, options?: LanguageServiceOptions): LanguageService

interface LanguageServiceOptions {
  // The type every expression must have, as check(source, { expect }) takes it.
  expect?: Type
}

interface LanguageService {
  complete(source: string, offset: number): CompletionResult
  hover(source: string, offset: number): HoverResult | undefined
  diagnostics(source: string): readonly Diagnostic[]
}
```

Offsets are UTF-16 code unit offsets into `source`, the same unit as JavaScript string indices and `Diagnostic.start`/`end`. An offset past the end (or `NaN`) means the end; a negative or fractional offset throws a `RangeError`. A bare `Environment` accepts an environment of any context type.

With `expect`, diagnostics include `EXPECTED_TYPE` when an expression cannot have that type, as `env.check(source, { expect })` reports it. A filter editor passes `t.boolean()`, so `account.mrr` is flagged while it is typed:

```ts
import { bonsai, t } from 'bonsai-js'
import { createLanguageService } from 'bonsai-js/service'

const env = bonsai({ variables: { account: t.object({ mrr: t.number() }) } })
const filters = createLanguageService(env, { expect: t.boolean() })
filters.diagnostics('account.mrr')[0].code // => "EXPECTED_TYPE"
filters.diagnostics('account.mrr > 100') // => []
```

## complete(source, offset)

<!-- no-run -->
```ts
interface CompletionResult {
  start: number // start of the range to replace (the partially typed name)
  end: number // end of that range
  items: readonly Completion[]
}

interface Completion {
  label: string
  kind: 'value' | 'variable' | 'local' | 'property' | 'function' | 'method' | 'keyword'
  detail: string // a type, or one signature per line
  documentation?: string
  insertText: string
  // Set when this item replaces a different range than the result's start..end:
  // a field that is not a plain name is inserted as ["first-name"] in place of the "." before it.
  range?: { start: number; end: number }
}
```

What is offered depends on the cursor:

| Cursor | Items |
| --- | --- |
| At the start of a name | the current item `.` (inside a lambda argument), `let` bindings and lambda parameters in scope, declared variables, every function, and keywords |
| After `.` or `?.` | the fields of the receiver's type, `length` for strings and lists, and the functions whose first parameter accepts the receiver (as methods) |
| Inside a string or comment, or after a digit | nothing |

Items are filtered by what has been typed so far (prefix matches first, then substring matches) and ordered by kind: locals, properties, variables, methods, functions, keywords. New kinds may be added in a minor release, so handle unknown ones. The service completes incomplete expressions by guessing the missing closing brackets and the missing rest of each enclosing `?:`, `let`, `try(x, fallback)`, or computed key `[k]: v`, nested ones included (`let v = try(b ? user.`), so it works in the middle of typing. Each guess costs a parse of the whole text, so a completion makes at most 100 of them, and fewer in a very long rule (about 12 near the 100,000 character limit, enough for a single open construct but not always for deep nesting). When the text before the cursor has a mistake of its own, it offers nothing. A field's detail is the type that reading it there has, as `check()` and hover report it: `nullable.` details `string | null`, and inside `x.c != null ? x.` the field `c` details `string`.

```ts
import { bonsai, t } from 'bonsai-js'
import { createLanguageService } from 'bonsai-js/service'

const env = bonsai({
  variables: { items: t.list(t.object({ sku: t.string(), qty: t.number() })) },
})
const service = createLanguageService(env)

const inLambda = service.complete('items.filter(.q', 15)
inLambda.start // => 14
inLambda.items[0].label // => "qty"
inLambda.items[0].detail // => "number"

const methods = service.complete('items.so', 8)
methods.items.map((item) => item.label) // => ["some", "sort", "sortBy"]
methods.items[0].insertText // => "some("
```

## hover(source, offset)

<!-- no-run -->
```ts
interface HoverResult {
  start: number
  end: number
  detail: string // the type, or the function's signatures
  documentation?: string // the function's description
}
```

Returns the type of the innermost expression at `offset`, or, on a function name, its signatures and description. Returns `undefined` when the source does not parse or nothing is under the cursor.

<!-- continue -->
```ts
service.hover('items.map(.qty).sum()', 17)?.detail // => "sum((number | null)[]): number\nsum((duration | null)[]): duration"
service.hover('items.map(.qty)', 12)?.detail // => "number"
service.hover('items.map(', 3) // => undefined
```

## diagnostics(source)

Returns every syntax and check diagnostic for `source`, exactly as `env.check(source).diagnostics` (or `env.check(source, { expect })` for a service created with `expect`), and never throws.

<!-- continue -->
```ts
service.diagnostics('items.map(.qtty)')[0].message // => 'Property "qtty" does not exist on { sku: string, qty: number }; did you mean "qty"?'
service.diagnostics('items.map(.qtty)')[0].suggestion // => "qty"
service.diagnostics('items.length > 0') // => []
```

## Rendering safely

Labels, details, documentation, and messages can contain text from the expression and from your schema. Insert them into the page as text (`textContent` or your framework's text binding), not as HTML.
