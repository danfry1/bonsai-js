// Conformance corpus for the Bonsai expression language, derived only from
// docs/language.md. Every case runs three ways (evaluateSync, evaluate, and
// compile().evaluateSync) and all three must agree with the expected outcome.
import { describe, it, expect } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'

type Code = string
interface Case {
  name?: string
  source: string
  context?: Record<string, unknown> | undefined
  value?: unknown
  /** Expected timestamp result, compared via toISOString(). */
  iso?: string
  /** Expected string result matching a pattern (for spec-level latitude). */
  match?: RegExp
  error?: Code | Code[]
  options?: Parameters<typeof bonsai>[0]
}

type Outcome = { value: unknown } | { error: string }

function normalize(v: unknown): unknown {
  return v instanceof Date ? { __iso: v.toISOString() } : v
}

function fail(e: unknown): Outcome {
  if (e !== null && typeof e === 'object' && 'code' in e && typeof e.code === 'string') {
    return { error: (e as { code: string }).code }
  }
  const err = e as Error
  return { error: `NON_BONSAI ${err?.name}: ${err?.message}` }
}

async function runAll(c: Case): Promise<Outcome[]> {
  const out: Outcome[] = []
  let env: ReturnType<typeof bonsai>
  try {
    env = bonsai(c.options)
  } catch (e) {
    return [fail(e), fail(e), fail(e)]
  }
  try {
    out.push({ value: normalize(env.evaluateSync(c.source, c.context)) })
  } catch (e) {
    out.push(fail(e))
  }
  try {
    out.push({ value: normalize(await env.evaluate(c.source, c.context)) })
  } catch (e) {
    out.push(fail(e))
  }
  try {
    out.push({ value: normalize(env.compile(c.source).evaluateSync(c.context)) })
  } catch (e) {
    out.push(fail(e))
  }
  return out
}

const MODES = ['evaluateSync', 'evaluate', 'compile().evaluateSync']

function runCases(cases: Case[]) {
  for (const c of cases) {
    it(c.name ?? c.source, async () => {
      const outs = await runAll(c)
      outs.forEach((o, i) => {
        const label = `${MODES[i]}: ${c.source}`
        if (c.error !== undefined) {
          const codes = Array.isArray(c.error) ? c.error : [c.error]
          expect(o, label).toHaveProperty('error')
          expect(codes, `${label} -> ${JSON.stringify(o)}`).toContain(
            (o as { error: string }).error,
          )
        } else if (c.iso !== undefined) {
          expect(o, label).toEqual({ value: { __iso: c.iso } })
        } else if (c.match !== undefined) {
          expect('value' in o ? o.value : o, label).toMatch(c.match)
        } else {
          expect(o, label).toEqual({ value: c.value })
        }
      })
      // All three modes agree.
      expect(outs[1], `evaluate vs evaluateSync: ${c.source}`).toEqual(outs[0])
      expect(outs[2], `compile vs evaluateSync: ${c.source}`).toEqual(outs[0])
    })
  }
}

// Helpers that build table rows.
const v = (source: string, value: unknown, context?: Record<string, unknown>): Case => ({
  source,
  value,
  context,
})
const err = (source: string, error: Code | Code[], context?: Record<string, unknown>): Case => ({
  source,
  error,
  context,
})
const ts = (source: string, iso: string, context?: Record<string, unknown>): Case => ({
  source,
  iso,
  context,
})

const TYPE = ['CHECK', 'TYPE_ERROR']
const TYPE_OR_OVERLOAD = ['CHECK', 'TYPE_ERROR', 'NO_OVERLOAD']
const STATIC = ['SYNTAX', 'CHECK']

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const users = [
  { name: 'A', age: 20, suspended: false },
  { name: 'B', age: 17, suspended: false },
  { name: 'C', age: 30, suspended: true },
  { name: 'D' },
]
const scored = [
  { name: 'A', score: 15, bonus: 12 },
  { name: 'B', score: 8, bonus: 5 },
  { name: 'C', score: 11, bonus: 20 },
]
const groups = [
  { users: [{ active: true }, { active: false }] },
  { users: [{ active: true }, { active: true }] },
]
const orders = [
  { id: 'a', promoSku: 'p1', lines: [{ sku: 'x' }, { sku: 'p1' }] },
  { id: 'b', promoSku: 'p2', lines: [{ sku: 'p1' }] },
]
const inherited = Object.create({ inh: 1 }) as Record<string, unknown>
inherited.own = 2
class Klass {
  x = 1
  // oxlint-disable-next-line typescript/class-literal-property-style -- the getter must live on the prototype
  get y() {
    return 2
  }
}
const withProtoKey = JSON.parse('{"__proto__": 1, "a": 2}') as Record<string, unknown>
const withCtorKey = JSON.parse('{"constructor": 1, "a": 2}') as Record<string, unknown>
const opaqueFn = () => 1
const sym = Symbol('s')
const T0 = new Date('2024-01-01T00:00:00Z')
const T1 = new Date('2024-01-02T00:00:00Z')
const cycA: Record<string, unknown> = {}
cycA.self = cycA
const cycB: Record<string, unknown> = {}
cycB.self = cycB
const big = Array.from({ length: 1000 }, (_, i) => i)
const big2 = Array.from({ length: 1000 }, (_, i) => i)
const getterObj = {}
Object.defineProperty(getterObj, 'g', { get: () => 5, enumerable: true })

// ---------------------------------------------------------------------------
// §1 Lexical structure
// ---------------------------------------------------------------------------
describe('§1 lexical', () => {
  runCases([
    v('1 + /* c */ 2', 3),
    v('1 + 2 // trailing comment', 3),
    v('// leading comment\n5', 5),
    v('/* a /* b */ 1', 1),
    err('/* a /* b */ c */ 1', 'SYNTAX'),
    err('/* unterminated', 'SYNTAX'),
    v('1\t+\r\n2', 3),
    v('$a + _b', 3, { $a: 1, _b: 2 }),
    v('a1$_', 7, { a1$_: 7 }),
    v('_1', null),
    v('obj.in', 5, { obj: { in: 5 } }),
    v('obj.let', 6, { obj: { let: 6 } }),
    v('obj.null', 7, { obj: { null: 7 } }),
    v('obj.true', 8, { obj: { true: 8 } }),
    v('obj.not', 9, { obj: { not: 9 } }),
    err('in', 'SYNTAX'),
    err('let + 1', 'SYNTAX'),
    v('42', 42),
    v('3.14', 3.14),
    v('1e-3', 0.001),
    v('1e3', 1000),
    v('1_000', 1000),
    v('1_000_000', 1000000),
    v('0xff', 255),
    v('0b101', 5),
    v('0o17', 15),
    err('.5', STATIC),
    err('1__000', 'SYNTAX'),
    err('1_', 'SYNTAX'),
    err('0x_ff', 'SYNTAX'),
    v('"a\\nb"', 'a\nb'),
    v('"a\\tb\\r"', 'a\tb\r'),
    v('"\\0"', '\0'),
    v("'it\\'s'", "it's"),
    v('"say \\"hi\\""', 'say "hi"'),
    v('"back\\\\slash"', 'back\\slash'),
    v('"\\`"', '`'),
    v('"\\$"', '$'),
    v('"\\x41"', 'A'),
    v('"\\u0041"', 'A'),
    v('"\\u{1F600}"', '\u{1F600}'),
    v("'single'", 'single'),
    err('"unterminated', 'SYNTAX'),
    err('1 |> 2', 'SYNTAX'),
    err('xs |> map(. + 1)', 'SYNTAX', { xs: [1] }),
  ])
})

