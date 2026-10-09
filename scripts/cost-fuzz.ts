/**
 * Cost-model fuzzer: searches for work the step budget does not pay for.
 *
 * The promise under test: at the default limits, any expression finishes or
 * fails within about 100 ms (Node, the built dist). Each case runs one
 * operation over adversarial data in a loop that exhausts the default budget,
 * so its CPU time is what a full budget buys for that operation. A case far
 * above the baseline (ordinary work to the full budget) is work the charging
 * model misses. Cases run in Node child processes (this file with --worker),
 * each building only the host data its cases use, so a runaway case is killed
 * by a wall-clock guard and one case's garbage is not billed to another.
 *
 *   bun run build && bun run cost-fuzz              # 300 s, random seed
 *   bun run cost-fuzz --seconds 1800 --seed 7       # a longer search
 *   bun run cost-fuzz --cases 200 --limit-ms 150    # a fixed number of cases
 *   bun run cost-fuzz --limit-x 10                  # relative to the baseline, on a busy machine
 */
/* oxlint-disable no-magic-numbers -- the data sizes and limits are the point */
/* oxlint-disable no-template-curly-in-string -- Bonsai template sources */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

interface Case {
  readonly id: number
  readonly source: string
  /** `open`, `host`, or `validated:<name>` (see the worker). */
  readonly env: string
  readonly async?: boolean
  /** An `expect` type name (see expectTypes). */
  readonly expect?: string
  /** What the case exercises, for grouping findings. */
  readonly label: string
}

interface Result {
  readonly id: number
  readonly cpuMs: number
  readonly outcome: string
  readonly rssMb: number
}

interface Api {
  bonsai: (options?: object) => {
    evaluateSync: (source: string, context?: object) => unknown
    evaluate: (source: string, context?: object) => Promise<unknown>
    compile: (
      source: string,
      options?: object,
    ) => {
      evaluateSync: (context?: object) => unknown
      evaluate: (context?: object) => Promise<unknown>
    }
    listFunctions: () => readonly { name: string }[]
  }
  fn: (spec: object) => object
  t: Record<string, (...args: unknown[]) => object>
}

const argv: readonly string[] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const DIST = flag('dist') ?? 'dist/index.mjs'
const api = (await import(pathToFileURL(DIST).href)) as Api

const cpuMs = (since: NodeJS.CpuUsage): number => {
  const used = process.cpuUsage(since)
  return (used.user + used.system) / 1000
}

// ===================================================================== worker

