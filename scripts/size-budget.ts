import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type * as BonsaiModule from '../src/index.js'

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
const liteEntry = JSON.stringify(join(root, 'dist', 'lite', 'index.mjs'))
const serviceEntry = JSON.stringify(join(root, 'dist', 'service', 'index.mjs'))
const runtimeEntry = JSON.stringify(join(root, 'dist', 'runtime', 'index.mjs'))
const coreEntry = JSON.stringify(join(root, 'dist', 'runtime', 'core.mjs'))
const builtinsEntry = JSON.stringify(join(root, 'dist', 'builtins', 'index.mjs'))
// An artifact as a browser receives it: plain JSON in the bundle.
const { bonsai, t, toArtifact } = (await import(
  join(root, 'dist', 'index.mjs')
)) as typeof BonsaiModule
const artifact = JSON.stringify(
  toArtifact(
    bonsai({ variables: { user: t.object({ age: t.number() }) } }).compile('user.age >= 18'),
  ),
)

const cases: SizeCase[] = [
  {
    name: "bonsai().evaluateSync('1 + 2')",
    source: `import { bonsai } from ${entry}\nconsole.log(bonsai().evaluateSync('1 + 2'))`,
    // 56.4 KB when set; 60.1 KB after the pre-1.0 review fixes (diagnostic
    // positions and frames, residual explain and bounds, input validation);
    // 62.3 KB after the third review round (stack-overflow guard, duration(),
    // check-time warnings, partial evaluation that never decides from data it
    // was not given); 64.0 KB after the fourth and fifth (balanced spans,
    // checker soundness for map literals, bounded overlays and partial
    // evaluation memory, residual snapshots); 66.0 KB after rounds six to nine
    // (error ownership per evaluation, bounded explanation rendering); 68.0 KB
    // for round ten (hostile thrown values, deterministic rendering, checked
    // unknown paths); 68.9 KB once each built-in became its own export and the
    // builtins option landed (2026-10-24), for bonsai-js/runtime/core.
    maxGzipBytes: 69_300,
  },
  {
    // The lite entry: checking and evaluating, without explaining and partial
    // evaluation. 55.8 KB when set (2026-10-14), 11.9 KB under the main entry;
    // 57.3 KB with the builtins option (2026-10-24).
    name: "lite: bonsai().evaluateSync('1 + 2')",
    source: `import { bonsai } from ${liteEntry}\nconsole.log(bonsai().evaluateSync('1 + 2'))`,
    maxGzipBytes: 57_700,
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
  {
    // A visual editor that only parses and prints ships the parser, not the engine.
    name: 'parse and print only',
    source: `import { parse, print } from ${entry}\nconsole.log(print(parse('a + b')))`,
    maxGzipBytes: 12_000,
  },
  {
    // The editor entry on its own: the checker without the compiler or runtime.
    name: 'language service only',
    source: `import { createLanguageService } from ${serviceEntry}\nconsole.log(createLanguageService)`,
    maxGzipBytes: 47_300,
  },
  {
    // Evaluating artifacts without the checker: the parser, binding, compiler,
    // built-ins, loader, and t for the declared variables. 44.2 KB when set
    // (2026-10-23): 35% under the main entry and 21% under lite. The built-ins
    // (27 KB minified) are most of it. 42.6 KB once built-in descriptions moved
    // to functions/descriptions.ts, which only the checker side imports; 43.3 KB
    // once each built-in became its own export (2026-10-24).
    name: 'runtime: runtime().load(artifact).evaluateSync()',
    source: `import { runtime, t } from ${runtimeEntry}\nconsole.log(runtime({ variables: { user: t.object({ age: t.number() }) } }).load(${artifact}).evaluateSync({ user: { age: 30 } }))`,
    maxGzipBytes: 43_700,
  },
  {
    // bonsai-js/runtime/core with no built-ins: a rule that calls no function.
    // 29.6 KB when set (2026-10-24), 13.7 KB under bonsai-js/runtime.
    name: 'runtime/core, no built-ins',
    source: `import { runtime, t } from ${coreEntry}\nconsole.log(runtime({ variables: { user: t.object({ age: t.number() }) } }).load(${artifact}).evaluateSync({ user: { age: 30 } }))`,
    maxGzipBytes: 30_000,
  },
  {
    // A typical rule's built-ins, through a namespace import: only those are kept.
    name: 'runtime/core, includes, toLowerCase, some, now, days',
    source: `import { runtime, t } from ${coreEntry}\nimport * as b from ${builtinsEntry}\nconsole.log(runtime({ variables: { user: t.object({ age: t.number() }) }, builtins: [b.includes, b.toLowerCase, b.some, b.now, b.days] }).load(${artifact}).evaluateSync({ user: { age: 30 } }))`,
    maxGzipBytes: 31_000,
  },
  {
    // Every built-in: what bonsai-js/runtime carries, and at most about 1 KB more.
    name: 'runtime/core, every built-in',
    source: `import { runtime, t } from ${coreEntry}\nimport * as b from ${builtinsEntry}\nconsole.log(runtime({ variables: { user: t.object({ age: t.number() }) }, builtins: Object.values(b) }).load(${artifact}).evaluateSync({ user: { age: 30 } }))`,
    maxGzipBytes: 44_700,
  },
  {
    // One built-in keeps only itself: each is a pure, separately exported definition.
    name: 'one built-in (trim) only',
    source: `import { trim } from ${builtinsEntry}\nconsole.log(trim.name)`,
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
    // Each case must also run, so a budget never measures a bundle that would fail.
    execFileSync('bun', [output], { stdio: ['ignore', 'ignore', 'inherit'] })
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