// ---------------------------------------------------------------------------
// §2 Values
// ---------------------------------------------------------------------------
describe('§2 values', () => {
  runCases([
    v('missing', null),
    v('missing == null', true),
    v('user.nope', null, { user: {} }),
    v('u', null, { u: undefined }),
    v('u == null', true, { u: undefined }),
    v('o.u', null, { o: { u: undefined } }),
    v('o.u == null', true, { o: { u: undefined } }),
    v('xs[0]', null, { xs: [undefined] }),
    v('user.middleName == null', true, { user: { middleName: null } }),
    v('user.middleName == null', true, { user: {} }),
    v('inf', Infinity, { inf: Infinity }),
    v('inf > 1e308', true, { inf: Infinity }),
    v('inf == inf', true, { inf: Infinity }),
    v('n', NaN, { n: NaN }),
    v('toNumber(inf)', Infinity, { inf: Infinity }),
    v('toString(inf)', 'Infinity', { inf: Infinity }),
    err('[inf, 1].max()', 'NON_FINITE', { inf: Infinity }),
    err('[inf, 1].sort()', 'NON_FINITE', { inf: Infinity }),
    err('[inf, 1].sum()', 'NON_FINITE', { inf: Infinity }),
    err('round(inf)', 'NON_FINITE', { inf: Infinity }),
    v('true', true),
    v('false', false),
    v('null', null),
    v('"😀".length', 2),
    v('"😀"[0]', '\ud83d'),
    v('m.own', 2, { m: inherited }),
    v('m.inh', null, { m: inherited }),
    v('m.toString', null, { m: {} }),
    v('m.hasOwnProperty', null, { m: {} }),
    v('k.x', 1, { k: new Klass() }),
    v('k.y', null, { k: new Klass() }),
    v('f == f', true, { f: opaqueFn }),
    err('f.x', 'TYPE_ERROR', { f: opaqueFn }),
    err('f.length', 'TYPE_ERROR', { f: opaqueFn }),
    v('b == b', true, { b: 10n }),
    err('b.x', 'TYPE_ERROR', { b: 10n }),
    v('s == s', true, { s: sym }),
    err('s.description', 'TYPE_ERROR', { s: sym }),
    v('o.f == o.f', true, { o: { f: opaqueFn } }),
    err('year(d)', ['TYPE_ERROR', 'INVALID_ARGUMENT'], { d: new Date('nope') }),
    err('d + days(1)', ['TYPE_ERROR', 'INVALID_ARGUMENT'], { d: new Date('nope') }),
  ])
})

// ---------------------------------------------------------------------------
// §3 Equality
// ---------------------------------------------------------------------------
describe('§3 equality', () => {
  runCases([
    v('1 == 1', true),
    v('1 == "1"', false),
    v('a == b', false, { a: 1, b: '1' }),
    v('0 == -0', true),
    v('true == 1', false),
    v('null == null', true),
    v('null == false', false),
    v('0 == null', false),
    v('"" == null', false),
    v('n == n', false, { n: NaN }),
    v('n != n', true, { n: NaN }),
    v('[1, 2] == [1, 2]', true),
    v('[1, [2, 3]] == [1, [2, 3]]', true),
    v('[1, 2] == [2, 1]', false),
    v('[1] == [1, 2]', false),
    v('[] == []', true),
    v('xs == [1, 2]', true, { xs: [1, 2] }),
    v('{a: 1, b: 2} == {b: 2, a: 1}', true),
    v('{a: 1} == {a: 1, b: null}', false),
    v('{a: {b: [1]}} == {a: {b: [1]}}', true),
    v('{} == {}', true),
    v('o == {a: 1}', true, { o: { a: 1 } }),
    v('m == {own: 2}', true, { m: inherited }),
    v('[1] == {}', false),
    v('"a" == ["a"]', false),
    v('days(1) == 86400000', false),
    v('[1] != [1]', false),
    v('1 != 2', true),
    v('timestamp("2024-01-01T00:00:00Z") == timestamp("2024-01-01T00:00:00.000Z")', true),
    v('d == timestamp("2024-01-01T00:00:00Z")', true, { d: T0 }),
    v('d == e', true, { d: T0, e: new Date(T0.getTime()) }),
    v('d == e', false, { d: T0, e: T1 }),
    v('hours(1) == minutes(60)', true),
    v('days(1) == hours(24)', true),
    v('days(1) != hours(23)', true),
    v('weeks(1) == days(7)', true),
    v('d == days(1)', false, { d: T0 }),
    v('null == []', false),
    v('"x" == {}', false),
  ])
})

// ---------------------------------------------------------------------------
// §3 Ordering
// ---------------------------------------------------------------------------
describe('§3 ordering', () => {
  runCases([
    v('1 < 2', true),
    v('2 <= 2', true),
    v('2 >= 3', false),
    v('3 > 2', true),
    v('"a" < "b"', true),
    v('"B" < "a"', true),
    v('"a" < "aa"', true),
    v('"10" < "9"', true),
    v('null < 1', false),
    v('1 < null', false),
    v('null <= 1', false),
    v('1 >= null', false),
    v('null >= null', false),
    v('x.age >= 18', false, { x: {} }),
    v('missing > 0', false),
    v('d > null', false, { d: T0 }),
    err('1 < "2"', TYPE),
    err('a < b', 'TYPE_ERROR', { a: 1, b: '2' }),
    err('true < false', TYPE),
    err('[1] < [2]', TYPE),
    err('hours(1) < 5', TYPE),
    err('a < b', 'TYPE_ERROR', { a: T0, b: 5 }),
    v('timestamp("2024-01-01T00:00:00Z") < timestamp("2024-01-02T00:00:00Z")', true),
    v('a < b', true, { a: T0, b: T1 }),
    v('a >= b', false, { a: T0, b: T1 }),
    v('hours(1) < days(1)', true),
    v('minutes(60) <= hours(1)', true),
    v('inf > 1', true, { inf: Infinity }),
    v('inf < 1', false, { inf: Infinity }),
    v('n < 1', false, { n: NaN }),
    v('n >= n', false, { n: NaN }),
    err('1 < 2 < 3', 'SYNTAX'),
    err('1 == 1 == true', 'SYNTAX'),
    err('1 != 2 == true', 'SYNTAX'),
    err('1 <= 2 > 0', 'SYNTAX'),
    err('1 in [1] in [true]', 'SYNTAX'),
    err('1 < 2 in [true]', 'SYNTAX'),
    v('1 < 2 == true', true),
    v('(1 < 2) == (2 < 3)', true),
  ])
})