async function worker(workerClass: string): Promise<void> {
  const { bonsai, fn, t } = api
  const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
  const wide = (n: number, key: (i: number) => string): Record<string, number> => {
    const out: Record<string, number> = {}
    for (let i = 0; i < n; i++) out[key(i)] = i
    return out
  }
  let deep: Record<string, unknown> = { v: 1 }
  for (let i = 0; i < 60; i++) deep = { d: deep, v: i }
  const sparse: unknown[] = []
  sparse.length = 2 ** 32 - 1
  sparse[5] = 1
  sparse[2 ** 31] = 2
  const zones = Intl.supportedValuesOf('timeZone')
  const currencies = Intl.supportedValuesOf('currency')
  class Account {
    readonly balance: number
    readonly owner: string
    constructor(i: number) {
      this.balance = i
      this.owner = `o${i}`
    }
  }
  const foreign = vm.runInNewContext(
    '({ map: new Map([["a", 1]]), date: new Date(0), obj: { a: 1 } })',
  ) as object

  // The class says which fixtures the cases use: `pure` builds none, `host` the
  // moderate host data, `validated:<name>` one huge record. Unrelated fixtures stay
  // out of the heap, so the collector's work (which grows with it) stays out of the timing.
  const context: Record<string, unknown> =
    workerClass === 'host'
      ? {
          ht: 'a'.repeat(99_990),
          hu: '😀'.repeat(49_000),
          hn: 1e308,
          hl: range(100_000),
          hstr: range(1000).map((i) => `${'s'.repeat(1000)}${i}`),
          hrec: range(50_000).map((i) => ({
            id: i,
            name: `n${i}`,
            tags: ['a', 'b'],
            score: i / 3,
          })),
          hsparse: sparse,
          hm: wide(100_000, (i) => `k${i}`),
          hmi: wide(100_000, (i) => String(i * 1_000_003)),
          hmd: wide(100_000, (i) => String(i)),
          hdeep: deep,
          hts: range(1000).map((i) => new Date(-8.64e15 + i * 1.7e13)),
          zones,
          currencies,
          locs: ['en', 'de-DE', 'ja-JP', 'ar-EG', 'hi-IN', 'zh-Hans-CN', 'fr-CA', 'x-bad'],
          accounts: range(10_000).map((i) => new Account(i)),
          foreign,
        }
      : { zones, currencies, locs: ['en', 'de-DE', 'ja-JP', 'x-bad'] }

  const bigRecord = workerClass === 'host' ? wide(200_000, (i) => `r${i}`) : {}
  const bigList = workerClass === 'host' ? range(100_000).map((i) => ({ id: i, s: `v${i}` })) : []
  const envs: Record<string, ReturnType<Api['bonsai']>> = {
    open: bonsai(),
    host: bonsai({
      functions: {
        bigRecord: fn({ params: [], returns: t.record(t.number()), run: () => bigRecord }),
        bigList: fn({
          params: [],
          returns: t.list(t.object({ id: t.number(), s: t.string() })),
          run: () => bigList,
        }),
        cheap: fn({
          params: [t.number()],
          returns: t.number(),
          cost: 1,
          run: (n: number) => n + 1,
        }),
        echo: fn({ params: [t.any()], returns: t.any(), run: (v: unknown) => v }),
      },
    }),
  }
  const validated = {
    huge: bonsai({ variables: { r: t.record(t.number()) }, validateContext: true }),
    records: bonsai({
      variables: { rs: t.list(t.object({ id: t.number(), name: t.string() })) },
      validateContext: true,
    }),
  }
  // Built on first use: they take a moment, and most batches never need them.
  const validatedBuilders: Record<string, () => object> = {
    huge: () => ({ r: wide(1_000_000, (i) => `h${i}`) }),
    hugeSparse: () => ({ r: wide(1_000_000, (i) => String(i * 7919)) }),
    records: () => ({ rs: range(100_000).map((i) => ({ id: i, name: `n${i}`, extra: i })) }),
  }
  const validatedContexts = new Map<string, object>()
  const validatedContext = (name: string): object => {
    let built = validatedContexts.get(name)
    if (built === undefined) {
      built = validatedBuilders[name]()
      validatedContexts.set(name, built)
    }
    return built
  }
  const expectTypes: Record<string, object> = {
    anyList: t.list(t.any()),
    records: t.list(t.object({ id: t.number(), s: t.string() })),
    numRecord: t.record(t.number()),
  }

  const collect = (globalThis as { gc?: () => void }).gc
  const outcomeOf = (error: unknown): string => {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code, name } = error as { code: unknown; name?: unknown }
      if (typeof name === 'string' && name.startsWith('Bonsai')) return String(code)
    }
    return `RAW ${String(error).slice(0, 120)}`
  }

  const run = async (c: Case): Promise<Result> => {
    const validatedName = c.env.startsWith('validated:')
      ? c.env.slice('validated:'.length)
      : undefined
    // Host data is built before the clock starts, and every case starts from a collected heap.
    const data = validatedName === undefined ? context : validatedContext(validatedName)
    collect?.()
    const started = process.cpuUsage()
    let outcome = 'OK'
    try {
      if (validatedName !== undefined) {
        const env = validatedName === 'records' ? validated.records : validated.huge
        env.evaluateSync(c.source, data)
      } else {
        const env = envs[c.env] ?? envs.open
        if (c.expect !== undefined) {
          const program = env.compile(c.source, { expect: expectTypes[c.expect] })
          if (c.async === true) await program.evaluate(data)
          else program.evaluateSync(data)
        } else if (c.async === true) await env.evaluate(c.source, data)
        else env.evaluateSync(c.source, data)
      }
    } catch (error) {
      outcome = outcomeOf(error)
    }
    const cpu = Math.round(cpuMs(started) * 10) / 10
    return { id: c.id, cpuMs: cpu, outcome, rssMb: Math.round(process.memoryUsage().rss / 1e6) }
  }

  // Baseline: ordinary work to the full default budget.
  const baseline: number[] = []
  for (let i = 0; i < 5; i++) {
    collect?.()
    const started = process.cpuUsage()
    try {
      envs.open.evaluateSync(
        'let L = "a".repeat(1000).split(""); L.map((x, i) => L.map((y, j) => j).length).length',
      )
    } catch {
      // STEP_LIMIT is the point.
    }
    baseline.push(cpuMs(started))
  }
  baseline.sort((a, b) => a - b)
  process.stdout.write(`${JSON.stringify({ baselineMs: baseline[2] })}\n`)
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === '') continue
    const c = JSON.parse(line) as Case
    // Announced first, so a case that hangs or crashes the worker is known.
    process.stdout.write(`${JSON.stringify({ start: c.id })}\n`)
    process.stdout.write(`${JSON.stringify(await run(c))}\n`)
  }
}

