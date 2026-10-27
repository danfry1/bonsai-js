// The home page hero's examples: one tab per place an expression lives, each
// with the types it is checked against, sample data, and the expression it
// opens with. Plain TypeScript (no Vue), so website/scripts/check-components.ts
// can verify every tab checks and gives the result the page implies.
import { fn, t, type HostFunction, type Type } from '../../../../../src/index.ts'

/** Longest opening expression, so each fits the editor on one line at laptop widths (check-components enforces it). */
export const MAX_EXPRESSION_LENGTH = 50

export interface Tab {
  id: string
  label: string
  /** What the expression is for, in a few words: the heading above the editor. */
  title: string
  /**
   * For an expression stored in JSON: the lines before it, the key it is the
   * value of, and the lines after, so the editor sits inline as that value.
   */
  json?: { before: string[]; key: string; after: string[] }
  variables: Record<string, Type>
  /** Functions the app defines, which the expression calls like built-ins; shown with their descriptions. */
  functions?: Record<string, HostFunction>
  data: Record<string, unknown>
  expression: string
  /**
   * The type the host requires the expression to produce. Only rules set it
   * (a rule must be true or false); a filter or template may produce anything.
   */
  expect?: Type
  /** What the app does with a result, in plain words, where the value alone doesn't say (a template's text does). */
  outcome?: (value: unknown) => string | undefined
}

const User = t.object({ name: t.string(), age: t.number(), country: t.enum('GB', 'IE', 'NZ', 'US') })

const orders = [
  { id: 'A1', status: 'open', total: 120 },
  { id: 'A2', status: 'paid', total: 80 },
  { id: 'A3', status: 'open', total: 45 },
  { id: 'A4', status: 'open', total: 310 },
]

export const tabs: Tab[] = [
  {
    id: 'rule',
    label: 'Business rule',
    title: 'Free shipping',
    variables: {
      order: t.object({ total: t.number(), country: t.enum('NZ', 'AU', 'US', 'GB') }),
      customer: t.object({ tier: t.enum('basic', 'gold') }),
    },
    data: { order: { total: 84.5, country: 'NZ' }, customer: { tier: 'gold' } },
    expression: 'order.total >= 50 && customer.tier == "gold"',
    expect: t.boolean(),
    outcome: (v) => (v === true ? 'Ships free' : v === false ? 'Pays for shipping' : undefined),
  },
  {
    id: 'functions',
    label: 'Your functions',
    title: 'Who can open an account',
    variables: { user: User },
    functions: {
      isAdult: fn({
        params: [User],
        returns: t.boolean(),
        description: 'Aged 18 or over',
        run: (user) => user.age >= 18,
      }),
      isUKCitizen: fn({
        params: [User],
        returns: t.boolean(),
        description: 'Lives in the UK',
        run: (user) => user.country === 'GB',
      }),
    },
    data: { user: { name: 'Ada', age: 34, country: 'GB' } },
    expression: 'user.isAdult() && user.isUKCitizen()',
    expect: t.boolean(),
    outcome: (v) => (v === true ? 'Can open an account' : v === false ? "Can't open an account" : undefined),
  },
  {
    id: 'filter',
    label: 'Saved filter',
    title: 'Open orders',
    variables: {
      orders: t.list(t.object({ id: t.string(), status: t.enum('open', 'paid', 'refunded'), total: t.number() })),
    },
    data: { orders },
    expression: 'orders.filter(.status == "open").map(.id)',
    outcome: (v) => (Array.isArray(v) ? `${v.length} of ${orders.length} orders` : undefined),
  },
  {
    id: 'template',
    label: 'Template',
    title: 'Cart reminder',
    variables: {
      user: t.object({ name: t.string() }),
      cart: t.object({ items: t.number(), total: t.number() }),
    },
    data: { user: { name: 'Ada' }, cart: { items: 3, total: 84.5 } },
    expression: '`Hi ${user.name}, you have ${cart.items} items`',
  },
  {
    id: 'config',
    label: 'Config file',
    title: 'Who gets the new checkout',
    json: { before: ['{', '  "flag": "new-checkout",'], key: 'enabledWhen', after: ['}'] },
    variables: {
      user: t.object({ country: t.enum('NZ', 'AU', 'US', 'GB'), betaOptIn: t.boolean(), signupDays: t.number() }),
    },
    data: { user: { country: 'NZ', betaOptIn: true, signupDays: 12 } },
    expression: "user.country in ['NZ', 'AU'] && user.betaOptIn",
    expect: t.boolean(),
    outcome: (v) => (v === true ? 'Gets the new checkout' : v === false ? 'Keeps the old checkout' : undefined),
  },
]