// ---------------------------------------------------------------------------
// §3 Arithmetic
// ---------------------------------------------------------------------------
describe('§3 arithmetic', () => {
  runCases([
    v('1 + 2 * 3', 7),
    v('(1 + 2) * 3', 9),
    v('2 ** 3 ** 2', 512),
    v('2 * 3 ** 2', 18),
    err('-2 ** 2', 'SYNTAX'),
    err('-x ** 2', 'SYNTAX', { x: 2 }),
    err('!x ** 2', 'SYNTAX', { x: true }),
    v('(-2) ** 2', 4),
    v('-(2 ** 2)', -4),
    v('2 ** -1', 0.5),
    v('-2 * 3', -6),
    v('-x', -5, { x: 5 }),
    v('-a.b', -2, { a: { b: 2 } }),
    v('10 % 3', 1),
    v('-7 % 3', -1),
    v('7 / 2', 3.5),
    v('10 - 4 - 3', 3),
    v('"a" + "b"', 'ab'),
    v('"" + ""', ''),
    v('[1] + [2, 3]', [1, 2, 3]),
    v('xs + [3]', [1, 2, 3], { xs: [1, 2] }),
    v('hours(1) + minutes(30) == minutes(90)', true),
    err('null + 1', TYPE),
    err('x + 1', 'TYPE_ERROR', { x: null }),
    err('missing + 1', 'TYPE_ERROR'),
    err('"a" + 1', TYPE),
    err('s + n', 'TYPE_ERROR', { s: 'a', n: 1 }),
    err('true + 1', TYPE),
    err('"a" * 2', TYPE),
    err('[1] - [1]', TYPE),
    err('-"a"', TYPE),
    err('-s', 'TYPE_ERROR', { s: 'a' }),
    err('t + 30', 'TYPE_ERROR', { t: T0 }),
    err('timestamp("2024-01-01T00:00:00Z") + 30', TYPE),
    err('a + b', 'TYPE_ERROR', { a: T0, b: T1 }),
    err('days(1) - t', 'TYPE_ERROR', { t: T0 }),
    err('days(1) + 1', TYPE),
    err('days(1) * days(1)', TYPE),
    err('2 / days(1)', TYPE),
    err('days(1) % 2', TYPE),
    v('inMinutes(hours(1) - minutes(30))', 30),
    v('hours(2) * 3 == hours(6)', true),
    v('3 * hours(2) == hours(6)', true),
    v('hours(6) / 3 == hours(2)', true),
    v('hours(1) / 2 == minutes(30)', true),
    v('hours(6) / hours(2)', 3),
    ts('t + days(1)', '2024-01-02T00:00:00.000Z', { t: T0 }),
    ts('days(1) + t', '2024-01-02T00:00:00.000Z', { t: T0 }),
    ts('t - hours(1)', '2023-12-31T23:00:00.000Z', { t: T0 }),
    ts('timestamp("2024-01-01T00:00:00Z") + hours(36)', '2024-01-02T12:00:00.000Z'),
    v('b - a == days(1)', true, { a: T0, b: T1 }),
    v('inHours(a - b)', -24, { a: T0, b: T1 }),
    err('1 / 0', ['DIVISION_BY_ZERO', 'CHECK']),
    err('1 / z', 'DIVISION_BY_ZERO', { z: 0 }),
    err('0 / z', 'DIVISION_BY_ZERO', { z: 0 }),
    err('5 % z', 'DIVISION_BY_ZERO', { z: 0 }),
    err('hours(1) / z', 'DIVISION_BY_ZERO', { z: 0 }),
    err('hours(1) / hours(z)', 'DIVISION_BY_ZERO', { z: 0 }),
    err('1e308 * 10', ['NON_FINITE', 'CHECK']),
    err('x * 10', 'NON_FINITE', { x: 1e308 }),
    err('10 ** x', 'NON_FINITE', { x: 400 }),
    err('x ** 0.5', 'NON_FINITE', { x: -8 }),
    err('inf + 1', 'NON_FINITE', { inf: Infinity }),
    err('inf - inf', 'NON_FINITE', { inf: Infinity }),
    err('sqrt(x)', ['NON_FINITE', 'INVALID_ARGUMENT'], { x: -1 }),
  ])
})

// ---------------------------------------------------------------------------
// §3 Logic
// ---------------------------------------------------------------------------
describe('§3 logic', () => {
  runCases([
    v('true && false', false),
    v('true && true', true),
    v('false || true', true),
    v('null && true', false),
    v('null || true', true),
    v('true && null', false),
    v('null || null', false),
    v('false || null', false),
    v('!null', true),
    v('!missing', true),
    v('!true', false),
    v('null ? 1 : 2', 2),
    v('missing ? 1 : 2', 2),
    err('!0', TYPE),
    err('!n', 'TYPE_ERROR', { n: 0 }),
    err('1 && true', TYPE),
    err('n && true', 'TYPE_ERROR', { n: 1 }),
    err('true && n', 'TYPE_ERROR', { n: 5 }),
    err('false || n', 'TYPE_ERROR', { n: 'x' }),
    err('"" || true', TYPE),
    err('s ? 1 : 2', 'TYPE_ERROR', { s: 'x' }),
    err('xs ? 1 : 2', 'TYPE_ERROR', { xs: [] }),
    v('false && n', false, { n: 5 }),
    v('true || n', true, { n: 5 }),
    v('false && 1 / z == 1', false, { z: 0 }),
    v('true || 1 / z == 1', true, { z: 0 }),
    v('true ? 1 : 1 / z', 1, { z: 0 }),
    v('false ? 1 / z : 2', 2, { z: 0 }),
    v('null ?? 1', 1),
    v('0 ?? 1', 0),
    v('false ?? true', false),
    v('"" ?? "d"', ''),
    v('missing ?? "d"', 'd'),
    v('x ?? (1 / z)', 1, { x: 1, z: 0 }),
    err('x ?? 1 / z', 'SYNTAX', { x: 1, z: 0 }),
    err('x ?? 0 > 10', 'SYNTAX', { x: 3 }),
    err('x == 1 ?? y', 'SYNTAX', { x: 1, y: 2 }),
    v('null ?? null ?? 3', 3),
    err('a ?? b || c', 'SYNTAX', { a: null, b: true, c: true }),
    err('a || b ?? c', 'SYNTAX', { a: null, b: true, c: true }),
    err('a ?? b && c', 'SYNTAX', { a: null, b: true, c: true }),
    err('a && b ?? c', 'SYNTAX', { a: null, b: true, c: true }),
    v('(a ?? b) || c', true, { a: null, b: false, c: true }),
    v('a ?? (b || c)', true, { a: null, b: false, c: true }),
    v('false ? 1 : true ? 2 : 3', 2),
    v('true ? 1 : false ? 2 : 3', 1),
    v('true || false && false', true),
    v('!true || true', true),
    v('!true == false', true),
    v('!a.b', false, { a: { b: true } }),
    v('x ?? (1 + 1)', 2, { x: null }),
    v('(x ?? 1) + 1', 2, { x: null }),
    err('x ?? 1 + 1', 'SYNTAX', { x: null }),
    v('null ?? false ? 1 : 2', 2),
    v('1 + 2 == 3 && 2 > 1', true),
  ])
})

