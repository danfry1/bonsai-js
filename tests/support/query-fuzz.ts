/** Random filters and records shared by the differential query tests. */
import { fc } from '@fast-check/vitest'
import { BonsaiError, bonsai } from '../../src/index.js'
import type { Columns } from '../../src/query/index.js'

export const columns: Columns = {
  name: 'text',
  city: 'text',
  total: 'number',
  qty: 'number',
  active: 'boolean',
  placed: 'timestamp',
}

export interface Row {
  id: number
  name: string | null
  city: string | null
  total: number | null
  qty: number | null
  active: boolean | null
  placed: Date | null
}

export const env = bonsai()
const duration = (source: string): unknown => env.evaluateSync(source)
export const known = {
  // Durations: whole days, a fraction of a millisecond, and one that overflows the Date range.
  span: duration('days(14)'),
  halfMs: duration('milliseconds(0.5)'),
  farSpan: duration('days(1e8)'),
  // A hole reads as null.
  // oxlint-disable-next-line no-sparse-arrays
  sparse: [1, , 'a'],
  dates: [new Date(-1), new Date(0), null],
  nums: [-0, 2 ** 53, 0.1, null],
  strs: ['e\u0301', '%', '\\', 'a\n'],
  mixed: [1, 'a', true, null, new Date(0)],
  empty: [],
  flag: true,
  nothing: null,
  d0: new Date(0),
  dm1: new Date(-1),
  limit: 10,
  word: 'apple pie',
  words: ['a', 'apple', 'É', null],
  since: new Date('2026-01-01T00:00:00.000Z'),
}

const STRINGS = [
  '',
  'a',
  'A',
  'ab',
  'a ',
  ' a',
  'é',
  'É',
  'ß',
  '%',
  '_',
  'a%',
  '\\',
  'x\ny',
  'apple',
  'Apple',
  'ap',
  '😀',
  '😀a',
  'e\u0301',
  '\u00e9',
  'a\n',
  '\n',
  '\r\n',
  '%a',
  '_a',
  'a_',
  '\u{1F600}\u{1F601}',
  '\uFFFF',
  '\u{10FFFF}',
  'ab\\',
  '\\%',
  ' ',
]
// Extremes overflow or underflow in arithmetic.
const NUMBERS = [
  0,
  -0,
  -1,
  1,
  2.5,
  10,
  100,
  -0.5,
  1e10,
  1e308,
  -1e308,
  1e-300,
  2 ** 53,
  2 ** 53 + 2,
  5e-324,
  0.1,
  0.2,
  0.30000000000000004,
  2 ** 31,
  -(2 ** 63),
]
const DATES = ['2025-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-03-15T12:30:45.123Z']
  .map((d) => new Date(d))
  .concat([new Date(-1), new Date(0), new Date(1), new Date(-2208988800001)])

const text = fc.oneof(fc.constantFrom(...STRINGS), fc.constant(null))
const num = fc.oneof(fc.constantFrom(...NUMBERS), fc.constant(null))
const rowArbitrary = (id: number): fc.Arbitrary<Row> =>
  fc.record({
    id: fc.constant(id),
    name: text,
    city: text,
    total: num,
    qty: num,
    active: fc.oneof(fc.boolean(), fc.constant(null)),
    placed: fc.oneof(fc.constantFrom(...DATES), fc.constant(null)),
  })
export const rowsArbitrary = fc
  .integer({ min: 1, max: 10 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => rowArbitrary(i + 1))))

const quoted = (s: string): string => JSON.stringify(s)
const strConst = fc.constantFrom(...STRINGS).map(quoted)
const numConst = fc.oneof(fc.constantFrom(...NUMBERS).map(String), fc.constant('limit'))
const textCol = fc.constantFrom('order.name', 'order.city')
const numCol = fc.constantFrom('order.total', 'order.qty')
const anyCol = fc.constantFrom(
  'order.name',
  'order.city',
  'order.total',
  'order.qty',
  'order.active',
  'order.placed',
)
const cmp = fc.constantFrom('<', '<=', '>', '>=')

