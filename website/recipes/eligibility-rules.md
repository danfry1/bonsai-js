# Eligibility Rules with Reasons

This recipe is for products where admins define who qualifies for something (payment terms, a discount tier, an upgrade offer) and customers or support staff need to know why a decision went the way it did. It builds rule storage with save-time checks, evaluation, a "why you do not qualify" list, an answer to "can this customer ever qualify?", and an audit record of each decision.

## Share the vocabulary in a library

Several environments (the admin tool, the checkout service, a nightly job) should agree on what a rule can read and call. A `Library` bundles variable declarations and host functions under a name; every environment that lists it gets both, and the context type includes its variables. See [Libraries](/api/host-functions#libraries).

```ts
import { bonsai, fn, t, type Library } from 'bonsai-js'

const customers = {
  name: 'customers',
  variables: {
    customer: t.object({
      country: t.string(),
      email: t.string(),
      tags: t.list(t.string()),
      ordersLastYear: t.number(),
    }),
  },
  functions: {
    domainOf: fn({
      params: [t.string()],
      returns: t.string(),
      description: 'The domain of an email address.',
      cost: 4,
      run: (email) => email.slice(email.lastIndexOf('@') + 1).toLowerCase(),
    }),
  },
} satisfies Library

const rules = bonsai({
  libraries: [customers],
  variables: { order: t.object({ total: t.number(), currency: t.string() }) },
  limits: { maxSourceLength: 2_000, maxSteps: 50_000 },
})
```

## Save rules only when they check

Store the source text of a rule, and accept it only when `check()` finds no errors. `expect: t.boolean()` makes sure a rule answers yes or no. When the check fails, return its diagnostics to the admin's editor: each has a message, a `suggestion` for a misspelled name, and `start` and `end` offsets to underline.

<!-- continue -->
```ts
type Saved = { name: string; source: string }
const store = new Map<string, Saved>()

function saveRule(name: string, source: string) {
  const checked = rules.check(source, { expect: t.boolean() })
  if (!checked.ok) {
    return { saved: false, problems: checked.diagnostics.map((d) => ({ message: d.message, start: d.start, end: d.end })) }
  }
  store.set(name, { name, source })
  return { saved: true, problems: [] }
}

saveRule('netTerms', 'customer.ordersLastYer >= 5').problems[0]?.message // => "Property \"ordersLastYer\" does not exist on customer; did you mean \"ordersLastYear\"?"
saveRule(
  'netTerms',
  'customer.ordersLastYear >= 5 && customer.country in ["GB", "IE", "NL"] && !("blocked" in customer.tags) && domainOf(customer.email) != "gmail.com"',
).saved // => true
```

For completions and hover while the admin types, use the [language service](/guide/editor-support) with the same environment.

## Evaluate a decision

Compile a stored rule when it is loaded and evaluate it per customer. The context is typed from the declarations, including the library's variables.

<!-- continue -->
```ts
const netTerms = rules.compile(store.get('netTerms')?.source ?? 'false', { expect: t.boolean() })

const ada = { country: 'GB', email: 'ada@analytical.co.uk', tags: ['wholesale'], ordersLastYear: 12 }
const bob = { country: 'FR', email: 'bob@gmail.com', tags: ['blocked'], ordersLastYear: 2 }
const order = { total: 800, currency: 'GBP' }

netTerms.evaluateSync({ customer: ada, order }) // => true
netTerms.evaluateSync({ customer: bob, order }) // => false
```

## Explain why a customer does not qualify

`explainSync()` evaluates the rule and records every sub-expression; `reasons()` returns the conditions that decided the result. By default `&&` stops at the first failing condition. Pass `exhaustive: true` to evaluate the rest too, so the customer sees every reason at once, not one per attempt. A negated condition is reported as written, with the value it had: `!("blocked" in customer.tags)` is `false` for a blocked customer.

<!-- continue -->
```ts
const why = netTerms.explainSync({ customer: bob, order }, { exhaustive: true })
why.reasons().map((r) => [r.text, r.value]) // => [["customer.ordersLastYear >= 5", false], ["customer.country in [\"GB\", \"IE\", \"NL\"]", false], ["!(\"blocked\" in customer.tags)", false], ["domainOf(customer.email) != \"gmail.com\"", false]]
```

Each reason has `start` and `end` offsets into the rule's source, which is how an editor highlights it. They also make a stable key for wording each condition for customers: let admins attach a sentence to a condition, and fall back to the condition's text when there is none.

<!-- continue -->
```ts
const rule = store.get('netTerms')?.source ?? ''
const wording: Record<string, string> = {
  'customer.ordersLastYear >= 5': 'At least 5 orders in the last year',
  '!("blocked" in customer.tags)': 'An account in good standing',
}
function unmet(customer: typeof bob): string[] {
  const explanation = netTerms.explainSync({ customer, order }, { exhaustive: true })
  if (!explanation.ok || explanation.value) return []
  return explanation.reasons().map((r) => wording[rule.slice(r.start, r.end)] ?? rule.slice(r.start, r.end))
}

unmet(bob) // => ["At least 5 orders in the last year", "customer.country in [\"GB\", \"IE\", \"NL\"]", "An account in good standing", "domainOf(customer.email) != \"gmail.com\""]
unmet(ada) // => []
```

The same condition can be reported more than once when several parts of a rule reach it; de-duplicate by `id` when that matters. See [Reasons](/api/explain#reasons).

## Can this customer ever qualify?

Before a customer builds an order, `partial()` answers from what is already known. Pass the customer, leave `order` unknown, and the result is either a decided `value` (no order changes the answer) or a residual: the part that still depends on the order.

<!-- continue -->
```ts
const premium = rules.compile('customer.ordersLastYear >= 10 && order.total >= 500 && order.currency == "GBP"', {
  expect: t.boolean(),
})

premium.partial({ customer: bob }) // => { status: "value", value: false }

const forAda = premium.partial({ customer: ada })
forAda.status // => "residual"
forAda.status === 'residual' ? forAda.source : undefined // => 'order.total >= 500 && order.currency == "GBP"'
forAda.status === 'residual' ? forAda.evaluateSync({ order }) : undefined // => true
```

A residual can be shown as "spend at least 500 in GBP to qualify", kept per customer, and evaluated per order without re-reading the customer. See [Partial Evaluation](/api/partial).

## Record each decision

For an audit log, store the rule source, the result, and the reasons. The reasons serialize bounded and cycle-safe: at most 10,000 values, the first 50 keys of a map, and getters never run, so a log line stays bounded whatever the customer record holds. The reasons record only the deciding conditions and the values beneath them; pass only the data a rule needs if the log must not hold the rest.

<!-- continue -->
```ts
const explanation = netTerms.explainSync({ customer: bob, order }, { exhaustive: true })
const record = JSON.stringify({
  rule: 'netTerms',
  source: rule,
  result: explanation.ok ? explanation.value : explanation.error.code,
  reasons: explanation.reasons(),
})

const logged = JSON.parse(record) as { result: boolean; reasons: { text: string; value: unknown }[] }
logged.result // => false
logged.reasons.map((r) => r.text).length // => 4
```

`JSON.stringify(explanation)` records the whole trace instead, with the value of each variable the rule reads; see [Serializing](/api/explain#serializing) for its bounds.
