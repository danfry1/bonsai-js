import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BonsaiError, Duration, bonsai, t } from '../src/index.js'
import { BonsaiTranslationError, toMongo, toSQL, type Columns } from '../src/query/index.js'

const open = bonsai()

function outcome(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiError) return error.code
    return `raw ${error instanceof Error ? error.message : String(error)}`
  }
  return 'ok'
}

describe('paths read through let names are checked in linear time', () => {
  // 20 lets of 40 members each: the last name stands for a path 800 keys long.
  const lets = (): string => {
    let source = ''
    let previous = 'k'
    for (let i = 1; i <= 20; i++) {
      source += `let a${i} = ${previous}${'.b'.repeat(40)}; `
      previous = `a${i}`
    }
    return source
  }
  const cyclic = (): Record<string, unknown> => {
    const node: Record<string, unknown> = { x: 1 }
    node.b = node
    return node
  }
  const options = { row: 'order', columns: { total: 'number' }, dialect: 'postgres' } as const

  it('proves and resolves a long aliased path once, however often it is used', () => {
    const guards = Array.from({ length: 300 }, () => 'has(a20.x)').join(' && ')
    const program = open.compile(`${lets()}${guards} && order.total > 1`)
    const start = performance.now()
    // Every proof used to build one key per prefix: hundreds of MB and seconds.
    expect(toSQL(program, { ...options, known: { k: cyclic() } }).sql).toBe(
      '(`total`::float8 > $1::float8)'.replaceAll('`', '"'),
    )
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('still names the missing part of an aliased path', () => {
    const program = open.compile(`${lets()}order.total > a20.x`)
    expect(() => toSQL(program, { ...options, known: { k: {} } })).toThrow(
      /^k\.b is missing from the known values/u,
    )
  })

  it('accepts a guard reached through a let name, and refuses an unguarded read', () => {
    const guarded = open.compile('let l = limits; has(l.max) && order.total > l.max')
    expect(toSQL(guarded, { ...options, known: { limits: {} } }).sql).toBe('FALSE')
    const unguarded = open.compile('let l = limits; order.total > l.max')
    expect(() => toSQL(unguarded, { ...options, known: { limits: {} } })).toThrow(
      /^limits\.max is missing/u,
    )
  })
})

describe('known Durations are read as evaluation reads them', () => {
  const program = open.compile('order.wait == d')
  const sql = (known: Record<string, unknown>) => () =>
    toSQL(program, { row: 'order', columns: { wait: 'duration' }, dialect: 'postgres', known })
  const mongo = (known: Record<string, unknown>) => () =>
    toMongo(program, { row: 'order', fields: { wait: 'duration' }, known })

  it('refuses a forged Duration, which evaluation treats as opaque', () => {
    const half = Object.freeze(Object.setPrototypeOf({ ms: 1.5 }, Duration.prototype) as Duration)
    const huge = Object.freeze(Object.setPrototypeOf({ ms: 1e300 }, Duration.prototype) as Duration)
    expect(program.evaluateSync({ order: { wait: new Duration(2) }, d: half })).toBe(false)
    for (const d of [half, huge]) {
      expect(outcome(sql({ d }))).toBe('UNTRANSLATABLE')
      expect(outcome(mongo({ d }))).toBe('UNTRANSLATABLE')
    }
  })

  it('never sends a value that changes after it is checked', () => {
    // A getter that is a number when checked and a pattern afterwards.
    const shifty = (): Duration => {
      let reads = 0
      return Object.create(Duration.prototype, {
        ms: { get: () => (++reads <= 1 ? 5 : /.*/u) },
      }) as Duration
    }
    const list = open.compile('order.wait in L')
    expect(
      outcome(() =>
        toMongo(list, { row: 'order', fields: { wait: 'duration' }, known: { L: [shifty()] } }),
      ),
    ).toBe('UNTRANSLATABLE')
    expect(outcome(mongo({ d: shifty() }))).toBe('UNTRANSLATABLE')
  })

  it('still translates a real Duration', () => {
    expect(sql({ d: new Duration(90_000) })().params).toEqual([90_000])
    expect(mongo({ d: new Duration(90_000) })().filter).toEqual({ wait: { $eq: 90_000 } })
  })
})

describe('host data that throws while translating is a Bonsai error', () => {
  const msThrows = Object.create(Duration.prototype, {
    ms: {
      get() {
        throw new Error('ms getter')
      },
    },
  }) as unknown
  const protoThrows = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('getPrototypeOf trap')
      },
    },
  )
  it.each([
    ['order.wait == d', { d: msThrows }],
    ['order.wait in L', { L: [msThrows] }],
    ['order.wait == d', { d: protoThrows }],
    ['order.wait in L', { L: [protoThrows] }],
  ])('%s', (source, known) => {
    const program = open.compile(source)
    const sql = () =>
      toSQL(program, { row: 'order', columns: { wait: 'duration' }, dialect: 'sqlite', known })
    const mongo = () => toMongo(program, { row: 'order', fields: { wait: 'duration' }, known })
    expect(outcome(sql)).toBe('UNTRANSLATABLE')
    expect(outcome(mongo)).toBe('UNTRANSLATABLE')
  })

  it('does not name internal bindings in the message', () => {
    const program = open.compile('order.wait == d')
    expect(() =>
      toSQL(program, {
        row: 'order',
        columns: { wait: 'duration' },
        dialect: 'sqlite',
        known: { d: protoThrows },
      }),
    ).toThrow('Reading the known values failed')
  })
})