const atom: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(numCol, cmp, numConst).map(([c, op, k]) => `${c} ${op} ${k}`),
  fc.tuple(numConst, cmp, numCol).map(([k, op, c]) => `${k} ${op} ${c}`),
  fc.tuple(numCol, cmp, numCol).map(([a, op, b]) => `${a} ${op} ${b}`),
  fc.tuple(textCol, fc.constantFrom('==', '!='), strConst).map(([c, op, k]) => `${c} ${op} ${k}`),
  fc.tuple(textCol, fc.constantFrom('==', '!='), textCol).map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(numCol, fc.constantFrom('==', '!='), fc.oneof(numConst, strConst))
    .map(([c, op, k]) => `${c} ${op} ${k}`),
  fc.tuple(anyCol, fc.constantFrom('== null', '!= null')).map(([c, op]) => `${c} ${op}`),
  fc.constantFrom('order.active', '!order.active', 'order.active == true', 'order.active != false'),
  fc
    .tuple(
      textCol,
      fc.constantFrom('.', '?.'),
      fc.constantFrom('startsWith', 'endsWith', 'includes'),
      strConst,
    )
    .map(([c, dot, f, k]) => `${c}${dot}${f}(${k})`),
  fc
    .tuple(textCol, fc.constantFrom('in', 'not in'))
    .map(([c, op]) => `${c} ${op} ["a", "apple", null, "É"]`),
  fc.tuple(textCol, fc.constantFrom('in', 'not in')).map(([c, op]) => `${c} ${op} words`),
  fc.tuple(numCol, fc.constantFrom('in', 'not in')).map(([c, op]) => `${c} ${op} [1, 2.5, -1]`),
  fc.tuple(strConst, textCol).map(([k, c]) => `${k} in ${c}`),
  textCol.map((c) => `${c} in word`),
  fc
    .tuple(numCol, fc.constantFrom('*', '+', '-'), fc.oneof(numConst, numCol), cmp, numConst)
    .map(([c, op, x, rel, k]) => `${c} ${op} ${x} ${rel} ${k}`),
  fc
    .tuple(
      numCol,
      fc.constantFrom('+ 1', '* 2', '* order.qty', '- order.total'),
      fc.constantFrom('in', 'not in'),
      fc.constantFrom('[]', '["a"]', '[1, null]', '[0, 2]'),
    )
    .map(([c, arith, op, list]) => `${c} ${arith} ${op} ${list}`),
  fc
    .tuple(
      fc.oneof(
        numCol,
        numCol.map((c) => `${c} * 2`),
      ),
      cmp,
    )
    .map(([c, op]) => `${c} ${op} null`),
  fc
    .tuple(fc.constantFrom('>=', '<'), fc.constantFrom('since'))
    .map(([op, k]) => `order.placed ${op} ${k}`),
  fc.constantFrom('true', 'false'),
  // The null-safe idioms: ?. with ??, compared with a boolean, and a ?? default receiver.
  fc
    .tuple(
      textCol,
      fc.constantFrom('.', '?.'),
      fc.constantFrom('startsWith', 'endsWith', 'includes'),
      strConst,
      fc.constantFrom(
        '?? false',
        '?? true',
        '?? flag',
        '?? order.active',
        '== true',
        '== false',
        '!= true',
        '!= false',
        '== null',
        '!= null',
      ),
    )
    .map(([c, dot, f, k, tail]) => `(${c}${dot}${f}(${k}) ${tail})`),
  fc
    .tuple(textCol, strConst, fc.constantFrom('startsWith', 'endsWith', 'includes'), strConst)
    .map(([c, d, f, k]) => `(${c} ?? ${d}).${f}(${k})`),
  fc.constantFrom('(order.active ?? false)', '(order.active ?? true)', '(order.active ?? flag)'),
  // Relative dates: a timestamp shifted by a duration, or a distance between timestamps.
  fc
    .tuple(
      fc.constantFrom(
        'since - order.placed',
        'order.placed - since',
        'order.placed + span',
        'span + order.placed',
        'order.placed - span',
        'order.placed + farSpan',
        'order.placed - halfMs',
        'since - order.placed',
      ),
      cmp,
      fc.constantFrom('span', 'since', 'halfMs', 'farSpan', 'd0'),
      fc.boolean(),
    )
    .map(([e, op, k, flip]) => (flip ? `${k} ${op} ${e}` : `${e} ${op} ${k}`)),
  fc
    .tuple(
      fc.constantFrom('order.name', 'order.active', 'order.placed'),
      fc.constantFrom('==', '!='),
      numCol,
      fc.constantFrom('+ 1', '* 2', '- order.qty'),
    )
    .chain(([c, op, n, arith]) =>
      fc.constantFrom(`${c} ${op} ${n} ${arith}`, `${n} ${arith} ${op} ${c}`),
    ),
  fc
    .tuple(
      anyCol,
      fc.constantFrom('in', 'not in'),
      fc.constantFrom(
        'sparse',
        'dates',
        'nums',
        'strs',
        'mixed',
        'empty',
        '[null]',
        '[d0, dm1]',
        '[flag, nothing]',
      ),
    )
    .map(([c, op, l]) => `${c} ${op} ${l}`),
  fc.tuple(anyCol, fc.constantFrom('==', '!='), anyCol).map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      fc.constantFrom('order.placed'),
      cmp,
      fc.constantFrom('order.placed', 'd0', 'dm1', 'nothing'),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      anyCol,
      fc.constantFrom('==', '!='),
      fc.constantFrom(
        'd0',
        'dm1',
        'nothing',
        'flag',
        'limit',
        'word',
        '-0',
        '0.1 + 0.2',
        '9007199254740993',
      ),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      fc.constantFrom('flag', 'limit > 5', 'nothing == null', 'false'),
      numCol,
      numCol,
      cmp,
      numConst,
    )
    .map(([cond, a, b, op, k]) => `(${cond} ? ${a} : ${b}) ${op} ${k}`),
  fc
    .tuple(
      numCol,
      cmp,
      fc.constantFrom(
        '(nothing ?? limit)',
        '(limit ?? 0)',
        '(let x = limit; x)',
        'try(limit, 0)',
        'nums[1]',
        'strs.length',
      ),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(
      textCol,
      fc.constantFrom('==', '!=', 'in'),
      fc.constantFrom('`${word}`', '`a${limit}`', 'strs[0]', 'word.toUpperCase()', 'strs'),
    )
    .map(([a, op, b]) => `${a} ${op} ${b}`),
  fc
    .tuple(strConst, fc.constantFrom('in', 'not in'), textCol)
    .map(([k, op, c]) => `${k} ${op} ${c}`),
  fc
    .tuple(
      textCol,
      fc.constantFrom('in', 'not in'),
      fc.constantFrom('"apple pie"', 'word', '"😀a%_\\n"'),
    )
    .map(([c, op, k]) => `${c} ${op} ${k}`),
  fc
    .tuple(
      fc.constantFrom('flag', 'nothing == null', 'limit < 0', 'true', 'nothing'),
      fc.constantFrom('&&', '||'),
      fc.constantFrom('order.active', 'order.name.startsWith("a")', 'order.total * 2 > 1'),
    )
    .map(([a, op, b]) => `(${a} ${op} ${b})`),
  fc
    .tuple(
      fc.constantFrom('order.active', 'order.name.startsWith("a")', 'order.total * 2 > 1'),
      fc.constantFrom('&&', '||'),
      fc.constantFrom('flag', 'true', 'false', 'nothing', 'nothing == null'),
    )
    .map(([a, op, b]) => `(${a} ${op} ${b})`),
)

export const predicate: fc.Arbitrary<string> = fc.letrec<{ p: string }>((tie) => ({
  p: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    atom,
    tie('p').map((p) => `!(${p})`),
    fc
      .tuple(tie('p'), fc.constantFrom('&&', '||'), tie('p'))
      .map(([a, op, b]) => `(${a} ${op} ${b})`),
  ),
})).p

/** The rows for which the predicate evaluates to true (failures excluded, as try(p, false)). */
export function expected(source: string, rows: readonly Row[], now?: Date): number[] {
  const program = (now === undefined ? env : bonsai({ clock: () => now })).compile(source)
  return rows
    .filter((order) => {
      try {
        return program.evaluateSync({ ...known, order }) === true
      } catch (error) {
        if (error instanceof BonsaiError) return false
        throw error
      }
    })
    .map((r) => r.id)
}