const isWorker: boolean = argv.includes('--worker')
if (isWorker) {
  await worker(flag('class') ?? 'host')
  process.exit(0)
}

// ===================================================================== parent

const SECONDS = Number(flag('seconds') ?? (flag('cases') === undefined ? '300' : '0'))
const CASES = Number(flag('cases') ?? '0')
const SEED = Number(flag('seed') ?? String(Date.now() % 1_000_000))
/** A case over this CPU time is reported. */
const LIMIT_MS = Number(flag('limit-ms') ?? '150')
/** With --limit-x, a case over this many times its batch's baseline is reported instead (for a loaded machine). */
const LIMIT_X = flag('limit-x') === undefined ? undefined : Number(flag('limit-x'))
/** Wall time after which a silent worker is killed and its case reported as a hang. */
const HANG_MS = Number(flag('hang-ms') ?? '10000')
const TOP = Number(flag('top') ?? '15')
const BATCH = 40

let seed = SEED >>> 0 || 1
const random = (): number => {
  // xorshift32
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 2 ** 32
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]

/**
 * Data an operation can take. Each kind lists expressions that build or name
 * adversarial values; the loop variables are `x`/`y` (one-letter strings) and
 * `i`/`j` (indices, 0-999).
 */
const KINDS = {
  text: [
    'x',
    'toString(j)',
    'ht',
    'hu',
    's',
    's + toString(j)',
    'toString(j) + s',
    // oxlint-disable-next-line no-template-curly-in-string -- Bonsai template source
    '`${s}${j}`',
    'hstr[j]',
    '"😀".repeat(20000) + y',
    '"ab".repeat(j)',
    '"ÿß".repeat(30000)',
  ],
  num: ['j', 'i * 1000 + j', 'hn', '-0', '0.1', '1e-300', 'hl[j]', 'j * 1000003'],
  list: [
    'L',
    'hl',
    'hsparse',
    'hstr',
    'hrec',
    'accounts',
    'L.map((z, k) => k)',
    'L.map((z, k) => {id: k, s: s})',
    'L.map((z, k) => [k, [k]])',
    'hts',
    'zones',
  ],
  map: [
    'hm',
    'hmi',
    'hmd',
    'hdeep',
    'm',
    'mi',
    '{a: 1, b: s}',
    'hrec[j]',
    'accounts[j]',
    'foreign',
  ],
  ts: ['timestamp(-8.64e15)', 'timestamp(8.64e15)', 'now()', 'hts[j]', 'timestamp(j * 86400000)'],
  dur: ['milliseconds(1.7e308)', 'days(j)', 'milliseconds(0.0001)', 'timestamp(j) - now()'],
  zone: [
    '"Europe/Berlin"',
    'zones[j % 400]',
    '"Bad/" + toString(j)',
    '"Pacific/Chatham"',
    '"Asia/Kolkata"',
  ],
  locale: ['"de-DE"', 'locs[j % 8]', '"x-" + toString(j)', '"en-u-nu-arab"'],
  currency: ['"EUR"', 'currencies[j % 300]', '"QQ" + toString(j % 10)'],
  pattern: [
    '"a+b"',
    '"(a|aa)*c"',
    '"^" + toString(j)',
    '"[a-z0-9._%+-]+@[a-z]+\\\\.[a-z]{2,}"',
    '"(" + toString(j)',
    '"(?:[a-z]{99}){9}"',
    '"[" + "Ā".repeat(1000) + "]x"',
    '"\\\\b" + toString(j) + "\\\\b"',
  ],
} as const
type Kind = keyof typeof KINDS
const v = (kind: Kind): string => `(${pick(KINDS[kind])})`

