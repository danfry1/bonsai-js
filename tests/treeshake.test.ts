import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const tmpDir = join(rootDir, '.tmp-treeshake')

function bundleSize(code: string): number {
  mkdirSync(tmpDir, { recursive: true })
  const entry = join(tmpDir, 'entry.ts')
  writeFileSync(entry, code)
  const out = join(tmpDir, 'out.mjs')
  execFileSync('bun', ['build', entry, '--outfile', out, '--minify', '--target=browser'], { stdio: 'pipe' })
  const size = readFileSync(out).byteLength
  rmSync(tmpDir, { recursive: true, force: true })
  return size
}

describe('tree-shaking', () => {
  it('importing only evaluateExpression should be smaller than importing everything', () => {
    const minimal = bundleSize(`
      import { evaluateExpression } from '../src/index.js'
      console.log(evaluateExpression('1+2'))
    `)
    const full = bundleSize(`
      import { bonsai } from '../src/index.js'
      import { all } from '../src/stdlib/index.js'
      const e = bonsai(); e.use(all)
      console.log(e.evaluateSync('1+2'))
    `)
    // Full bundle with all stdlib should be larger than minimal
    expect(full).toBeGreaterThan(minimal)
  })

  it('importing individual stdlib modules should be smaller than importing all', () => {
    const stringsOnly = bundleSize(`
      import { bonsai } from '../src/index.js'
      import { strings } from '../src/stdlib/strings.js'
      const e = bonsai(); e.use(strings)
      console.log(e.evaluateSync('"hi" |> upper'))
    `)
    const allStdlib = bundleSize(`
      import { bonsai } from '../src/index.js'
      import { all } from '../src/stdlib/index.js'
      const e = bonsai(); e.use(all)
      console.log(e.evaluateSync('"hi" |> upper'))
    `)
    // strings-only should be smaller than all stdlib
    expect(allStdlib).toBeGreaterThan(stringsOnly)
  })

  it('sideEffects: false is set in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))
    expect(pkg.sideEffects).toBe(false)
  })
})

describe('bundle size budgets', () => {
  // Minified, browser-targeted byte ceilings. `bun build` output is
  // deterministic for a given bun version, so these are stable across machines
  // and CI (unlike the perf gate). They are generous ceilings sized to catch a
  // significant regression (for example the core entry accidentally importing
  // the whole stdlib or the autocomplete engine), not tight microbudgets;
  // update them deliberately when an intentional change moves a number.
  const KB = 1024

  const CORE = `
    import { evaluateExpression } from '../src/index.js'
    console.log(evaluateExpression('1+2'))
  `
  const FULL = `
    import { bonsai } from '../src/index.js'
    import { all } from '../src/stdlib/index.js'
    const e = bonsai(); e.use(all)
    console.log(e.evaluateSync('1+2'))
  `
  const AUTOCOMPLETE = `
    import { createAutocomplete } from '../src/autocomplete/index.js'
    import { bonsai } from '../src/index.js'
    console.log(createAutocomplete(bonsai(), {}))
  `

  it('core entry (evaluateExpression only) stays within budget', () => {
    expect(bundleSize(CORE)).toBeLessThan(56 * KB)
  })

  it('full entry (bonsai + all stdlib) stays within budget', () => {
    expect(bundleSize(FULL)).toBeLessThan(62 * KB)
  })

  it('autocomplete subpath stays within budget', () => {
    expect(bundleSize(AUTOCOMPLETE)).toBeLessThan(76 * KB)
  })

  it('core entry does not pull in the autocomplete engine', () => {
    expect(bundleSize(CORE)).toBeLessThan(bundleSize(AUTOCOMPLETE))
  })
})
