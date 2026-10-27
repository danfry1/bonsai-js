// Data behind the home page's "What you get" grid: the mistakes the checker
// catches, the explained decision, the rule shown as SQL, and the expressions
// that refuse to run. Plain TypeScript (no Vue), so
// website/scripts/check-components.ts can verify everything the page claims.
import { t } from '../../../../../src/index.ts'

export const variables = {
  order: t.object({
    total: t.number(),
    country: t.enum('NZ', 'AU', 'US', 'GB'),
    items: t.list(t.object({ price: t.number() })),
  }),
  user: t.object({ email: t.optional(t.string()) }),
}

/** Mistakes someone writing a rule makes, and the diagnostic code each one gets. */
export const mistakes = [
  { rule: 'order.totl > 100', summary: 'did you mean "total"?', code: 'UNKNOWN_PROPERTY' },
  { rule: 'order.total >= "50"', summary: "can't compare a number with text", code: 'TYPE_ERROR' },
  { rule: 'user.email.endsWith("@acme")', summary: 'email may be missing', code: 'NULLABLE_RECEIVER' },
  { rule: 'order.country == "UK"', summary: 'never true: country is NZ, AU, US or GB', code: 'ALWAYS_FALSE' },
] as const

/**
 * The rule the grid explains, and the orders it can be explained for. The
 * first, shown by default, passes one condition and fails the other.
 */
export const explained = {
  variables: { order: t.object({ total: t.number(), country: t.enum('NZ', 'AU', 'US', 'GB') }) },
  rule: 'order.total >= 50 && order.country == "NZ"',
  orders: [
    { total: 120, country: 'US' },
    { total: 84.5, country: 'NZ' },
    { total: 19.9, country: 'GB' },
  ],
  whenTrue: 'Ships free',
  whenFalse: 'Pays',
} as const

/** Database columns for bonsai-js/query. */
export const columns = { total: 'number', country: 'text' } as const

/** The rule the grid shows as SQL. */
export const sqlRule = 'order.total >= 50 && order.country in ["NZ", "AU"]'

/** The SQL that sqlRule becomes for SQLite, as the page shows it; check-components keeps it current. */
export const sqlShown = '((`total` >= ?1) AND (`country` IN (?2, ?3)))'

/**
 * Expressions an untrusted author might try: why each is blocked, in plain
 * words, and the exact error Bonsai gives (shown on hover; check-components
 * keeps it current).
 */
export const refusals = [
  { code: 'user.constructor', summary: 'No way into JavaScript', message: 'Property "constructor" is not accessible' },
  {
    code: 'user.role = "admin"',
    summary: 'Expressions only read, never change data',
    message: 'Unexpected "="; use == to compare (expressions cannot assign)',
  },
  {
    code: '"ab".repeat(1e9)',
    summary: 'Stopped at the size limit',
    message: 'String of length 2000000000 exceeds the limit of 100000',
  },
]