// ---------------------------------------------------------------------------
// §3 Membership
// ---------------------------------------------------------------------------
describe('§3 membership', () => {
  runCases([
    v('2 in [1, 2, 3]', true),
    v('4 in [1, 2]', false),
    v('[1] in [[1], [2]]', true),
    v('{a: 1} in [{a: 1}]', true),
    v('"1" in [1]', false),
    v('null in [null]', true),
    v('null in [1]', false),
    v('d in [e]', true, { d: T0, e: new Date(T0.getTime()) }),
    v('hours(24) in [days(1)]', true),
    v('"ell" in "hello"', true),
    v('"" in "abc"', true),
    v('"a" in "ABC"', false),
    v('"a" in {a: 1}', true),
    v('"b" in {a: 1}', false),
    v('"a" in {a: null}', true),
    v('"u" in o', false, { o: { u: undefined } }),
    v('"toString" in {}', false),
    v('"constructor" in {}', false),
    v('"inh" in m', false, { m: inherited }),
    v('"own" in m', true, { m: inherited }),
    v('1 in null', false),
    v('"a" in null', false),
    v('1 in missing', false),
    v('1 not in [1]', false),
    v('3 not in [1]', true),
    v('1 not in null', true),
    v('"z" not in "abc"', true),
    v('"a" not in {a: 1}', false),
    err('1 in "123"', TYPE),
    err('n in s', 'TYPE_ERROR', { n: 1, s: '123' }),
    v('1 in {a: 1}', false),
    v('1 in {"1": true}', true),
    err('1 in 5', TYPE),
    err('k in 5', TYPE, { k: 1 }),
    v('1 + 1 in [2]', true),
    v('1 in [1] == true', true),
    v('!(1 in [2])', true),
    v('x in xs', true, { x: [1, 2], xs: [[1, 2]] }),
  ])
})

// ---------------------------------------------------------------------------
// §4 Names, members, indexing
// ---------------------------------------------------------------------------
describe('§4 names, members, indexing', () => {
  runCases([
    v('a.b.c', 1, { a: { b: { c: 1 } } }),
    v('a.b.c', null, { a: null }),
    v('x.y.z', null),
    v('a.b.c', null, { a: { b: null } }),
    v('"abc".length', 3),
    v('[1, 2].length', 2),
    v('s.length', 3, { s: 'abc' }),
    v('xs.length', 0, { xs: [] }),
    v('{length: 5}.length', 5),
    v('o.length', 2, { o: { length: 2 } }),
    err('"abc".foo', TYPE),
    err('s.foo', 'TYPE_ERROR', { s: 'abc' }),
    err('s.toUpperCase', 'TYPE_ERROR', { s: 'abc' }),
    err('[1].foo', TYPE),
    err('xs.map', 'TYPE_ERROR', { xs: [1] }),
    err('n.x', 'TYPE_ERROR', { n: 5 }),
    err('b.x', 'TYPE_ERROR', { b: true }),
    err('t.getTime', 'TYPE_ERROR', { t: T0 }),
    err('d.x', 'TYPE_ERROR', { d: 1, x: 0 }),
    err('days(1).x', TYPE),
    err('n.length', 'TYPE_ERROR', { n: 5 }),
    v('[10, 20, 30][1]', 20),
    v('[10, 20][2]', null),
    v('[10, 20][-1]', null),
    v('xs[i]', null, { xs: [1, 2], i: -1 }),
    v('xs[i]', 2, { xs: [1, 2], i: 1 }),
    v('"abc"[0]', 'a'),
    v('"abc"[5]', null),
    v('"abc"[-1]', null),
    v('{a: 1}["a"]', 1),
    err('{a: 1}["b"]', 'CHECK'),
    v('o["b"]', null, { o: { a: 1 } }),
    err('{a: 1}.b', 'CHECK'),
    v('o.b', null, { o: { a: 1 } }),
    err('let o = {a: 1}; o.b', 'CHECK'),
    v('o[k]', 1, { o: { key: 1 }, k: 'key' }),
    v('n[0]', null, { n: null }),
    v('n["a"]', null, { n: null }),
    v('missing[0]', null),
    err('[1, 2]["0"]', TYPE),
    err('xs[k]', 'TYPE_ERROR', { xs: [1, 2], k: '0' }),
    v('{"0": 1}[0]', 1),
    v('o[k]', 1, { o: { '0': 1 }, k: 0 }),
    v('xs[i]', null, { xs: [1, 2], i: 1.5 }),
    err('5[0]', TYPE),
    err('n[0]', 'TYPE_ERROR', { n: 5 }),
    err('b[0]', 'TYPE_ERROR', { b: true }),
    v('a?.b', null, { a: null }),
    v('a?.b', 1, { a: { b: 1 } }),
    v('a?.[0]', 5, { a: [5] }),
    v('a?.[0]', null, { a: null }),
    v('"abc"?.length', 3),
    err('s?.foo', 'TYPE_ERROR', { s: 'abc' }),
    err('a.trim()', ['NULL_RECEIVER', 'TYPE_ERROR'], { a: null }),
    err('missing.trim()', ['NULL_RECEIVER', 'TYPE_ERROR']),
    err('trim(a)', ['NULL_RECEIVER', 'TYPE_ERROR'], { a: null }),
    v('a?.trim()', null, { a: null }),
    v('missing?.trim()', null),
    v('a?.trim()', 'x', { a: ' x ' }),
    v('"a"?.toUpperCase()', 'A'),
    v('a?.b?.toUpperCase()', null, { a: {} }),
    err('o.__proto__', ['BLOCKED_PROPERTY', 'CHECK', 'SYNTAX'], { o: {} }),
    err('o.constructor', ['BLOCKED_PROPERTY', 'CHECK', 'SYNTAX'], { o: {} }),
    err('o.prototype', ['BLOCKED_PROPERTY', 'CHECK', 'SYNTAX'], { o: {} }),
    v('o["__proto__"]', null, { o: {} }),
    v('o[k]', null, { o: {}, k: 'constructor' }),
    v('o["con" + "structor"]', null, { o: {} }),
    err('o.__proto__', ['BLOCKED_PROPERTY', 'CHECK', 'SYNTAX'], { o: withProtoKey }),
    v('o[k]', null, { o: withProtoKey, k: '__proto__' }),
    err('o.constructor', ['BLOCKED_PROPERTY', 'CHECK', 'SYNTAX'], { o: withCtorKey }),
    err('s.constructor', ['BLOCKED_PROPERTY', 'CHECK', 'SYNTAX', 'TYPE_ERROR'], { s: 'abc' }),
    v('o.a', 2, { o: withProtoKey }),
    {
      name: 'strict: undeclared variable is a check error',
      source: 'undeclaredVar',
      options: { strict: true },
      error: 'CHECK',
    },
    {
      name: 'strict: undeclared variable under ??',
      source: 'undeclaredVar ?? 1',
      options: { strict: true },
      error: 'CHECK',
    },
  ])
})