/** One operation per built-in (checked against listFunctions below), plus syntax. */
const OPS: Readonly<Record<string, () => string>> = {
  toUpperCase: () => `toUpperCase(${v('text')})`,
  toLowerCase: () => `toLowerCase(${v('text')})`,
  trim: () => `trim(${v('text')})`,
  trimStart: () => `trimStart(${v('text')})`,
  trimEnd: () => `trimEnd(${v('text')})`,
  startsWith: () => `startsWith(${v('text')}, ${v('text')})`,
  endsWith: () => `endsWith(${v('text')}, ${v('text')})`,
  includes: () =>
    pick([`includes(${v('text')}, ${v('text')})`, `includes(${v('list')}, ${v('num')})`]),
  indexOf: () =>
    pick([`indexOf(${v('text')}, ${v('text')})`, `indexOf(${v('list')}, ${v('map')})`]),
  lastIndexOf: () =>
    pick([`lastIndexOf(${v('text')}, ${v('text')})`, `lastIndexOf(${v('list')}, ${v('num')})`]),
  slice: () => pick([`slice(${v('text')}, 1, -1)`, `slice(${v('list')}, 1, 90000)`]),
  split: () => `split(${v('text')}, ${pick(['""', '"a"', 'y', v('text')])})`,
  replace: () => `replace(${v('text')}, ${v('text')}, ${v('text')})`,
  replaceAll: () => `replaceAll(${v('text')}, ${pick(['""', '"a"', v('text')])}, ${v('text')})`,
  padStart: () => `padStart(${v('text')}, ${pick(['99999', 'j * 100'])}, ${v('text')})`,
  padEnd: () => `padEnd(${v('text')}, ${pick(['99999', 'j * 100'])}, ${v('text')})`,
  repeat: () => `repeat(${v('text')}, ${pick(['2', 'j', '99999'])})`,
  at: () => pick([`at(${v('text')}, -1)`, `at(${v('list')}, j)`]),
  matches: () => `matches(${v('text')}, ${v('pattern')})`,
  toString: () => `toString(${pick([v('num'), v('ts'), v('dur'), v('text'), 'true'])})`,
  toNumber: () => `toNumber(${pick([v('text'), '"1e400"', '"0x1F"', 'toString(j)'])})`,
  round: () => `round(${v('num')}, ${pick(['0', '2', '-3'])})`,
  floor: () => `floor(${v('num')})`,
  ceil: () => `ceil(${v('num')})`,
  trunc: () => `trunc(${v('num')})`,
  abs: () => pick([`abs(${v('num')})`, `abs(${v('dur')})`]),
  sqrt: () => `sqrt(${v('num')})`,
  clamp: () => `clamp(${v('num')}, 0, 10)`,
  toFixed: () => `toFixed(${v('num')}, ${pick(['0', '20', '100'])})`,
  formatNumber: () => `formatNumber(${v('num')}, ${pick(['0', '2', '20'])}, ${v('locale')})`,
  formatCurrency: () => `formatCurrency(${v('num')}, ${v('currency')}, ${v('locale')})`,
  min: () => pick([`min(${v('list')})`, `min(${v('num')}, ${v('num')})`]),
  max: () => pick([`max(${v('list')})`, `max(${v('ts')}, ${v('ts')})`]),
  sum: () => `sum(${v('list')})`,
  avg: () => `avg(${v('list')})`,
  // oxlint-disable-next-line no-template-curly-in-string -- Bonsai template source
  map: () => `map(${v('list')}, (e) => ${pick(['e', '[e]', '{e: e}', '`${e}`'])}).length`,
  filter: () => `filter(${v('list')}, (e) => e == e).length`,
  find: () => `find(${v('list')}, (e) => e != e)`,
  findIndex: () => `findIndex(${v('list')}, (e) => e != e)`,
  some: () => `some(${v('list')}, (e) => e != e)`,
  every: () => `every(${v('list')}, (e) => e == e)`,
  none: () => `none(${v('list')}, (e) => e != e)`,
  flatMap: () => `flatMap(${v('list')}, (e) => [e, e]).length`,
  sortBy: () => `sortBy(${v('list')}, (e) => ${pick(['toString(e)', 'e', 's'])}).length`,
  groupBy: () =>
    `keys(groupBy(${v('list')}, (e) => ${pick(['toString(e)', 's + toString(e)', 'e'])})).length`,
  count: () => pick([`count(${v('list')})`, `count(${v('list')}, (e) => e == e)`]),
  reduce: () =>
    `reduce(${v('list')}, (acc, e) => ${pick(['acc + 1', 'acc + toString(e)', '[acc]'])}, ${pick(['0', '""', '[]'])})`,
  sort: () => `sort(${v('list')}).length`,
  reverse: () => `reverse(${v('list')}).length`,
  unique: () => `unique(${v('list')}).length`,
  flat: () => `flat(${v('list')}).length`,
  first: () => `first(${v('list')})`,
  last: () => `last(${v('list')})`,
  join: () => `join(${v('list')}, ${pick(['""', '", "', 's'])})`,
  isEmpty: () => pick([`isEmpty(${v('map')})`, `isEmpty(${v('list')})`, `isEmpty(${v('text')})`]),
  keys: () => `keys(${v('map')}).length`,
  values: () => `values(${v('map')}).length`,
  entries: () => `entries(${v('map')}).length`,
  type: () => `type(${pick(Object.keys(KINDS).map((k) => v(k as Kind)))})`,
  now: () => 'now()',
  timestamp: () =>
    `timestamp(${pick([v('num'), '"2026-03-29T01:30:00Z"', '"+275760-09-13T00:00:00Z"', v('text')])})`,
  duration: () =>
    `duration(${pick([v('dur'), '"-P999999999999999DT999999999999999H"', '"PT0.001S"', v('text')])})`,
  weeks: () => `weeks(${v('num')})`,
  days: () => `days(${v('num')})`,
  hours: () => `hours(${v('num')})`,
  minutes: () => `minutes(${v('num')})`,
  seconds: () => `seconds(${v('num')})`,
  milliseconds: () => `milliseconds(${v('num')})`,
  inDays: () => `inDays(${v('dur')})`,
  inHours: () => `inHours(${v('dur')})`,
  inMinutes: () => `inMinutes(${v('dur')})`,
  inSeconds: () => `inSeconds(${v('dur')})`,
  inMilliseconds: () => `inMilliseconds(${v('dur')})`,
  year: () => `year(${v('ts')}, ${v('zone')})`,
  month: () => `month(${v('ts')}, ${v('zone')})`,
  day: () => `day(${v('ts')}, ${v('zone')})`,
  hour: () => `hour(${v('ts')}, ${v('zone')})`,
  minute: () => `minute(${v('ts')}, ${v('zone')})`,
  second: () => `second(${v('ts')}, ${v('zone')})`,
  dayOfWeek: () => `dayOfWeek(${v('ts')}, ${v('zone')})`,
  startOfDay: () => `startOfDay(${v('ts')}, ${v('zone')})`,
  startOfMonth: () => `startOfMonth(${v('ts')}, ${v('zone')})`,
  startOfYear: () => `startOfYear(${v('ts')}, ${v('zone')})`,
  addDays: () => `addDays(${v('ts')}, ${pick(['j', '1e8', '-1'])}, ${v('zone')})`,
  addMonths: () => `addMonths(${v('ts')}, ${pick(['j', '1e6'])}, ${v('zone')})`,
  addYears: () => `addYears(${v('ts')}, ${pick(['j', '1e308'])}, ${v('zone')})`,
  formatDate: () =>
    `formatDate(${v('ts')}, ${pick(['"yyyy-MM-dd HH:mm:ss"', '"EEEE ".repeat(j)', '"s".repeat(j * 100)'])}, ${v('zone')})`,
}

