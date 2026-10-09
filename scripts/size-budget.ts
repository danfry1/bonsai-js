import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// Bundles small consumers of the built package (run `bun run build` first),
// minified for the browser, and fails when one outgrows its gzip budget. The
// small cases guard tree-shaking: importing only `t` or the error helpers must
// not pull in the engine.

interface SizeCase {
  name: string
  source: string
  maxGzipBytes: number
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = JSON.stringify(join(root, 'dist', 'index.mjs'))

const cases: SizeCase[] = [
  {
    name: "bonsai().evaluateSync('1 + 2')",
    source: `import { bonsai } from ${entry}\nconsole.log(bonsai().evaluateSync('1 + 2'))`,
    // 56.4 KB when set; 60.1 KB after the pre-1.0 review fixes (diagnostic
    // positions and frames, residual explain and bounds, input validation).
    maxGzipBytes: 62_000,
  },
  {
    name: 't only',
    source: `import { t } from ${entry}\nconsole.log(t.number())`,
    maxGzipBytes: 1000,
  },
  {
    name: 'error helpers only',
    source: `import { isBonsaiError } from ${entry}\nconsole.log(isBonsaiError(null))`,
    maxGzipBytes: 1000,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'bonsai-size-'))
try {
  const lines = ['Bundle size budget (minified, gzip):']
  let failed = false
  for (const [index, sizeCase] of cases.entries()) {
    const input = join(dir, `case-${index}.mjs`)
    const output = join(dir, `case-${index}.out.js`)
    writeFileSync(input, sizeCase.source)
    execFileSync('bun', ['build', input, '--minify', '--target', 'browser', '--outfile', output], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const bytes = gzipSync(readFileSync(output), { level: 9 }).length
    const ok = bytes <= sizeCase.maxGzipBytes
    if (!ok) failed = true
    lines.push(
      `- ${sizeCase.name}: ${bytes.toLocaleString('en-US')} B (max ${sizeCase.maxGzipBytes.toLocaleString('en-US')}) [${ok ? 'PASS' : 'FAIL'}]`,
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  if (failed) process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
