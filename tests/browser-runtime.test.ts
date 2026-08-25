import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const tmpDir = join(rootDir, '.tmp-browser-runtime')

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('browser-targeted runtime', () => {
  it('bundles and executes every public surface without Node globals', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const entry = join(tmpDir, 'entry.ts')
    const output = join(tmpDir, 'bundle.js')

    writeFileSync(
      entry,
      [
        "import { bonsai } from '../src/index.js'",
        "import { all } from '../src/stdlib/index.js'",
        "import { createAutocomplete } from '../src/autocomplete/index.js'",
        "import { createChecker, t } from '../src/checker/index.js'",
        '',
        'const schema = t.object({',
        '  user: t.object({ name: t.string(), age: t.number() }),',
        '  items: t.array(t.number()),',
        '})',
        'const expr = bonsai().use(all).seal()',
        "const value = expr.evaluateSync('user.name |> upper', {",
        "  user: { name: 'browser', age: 30 },",
        '  items: [1, 2, 3],',
        '})',
        "if (value !== 'BROWSER') throw new Error('browser runtime evaluation failed')",
        "const checked = createChecker(expr, { schema }).check('items |> sum', {",
        '  expectedType: t.number(),',
        '})',
        "if (!checked.valid) throw new Error('browser checker failed')",
        'const labels = createAutocomplete(expr, { schema })',
        "  .complete('user.', 5)",
        '  .map((item) => item.label)',
        "if (!labels.includes('name') || !labels.includes('age')) {",
        "  throw new Error('browser autocomplete failed')",
        '}',
        "globalThis.bonsaiBrowserSmokeResult = 'ok'",
        "globalThis.bonsaiBrowserAsyncResult = expr.evaluate('items |> sum', {",
        "  user: { name: 'browser', age: 30 },",
        '  items: [1, 2, 3],',
        '})',
      ].join('\n'),
    )

    execFileSync(
      'bun',
      ['build', entry, '--outfile', output, '--target=browser', '--format=iife', '--minify'],
      { stdio: 'pipe' },
    )

    const bundle = readFileSync(output, 'utf8')
    expect(bundle).not.toContain('node:')

    const sandbox: Record<string, unknown> = Object.create(null)
    runInNewContext(bundle, sandbox, { timeout: 5_000 })

    expect(sandbox.bonsaiBrowserSmokeResult).toBe('ok')
    await expect(sandbox.bonsaiBrowserAsyncResult).resolves.toBe(6)
  })
})