/** Operators and syntax forms, over any kinds. */
const SYNTAX: readonly (() => string)[] = [
  () => `${v('text')} + ${v('text')}`,
  () => `${v('text')} == ${v('text')}`,
  () => `${v('text')} != ${v('text')}`,
  () => `${v('text')} < ${v('text')}`,
  () => `${v('map')} == ${v('map')}`,
  () => `${v('list')} == ${v('list')}`,
  () => `${v('text')} in ${v('text')}`,
  () => `${v('text')} in ${v('map')}`,
  () => `${v('num')} in ${v('list')}`,
  () => `${v('map')} in ${v('list')}`,
  () => `${v('map')}[${v('text')}]`,
  () => `${v('list')}[j]`,
  () => `${v('text')}[j]`,
  () => `has(${v('map')}.k5)`,
  () => `${v('map')}?.k7 ?? ${v('num')}`,
  () => `\`\${${v('ts')}}\${${v('dur')}}\${${v('text')}}\``,
  () => `[...${v('list')}, j].length`,
  () => `{...${v('map')}, k: j}.k`,
  () => `{[${v('text')}]: j}`,
  () => `try(${pick(Object.values(OPS))()}, 0)`,
  () => `try(${v('num')} / 0, 0)`,
  () => `let q = ${v('text')}; q + q`,
  () => `${v('num')} ** ${v('num')}`,
  () => `${v('num')} % 7`,
  () => `${v('ts')} - ${v('ts')}`,
  () => `${v('ts')} + ${v('dur')}`,
  () => `${v('dur')} * 3`,
  () => `-${v('dur')}`,
  () => `j > 500 ? ${v('text')} : ${v('text')}`,
]

