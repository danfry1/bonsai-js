// Verifies the expressions shown by the site's Vue components:
// every playground example evaluates (or fails with its expected check
// error) the way the playground runs it; each home page hero tab checks and
// evaluates; each mistake in the home page's grid gets its diagnostic, the
// explained rule explains as the page describes, the database rule translates
// to the SQL shown, and every refusal fails with the message it displays. Also
// checks that the CodeMirror guide shows exactly the extension its demo runs.
//
//   bun website/scripts/check-components.ts
import { readFileSync } from 'node:fs'
import { bonsai, formatType, t } from '../../src/index.ts'
import { toSQL } from '../../src/query/index.ts'
import { examples } from '../.vitepress/theme/components/playground/examples.ts'
import { buildContext } from '../.vitepress/theme/components/playground/schema.ts'
import { createLanguageService } from '../../src/service/index.ts'
import {
  columns,
  explained,
  mistakes,
  refusals,
  sqlRule,
  sqlShown,
  variables,
} from '../.vitepress/theme/components/home/proofs-data.ts'
import { MAX_EXPRESSION_LENGTH, tabs } from '../.vitepress/theme/components/home/tabs-data.ts'
import { display } from './format.ts'

let failures = 0
const fail = (message: string): void => {
  failures++
  console.error(`FAIL ${message}`)
}

for (const example of examples) {
  const { context, variables } = buildContext(example.vars)
  const env = bonsai({ variables })
  const check = env.check(example.expression)
  const errors = check.diagnostics.filter((d) => d.severity === 'error')
  if (example.expectError !== undefined) {
    if (!errors.some((d) => d.code === example.expectError)) {
      fail(`playground ${example.id}: expected ${example.expectError}, got ${errors.map((d) => d.code).join(', ') || 'no error'}`)
    }
    continue
  }
  if (check.diagnostics.length > 0) {
    fail(`playground ${example.id}: ${check.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`)
    continue
  }
  try {
    const result = env.evaluateSync(example.expression, context)
    console.log(`ok playground ${example.id}: ${formatType(check.type)} ${display(result)}`)
  } catch (error) {
    fail(`playground ${example.id}: ${(error as Error).message}`)
  }
}

// The home page's "What you get" grid: each mistake gets exactly the diagnostic
// it summarises, and a summary that names a fix ('did you mean "x"') matches the
// checker's suggestion; the explained rule passes one condition and fails the
// other, as the copy says; and the database rule translates to the SQL shown.
const home = bonsai({ variables })
try {
  for (const mistake of mistakes) {
    const found = home.check(mistake.rule, { expect: t.boolean() }).diagnostics
    if (found.map((d) => d.code).join() !== mistake.code) {
      fail(`home mistake ${mistake.rule}: expected ${mistake.code}, got ${found.map((d) => d.code).join() || 'none'}`)
    }
    const named = /did you mean "([^"]+)"/u.exec(mistake.summary)?.[1]
    if (named !== undefined && found[0]?.suggestion !== named) fail(`home mistake ${mistake.rule}: summary suggests ${named}`)
  }
  const parts = bonsai({ variables: explained.variables })
    .compile(explained.rule, { expect: t.boolean() })
    .explainSync({ order: explained.orders[0] }).trace.children
  if (parts[0]?.value !== true || parts[1]?.value !== false) {
    fail('home explained rule: the trace no longer matches the copy')
  }
  const { sql } = toSQL(home.compile(sqlRule, { expect: t.boolean() }), { row: 'order', columns, dialect: 'sqlite' })
  if (sql !== sqlShown) fail(`home SQL: ${sqlRule} now translates to ${sql}`)
  console.log(`ok home grid: ${mistakes.length} mistakes, the explained rule, the SQL`)
} catch (error) {
  fail(`home grid: ${(error as Error).message}`)
}

// The home page hero's tabs: each opens with an expression that checks against
// its declared types, produces its expected type, and evaluates on its sample
// data; the business-rule tab catches the typo the page invites.
for (const tab of tabs) {
  if (tab.expression.length > MAX_EXPRESSION_LENGTH) {
    fail(`home tab ${tab.id}: ${tab.expression.length} characters wraps in the editor; keep it to ${MAX_EXPRESSION_LENGTH}`)
  }
  const env = bonsai({ variables: tab.variables })
  const check = env.check(tab.expression, { expect: tab.expect })
  if (check.diagnostics.length > 0) {
    fail(`home tab ${tab.id}: ${check.diagnostics.map((d) => d.message).join('; ')}`)
    continue
  }
  try {
    const value = env.evaluateSync(tab.expression, tab.data)
    // A tab that puts its result in words must have words for its opening result.
    const said = tab.outcome?.(value)
    if (tab.outcome && said === undefined) fail(`home tab ${tab.id}: no words for its opening result ${display(value)}`)
    console.log(`ok home tab ${tab.id}: ${display(value)}${said ? ` (${said})` : ''}`)
  } catch (error) {
    fail(`home tab ${tab.id}: ${(error as Error).message}`)
  }
}
{
  const rule = tabs[0]
  const typo = bonsai({ variables: rule.variables }).check(rule.expression.replace('tier', 'teir'), { expect: rule.expect })
  if (typo.diagnostics[0]?.suggestion !== 'tier') fail('home tab rule: misspelling tier should suggest tier')
  // Comparing a field to a value offers its values, typed after `== ` or inside the quotes.
  const service = createLanguageService(bonsai({ variables: rule.variables }), { expect: rule.expect })
  for (const text of ['order.country == ', 'order.country == ""']) {
    const at = text.endsWith('"') ? text.length - 1 : text.length
    const labels = service.complete(text, at).items.map((i) => i.label)
    if (!labels.some((l) => l.includes('NZ'))) fail(`home tab rule: completing "${text}" offers ${labels.join(', ') || 'nothing'}`)
  }
}

const guarded = bonsai({ variables: { user: t.object({ role: t.string() }) } })
for (const refusal of refusals) {
  try {
    guarded.evaluateSync(refusal.code, { user: { role: 'viewer' } })
    fail(`home refusal ${refusal.code}: evaluated without an error`)
  } catch (error) {
    const actual = (error as Error).message
    if (actual !== refusal.message) fail(`home refusal ${refusal.code}: shows "${refusal.message}", actual "${actual}"`)
  }
}

// The block after <!-- codemirror-extension --> must be the demo's module, character for character.
const guide = readFileSync(new URL('../guide/codemirror.md', import.meta.url), 'utf8')
const shown = /<!-- codemirror-extension -->\n```ts\n([\s\S]*?)\n```/u.exec(guide)?.[1]
const module = readFileSync(
  new URL('../.vitepress/theme/components/codemirror/bonsai-language.ts', import.meta.url),
  'utf8',
)
if (shown === undefined) fail('codemirror guide: no ```ts block after <!-- codemirror-extension -->')
else if (shown !== module.trimEnd()) {
  fail('codemirror guide: the extension shown differs from components/codemirror/bonsai-language.ts')
}

console.log(
  `${examples.length} playground examples, the home page, ${refusals.length} refusals checked, ${failures} failures`,
)
if (failures > 0) process.exit(1)
