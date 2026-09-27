import { performance } from 'node:perf_hooks'
import { bonsai } from '../src/index.js'

interface PerfCase {
  name: string
  minHz: number
  fn: () => unknown
}

interface PerfResult {
  name: string
  hz: number
  minHz: number
}

const OPS_PER_SECOND = 1000
const PERCENT = 100
const WARMUP_ITERATIONS = 20_000
const ASYNC_WARMUP_ITERATIONS = 2000
const DURATION_MS = 250
const MIN_CACHE_EFFECTIVENESS = 5
const MIN_COMPILED_RATIO = 0.85
const ITEM_COUNT = 1000
const PRICE_SPREAD = 50
const QTY_SPREAD = 5
const LAST_ID = 999

// Bonsai template source, not a JavaScript template.
// oxlint-disable-next-line no-template-curly-in-string
const TEMPLATE = '`${user.name} (${user.age}) on ${user.plan}`'
const RULE = 'user.age >= 18 && user.country == "GB" && user.plan == "pro"'

// A larger list exercises the per-element step accounting on the lambda path.
const collectionContext = {
  items: Array.from({ length: ITEM_COUNT }, (_, i) => ({
    id: i,
    active: i % 2 === 0,
    price: (i % PRICE_SPREAD) + 1,
    qty: (i % QTY_SPREAD) + 1,
  })),
}

const context = {
  user: {
    name: 'Dan',
    age: 30,
    country: 'GB',
    plan: 'pro',
    tags: ['beta', 'staff', 'vip'],
  },
  a: { x: 3 },
  b: { y: 4 },
  c: { z: 5 },
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`)
}

const env = bonsai()
const compiled = env.compile(RULE)
// A zero-size cache forces every evaluateSync(source) through parse, check, and compile.
const uncached = bonsai({ limits: { cacheSize: 0 } })

function measure(fn: () => unknown): number {
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

async function measureAsync(fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < ASYNC_WARMUP_ITERATIONS; i++) await fn()

  let iterations = 0
  const start = performance.now()
  let now = start

  while (now - start < DURATION_MS) {
    await fn()
    iterations++
    now = performance.now()
  }

  return (iterations * OPS_PER_SECOND) / (now - start)
}

// Floors are set to roughly one tenth of the throughput observed on a fast
// developer machine. That leaves comfortable headroom for slower, noisier CI
// runners while still failing on a catastrophic regression. This is a guard
// against regressions, not a microbenchmark; scripts/perf-compare.ts provides
// the tighter same-machine comparison. The cache-effectiveness and compiled
// parity ratios below are the relative, machine-independent checks.
const cases: PerfCase[] = [
  {
    name: 'cached rule',
    minHz: 1_200_000,
    fn: () => env.evaluateSync(RULE, context),
  },
  {
    name: 'compiled rule',
    minHz: 1_600_000,
    fn: () => compiled.evaluateSync(context),
  },
  {
    name: 'arithmetic',
    minHz: 900_000,
    fn: () => env.evaluateSync('a.x * b.y + c.z * 2', context),
  },
  {
    name: 'filter(.active).map(.price * .qty) x1000',
    minHz: 5_000,
    fn: () => env.evaluateSync('items.filter(.active).map(.price * .qty)', collectionContext),
  },
  {
    name: 'some(.id == 999) x1000',
    minHz: 7_000,
    fn: () => env.evaluateSync(`items.some(.id == ${String(LAST_ID)})`, collectionContext),
  },
  {
    name: 'in on list',
    minHz: 800_000,
    fn: () => env.evaluateSync('"vip" in user.tags', context),
  },
  {
    name: 'template',
    minHz: 500_000,
    fn: () => env.evaluateSync(TEMPLATE, context),
  },
]

const results: PerfResult[] = cases.map((entry) => ({
  name: entry.name,
  hz: measure(entry.fn),
  minHz: entry.minHz,
}))

results.push({
  name: 'async evaluate (sync expression)',
  hz: await measureAsync(() => env.evaluate(RULE, context)),
  minHz: 600_000,
})

results.push({
  name: 'cold compile',
  hz: measure(() => uncached.evaluateSync(RULE, context)),
  minHz: 28_000,
})

// Machine-readable output for scripts/perf-compare.ts.
const jsonPath = process.env.PERF_GATE_JSON
if (jsonPath !== undefined && jsonPath !== '') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    jsonPath,
    JSON.stringify(Object.fromEntries(results.map((result) => [result.name, result.hz]))),
  )
}

function resultNamed(name: string): PerfResult {
  const found = results.find((entry) => entry.name === name)
  if (!found) throw new Error(`Missing ${name} benchmark result`)
  return found
}

const cachedRule = resultNamed('cached rule')
const compiledRule = resultNamed('compiled rule')
const coldCompile = resultNamed('cold compile')

writeLine('Performance gate results:')
for (const result of results) {
  const status = result.hz >= result.minHz ? 'PASS' : 'FAIL'
  writeLine(
    `- ${result.name}: ${Math.round(result.hz).toLocaleString()} ops/sec (min ${result.minHz.toLocaleString()}) [${status}]`,
  )
}

const ratio = cachedRule.hz / coldCompile.hz
writeLine(`- cache effectiveness: ${ratio.toFixed(2)}x faster than a cold compile`)
const compiledRatio = compiledRule.hz / cachedRule.hz
writeLine(`- compiled/cached parity: ${compiledRatio.toFixed(2)}x`)

const failures = results
  .filter((result) => result.hz < result.minHz)
  .map((result) => `${result.name} dropped below ${result.minHz.toLocaleString()} ops/sec`)

if (ratio < MIN_CACHE_EFFECTIVENESS) {
  failures.push(
    `cached rule should be at least ${String(MIN_CACHE_EFFECTIVENESS)}x faster than a cold compile, got ${ratio.toFixed(2)}x`,
  )
}

if (compiledRatio < MIN_COMPILED_RATIO) {
  failures.push(
    `compiled rule should retain at least ${String(MIN_COMPILED_RATIO * PERCENT)}% of cached throughput, got ${(compiledRatio * PERCENT).toFixed(1)}%`,
  )
}

if (failures.length > 0) {
  throw new Error(`Performance gate failed:\n- ${failures.join('\n- ')}`)
}