// ---------------------------------------------------------------------------
// §4 has()
// ---------------------------------------------------------------------------
describe('§4 has', () => {
  runCases([
    v('has(a.b)', true, { a: { b: null } }),
    v('has(a.b)', true, { a: { b: 1 } }),
    v('has(a.b)', false, { a: { b: undefined } }),
    v('has(a.b)', false, { a: {} }),
    v('has(a.b)', false, { a: null }),
    v('has(a.b)', false),
    v('has(a.b.c)', false, { a: {} }),
    v('has(a.b.c)', true, { a: { b: { c: false } } }),
    v('has(a["b"])', true, { a: { b: 0 } }),
    v('has(a[k])', false, { a: { b: 0 }, k: 'c' }),
    v('has(m.inh)', false, { m: inherited }),
    v('has(m.own)', true, { m: inherited }),
    v('has(xs[1])', true, { xs: [1, 2] }),
    v('has(xs[1])', true, { xs: [1, null] }),
    v('has(xs[1])', true, { xs: [1, undefined] }),
    // oxlint-disable-next-line no-sparse-arrays -- a hole is the case under test
    v('has(xs[1])', true, { xs: [1, , 3] }),
    v('has(xs[5])', false, { xs: [1, 2] }),
    v('has(xs[-1])', false, { xs: [1, 2] }),
    v('has({a: null}.a)', true),
    err('has(1)', STATIC),
    err('has(x)', STATIC, { x: 1 }),
  ])
})

// ---------------------------------------------------------------------------
// §5 Functions, calls, UFCS
// ---------------------------------------------------------------------------
describe('§5 calls and UFCS', () => {
  runCases([
    v('toUpperCase("ab")', 'AB'),
    v('"ab".toUpperCase()', 'AB'),
    v('"AB".toLowerCase() == toLowerCase("AB")', true),
    v('" x ".trim()', 'x'),
    v('trim(" x ")', 'x'),
    v('"abc".includes("b")', true),
    v('includes("abc", "b")', true),
    v('[1, 2].includes(2)', true),
    v('includes([1, 2], 3)', false),
    v('"abc".startsWith("ab")', true),
    v('endsWith("abc", "bc")', true),
    v('"abc".indexOf("c")', 2),
    v('[1, 2].indexOf(3)', -1),
    v('"hello".slice(1, 3)', 'el'),
    v('slice("hello", 1, 3)', 'el'),
    v('[1, 2, 3].slice(1)', [2, 3]),
    v('"a,b".split(",")', ['a', 'b']),
    v('split("a,b", ",")', ['a', 'b']),
    v('"a-b-c".replace("-", "+")', 'a+b-c'),
    v('"a-b-c".replaceAll("-", "+")', 'a+b+c'),
    v('"5".padStart(3, "0")', '005'),
    v('"5".padEnd(3, "0")', '500'),
    v('"ab".repeat(3)', 'ababab'),
    v('[1, 2, 3].at(-1)', 3),
    v('"abc".at(-1)', 'c'),
    v('[1, 2].join("-")', '1-2'),
    v('[1, 2, 3].reverse()', [3, 2, 1]),
    v('[3, 1, 2].sort()', [1, 2, 3]),
    v('sort([3, 1, 2])', [1, 2, 3]),
    v('[1, 2, 3].sum()', 6),
    v('sum([1, 2, 3])', 6),
    v('[1, null, 3].sum()', 4),
    v('avg([2, 4])', 3),
    v('[null, 2].avg()', 2),
    v('[].avg()', null),
    v('[].min()', null),
    v('[].max()', null),
    v('[3, 1].min()', 1),
    v('max([1, 5, 3])', 5),
    v('[1, null, 5].max()', 5),
    v('[1, 2, 3].first()', 1),
    v('[1, 2, 3].last()', 3),
    v('[1, 1, 2].unique()', [1, 2]),
    v('[[1], [2]].flat()', [1, 2]),
    v('[1, 2].none(. > 5)', true),
    v('[1, 2, 3].count(. > 1)', 2),
    v('"".isEmpty()', true),
    v('[].isEmpty()', true),
    v('{}.isEmpty()', true),
    v('[0].isEmpty()', false),
    v('{a: 1, b: 2}.keys()', ['a', 'b']),
    v('keys({a: 1, b: 2})', ['a', 'b']),
    v('{a: 1, b: 2}.values()', [1, 2]),
    v('{a: 1}.entries()', [{ key: 'a', value: 1 }]),
    v('round(2.5)', 3),
    v('round(3.14159, 2)', 3.14),
    v('3.14159.round(2)', 3.14),
    v('floor(1.7)', 1),
    v('ceil(1.2)', 2),
    v('trunc(-1.7)', -1),
    v('abs(-3)', 3),
    v('sqrt(16)', 4),
    v('clamp(15, 0, 10)', 10),
    v('clamp(-5, 0, 10)', 0),
    v('toFixed(1.5, 2)', '1.50'),
    v('toString(42)', '42'),
    v('(42).toString() == toString(42)', true),
    v('toNumber("42")', 42),
    v('type(1)', 'number'),
    v('type("s")', 'string'),
    v('type([])', 'list'),
    v('type({})', 'map'),
    v('type(null)', 'null'),
    v('type(true)', 'boolean'),
    v('trim(" a ")', 'a', { trim: 5 }),
    v('trim', 5, { trim: 5 }),
    err('o.trim()', TYPE_OR_OVERLOAD, { o: { trim: () => 'EVIL' } }),
    err('o.f()', TYPE_OR_OVERLOAD, { o: { f: () => 1 } }),
    err('nope(1)', 'CHECK'),
    err('"abc".sum()', TYPE_OR_OVERLOAD),
    err('s.sum()', ['TYPE_ERROR', 'NO_OVERLOAD'], { s: 'abc' }),
    err('toUpperCase(n)', ['TYPE_ERROR', 'NO_OVERLOAD'], { n: 5 }),
    err('a.toUpperCase()', ['NULL_RECEIVER', 'TYPE_ERROR'], { a: null }),
    v('a?.toUpperCase()', null, { a: null }),
    err('s.startsWith(x)', 'NO_OVERLOAD', { s: 'abc', x: null }),
    err('s?.startsWith(x)', 'NO_OVERLOAD', { s: 'abc', x: null }),
    v('s.startsWith(x ?? "")', true, { s: 'abc', x: null }),
  ])
})