/** Data the expression builds for itself before the loop. */
const PRELUDE =
  'let L = "a".repeat(1000).split(""); let s = "a".repeat(99990); ' +
  'let m = L.groupBy((z, k) => "k" + toString(k)); let mi = L.groupBy((z, k) => k * 1000003); '

/** Wraps one operation in a loop that runs until the default budget is gone. */
function wrap(op: string): string {
  return `${PRELUDE}L.map((x, i) => L.map((y, j) => ${op}).length).length`
}

/** Cases the random generator would rarely reach: host boundaries and one-shot heavy work. */
const FIXED: readonly Omit<Case, 'id'>[] = [
  { label: 'validateContext 1M-key record', source: 'r.h1', env: 'validated:huge' },
  {
    label: 'validateContext 1M sparse-key record',
    source: 'r["7919"]',
    env: 'validated:hugeSparse',
  },
  { label: 'validateContext 100k records', source: 'rs[0].id', env: 'validated:records' },
  { label: 'host result 200k-key record', source: 'bigRecord().r1', env: 'host' },
  { label: 'host result in a loop', source: wrap('bigRecord().r1'), env: 'host' },
  { label: 'host result list', source: wrap('bigList()[j].id'), env: 'host' },
  { label: 'host call cost 1', source: wrap('cheap(j)'), env: 'host' },
  { label: 'host echo of host data', source: wrap('keys(echo(hm)).length'), env: 'host' },
  { label: 'expect guard on host list', source: 'hrec', env: 'open', expect: 'anyList' },
  {
    label: 'expect guard on records',
    source: 'hrec.map(r => {id: r.id, s: r.name})',
    env: 'open',
    expect: 'records',
  },
  { label: 'expect guard on wide map', source: 'hm', env: 'open', expect: 'numRecord' },
  {
    label: 'async map over host list',
    source: wrap('keys(hrec[j]).length'),
    env: 'open',
    async: true,
  },
  {
    label: 'sparse int-key spread ==',
    source:
      'let m = "a".repeat(100000).split("").groupBy((x, i) => i * 1000003); "a".repeat(40).split("").map(z => {...m} == m).length',
    env: 'open',
  },
  {
    label: 'sparse int-key spread read',
    source:
      'let m = "a".repeat(50000).split("").groupBy((x, i) => i * 1000003); "a".repeat(40).split("").map(z => {...m}.a).length',
    env: 'open',
  },
  {
    label: 'sparse int-key keys',
    source:
      'let m = "a".repeat(100000).split("").groupBy((x, i) => i * 1000003); "a".repeat(40).split("").map(z => m.keys().length).length',
    env: 'open',
  },
  {
    label: 'template of 64 timestamps',
    source: `let n = timestamp(-8.64e15); "a".repeat(1000).split("").map(x => "a".repeat(1000).split("").map(y => \`${'${n}'.repeat(64)}\`).length).length`,
    env: 'open',
  },
  {
    label: 'duration toString x8',
    source:
      'let d = milliseconds(1.7e308); "a".repeat(1000).split("").map(x => "a".repeat(1000).split("").map(y => [toString(d), toString(d), toString(d), toString(d), toString(d), toString(d), toString(d), toString(d)]).length).length',
    env: 'open',
  },
  {
    label: 'formatCurrency distinct locales',
    source: wrap('formatCurrency(j, currencies[(i * 7 + j) % 300], locs[j % 8])'),
    env: 'open',
  },
  { label: 'unique on records', source: wrap('unique(hrec).length'), env: 'open' },
  {
    label: 'unique on records of long strings',
    source: wrap('unique(hstr.map(e => {e: e, s: s})).length'),
    env: 'open',
  },
  {
    label: 'map equality, different sizes',
    source:
      'let m = "a".repeat(50000).split("").groupBy((x, i) => i); "a".repeat(100000).split("").map(x => m == {} || m == {}).length',
    env: 'open',
  },
  {
    label: 'rope index',
    source:
      'let s = "a".repeat(99990); "a".repeat(50000).split("").map((x, i) => let r = s + toString(i); r[0] == "a" ? r : "").length',
    env: 'open',
  },
]

