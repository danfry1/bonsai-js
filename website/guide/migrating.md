# Migrate to Bonsai

Bonsai deliberately looks familiar, but migration should be treated as a
semantic change rather than a package-name replacement. Start with a corpus of
your real expressions and expected results, translate it once, then run that
corpus against both engines before switching production traffic.

## From Jexl

The instance and evaluation APIs map closely:

| Jexl | Bonsai |
|---|---|
| `jexl.eval(source, context)` | `expr.evaluate(source, context)` |
| `jexl.evalSync(source, context)` | `expr.evaluateSync(source, context)` |
| `jexl.compile(source)` | `expr.compile(source)` |
| `jexl.addTransform(name, fn)` | `expr.addTransform(name, fn, metadata)` |
| `jexl.addFunction(name, fn)` | `expr.addFunction(name, fn, metadata)` |
| `value\|transform(arg)` | `value \|> transform(arg)` |
| `items[.active]` | `items.filter(.active)` |
| `value ^ exponent` | `value ** exponent` |

Jexl's published grammar uses JavaScript's coercing operators. Bonsai is
stricter: `==` is identity equality, `+` accepts two numbers or two strings,
and ordered comparisons require two numbers or two strings. Audit expressions
that relied on values such as `"1" == 1`, numeric strings, object conversion, or
Jexl's `//` floor-division operator. Use a trusted function for domain-specific
conversion or floor division.

Jexl also permits custom unary and binary operators. Bonsai keeps its grammar
closed so that parsing, checking, autocomplete, and runtime semantics cannot
drift. Migrate a custom operator to a clearly named function or transform.

```ts
// Jexl
jexl.addBinaryOp('_=', 20, caseInsensitiveEqual)
await jexl.eval('customer.plan _= "PRO"', context)

// Bonsai
const expr = bonsai().defineFunction({
  name: 'equalFolded',
  parameters: [
    { name: 'left', type: t.string() },
    { name: 'right', type: t.string() },
  ],
  returnType: t.boolean(),
  evaluate: (left, right) =>
    String(left).localeCompare(String(right), undefined, { sensitivity: 'accent' }) === 0,
})

await expr.evaluate('equalFolded(customer.plan, "PRO")', context)
```

Other differences to review:

- Bonsai reads own properties only. Prototype members (class getters and
  methods, `Map#size`, `Date#getTime`) are not a data source; serialize such
  objects to plain objects and arrays at the boundary. Sets, Maps, and other
  iterables cannot be spread; pass arrays.
- Arithmetic and ordering are strict: `"Total: " + n` and `age > "18"` are
  typed errors rather than coercions. Use a template literal (`` `Total: ${n}` ``)
  and compare numbers with numbers. A missing numeric field compared with `>=`
  is an error, not `false`; guard it with `??` or check it with the static
  checker.
- Array filtering is explicit through `filter(...)`; a bracket expression is an
  index/property lookup.
- Property reads on a nullish receiver yield `undefined`, as in Jexl. Method
  calls on a nullish receiver throw; use `?.` there (`user.name?.trim()`).
  Nullish fallback uses `??`.
- `join` and `toSorted` reject non-primitive elements instead of calling
  `toString` implicitly.
- Built-in methods enforce Bonsai's declared arity and parameter types at
  runtime; they do not inherit JavaScript's missing-argument or implicit
  coercion behavior. Rewrite `text.slice("1")` as `text.slice(1)` and supply
  required arguments such as `text.at(index)`.
- Autocomplete no longer probes transforms by executing them. Register custom
  transforms with `defineTransform()` metadata (or pass `transformSignatures`)
  so pipe completions stay filtered.
- Async transforms and functions are awaited by `evaluate()`. Promise values in
  the context are not implicitly unwrapped.
- Extension names and the operator grammar are fixed after configuration; call
  `seal()` to enforce that lifecycle.

The [Jexl language reference](https://github.com/TomFrost/Jexl#all-the-details)
is the source of truth when inventorying old syntax.

## From `eval()` or `new Function()`

Do not pass the whole application scope as context. Define a small data contract
for the expression, register the few trusted operations it needs, and keep side
effects outside the language.

```ts
import { bonsai } from 'bonsai-js'
import { createChecker, t } from 'bonsai-js/checker'

const contextSchema = t.object({
  order: t.object({ total: t.number(), country: t.string() }),
  customer: t.object({ plan: t.string() }),
})

const expr = bonsai({
  allowedProperties: ['total', 'country', 'plan'],
  maxSourceLength: 5_000,
  maxSteps: 100_000,
}).seal()

const source = 'order.total >= 100 && customer.plan == "pro"'
const checked = createChecker(expr, {
  schema: contextSchema,
  expectedType: t.boolean(),
}).check(source)

if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics))
const rule = expr.compile(source)
const result = rule.evaluateSync({
  order: { total: 129, country: 'GB' },
  customer: { plan: 'pro' },
})
```

JavaScript expressions containing assignment, mutation, constructors, global
objects, arbitrary method calls, statements, or closures need redesign rather
than translation. Move that behavior into audited host code and expose a pure,
narrow function to Bonsai only when the expression genuinely needs it.

## Cut over safely

1. Export the production expression corpus and representative plain-data
   contexts, removing secrets.
2. Translate syntax and record every intentional semantic difference.
3. Declare extension signatures and a context schema; run the static checker on
   the whole corpus.
4. Compare old and new results in shadow traffic. Classify mismatches instead of
   weakening Bonsai's strict behavior globally.
5. Set domain-specific structural, work, and output limits.
6. Compile repeated expressions, seal the configured instance, and switch only
   after the corpus is green.

For stored rules, keep the original source, migrated source, expected result,
and Bonsai version together. That fixture becomes both your migration audit and
your future upgrade test.