// ---------------------------------------------------------------------------
// §5 try
// ---------------------------------------------------------------------------
describe('§5 try', () => {
  runCases([
    v('try(1, 2)', 1),
    v('try(null, 2)', null),
    v('try(s + 1, "x")', 'x', { s: 'a' }),
    v('try(a.trim(), "d")', 'd', { a: null }),
    v('try(n.foo, 0)', 0, { n: 5 }),
    v('try(1 / z, 5)', 5, { z: 0 }),
    v('try(x * 10, -1)', -1, { x: 1e308 }),
    v('try(try(1 / z, s + 1), 7)', 7, { z: 0, s: 'a' }),
    v('try(1, 1 / z)', 1, { z: 0 }),
    err('try(1 +, 2)', 'SYNTAX'),
    err('try(1 / z, s + 1)', 'TYPE_ERROR', { z: 0, s: 'a' }),
    {
      name: 'try does not catch STEP_LIMIT',
      source: 'try(xs.map(. + 1).length, 0)',
      context: { xs: big },
      options: { limits: { maxSteps: 100 } },
      error: 'STEP_LIMIT',
    },
    {
      name: 'try does not catch STRING_LIMIT',
      source: 'try("abc".repeat(100), "x")',
      options: { limits: { maxStringLength: 10 } },
      error: 'STRING_LIMIT',
    },
    {
      name: 'try does not catch LIST_LIMIT',
      source: 'try(xs.map(. * 2), [])',
      context: { xs: [1, 2, 3, 4, 5, 6] },
      options: { limits: { maxListLength: 5 } },
      error: 'LIST_LIMIT',
    },
  ])
})

// ---------------------------------------------------------------------------
// §6 Lambdas and implicit `.`
// ---------------------------------------------------------------------------
describe('§6 lambdas and implicit .', () => {
  runCases([
    v('users.filter(u => u.age >= 18).map(u => u.name)', ['A', 'C'], { users }),
    v('orders.map((o, i) => `${i}: ${o.id}`)', ['0: a', '1: b'], { orders }),
    v('users.filter(.age >= 18 && !.suspended).map(.name)', ['A'], { users }),
    v('users.filter(.score > max(.bonus, 10)).map(.name)', ['A'], { users: scored }),
    v(
      'users.map({ name: .name, adult: .age >= 18 })',
      [
        { name: 'A', adult: true },
        { name: 'B', adult: false },
        { name: 'C', adult: true },
        { name: 'D', adult: false },
      ],
      { users },
    ),
    v('groups.map(.users.filter(.active).length)', [1, 2], { groups }),
    v(
      'groups.map(filter(.users, .active))',
      [[{ active: true }], [{ active: true }, { active: true }]],
      { groups },
    ),
    v('groups.map(filter(.users, .active).length)', [1, 2], { groups }),
    v('xs.filter(10 < .)', [15, 20], { xs: [5, 15, 20] }),
    v('rows.map(.[0])', [1, 3], {
      rows: [
        [1, 2],
        [3, 4],
      ],
    }),
    v('orders.filter(o => o.lines.some(.sku == o.promoSku)).map(.id)', ['a'], { orders }),
    v('[1, 2].map(.)', [1, 2]),
    v('users.map(.name.toUpperCase())', ['A', 'B', 'C', 'D'], { users }),
    v('users.map(`${.name}!`)', ['A!', 'B!', 'C!', 'D!'], { users }),
    v('xs.map(x => ys.filter(. > x))', [[2, 3], [3]], { xs: [1, 2], ys: [1, 2, 3] }),
    v('xs.map((a, i) => a * i)', [0, 2], { xs: [1, 2] }),
    v('xs.map(x => x * 2)', [2, 4], { x: 100, xs: [1, 2] }),
    v('[{n: 2}, {n: 1}].sortBy(.n).map(.n)', [1, 2]),
    v('[{n: 1}, {n: 2}].sortBy(.n, "desc").map(.n)', [2, 1]),
    v('groupBy([1, 2, 3], . % 2 == 0 ? "e" : "o")', { o: [1, 3], e: [2] }),
    v('[1, 2, 3].find(. > 1)', 2),
    v('[1, 2, 3].find(. > 5)', null),
    v('[1, 2, 3].findIndex(. > 1)', 1),
    v('[1, 2, 3].findIndex(. > 5)', -1),
    v('[1, 2].some(. > 1)', true),
    v('[1, 2].every(. > 1)', false),
    v('[1, 2].flatMap(x => [x, x])', [1, 1, 2, 2]),
    v('[1, 2, 3].reduce((acc, x) => acc + x, 0)', 6),
    v('users.filter(.age >= 18).length', 2, { users }),
    v('[1, 0, 2].some(10 / . > 5)', true),
    err('[0, 1].some(10 / . > 5)', 'DIVISION_BY_ZERO'),
    v('[1, 0].every(10 / . > 100)', false),
    v('[2, 0].find(10 / . == 5)', 2),
    v('[2, 0].findIndex(10 / . == 5)', 0),
    err('xs.map(x => .)', STATIC, { xs: [1] }),
    err('xs.map(x => x + .)', STATIC, { xs: [1] }),
    err('xs.map(x => .name)', STATIC, { xs: [{ name: 'a' }] }),
    err('.x', STATIC, { x: 1 }),
    err('.', STATIC),
    err('max(.a, 1)', STATIC),
    err('[1].includes(.)', STATIC),
    err('x => x', STATIC),
    err('let f = x => x; 1', STATIC),
    err('[x => x]', STATIC),
    err('{a: x => 1}', STATIC),
    err('max(x => x, 1)', STATIC),
    err('filter(...args)', [...STATIC, 'NO_OVERLOAD'], { args: [[1, 2]] }),
    err('xs.map(...fs)', [...STATIC, 'NO_OVERLOAD'], { xs: [1], fs: [] }),
    err('xs.map(x => xs.map(x => x))', STATIC, { xs: [1] }),
    err('xs.map((x, x) => x)', STATIC, { xs: [1] }),
  ])
})

// ---------------------------------------------------------------------------
// §7 Let
// ---------------------------------------------------------------------------
describe('§7 let', () => {
  runCases([
    v('let x = 2; x * 3', 6),
    v('let a = 1; let b = a + 1; b', 2),
    v('let x = 1; x', 1, { x: 5 }),
    v('let x = 1; x + 1 == 2', true),
    v('1 + (let x = 2; x)', 3),
    v('[(let y = 1; y), y]', [1, null]),
    v('xs.map(x => let y = x * 2; y)', [2, 4], { xs: [1, 2] }),
    v('let total = order.items.map(.price * .qty).sum();\ntotal > 100 ? total * 0.9 : total', 108, {
      order: { items: [{ price: 60, qty: 2 }] },
    }),
    v('let total = order.items.map(.price * .qty).sum();\ntotal > 100 ? total * 0.9 : total', 50, {
      order: { items: [{ price: 25, qty: 2 }] },
    }),
    err('let x = 1; let x = 2; x', STATIC),
    err('let x = 1; [1].map(x => x)', STATIC),
    err('1 + let x = 1; x', 'SYNTAX'),
    err('let x = 1', 'SYNTAX'),
  ])
})

