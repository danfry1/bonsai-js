import { readFileSync } from 'node:fs'

// Fails when a mutation report scores under a floor. Stryker has one break
// threshold for a run; the weekly workflow runs one file per job, each with its
// own floor, so each job checks its report with this.
//
//   bun run scripts/mutation-floor.ts <report.json> <floor percent>

interface Report {
  files: Record<string, { mutants: { status: string }[] }>
}

const [path, floorText] = process.argv.slice(2)
const floor = Number(floorText)
if (path === undefined || !Number.isFinite(floor)) {
  throw new Error('usage: mutation-floor.ts <report.json> <floor percent>')
}

const report = JSON.parse(readFileSync(path, 'utf8')) as Report
// Stryker's mutation score: detected (killed or timed out) over detected and
// undetected (survived or without coverage); compile and runtime errors and
// ignored mutants count for neither.
let detected = 0
let undetected = 0
for (const file of Object.values(report.files)) {
  for (const { status } of file.mutants) {
    if (status === 'Killed' || status === 'Timeout') detected++
    else if (status === 'Survived' || status === 'NoCoverage') undetected++
  }
}
if (detected + undetected === 0) throw new Error(`${path} has no mutants to score`)
const PERCENT = 100
const score = (PERCENT * detected) / (detected + undetected)
const ok = score >= floor
process.stdout.write(
  `Mutation score ${score.toFixed(2)}% (floor ${floor}%): ${detected} detected, ${undetected} undetected [${ok ? 'PASS' : 'FAIL'}]\n`,
)
if (!ok) process.exitCode = 1