describe('one budget covers the whole translation', () => {
  // 9,000 known reads to check before partial evaluation, and a known list to map during it.
  const reads = 9000
  const k = Object.fromEntries(Array.from({ length: reads }, (_, i) => [`f${i}`, 1]))
  const source = `[${Array.from({ length: reads }, (_, i) => `k.f${i}`).join(', ')}].sum() + xs.map(. * 2).sum() > order.total`
  const program = open.compile(source)
  const known = { k, xs: Array.from({ length: 20_000 }, (_, i) => i) }
  const options = { row: 'order', columns: { total: 'number' }, dialect: 'sqlite', known } as const

  it('gives partial evaluation only the steps left after checking the known values', () => {
    // Partial evaluation alone needs about 116,000 steps, checking about 27,000 more.
    const alone = program.partial(known, { unknown: ['order'], maxSteps: 130_000 })
    expect(alone.status).toBe('residual')
    expect(outcome(() => toSQL(program, { ...options, maxSteps: 130_000 }))).toBe('STEP_LIMIT')
    expect(outcome(() => toSQL(program, { ...options, maxSteps: 160_000 }))).toBe('ok')
  })

  it('names the whole budget when partial evaluation runs out of it', () => {
    expect(() => toSQL(program, { ...options, maxSteps: 130_000 })).toThrow(
      'Translation exceeded the step limit of 130000',
    )
  })

  it('still lets partial() validate the options', () => {
    expect(() => toSQL(program, { ...options, maxSteps: -1 })).toThrow(RangeError)
    expect(() => toSQL(program, { ...options, maxSteps: 1.5 })).toThrow(RangeError)
    expect(() => toSQL(program, { ...options, timeout: -1 })).toThrow(RangeError)
  })

  it('keeps 0 as no limit', () => {
    expect(outcome(() => toSQL(program, { ...options, maxSteps: 0, timeout: 0 }))).toBe('ok')
  })

  it('takes a fractional timeout, as evaluation does', () => {
    expect(outcome(() => toSQL(program, { ...options, timeout: 60_000.5 }))).toBe('ok')
    expect(outcome(() => toSQL(program, { ...options, timeout: 0.001 }))).toBe('TIMEOUT')
  })
})

describe('unary minus translates for SQL', () => {
  let lite: DatabaseSync
  beforeAll(() => {
    lite = new DatabaseSync(':memory:')
    lite.exec('create table t (id integer, total real) strict')
    const insert = lite.prepare('insert into t values (?, ?)')
    for (const [id, total] of [
      [1, null],
      [2, 0],
      [3, -0],
      [4, 5],
      [5, -5],
      [6, 1e308],
    ] as const)
      insert.run(id, total)
  })
  afterAll(() => {
    lite.close()
  })
  const columns: Columns = { total: 'number' }
  const rows = [
    { id: 1, total: null },
    { id: 2, total: 0 },
    { id: 3, total: -0 },
    { id: 4, total: 5 },
    { id: 5, total: -5 },
    { id: 6, total: 1e308 },
  ]
  const matches = (source: string): number[] =>
    rows
      .filter((row) => {
        try {
          return open.evaluateSync(source, { order: row }) === true
        } catch {
          return false
        }
      })
      .map((row) => row.id)

  it.each([
    '-order.total > 0',
    '-order.total >= 0',
    '-order.total == 0',
    '!(-order.total > 0)',
    '-order.total * 2 < -1',
    '-(order.total + 1) < 0',
    '-order.total in [5, -5]',
  ])('%s', (source) => {
    const query = toSQL(open.compile(source), { row: 'order', columns, dialect: 'sqlite' })
    const ids = lite
      .prepare(`select id from t where ${query.sql} order by id`)
      .all(...(query.params as number[]))
      .map((r) => (r as { id: number }).id)
    expect(ids).toEqual(matches(source))
  })

  it('stays SQL only, like the other arithmetic', () => {
    expect(() =>
      toMongo(open.compile('-order.total > 0'), { row: 'order', fields: columns }),
    ).toThrow(BonsaiTranslationError)
  })

  it('negates numbers only', () => {
    const typed = bonsai({ variables: { order: t.object({ wait: t.duration() }) } })
    expect(() =>
      toSQL(typed.compile('-order.wait > minutes(1)'), {
        row: 'order',
        columns: { wait: 'duration' },
        dialect: 'sqlite',
      }),
    ).toThrow('"-" is translated for numbers only')
  })
})

describe('the documented inMilliseconds examples', () => {
  it('translates without ?. for a declared, required duration', () => {
    const typed = bonsai({ variables: { order: t.object({ wait: t.duration() }) } })
    const query = toSQL(typed.compile('inMilliseconds(order.wait) > 100'), {
      row: 'order',
      columns: { wait: 'duration' },
      dialect: 'sqlite',
    })
    expect(query.sql).toContain('`wait`')
  })

  it('needs ?. for an optional field, as the checker says', () => {
    const typed = bonsai({ variables: { order: t.object({ wait: t.optional(t.duration()) }) } })
    expect(() => typed.compile('inMilliseconds(order.wait) > 100')).toThrow(BonsaiError)
    const query = toSQL(typed.compile('order.wait?.inMilliseconds() > 100'), {
      row: 'order',
      columns: { wait: 'duration' },
      dialect: 'sqlite',
    })
    expect(query.sql).toContain('`wait`')
  })
})