// ---------------------------------------------------------------------------
// §8 Literals
// ---------------------------------------------------------------------------
describe('§8 literals', () => {
  runCases([
    v('[]', []),
    v('[1, 2, ...rest]', [1, 2, 3, 4], { rest: [3, 4] }),
    v('[...xs, ...xs]', [1, 1], { xs: [1] }),
    v('[...n]', [], { n: null }),
    err('[...5]', TYPE),
    err('[...{a: 1}]', TYPE),
    v(
      '{ a: 1, "b-c": 2, [key]: 3, ...other, name }',
      { a: 1, 'b-c': 2, k: 3, z: 9, name: 'N' },
      { key: 'k', other: { z: 9 }, name: 'N' },
    ),
    v('{}', {}),
    v('{zz}', { zz: null }),
    v('{[1]: "x"}', { '1': 'x' }),
    v('{[1.5]: 1}', { '1.5': 1 }),
    v('{[k]: 1}', { '42': 1 }, { k: 42 }),
    err('{[true]: 1}', TYPE),
    err('{[k]: 1}', 'TYPE_ERROR', { k: null }),
    err('{[k]: 1}', 'TYPE_ERROR', { k: [1] }),
    v('{...null}', {}),
    v('{a: 1, ...n}', { a: 1 }, { n: null }),
    v('{...missing}', {}),
    err('{...[1]}', TYPE),
    err('{...n}', 'TYPE_ERROR', { n: 5 }),
    err('{a: 1, a: 2}', 'SYNTAX'),
    err('{a: 1, "a": 2}', 'SYNTAX'),
    err('{a, a: 1}', 'SYNTAX', { a: 1 }),
    v('{a: 1, ["a"]: 2}', { a: 2 }),
    v('{a: 1, [k]: 2}', { a: 2 }, { k: 'a' }),
    v('{a: 1, ...{a: 2}}', { a: 2 }),
    v('{a: 1, ...o}', { a: 3 }, { o: { a: 3 } }),
    v('{...o, b: 1}', { a: 3, b: 1 }, { o: { a: 3 } }),
    v('{...m}', { own: 2 }, { m: inherited }),
    err('{constructor: 1}', ['SYNTAX', 'CHECK', 'BLOCKED_PROPERTY']),
    err('{prototype: 1}', ['SYNTAX', 'CHECK', 'BLOCKED_PROPERTY']),
    err('{__proto__: 1}', ['SYNTAX', 'CHECK', 'BLOCKED_PROPERTY']),
    err('{"__proto__": 1}', ['SYNTAX', 'CHECK', 'BLOCKED_PROPERTY']),
    err('{[k]: 1}', 'BLOCKED_PROPERTY', { k: '__proto__' }),
    v('{a: 1}.a', 1),
    v('{"b-c": 2}["b-c"]', 2),
  ])
})

// ---------------------------------------------------------------------------
// §8 Templates
// ---------------------------------------------------------------------------
describe('§8 templates', () => {
  runCases([
    v('`a${1 + 1}b`', 'a2b'),
    v('`plain`', 'plain'),
    v('``', ''),
    v('`x${null}y`', 'xy'),
    v('`x${missing}y`', 'xy'),
    v('`x${u}y`', 'xy', { u: undefined }),
    v('`${0.1 + 0.2}`', '0.30000000000000004'),
    v('`${1.50}`', '1.5'),
    v('`${1_000}`', '1000'),
    v('`${"s"}`', 's'),
    v('`${true}`', 'true'),
    v('`a${1}`', 'a1'),
    v('`${`in${1}`}`', 'in1'),
    v('`\\${x}`', '${x}', { x: 1 }),
    v('`a\\`b`', 'a`b'),
    v('`line1\nline2`', 'line1\nline2'),
    {
      source: '`${t}`',
      context: { t: new Date('2024-01-02T03:04:05Z') },
      match: /^2024-01-02T03:04:05(?:\.000)?Z$/u,
    },
    {
      source: '`${timestamp("2024-01-02T03:04:05Z")}`',
      match: /^2024-01-02T03:04:05(?:\.000)?Z$/u,
    },
    v('`${hours(1) + minutes(30)}`', 'PT1H30M'),
    v('`${minutes(90)}`', 'PT1H30M'),
    { source: '`${days(1)}`', match: /^(?:P1D|PT24H)$/u },
    err('`${[1]}`', TYPE),
    err('`${xs}`', 'TYPE_ERROR', { xs: [1] }),
    err('`${{a: 1}}`', TYPE),
    err('`${o}`', 'TYPE_ERROR', { o: { a: 1 } }),
  ])
})

// ---------------------------------------------------------------------------
// §9 Time
// ---------------------------------------------------------------------------
describe('§9 time', () => {
  const late = new Date('2024-01-01T23:30:00Z')
  runCases([
    ts('timestamp("2024-01-01T00:00:00Z")', '2024-01-01T00:00:00.000Z'),
    ts('addDays(t, 1)', '2024-01-02T00:00:00.000Z', { t: T0 }),
    ts('t.addDays(1)', '2024-01-02T00:00:00.000Z', { t: T0 }),
    ts('addMonths(timestamp("2024-01-15T00:00:00Z"), 1)', '2024-02-15T00:00:00.000Z'),
    ts('addYears(timestamp("2024-01-15T00:00:00Z"), 1)', '2025-01-15T00:00:00.000Z'),
    ts(
      'addDays(timestamp("2024-03-30T12:00:00Z"), 1, "Europe/Berlin")',
      '2024-03-31T11:00:00.000Z',
    ),
    ts('addDays(timestamp("2024-03-30T12:00:00Z"), 1)', '2024-03-31T12:00:00.000Z'),
    ts('timestamp("2024-03-30T12:00:00Z") + days(1)', '2024-03-31T12:00:00.000Z'),
    ts(
      'addMonths(timestamp("2024-03-15T12:00:00Z"), 1, "Europe/Berlin")',
      '2024-04-15T11:00:00.000Z',
    ),
    v('year(t)', 2024, { t: late }),
    v('day(t)', 1, { t: late }),
    v('hour(t)', 23, { t: late }),
    v('minute(t)', 30, { t: late }),
    v('second(t)', 0, { t: late }),
    v('day(t, "Europe/Berlin")', 2, { t: late }),
    v('hour(t, "Europe/Berlin")', 0, { t: late }),
    v('year(timestamp("2023-12-31T23:30:00Z"), "Europe/Berlin")', 2024),
    v('t.year()', 2024, { t: late }),
    ts('startOfDay(t)', '2024-01-01T00:00:00.000Z', { t: late }),
    ts('startOfDay(t, "Europe/Berlin")', '2024-01-01T23:00:00.000Z', { t: late }),
    ts('startOfMonth(timestamp("2024-02-15T10:00:00Z"))', '2024-02-01T00:00:00.000Z'),
    ts('startOfYear(timestamp("2024-02-15T10:00:00Z"))', '2024-01-01T00:00:00.000Z'),
    v('formatDate(t, "yyyy-MM-dd HH:mm:ss")', '2024-01-01 23:30:00', { t: late }),
    v('formatDate(t, "yyyy-MM-dd HH:mm:ss", "Europe/Berlin")', '2024-01-02 00:30:00', { t: late }),
    v('inHours(days(2))', 48),
    v('inMinutes(hours(1))', 60),
    v('inSeconds(minutes(2))', 120),
    v('inMilliseconds(seconds(1))', 1000),
    v('inDays(weeks(1))', 7),
    v('milliseconds(1500) == seconds(1.5)', true),
    v('inDays(b - a)', 1, { a: T0, b: T1 }),
    v('now() == now()', true),
    v('now() - now() == milliseconds(0)', true),
    v('type(now())', 'timestamp'),
    v('type(days(1))', 'duration'),
    err('timestamp("not a date")', ['INVALID_ARGUMENT', 'TYPE_ERROR']),
  ])
})

