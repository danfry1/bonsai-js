import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, t } from '../src/index.js'
import { toMongo, toSQL } from '../src/query/index.js'

/** The code of the Bonsai error `run` throws, or `value` when it returns. */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'value'
  } catch (error) {
    return error instanceof BonsaiError ? error.code : 'RAW'
  }
}

describe('round 14: a list literal over maxListLength in a query', () => {
  const env = bonsai({
    variables: { r: t.object({ x: t.number() }) },
    limits: { maxListLength: 2 },
  })
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (x REAL) STRICT; INSERT INTO t VALUES (1), (2), (5)')
  const selected = (source: string): number[] | string => {
    try {
      const { sql, params } = toSQL(env.compile(source), {
        row: 'r',
        columns: { x: 'number' },
        dialect: 'sqlite',
      })
      const rows = db.prepare(`SELECT x FROM t WHERE ${sql}`).all(...(params as number[]))
      return rows.map((row) => row.x as number)
    } catch (error) {
      return error instanceof BonsaiError ? error.code : 'RAW'
    }
  }

  it('is never translated: evaluation fails on every record', () => {
    for (const source of [
      'r.x in [1, 2, 3]',
      'r.x in [1, 2, 3] || true',
      '!(r.x in [1, 2, 3])',
      'r.x not in [7, 8, 9]',
    ]) {
      expect(codeOf(() => env.evaluateSync(source, { r: { x: 1 } }))).toBe('LIST_LIMIT')
      expect(selected(source)).toBe('UNTRANSLATABLE')
      expect(
        codeOf(() => toMongo(env.compile(source), { row: 'r', fields: { x: 'number' } })),
      ).toBe('UNTRANSLATABLE')
    }
  })

  it('still translates a list within the limit', () => {
    expect(selected('r.x in [1, 2]')).toEqual([1, 2])
  })
})

describe('round 14: built-ins check maxListLength before they build', () => {
  const env = bonsai({ variables: { xs: t.list(t.number()) }, limits: { maxListLength: 2 } })
  const xs = [1, 2, 3, 4, 5]

  it('groupBy fails when a bucket grows past the limit', () => {
    expect(codeOf(() => env.evaluateSync('xs.groupBy(x => 1)', { xs }))).toBe('LIST_LIMIT')
    expect(codeOf(() => env.evaluateSync('xs.groupBy(x => x % 2)', { xs }))).toBe('LIST_LIMIT')
    expect(env.evaluateSync('xs.slice(0, 2).groupBy(x => x % 2)', { xs })).toEqual({
      '0': [2],
      '1': [1],
    })
  })

  it('filter, sort, unique, and slice stop at the limit', () => {
    for (const source of ['xs.filter(x => true)', 'xs.sort()', 'xs.unique()', 'xs.slice(0, 4)'])
      expect(codeOf(() => env.evaluateSync(source, { xs }))).toBe('LIST_LIMIT')
    expect(env.evaluateSync('xs.filter(x => x > 3)', { xs })).toEqual([4, 5])
  })
})

describe('round 14: one maxValueDepth for building, equality, unique, and validation', () => {
  const nested = (levels: number): unknown => {
    let value: unknown = 1
    for (let i = 0; i < levels; i++) value = [value]
    return value
  }
  const env = bonsai({ strict: false, limits: { maxValueDepth: 4 } })

  it('allows four levels and refuses five everywhere', () => {
    for (const [levels, want] of [
      [4, 'value'],
      [5, 'VALUE_DEPTH_LIMIT'],
    ] as const) {
      const d = nested(levels)
      expect(codeOf(() => env.evaluateSync(`${'['.repeat(levels)}1${']'.repeat(levels)}`))).toBe(
        want,
      )
      expect(codeOf(() => env.evaluateSync('d == e', { d, e: nested(levels) }))).toBe(want)
      expect(codeOf(() => env.evaluateSync('xs.unique()', { xs: d }))).toBe(want)
    }
  })
})
