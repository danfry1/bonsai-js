# What is Bonsai

Bonsai is a small, safe, typed expression language for JavaScript applications. It evaluates text such as

<!-- context: { user: { plan: "pro" }, orders: [{ total: 80, paid: true }, { total: 45, paid: true }, { total: 300, paid: false }] } -->
```bonsai
user.plan == "pro" && orders.filter(.paid).map(.total).sum() > 100 // => true
```

against data you pass in, without executing JavaScript. It is meant for logic that people other than your developers write: pricing and eligibility rules, saved filters, formula fields, notification templates, and feature conditions.

Throughout this site, `// => value` after an expression shows its result.

## What you get

- **Familiar syntax.** JavaScript operators and names: `a.b`, `?.`, `??`, template literals, `filter`, `map`, `includes`, `toUpperCase`. Every function also works as a method, so `sum(xs)` and `xs.sum()` are the same call.
- **Static checking.** Declare the shape of your data once with `t` and get errors for typos, wrong types, and possibly-null values before an expression is saved, with suggestions and exact source ranges. The TypeScript types of the context and the result are inferred from the same declaration.
- **Safety by construction.** No globals, no prototype access, no calling functions found in data, no conversion hooks, no mutation. Every evaluation terminates and is bounded by a step budget, size limits, an optional timeout, and an `AbortSignal`.
- **Speed.** Expressions compile once to closures (no `eval`, safe under a strict Content Security Policy) and are cached per environment.
- **Editor support.** A language service in `bonsai-js/service` provides completions, hover, and diagnostics without evaluating anything.
- **No dependencies.** Runs in Node.js 24 and newer, current Bun, and modern ESM browsers.

## What it is not

Bonsai is not a general-purpose language. There are no loops, no recursion, no assignment, and no user-defined functions beyond lambdas passed to built-ins. That is deliberate: it is what makes every expression terminate and keeps the checker precise. When an expression needs something the language does not have, you add a [host function](/api/host-functions).

## Where to go next

- [Install](/guide/install) and follow the [Quick Start](/guide/quick-start).
- Read the [Mental Model](/guide/mental-model): the handful of rules that differ from JavaScript.
- Browse the [language reference](/language/) and the [built-in functions](/functions/).
- Try expressions in the [Playground](/playground).
- Upgrading? See [Migrating from 0.x](/guide/migrating).
