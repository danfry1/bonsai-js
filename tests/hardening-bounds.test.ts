import { describe, expect, it } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'
import { codeOf } from './helpers.js'

const env = bonsai()
const wide = (n: number, key: (i: number) => string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (let i = 0; i < n; i++) out[key(i)] = i
  return out
}

describe('work the step budget pays for', () => {
  it('charges listing a large map by its size (keys, isEmpty, spread)', () => {
    // 20,000 keys is past the large-map threshold: 4 steps per key to list.
    const m = wide(20_000, (i) => `k${i}`)
    expect(codeOf(() => env.evaluateSync('keys(m).length', { m }, { maxSteps: 70_000 }))).toBe(
      'STEP_LIMIT',
    )
    expect(env.evaluateSync('keys(m).length', { m }, { maxSteps: 100_000 })).toBe(20_000)
    expect(codeOf(() => env.evaluateSync('isEmpty(m)', { m }, { maxSteps: 70_000 }))).toBe(
      'STEP_LIMIT',
    )
    // A spread lists and writes every key: 4 + 6 steps each.
    expect(codeOf(() => env.evaluateSync('{...m}.k1', { m }, { maxSteps: 150_000 }))).toBe(
      'STEP_LIMIT',
    )
    expect(env.evaluateSync('{...m}.k1', { m }, { maxSteps: 250_000 })).toBe(1)
  })

  it('charges building a large map with groupBy', () => {
    const source = 'keys(groupBy(xs, (x) => x * 1000003)).length'
    const xs = Array.from({ length: 20_000 }, (_, i) => i)
    expect(codeOf(() => env.evaluateSync(source, { xs }, { maxSteps: 300_000 }))).toBe('STEP_LIMIT')
    expect(env.evaluateSync(source, { xs }, { maxSteps: 1_000_000 })).toBe(20_000)
  })

  it('charges comparing maps of different sizes for listing both', () => {
    const m = wide(20_000, (i) => `k${i}`)
    expect(
      codeOf(() => env.evaluateSync('m == {} || m == {} || m == {}', { m }, { maxSteps: 200_000 })),
    ).toBe('STEP_LIMIT')
  })

  it('charges the keys of a record while validating the context', () => {
    const typed = bonsai({ variables: { r: t.record(t.number()) }, validateContext: true })
    // 300,000 keys cost 4 steps each to list: more than the default budget.
    expect(codeOf(() => typed.evaluateSync('1', { r: wide(300_000, (i) => `h${i}`) }))).toBe(
      'STEP_LIMIT',
    )
    expect(typed.evaluateSync('r.h1', { r: wide(1000, (i) => `h${i}`) })).toBe(1)
  })

  it('charges the keys of a record a host function returns', () => {
    const big = wide(300_000, (i) => `r${i}`)
    const hosted = bonsai({
      functions: { big: fn({ params: [], returns: t.record(t.number()), run: () => big }) },
    })
    expect(codeOf(() => hosted.evaluateSync('big().r1'))).toBe('STEP_LIMIT')
  })

  it('charges the remainder of a huge number by its long division', () => {
    const source = 'xs.map(x => hn % 7).length'
    const xs = Array.from({ length: 1000 }, (_, i) => i)
    // 1e308 % 7 divides over about 1000 bits: some 40 steps, not 1.
    expect(codeOf(() => env.evaluateSync(source, { xs, hn: 1e308 }, { maxSteps: 20_000 }))).toBe(
      'STEP_LIMIT',
    )
    expect(env.evaluateSync(source, { xs, hn: 1e6 }, { maxSteps: 20_000 })).toBe(1000)
    expect(env.evaluateSync('hn % 7', { hn: 1e308 })).toBe(1e308 % 7)
  })

  it('charges reading a time zone past the end of the Date range every time', () => {
    const source = 'xs.map(x => startOfYear(timestamp(8.64e15), "Pacific/Chatham")).length'
    const xs = Array.from({ length: 200 }, (_, i) => i)
    expect(codeOf(() => env.evaluateSync(source, { xs }, { maxSteps: 5000 }))).toBe('STEP_LIMIT')
  })

  it('charges unique() for building and hashing each key', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i)
    expect(codeOf(() => env.evaluateSync('unique(xs).length', { xs }, { maxSteps: 5000 }))).toBe(
      'STEP_LIMIT',
    )
    expect(env.evaluateSync('unique(xs).length', { xs }, { maxSteps: 20_000 })).toBe(1000)
  })
})