function randomCase(id: number): Case {
  const useSyntax = random() < 0.35
  const name = useSyntax ? 'syntax' : pick(Object.keys(OPS))
  const op = useSyntax ? pick(SYNTAX)() : OPS[name]()
  return { id, source: wrap(op), env: 'open', async: random() < 0.1, label: name }
}

// Every built-in has a generator, so a new one cannot be skipped.
const missing = api
  .bonsai()
  .listFunctions()
  .map((f) => f.name)
  .filter((name) => !(name in OPS))
if (missing.length > 0) {
  process.stderr.write(`cost-fuzz: no generator for built-ins: ${missing.join(', ')}\n`)
  process.exit(2)
}

/** Host data names; a case that uses none runs in a worker without host fixtures. */
const HOST_NAME =
  /\b(?:ht|hu|hn|hl|hstr|hrec|hsparse|hm|hmi|hmd|hdeep|hts|accounts|foreign|bigRecord|bigList|cheap|echo)\b/u
function classOf(c: Case): string {
  if (c.env.startsWith('validated:')) return c.env
  return HOST_NAME.test(c.source) || c.env === 'host' ? 'host' : 'pure'
}

interface Batch {
  readonly baselineMs: number
  readonly results: Result[]
  /** The case running when the worker hung or died. */
  readonly hung: number | undefined
}