// ---------------------------------------------------------------------------
// §10 Guarantees and limits
// ---------------------------------------------------------------------------
describe('§10 guarantees', () => {
  const deep = `${'('.repeat(2000)}1${')'.repeat(2000)}`
  runCases([
    {
      name: 'maxSteps bounds lambda calls',
      source: 'xs.map(. + 1).length',
      context: { xs: big },
      options: { limits: { maxSteps: 100 } },
      error: 'STEP_LIMIT',
    },
    {
      name: 'maxSteps charges equality',
      source: 'xs == ys',
      context: { xs: big, ys: big2 },
      options: { limits: { maxSteps: 100 } },
      error: 'STEP_LIMIT',
    },
    {
      name: 'maxSteps charges membership',
      source: '999 in xs',
      context: { xs: big },
      options: { limits: { maxSteps: 100 } },
      error: 'STEP_LIMIT',
    },
    {
      name: 'maxSteps charges concatenation',
      source: '(xs + ys).length',
      context: { xs: big, ys: big2 },
      options: { limits: { maxSteps: 100 } },
      error: 'STEP_LIMIT',
    },
    {
      name: 'maxSteps charges spread',
      source: '[...xs].length',
      context: { xs: big },
      options: { limits: { maxSteps: 100 } },
      error: 'STEP_LIMIT',
    },
    {
      name: 'cyclic host data equality is bounded by depth',
      source: 'a == b',
      context: { a: cycA, b: cycB },
      error: ['VALUE_DEPTH_LIMIT'],
    },
    { name: 'deep nesting is bounded', source: deep, error: 'TOO_DEEP' },
    {
      name: 'maxStringLength: repeat',
      source: '"abc".repeat(5)',
      options: { limits: { maxStringLength: 10 } },
      error: 'STRING_LIMIT',
    },
    {
      name: 'maxStringLength: concat',
      source: '"aaaaaa" + "bbbbbb"',
      options: { limits: { maxStringLength: 10 } },
      error: 'STRING_LIMIT',
    },
    {
      name: 'maxStringLength: template',
      source: '`${s}${s}`',
      context: { s: 'aaaaaa' },
      options: { limits: { maxStringLength: 10 } },
      error: 'STRING_LIMIT',
    },
    {
      name: 'maxStringLength: padStart',
      source: '"ab".padStart(20)',
      options: { limits: { maxStringLength: 10 } },
      error: 'STRING_LIMIT',
    },
    {
      name: 'maxStringLength: host string read unchanged',
      source: 's.length',
      context: { s: 'x'.repeat(50) },
      options: { limits: { maxStringLength: 10 } },
      value: 50,
    },
    {
      name: 'maxListLength: literal',
      source: '[1, 2, 3, 4]',
      options: { limits: { maxListLength: 3 } },
      error: 'LIST_LIMIT',
    },
    {
      name: 'maxListLength: concat',
      source: '[1, 2] + [3, 4]',
      options: { limits: { maxListLength: 3 } },
      error: 'LIST_LIMIT',
    },
    {
      name: 'maxListLength: map',
      source: 'xs.map(.)',
      context: { xs: [1, 2, 3, 4, 5] },
      options: { limits: { maxListLength: 3 } },
      error: 'LIST_LIMIT',
    },
    {
      name: 'maxListLength: host list read unchanged',
      source: 'xs.length',
      context: { xs: [1, 2, 3, 4, 5] },
      options: { limits: { maxListLength: 3 } },
      value: 5,
    },
    v('let s = xs.sort(); xs', [3, 1, 2], { xs: [3, 1, 2] }),
    v('let r = xs.reverse(); xs', [3, 1, 2], { xs: [3, 1, 2] }),
    v('o.g', 5, { o: getterObj }),
  ])

  it('built-ins do not mutate host inputs', async () => {
    const xs = [3, 1, 2]
    const o = { a: 1 }
    const env = bonsai()
    env.evaluateSync('[xs.sort(), xs.reverse(), {...o, b: 2}, xs.map(. + 1)]', { xs, o })
    await env.evaluate('[xs.sort(), xs.reverse()]', { xs, o })
    expect(xs).toEqual([3, 1, 2])
    expect(o).toEqual({ a: 1 })
  })

  it('evaluateSync rejects async host functions at check time, before host code runs', async () => {
    let ran = false
    const env = bonsai({
      functions: {
        a: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: () => {
            ran = true
            return Promise.resolve(1)
          },
        }),
        s: fn({ params: [], returns: t.number(), run: () => ((ran = true), 1) }),
      },
    })
    let code: unknown
    try {
      env.evaluateSync('s() + a()')
    } catch (e) {
      code = (e as { code?: unknown }).code
    }
    expect(code).toBe('ASYNC_IN_SYNC')
    expect(ran).toBe(false)
    expect(await env.evaluate('a() + 1')).toBe(2)
  })

  it('host function failures are caught by try and surface as HOST_ERROR otherwise', async () => {
    const env = bonsai({
      functions: {
        boom: fn({
          params: [],
          returns: t.number(),
          run: () => {
            throw new Error('kaput')
          },
        }),
      },
    })
    expect(env.evaluateSync('try(boom(), 7)')).toBe(7)
    expect(await env.evaluate('try(boom(), 7)')).toBe(7)
    expect(() => env.evaluateSync('boom()')).toThrow(
      expect.objectContaining({ code: 'HOST_ERROR' }),
    )
  })

  it('operands and arguments evaluate left to right, one at a time', async () => {
    for (const mode of ['sync', 'async'] as const) {
      const log: number[] = []
      const env = bonsai({
        functions: {
          tick: fn({ params: [t.number()], returns: t.number(), run: (n) => (log.push(n), n) }),
        },
      })
      const src = '[tick(1) + tick(2), max(tick(3), tick(4)), [5, 6].map(tick(.))]'
      if (mode === 'sync') env.evaluateSync(src)
      else await env.evaluate(src)
      expect(log, mode).toEqual([1, 2, 3, 4, 5, 6])
    }
  })

  it('lambdas stop as soon as the result is known', () => {
    const log: number[] = []
    const env = bonsai({
      functions: {
        tick: fn({ params: [t.number()], returns: t.number(), run: (n) => (log.push(n), n) }),
      },
    })
    expect(env.evaluateSync('[1, 2, 3, 4].some(tick(.) == 2)')).toBe(true)
    expect(log).toEqual([1, 2])
    log.length = 0
    expect(env.evaluateSync('[1, 2, 3, 4].every(tick(.) < 2)')).toBe(false)
    expect(log).toEqual([1, 2])
    log.length = 0
    expect(env.evaluateSync('[1, 2, 3, 4].find(tick(.) == 3)')).toBe(3)
    expect(log).toEqual([1, 2, 3])
  })
})
