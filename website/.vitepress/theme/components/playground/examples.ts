// Playground examples. `website/scripts/check-playground.ts` evaluates every
// example the way the playground does, so these stay valid.

export interface ExampleVar {
  name: string
  value: string
}

export interface Example {
  id: string
  group: string
  title: string
  expression: string
  vars: ExampleVar[]
  /** Examples that demonstrate a check error set this. */
  expectError?: string
}

export const examples: Example[] = [
  { id: 'hello', group: 'Basics', title: 'Hello World', expression: '"hello".toUpperCase()', vars: [] },
  {
    id: 'templates',
    group: 'Basics',
    title: 'Template Literals',
    expression: '`Hello ${name}!`',
    vars: [{ name: 'name', value: '"world"' }],
  },
  {
    id: 'ternary',
    group: 'Basics',
    title: 'Conditionals',
    expression: 'age >= 18 ? "adult" : "minor"',
    vars: [{ name: 'age', value: '21' }],
  },
  {
    id: 'in-operator',
    group: 'Basics',
    title: 'Membership',
    expression: 'role in ["admin", "editor"] ? "Can edit" : "Read only"',
    vars: [{ name: 'role', value: '"editor"' }],
  },
  {
    id: 'let',
    group: 'Basics',
    title: 'let Bindings',
    expression: 'let total = cart.map(.price * .qty).sum();\ntotal > 100 ? total * 0.9 : total',
    vars: [{ name: 'cart', value: '[\n  { "price": 40, "qty": 2 },\n  { "price": 25, "qty": 1 }\n]' }],
  },
  {
    id: 'methods',
    group: 'Text',
    title: 'Method Chains',
    expression: '"hello world".slice(0, 5).toUpperCase()',
    vars: [],
  },
  {
    id: 'string-format',
    group: 'Text',
    title: 'Formatting',
    expression:
      '`${name.toUpperCase()} scored ${score}%: ${score >= 90 ? "excellent" : score >= 70 ? "good" : "needs work"}`',
    vars: [
      { name: 'name', value: '"alice"' },
      { name: 'score', value: '85' },
    ],
  },
  {
    id: 'filtering',
    group: 'Lists',
    title: 'Filter and Map',
    expression: 'users.filter(.age >= 18).map(.name)',
    vars: [{ name: 'users', value: '[\n  { "name": "Alice", "age": 25 },\n  { "name": "Bob", "age": 15 }\n]' }],
  },
  {
    id: 'sorting',
    group: 'Lists',
    title: 'Sorting',
    expression: 'players.sortBy(.score, "desc").map(.name).slice(0, 2)',
    vars: [
      {
        name: 'players',
        value: '[\n  { "name": "Ann", "score": 42 },\n  { "name": "Ben", "score": 87 },\n  { "name": "Cat", "score": 61 }\n]',
      },
    ],
  },
  {
    id: 'unique-tags',
    group: 'Lists',
    title: 'Flatten and Unique',
    expression: 'posts.flatMap(.tags).unique().sort()',
    vars: [
      {
        name: 'posts',
        value:
          '[\n  { "title": "Intro", "tags": ["js", "tutorial"] },\n  { "title": "Advanced", "tags": ["js", "deep-dive"] },\n  { "title": "Guide", "tags": ["tutorial", "guide"] }\n]',
      },
    ],
  },
  {
    id: 'nested-lambdas',
    group: 'Lists',
    title: 'Nested Lambdas',
    expression: 'orders.filter(o => o.lines.some(.sku == o.promoSku)).map(.id)',
    vars: [
      {
        name: 'orders',
        value:
          '[\n  { "id": "A1", "promoSku": "X", "lines": [{ "sku": "X" }, { "sku": "Y" }] },\n  { "id": "B2", "promoSku": "Z", "lines": [{ "sku": "Y" }] }\n]',
      },
    ],
  },
  {
    id: 'group-by',
    group: 'Lists',
    title: 'Group By',
    expression: 'tickets.groupBy(.status)',
    vars: [
      {
        name: 'tickets',
        value: '[\n  { "id": 1, "status": "open" },\n  { "id": 2, "status": "closed" },\n  { "id": 3, "status": "open" }\n]',
      },
    ],
  },
  { id: 'math', group: 'Numbers', title: 'Sum', expression: '[10, 20, 30].sum()', vars: [] },
  {
    id: 'grade-calc',
    group: 'Numbers',
    title: 'Average and Round',
    expression: '(scores.avg() ?? 0).clamp(0, 100).round(1)',
    vars: [{ name: 'scores', value: '[88, 92, 76, 95, 81]' }],
  },
  {
    id: 'try',
    group: 'Numbers',
    title: 'Recovering with try',
    expression: 'try(stats.visits / stats.days, 0)',
    vars: [{ name: 'stats', value: '{ "visits": 120, "days": 0 }' }],
  },
  {
    id: 'null-safety',
    group: 'Null Safety',
    title: 'Defaults',
    expression: 'user.profile.avatar ?? "default.png"',
    vars: [{ name: 'user', value: '{ "name": "Ada", "profile": null }' }],
  },
  {
    id: 'optional-call',
    group: 'Null Safety',
    title: 'Optional Calls',
    expression: 'user.nickname?.toUpperCase() ?? user.name',
    vars: [{ name: 'user', value: '{ "name": "Ada", "nickname": null }' }],
  },
  {
    id: 'account-age',
    group: 'Time',
    title: 'Durations',
    expression: 'let age = now() - user.createdAt;\n`${floor(inDays(age))} days, older than 30: ${age > days(30)}`',
    vars: [{ name: 'user', value: '{ "createdAt": "2025-06-01T09:00:00Z" }' }],
  },
  {
    id: 'time-zones',
    group: 'Time',
    title: 'Time Zones',
    expression: 'formatDate(order.placedAt, "dd/MM/yyyy HH:mm", "Asia/Tokyo")',
    vars: [{ name: 'order', value: '{ "placedAt": "2026-01-14T23:30:00Z" }' }],
  },
  {
    id: 'typo',
    group: 'Checking',
    title: 'Typos',
    expression: 'user.agee >= 18',
    vars: [{ name: 'user', value: '{ "name": "Ada", "age": 36 }' }],
    expectError: 'UNKNOWN_PROPERTY',
  },
  {
    id: 'strict-booleans',
    group: 'Checking',
    title: 'Strict Booleans',
    expression: 'items.length && items[0] == "a"',
    vars: [{ name: 'items', value: '["a"]' }],
    expectError: 'TYPE_ERROR',
  },
]

export const defaultExample = examples[0]
