// Playground examples. `website/scripts/check-components.ts` evaluates every
// example the way the playground does, so these stay valid.
import { prettyJSON } from './pretty'

export interface Example {
  id: string
  group: string
  title: string
  expression: string
  /** The data as JSON text: each key is a variable. */
  data: string
  /** Examples that demonstrate a check error set this. */
  expectError?: string
}

const example = (
  group: string,
  id: string,
  title: string,
  expression: string,
  data: Record<string, unknown>,
  expectError?: string,
): Example => ({ id, group, title, expression, data: prettyJSON(data, 56), ...(expectError ? { expectError } : {}) })

export const examples: Example[] = [
  example(
    'Rules',
    'free-shipping',
    'Free shipping',
    'order.total >= 50 && (customer.tier == "gold" || order.country == "NZ")',
    { order: { total: 84.5, country: 'NZ' }, customer: { name: 'Ada', tier: 'basic' } },
  ),
  example('Rules', 'can-edit', 'Who can edit', 'user.role in ["admin", "editor"] && !user.suspended', {
    user: { name: 'Grace', role: 'editor', suspended: false },
  }),
  example('Rules', 'feature-flag', 'Feature flag', 'user.country in ["NZ", "AU"] && user.signupDays < 30', {
    user: { country: 'AU', signupDays: 12, betaOptIn: true },
  }),
  example('Lists', 'saved-filter', 'Open tickets', 'tickets.filter(.status == "open" && .priority >= 2).map(.id)', {
    tickets: [
      { id: 101, status: 'open', priority: 3 },
      { id: 102, status: 'closed', priority: 3 },
      { id: 103, status: 'open', priority: 1 },
    ],
  }),
  example('Lists', 'cart-total', 'Cart total', 'let total = cart.map(.price * .qty).sum();\ntotal > 100 ? total * 0.9 : total', {
    cart: [
      { sku: 'TEA-01', price: 40, qty: 2 },
      { sku: 'POT-07', price: 25, qty: 1 },
    ],
  }),
  example('Lists', 'sorting', 'Top two', 'players.sortBy(.score, "desc").map(.name).slice(0, 2)', {
    players: [
      { name: 'Ann', score: 42 },
      { name: 'Ben', score: 87 },
      { name: 'Cat', score: 61 },
    ],
  }),
  example('Lists', 'unique-tags', 'Every tag once', 'posts.flatMap(.tags).unique().sort()', {
    posts: [
      { title: 'Intro', tags: ['js', 'tutorial'] },
      { title: 'Advanced', tags: ['js', 'deep-dive'] },
      { title: 'Guide', tags: ['tutorial', 'guide'] },
    ],
  }),
  example('Lists', 'nested-lambdas', 'Nested lambdas', 'orders\n  .filter(o => o.lines.some(.sku == o.promoSku))\n  .map(.id)', {
    orders: [
      { id: 'A1', promoSku: 'X', lines: [{ sku: 'X' }, { sku: 'Y' }] },
      { id: 'B2', promoSku: 'Z', lines: [{ sku: 'Y' }] },
    ],
  }),
  example('Lists', 'group-by', 'Group by', 'tickets.groupBy(.status)', {
    tickets: [
      { id: 1, status: 'open' },
      { id: 2, status: 'closed' },
      { id: 3, status: 'open' },
    ],
  }),
  example('Text', 'message', 'Message template', '`Hi ${user.firstName}, ${order.items.length} items in order ${order.id} have shipped.`', {
    user: { firstName: 'Ada' },
    order: { id: 'A1001', items: ['TEA-01', 'POT-07'] },
  }),
  example(
    'Text',
    'formatting',
    'Formatting',
    '`${name.toUpperCase()} scored ${score}%: ${score >= 90 ? "excellent" : score >= 70 ? "good" : "needs work"}`',
    { name: 'alice', score: 85 },
  ),
  example('Text', 'methods', 'Text methods', 'title.trim().slice(0, 11).toUpperCase()', { title: '  hello world, again  ' }),
  example('Numbers', 'average', 'Average and round', '(scores.avg() ?? 0).clamp(0, 100).round(1)', {
    scores: [88, 92, 76, 95, 81],
  }),
  example('Numbers', 'try', 'Recover with try', 'try(stats.visits / stats.days, 0)', { stats: { visits: 120, days: 0 } }),
  example('Missing values', 'defaults', 'Defaults', 'user.profile.avatar ?? "default.png"', {
    user: { name: 'Ada', profile: null },
  }),
  example('Missing values', 'optional-call', 'Optional calls', 'user.nickname?.toUpperCase() ?? user.name', {
    user: { name: 'Ada', nickname: null },
  }),
  example(
    'Time',
    'account-age',
    'Durations',
    'let age = now() - user.createdAt;\n`${floor(inDays(age))} days, older than 30: ${age > days(30)}`',
    { user: { createdAt: '2025-06-01T09:00:00Z' } },
  ),
  example('Time', 'time-zones', 'Time zones', 'formatDate(order.placedAt, "dd/MM/yyyy HH:mm", "Asia/Tokyo")', {
    order: { placedAt: '2026-01-14T23:30:00Z' },
  }),
  example('Mistakes', 'typo', 'A typo', 'user.agee >= 18', { user: { name: 'Ada', age: 36 } }, 'UNKNOWN_PROPERTY'),
  example('Mistakes', 'strict-booleans', 'Not a boolean', 'items.length && items[0] == "a"', { items: ['a'] }, 'TYPE_ERROR'),
]

export const defaultExample = examples[0]
