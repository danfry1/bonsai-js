/**
 * Relative performance gate: run scripts/perf-gate.ts against the current tree
 * and against a base git ref, then fail if any case lost more than the allowed
 * share of its throughput.
 *
 * The absolute floors in perf-gate.ts are deliberately loose (about one tenth
 * of a fast machine) so they survive slow CI runners; that also means they
 * cannot see a 2x regression. Comparing base and head on the *same* machine in
 * the *same* job removes the machine from the equation, so a tighter tolerance
 * is meaningful.
 *
 * Usage: bun run scripts/perf-compare.ts [baseRef] (default: origin/main)
 *
 * The current perf-gate.ts is copied into the base worktree so both sides run
 * identical cases; the gate only uses APIs that exist on every supported base.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PERCENT = 100
const SHORT_SHA_LENGTH = 12
// A case fails when head retains less than this share of base throughput.
// Bench noise on shared runners is typically under 10%; 0.75 leaves headroom
// for that while still catching the 2x-10x class of regression.
const MIN_RETAINED_RATIO = Number(process.env.PERF_COMPARE_MIN_RATIO ?? '0.75')
// Each side is measured this many times, interleaved, and the best run is
// kept. Taking the max rather than the mean discards GC pauses and scheduler
// hiccups that would otherwise read as a regression.
const ROUNDS = Number(process.env.PERF_COMPARE_ROUNDS ?? '2')

if (!(MIN_RETAINED_RATIO > 0 && MIN_RETAINED_RATIO <= 1)) {
  throw new Error('PERF_COMPARE_MIN_RATIO must be greater than 0 and at most 1')
}
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) {
  throw new Error('PERF_COMPARE_ROUNDS must be a positive integer')
}

const root = resolve(import.meta.dirname, '..')
const baseRef = process.argv[2] ?? 'origin/main'

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`)
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function runGate(cwd: string, jsonPath: string): Record<string, number> {
  execFileSync('bun', ['run', 'scripts/perf-gate.ts'], {
    cwd,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PERF_GATE_JSON: jsonPath },
  })
  return JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, number>
}

function best(runs: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const run of runs) {
    for (const [name, hz] of Object.entries(run)) out[name] = Math.max(out[name] ?? 0, hz)
  }
  return out
}

const scratch = mkdtempSync(join(tmpdir(), 'bonsai-perf-compare-'))
const baseDir = join(scratch, 'base')
try {
  const baseSha = git('rev-parse', '--verify', `${baseRef}^{commit}`)
  writeLine(`Comparing against ${baseRef} (${baseSha.slice(0, SHORT_SHA_LENGTH)})`)
  git('worktree', 'add', '--detach', baseDir, baseSha)
  // Same cases on both sides.
  copyFileSync(join(root, 'scripts', 'perf-gate.ts'), join(baseDir, 'scripts', 'perf-gate.ts'))
  // The base worktree shares this checkout's installed dependencies.
  symlinkSync(join(root, 'node_modules'), join(baseDir, 'node_modules'), 'dir')

  const baseRuns: Record<string, number>[] = []
  const headRuns: Record<string, number>[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const basePath = join(scratch, `base-${String(round)}.json`)
    const headPath = join(scratch, `head-${String(round)}.json`)
    // Alternate order to avoid consistently favoring either side through CPU
    // warm-up, thermal drift, or other time-correlated runner behavior.
    if (round % 2 === 0) {
      baseRuns.push(runGate(baseDir, basePath))
      headRuns.push(runGate(root, headPath))
    } else {
      headRuns.push(runGate(root, headPath))
      baseRuns.push(runGate(baseDir, basePath))
    }
  }
  const base = best(baseRuns)
  const head = best(headRuns)

  const failures: string[] = []
  writeLine('Relative performance (head vs base, best of rounds):')
  for (const [name, headHz] of Object.entries(head)) {
    const baseHz = base[name]
    if (baseHz === undefined || baseHz === 0) {
      writeLine(`- ${name}: ${Math.round(headHz).toLocaleString()} ops/sec (no base measurement)`)
      continue
    }
    const ratio = headHz / baseHz
    const status = ratio >= MIN_RETAINED_RATIO ? 'OK' : 'REGRESSION'
    writeLine(
      `- ${name}: ${Math.round(headHz).toLocaleString()} vs ${Math.round(baseHz).toLocaleString()} ops/sec (${(ratio * PERCENT).toFixed(0)}%) [${status}]`,
    )
    if (ratio < MIN_RETAINED_RATIO) {
      failures.push(
        `${name} retained only ${(ratio * PERCENT).toFixed(0)}% of base throughput (minimum ${String(MIN_RETAINED_RATIO * PERCENT)}%)`,
      )
    }
  }

  if (failures.length > 0) {
    throw new Error(`Performance regression against ${baseRef}:\n- ${failures.join('\n- ')}`)
  }
} finally {
  try {
    git('worktree', 'remove', '--force', baseDir)
  } catch {
    // The worktree may not have been created; prune whatever is left.
  }
  git('worktree', 'prune')
  rmSync(scratch, { recursive: true, force: true })
}
