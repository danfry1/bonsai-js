import { DatabaseSync } from 'node:sqlite'
import { Query } from 'mingo'
import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'
import { toMongo, toSQL } from '../src/query/index.js'

const MAX_TIME = 8.64e15
const MAX_DURATION = Number.MAX_SAFE_INTEGER

/** Whether the row evaluates to true, and whether SQLite and mingo select it. */
function select(source: string, at: number, now: Date) {
  const env = bonsai()
  const program = env.compile(source)
  let evaluated: unknown
  try {
    evaluated = program.evaluateSync({ r: { at: new Date(at) }, end: now }, { now })
  } catch (error) {
    evaluated = (error as { code: string }).code
  }
  const options = { row: 'r', now, known: { end: now } }
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (at INTEGER) STRICT')
  db.prepare('INSERT INTO t VALUES (?)').run(at)
  const { sql, params } = toSQL(program, {
    ...options,
    columns: { at: 'timestamp' },
    dialect: 'sqlite',
  })
  const sqlite = db.prepare(`SELECT count(*) AS c FROM t WHERE ${sql}`).get(...params) as {
    c: number
  }
  const { filter } = toMongo(program, { ...options, fields: { at: 'timestamp' } })
  const mongo = new Query(filter).test({ at: new Date(at) })
  return { evaluated, sqlite: sqlite.c === 1, mongo }
}

describe('round 15: query translation at the ends of the Date range', () => {
  const now = new Date(MAX_TIME)

  it('excludes a record whose distance from now is past the duration range', () => {
    for (const source of [
      'now() - r.at > days(14)',
      '!(now() - r.at > days(14))',
      'end - r.at > days(14)',
      'days(14) <= now() - r.at',
      'r.at - now() < days(-1)',
    ]) {
      expect(select(source, -MAX_TIME, now)).toEqual({
        evaluated: 'INVALID_ARGUMENT',
        sqlite: false,
        mongo: false,
      })
    }
  })

  it('selects a record exactly at the edge of the duration range as evaluation does', () => {
    const edge = MAX_TIME - MAX_DURATION
    expect(select('now() - r.at > days(14)', edge, now)).toEqual({
      evaluated: true,
      sqlite: true,
      mongo: true,
    })
    expect(select('now() - r.at > days(14)', edge - 1, now)).toEqual({
      evaluated: 'INVALID_ARGUMENT',
      sqlite: false,
      mongo: false,
    })
  })

  it('bounds the other side when now is at the start of the Date range', () => {
    const start = new Date(-MAX_TIME)
    const edge = -MAX_TIME + MAX_DURATION
    expect(select('r.at - now() > days(1)', edge, start)).toEqual({
      evaluated: true,
      sqlite: true,
      mongo: true,
    })
    expect(select('r.at - now() > days(1)', edge + 1, start)).toEqual({
      evaluated: 'INVALID_ARGUMENT',
      sqlite: false,
      mongo: false,
    })
  })
})

describe('round 15: refusal messages', () => {
  it('names the error of a text argument that always fails', () => {
    const program = bonsai().compile('r.name?.startsWith(toString(k * 1e308)) ?? false')
    expect(() =>
      toSQL(program, { row: 'r', columns: { name: 'text' }, dialect: 'sqlite', known: { k: 5 } }),
    ).toThrow(/always fails: Arithmetic produced a non-finite number/u)
  })
})