function runBatch(cases: readonly Case[]): Promise<Batch> {
  return new Promise((resolve) => {
    const child = spawn('node', [
      '--max-old-space-size=4096',
      '--expose-gc',
      'scripts/cost-fuzz.ts',
      '--worker',
      '--dist',
      DIST,
      '--class',
      classOf(cases[0]),
    ])
    const results: Result[] = []
    let baselineMs = Number.NaN
    let running: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve({ baselineMs, results, hung: running })
    }
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(finish, HANG_MS)
    }
    arm()
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Partial<Result> & { baselineMs?: number; start?: number }
      if (message.baselineMs !== undefined) {
        baselineMs = message.baselineMs
        for (const c of cases) child.stdin.write(`${JSON.stringify(c)}\n`)
        child.stdin.end()
      } else if (message.start !== undefined) {
        running = message.start
      } else {
        results.push(message as Result)
        running = undefined
      }
      arm()
    })
    child.on('exit', finish)
  })
}

const findings: { c: Case; r: Result | undefined; kind: string }[] = []
const all: { c: Case; r: Result }[] = []
const baselines: number[] = []

async function runAll(cases: readonly Case[]): Promise<void> {
  let queue = [...cases]
  while (queue.length > 0) {
    const kind = classOf(queue[0])
    const batch = queue.filter((c) => classOf(c) === kind).slice(0, BATCH)
    const out = await runBatch(batch)
    if (!Number.isNaN(out.baselineMs)) baselines.push(out.baselineMs)
    const byId = new Map(batch.map((c) => [c.id, c]))
    for (const r of out.results) {
      const c = byId.get(r.id) as Case
      all.push({ c, r })
      if (r.outcome.startsWith('RAW')) findings.push({ c, r, kind: 'raw error' })
      else if (LIMIT_X === undefined ? r.cpuMs > LIMIT_MS : r.cpuMs > LIMIT_X * out.baselineMs)
        findings.push({ c, r, kind: 'slow' })
    }
    const done = new Set(out.results.map((r) => r.id))
    if (out.hung !== undefined) {
      findings.push({ c: byId.get(out.hung) as Case, r: undefined, kind: 'hang or crash' })
      done.add(out.hung)
    } else if (out.results.length === 0) {
      process.stderr.write('cost-fuzz: the worker produced nothing; is the dist built?\n')
      process.exit(2)
    }
    const inBatch = new Set(batch.map((c) => c.id))
    queue = [...batch.filter((c) => !done.has(c.id)), ...queue.filter((c) => !inBatch.has(c.id))]
  }
}

const started = Date.now()
let nextId = 0
await runAll(FIXED.map((c) => ({ ...c, id: nextId++ })))
while ((CASES > 0 && nextId - FIXED.length < CASES) || Date.now() < started + SECONDS * 1000) {
  const batch: Case[] = []
  for (let k = 0; k < BATCH; k++) batch.push(randomCase(nextId++))
  await runAll(batch)
}

const say = (text: string): void => {
  process.stdout.write(`${text}\n`)
}
baselines.sort((a, b) => a - b)
say(
  `cost-fuzz: seed ${SEED}, ${all.length} cases in ${Math.round((Date.now() - started) / 1000)}s, ` +
    `baseline ${(baselines[Math.floor(baselines.length / 2)] ?? Number.NaN).toFixed(1)} ms per full budget, limit ${LIMIT_MS} ms`,
)
say(`worst ${TOP} by CPU time:`)
for (const { c, r } of all.sort((a, b) => b.r.cpuMs - a.r.cpuMs).slice(0, TOP)) {
  say(`  ${r.cpuMs.toFixed(1).padStart(8)} ms  ${r.outcome.padEnd(14)} ${c.label}`)
}
// One finding per class: the shortest source that shows it.
const byClass = new Map<string, (typeof findings)[number]>()
for (const f of findings) {
  const key = `${f.kind}:${f.c.label}`
  const seen = byClass.get(key)
  if (seen === undefined || f.c.source.length < seen.c.source.length) byClass.set(key, f)
}
if (byClass.size === 0) say('no findings')
for (const f of byClass.values()) {
  const detail = f.r === undefined ? '' : ` ${f.r.cpuMs} ms, ${f.r.outcome}, rss ${f.r.rssMb} MB`
  say(
    `[${f.kind}] ${f.c.label}:${detail}\n    env=${f.c.env}${f.c.async === true ? ' async' : ''} ${f.c.source}`,
  )
}
process.exit(byClass.size > 0 ? 1 : 0)
