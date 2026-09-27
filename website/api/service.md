# Language Service

```ts
import { createLanguageService } from 'bonsai-js/service'
```

`createLanguageService(env)` returns editor features computed from an environment's static information: declared variables, built-ins, host functions, and their types and descriptions. Nothing in the service evaluates an expression or calls a host function. For a guided introduction, see [Editor Support](/guide/editor-support).

<!-- no-run -->
```ts
function createLanguageService(env: Environment<any>): LanguageService

interface LanguageService {
  complete(source: string, offset: number): CompletionResult
  hover(source: string, offset: number): HoverResult | undefined
  diagnostics(source: string): readonly Diagnostic[]
}
```

Offsets are UTF-16 code unit offsets into `source`, the same unit as JavaScript string indices and `Diagnostic.start`/`end`.

## complete(source, offset)

<!-- no-run -->
```ts
interface CompletionResult {
  from: number // start of the range to replace (the partially typed name)
  to: number // end of that range
  items: readonly Completion[]
}

interface Completion {
  label: string
  kind: 'variable' | 'local' | 'property' | 'function' | 'method' | 'keyword'
  detail: string // a type, or one signature per line
  documentation?: string
  insertText: string
}
```

What is offered depends on the cursor:

| Cursor | Items |
| --- | --- |
| At the start of a name | the current item `.` (inside a lambda argument), `let` bindings and lambda parameters in scope, declared variables, every function, and keywords |
| After `.` or `?.` | the fields of the receiver's type, `length` for strings and lists, and the functions whose first parameter accepts the receiver (as methods) |
| Inside a string or comment, or after a digit | nothing |

Items are filtered by what has been typed so far (prefix matches first, then substring matches) and ordered by kind: locals, properties, variables, methods, functions, keywords. The service completes incomplete expressions by guessing the missing closing brackets, so it works in the middle of typing.

```ts
import { bonsai, t } from 'bonsai-js'
import { createLanguageService } from 'bonsai-js/service'

const env = bonsai({
  variables: { items: t.list(t.object({ sku: t.string(), qty: t.number() })) },
})
const service = createLanguageService(env)

const inLambda = service.complete('items.filter(.q', 15)
inLambda.from // => 14
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

Returns every syntax and check diagnostic for `source`, exactly as `env.check(source).diagnostics`, and never throws.

<!-- continue -->
```ts
service.diagnostics('items.map(.qtty)')[0].message // => 'Property "qtty" does not exist on { sku: string, qty: number }; did you mean "qty"?'
service.diagnostics('items.length > 0') // => []
```

## Rendering safely

Labels, details, documentation, and messages can contain text from the expression and from your schema. Insert them into the page as text (`textContent` or your framework's text binding), not as HTML.
