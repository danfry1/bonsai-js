// Verifies the expressions shown by the site's Vue components:
// every playground example evaluates (or fails with its expected check
// error) the way the playground runs it, every home-page sample produces the
// result it displays, and every home-page use-case snippet parses.
//
//   bun website/scripts/check-components.ts
import { bonsai, formatType } from '../../src/index.ts'
import { examples } from '../.vitepress/theme/components/playground/examples.ts'
import { buildContext } from '../.vitepress/theme/components/playground/schema.ts'
import { samples, useCases } from '../.vitepress/theme/components/home/samples.ts'
import { display, normalize } from './format.ts'

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

const open = bonsai()
for (const sample of samples) {
  try {
    const actual = display(open.evaluateSync(sample.code, sample.context))
    if (normalize(actual) !== normalize(sample.result)) fail(`home sample ${sample.code}: shows ${sample.result}, actual ${actual}`)
  } catch (error) {
    fail(`home sample ${sample.code}: ${(error as Error).message}`)
  }
}
for (const useCase of useCases) {
  const check = open.check(useCase.code)
  if (!check.ok) fail(`home use case ${useCase.title}: ${check.diagnostics.map((d) => d.message).join('; ')}`)
}

console.log(`${examples.length} playground examples, ${samples.length + useCases.length} home snippets checked, ${failures} failures`)
if (failures > 0) process.exit(1)
