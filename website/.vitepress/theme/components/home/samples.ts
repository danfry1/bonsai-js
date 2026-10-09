// Home page snippets. website/scripts/check-components.ts verifies every
// sample's result and that every use-case snippet type-checks.
export interface Sample {
  comment: string
  code: string
  result: string
  context: Record<string, unknown>
}

export const samples: Sample[] = [
  {
    comment: 'Method chains on any value',
    code: '"  hello world  ".trim().toUpperCase()',
    result: '"HELLO WORLD"',
    context: {},
  },
  {
    comment: 'Null-safe defaults',
    code: 'user.profile.avatar ?? "default.png"',
    result: '"default.png"',
    context: { user: { profile: null } },
  },
  {
    comment: '"." is the current item',
    code: 'users.filter(.age >= 18).map(.name)',
    result: '["Alice"]',
    context: {
      users: [
        { name: 'Alice', age: 25 },
        { name: 'Bob', age: 15 },
      ],
    },
  },
]

export const useCases = [
  {
    kicker: 'Pricing & Eligibility',
    title: 'Business Rules',
    body: 'A pricing rule changes every quarter. With Bonsai it is a text field in your admin panel, checked against your data types when it is saved.',
    code: 'order.total >= freeShippingThreshold\n  && customer.tier == "gold"',
  },
  {
    kicker: 'Search & Admin UIs',
    title: 'Filter Builders',
    body: 'Store a saved view as a string and evaluate it per row, with no custom query parser to build or maintain.',
    code: 'orders.filter(\n  .status == "pending"\n  && now() - .placedAt > days(2)\n)',
  },
  {
    kicker: 'Notifications & Emails',
    title: 'Templates',
    body: 'Template expressions live alongside the copy, not buried in application code or a separate engine.',
    code: '`Hi ${user.firstName},\n  order ${order.id} ships\n  ${order.shipDate.formatDate("dd MMM")}`',
  },
]

