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
const PERCENT = 100
const WARMUP_ITERATIONS = 20_000
const DURATION_MS = 250
const MIN_CACHE_EFFECTIVENESS = 5
const MIN_COMPILED_RATIO = 0.85
const LAST_SAMPLE_ITEM = 5
const SAMPLE_ITEMS = [1, 2, 3, 4, LAST_SAMPLE_ITEM] as const

// A larger array exercises per-element step accounting (default-on via maxSteps)
// on the lambda-callback and spread paths, which the small SAMPLE_ITEMS case
// above does not. Guards against a regression in the accounting hot path.
const LAMBDA_ITEM_COUNT = 1000
const lambdaContext = {
  items: Array.from({ length: LAMBDA_ITEM_COUNT }, (_, i) => ({ x: i })),
}
const spreadContext = {
  items: Array.from({ length: LAMBDA_ITEM_COUNT }, (_, i) => i),
}

const collectionContext = {
  items: Array.from({ length: LAMBDA_ITEM_COUNT }, (_, i) => ({
    x: i,
    active: i % 2 === 0,
  })),
  nums: spreadContext.items,
}

const context = {
  user: {
    name: 'Dan',
    age: 30,
    verified: true,
    profile: { address: { city: 'London' } },
  },
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
  {
    // Per-element accounting path: a bonsai lambda charges one step per element.
    name: 'lambda map (.x) x1000',
    minHz: 12_000,
    fn: () => {
      expr.evaluateSync('items.map(.x)', lambdaContext)
    },
  },
  {
    // Per-element accounting path: spread materialization charges per element.
    name: 'array spread x1000',
    minHz: 15_000,
    fn: () => {
      expr.evaluateSync('[...items]', spreadContext)
    },
  },
  // The cases below have no absolute floor of their own (their throughput is
  // dominated by native work); they exist for the relative base-vs-head
  // comparison in scripts/perf-compare.ts, which is what actually catches a
  // regression. Member reads, array method dispatch, and membership were all
  // hot paths that regressed silently before that comparison existed.
  {
    name: 'deep member access',
    minHz: 1_000_000,
    fn: () => {
      expr.evaluateSync('user.profile.address.city', context)
    },
  },
  {
    name: 'filter(.active).map(.x) x1000',
    minHz: 8_000,
    fn: () => {
      expr.evaluateSync('items.filter(.active).map(.x)', collectionContext)
    },
  },
  {
    name: 'includes on x1000',
    minHz: 50_000,
    fn: () => {
      expr.evaluateSync('nums.includes(999)', collectionContext)
    },
  },
  {
    name: 'in on x1000',
    minHz: 50_000,
    fn: () => {
      expr.evaluateSync('999 in nums', collectionContext)
    },
  },
  {
    name: 'slice on x1000',
    minHz: 500_000,
    fn: () => {
      expr.evaluateSync('nums.slice(0, 3)', collectionContext)
    },
  },
]

const results: PerfResult[] = cases.map((entry) => ({
  name: entry.name,
  hz: measure(entry.fn),
  minHz: entry.minHz,
}))

// Machine-readable output for scripts/perf-compare.ts.
const jsonPath = process.env.PERF_GATE_JSON
if (jsonPath !== undefined && jsonPath !== '') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    jsonPath,
    JSON.stringify(Object.fromEntries(results.map((result) => [result.name, result.hz]))),
  )
}

const uncachedHz = measure(() => {
  uncached.clearCache()
  uncached.evaluateSync('user.age >= 18 && user.verified', context)
})

const cachedComparison = results.find((entry) => entry.name === 'cached comparison')
if (!cachedComparison) {
  throw new Error('Missing cached comparison benchmark result')
}
const compiledComparison = results.find((entry) => entry.name === 'compiled comparison')
if (!compiledComparison) {
  throw new Error('Missing compiled comparison benchmark result')
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
const compiledRatio = compiledComparison.hz / cachedComparison.hz
writeLine(`- compiled/cached parity: ${compiledRatio.toFixed(2)}x`)

const failures = results
  .filter((result) => result.hz < result.minHz)
  .map((result) => `${result.name} dropped below ${result.minHz.toLocaleString()} ops/sec`)

if (ratio < MIN_CACHE_EFFECTIVENESS) {
  failures.push(
    `cached comparison should be at least ${String(MIN_CACHE_EFFECTIVENESS)}x faster than uncached parsing, got ${ratio.toFixed(2)}x`,
  )
}

if (compiledRatio < MIN_COMPILED_RATIO) {
  failures.push(
    `compiled comparison should retain at least ${String(MIN_COMPILED_RATIO * PERCENT)}% of cached throughput, got ${(compiledRatio * PERCENT).toFixed(1)}%`,
  )
}

if (failures.length > 0) {
  throw new Error(`Performance gate failed:\n- ${failures.join('\n- ')}`)
}
