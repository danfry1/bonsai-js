import { performance } from 'node:perf_hooks'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'

interface PerfCase {
  name: string
  minHz: number
  fn: () => void
}

interface PerfResult {
  name: string
  hz: number
  minHz: number
}

const OPS_PER_SECOND = 1000
const WARMUP_ITERATIONS = 20_000
const DURATION_MS = 250
const LAST_SAMPLE_ITEM = 5
const SAMPLE_ITEMS = [1, 2, 3, 4, LAST_SAMPLE_ITEM] as const

const context = {
  user: { name: 'Dan', age: 30, verified: true },
  items: SAMPLE_ITEMS,
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`)
}

const expr = bonsai()
expr.use(strings)
expr.use(arrays)
expr.use(math)

const compiled = expr.compile('user.age >= 18 && user.verified')
const uncached = bonsai()
uncached.use(strings)
uncached.use(arrays)
uncached.use(math)

function measure(fn: () => void): number {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn()

  let iterations = 0
  const start = performance.now()
  let now = start

  while (now - start < DURATION_MS) {
    fn()
    iterations++
    now = performance.now()
  }

  const elapsedMs = now - start
  return (iterations * OPS_PER_SECOND) / elapsedMs
}

// Floors are set to roughly one tenth of the throughput observed on a fast
// developer machine. That leaves comfortable headroom for slower, noisier CI
// runners (which run perhaps a third to a half as fast) while still failing on
// a catastrophic regression (a ~3x or worse slowdown). This is a guard against
// regressions, not a microbenchmark; tighten deliberately if you record a
// CI-measured baseline. The cache-effectiveness ratio below is the relative,
// machine-independent check.
const cases: PerfCase[] = [
  {
    name: 'cached literal',
    minHz: 4_000_000,
    fn: () => {
      expr.evaluateSync('42')
    },
  },
  {
    name: 'cached comparison',
    minHz: 1_200_000,
    fn: () => {
      expr.evaluateSync('user.age >= 18 && user.verified', context)
    },
  },
  {
    name: 'transform pipeline',
    minHz: 1_500_000,
    fn: () => {
      expr.evaluateSync('user.name |> upper', context)
    },
  },
  {
    name: 'compiled comparison',
    minHz: 1_200_000,
    fn: () => {
      compiled.evaluateSync(context)
    },
  },
  {
    name: 'array transform',
    minHz: 2_500_000,
    fn: () => {
      expr.evaluateSync('items |> sum', context)
    },
  },
]

const results: PerfResult[] = cases.map((entry) => ({
  name: entry.name,
  hz: measure(entry.fn),
  minHz: entry.minHz,
}))

const uncachedHz = measure(() => {
  uncached.clearCache()
  uncached.evaluateSync('user.age >= 18 && user.verified', context)
})

const cachedComparison = results.find((entry) => entry.name === 'cached comparison')
if (!cachedComparison) {
  throw new Error('Missing cached comparison benchmark result')
}

writeLine('Performance gate results:')
for (const result of results) {
  const status = result.hz >= result.minHz ? 'PASS' : 'FAIL'
  writeLine(
    `- ${result.name}: ${Math.round(result.hz).toLocaleString()} ops/sec (min ${result.minHz.toLocaleString()}) [${status}]`,
  )
}

const ratio = cachedComparison.hz / uncachedHz
writeLine(`- cache effectiveness: ${ratio.toFixed(2)}x faster than uncached parsing`)

const failures = results
  .filter((result) => result.hz < result.minHz)
  .map((result) => `${result.name} dropped below ${result.minHz.toLocaleString()} ops/sec`)

if (ratio < 2) {
  failures.push(
    `cached comparison should be at least 2x faster than uncached parsing, got ${ratio.toFixed(2)}x`,
  )
}

if (failures.length > 0) {
  throw new Error(`Performance gate failed:\n- ${failures.join('\n- ')}`)
}