describe('has() reads like any other read', () => {
  it('is a TYPE_ERROR on an opaque value, like "k" in it', () => {
    const lookup = new Map([['a', 1]])
    expect(codeOf(() => env.evaluateSync('has(m.a)', { m: lookup }))).toBe('TYPE_ERROR')
    expect(codeOf(() => env.evaluateSync('has(m["a"])', { m: lookup }))).toBe('TYPE_ERROR')
    expect(codeOf(() => env.evaluateSync('"a" in m', { m: lookup }))).toBe('TYPE_ERROR')
    expect(env.evaluateSync('try(has(m.a), false)', { m: lookup })).toBe(false)
  })

  it('keeps its documented answers for maps, lists, and null', () => {
    expect(env.evaluateSync('has(m.a)', { m: { a: null } })).toBe(true)
    expect(env.evaluateSync('has(m.b)', { m: { a: 1 } })).toBe(false)
    expect(env.evaluateSync('has(xs[1])', { xs: [1, 2] })).toBe(true)
    expect(env.evaluateSync('has(n.a)', { n: null })).toBe(false)
  })
})

describe('produced lists never hold host undefined', () => {
  const xs = [3, undefined, 1]
  // oxlint-disable-next-line no-sparse-arrays -- a hole is the point
  const holes = [3, , 1]
  it.each([
    'sort(xs)',
    'sortBy(xs, (x) => x)',
    'reverse(xs)',
    'slice(xs, 0)',
    'xs + [1]',
    'filter(xs, (x) => true)',
    'flat([xs])',
    'flatMap([1], (x) => xs)',
    'values(groupBy(xs, (x) => "g"))[0]',
  ])('%s', (source) => {
    for (const list of [xs, holes]) {
      const result = env.evaluateSync(source, { xs: list }) as unknown[]
      expect(result.includes(undefined)).toBe(false)
      expect(result.includes(null)).toBe(true)
    }
  })
})

describe('time zones: cached offsets match Intl at real transitions', () => {
  it.each(['Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Santiago'])(
    '%s, 2020 to 2026',
    (zone) => {
      const format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
      const fields = (ms: number): string =>
        format
          .formatToParts(new Date(ms))
          .filter((p) => p.type !== 'literal')
          .map((p) => Number(p.value))
          .join(',')
      const offset = (ms: number): number => {
        const [mo, d, y, h, mi, s] = fields(ms).split(',').map(Number)
        return Date.UTC(y, mo - 1, d, h, mi, s) - ms
      }
      const program = env.compile(
        '[month(t, z), day(t, z), year(t, z), hour(t, z), minute(t, z), second(t, z)]',
      )
      let transitions = 0
      const step = 3 * 3_600_000
      let previous = offset(Date.UTC(2020, 0, 1))
      for (let ms = Date.UTC(2020, 0, 1); ms < Date.UTC(2026, 0, 1); ms += step) {
        const now = offset(ms)
        if (now === previous) continue
        let low = (ms - step) / 1000
        let high = ms / 1000
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2)
          if (offset(middle * 1000) === previous) low = middle
          else high = middle
        }
        transitions++
        for (const at of [high * 1000 - 1000, high * 1000, high * 1000 + 1000]) {
          expect((program.evaluateSync({ t: new Date(at), z: zone }) as number[]).join(',')).toBe(
            fields(at),
          )
        }
        previous = now
      }
      expect(transitions).toBeGreaterThan(0)
    },
  )
})
