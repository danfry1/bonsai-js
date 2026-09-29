// Behavior of every built-in function: results, null and optional-argument
// handling, invalid-argument errors, limits, and the async variants of the
// higher-order functions (a lambda that calls an async host function).
import { describe, expect, it } from 'vitest'
import { BonsaiError, Duration, bonsai, fn, t } from '../src/index.js'

const env = bonsai()
const LOCALES = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'ja-JP',
  'es-ES',
  'it-IT',
  'nl-NL',
  'pt-BR',
  'sv-SE',
  'da-DK',
  'fi-FI',
  'pl-PL',
  'cs-CZ',
  'ko-KR',
  'zh-CN',
  'ru-RU',
  'tr-TR',
  'nb-NO',
  'hu-HU',
]

type Outcome = { value: unknown } | { error: string }

function capture(evaluate: () => unknown): Outcome {
  try {
    return { value: normalize(evaluate()) }
  } catch (error) {
    if (error instanceof BonsaiError) return { error: error.code }
    throw error
  }
}

async function captureAsync(evaluate: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: normalize(await evaluate()) }
  } catch (error) {
    if (error instanceof BonsaiError) return { error: error.code }
    throw error
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return { iso: value.toISOString() }
  if (value instanceof Duration) return { duration: value.toString() }
  return value
}

/** Evaluates sync and async and requires both to agree. */
async function both(
  source: string,
  context: Record<string, unknown> = {},
  environment = env,
): Promise<Outcome> {
  const sync = capture(() => environment.evaluateSync(source, context))
  const async = await captureAsync(() => environment.evaluate(source, context))
  expect(async, source).toEqual(sync)
  return sync
}

async function ok(source: string, context: Record<string, unknown> = {}): Promise<unknown> {
  const outcome = await both(source, context)
  if ('error' in outcome) throw new Error(`${source} failed with ${outcome.error}`)
  return outcome.value
}

async function fails(source: string, context: Record<string, unknown> = {}): Promise<string> {
  const outcome = await both(source, context)
  if ('value' in outcome) throw new Error(`${source} produced ${JSON.stringify(outcome.value)}`)
  return outcome.error
}

describe('string functions', () => {
  it('changes case and trims', async () => {
    expect(await ok('toUpperCase("abc")')).toBe('ABC')
    expect(await ok('"ABC".toLowerCase()')).toBe('abc')
    expect(await ok('trim("  a b  ")')).toBe('a b')
    expect(await ok('trimStart("  a  ")')).toBe('a  ')
    expect(await ok('trimEnd("  a  ")')).toBe('  a')
  })

  it('tests prefixes, suffixes, and substrings', async () => {
    expect(await ok('startsWith("api-users", "api-")')).toBe(true)
    expect(await ok('endsWith("file.ts", ".js")')).toBe(false)
    expect(await ok('includes("hello", "ell")')).toBe(true)
    expect(await ok('includes([1, 2, 3], 2)')).toBe(true)
    expect(await ok('includes([{ a: 1 }], { a: 1 })')).toBe(true)
    expect(await ok('includes(xs, 9)', { xs: [1, 2] })).toBe(false)
  })

  it('finds positions in text and lists', async () => {
    expect(await ok('indexOf("abab", "b")')).toBe(1)
    expect(await ok('lastIndexOf("abab", "b")')).toBe(3)
    expect(await ok('indexOf("abab", "z")')).toBe(-1)
    expect(await ok('indexOf([1, 2, 1], 1)')).toBe(0)
    expect(await ok('lastIndexOf([1, 2, 1], 1)')).toBe(2)
    expect(await ok('indexOf(xs, 9)', { xs: [1, 2] })).toBe(-1)
    expect(await ok('lastIndexOf(xs, 9)', { xs: [1, 2] })).toBe(-1)
    expect(await ok('indexOf([[1], [2]], [2])')).toBe(1)
  })

  it('slices text and lists with optional end and negative positions', async () => {
    expect(await ok('slice("hello", 1)')).toBe('ello')
    expect(await ok('slice("hello", 1, 3)')).toBe('el')
    expect(await ok('slice("hello", -3)')).toBe('llo')
    expect(await ok('slice("hello", 1, e)', { e: null })).toBe('ello')
    expect(await ok('slice([1, 2, 3, 4], 1, 3)')).toEqual([2, 3])
    expect(await ok('slice([1, 2, 3, 4], -2)')).toEqual([3, 4])
    expect(await ok('slice(xs, 1, e)', { xs: [1, 2, 3], e: null })).toEqual([2, 3])
    expect(await fails('slice("hello", 1.5)')).toBe('INVALID_ARGUMENT')
    expect(await fails('slice("hello", 0, 2.5)')).toBe('INVALID_ARGUMENT')
    expect(await fails('slice([1], 0.5)')).toBe('INVALID_ARGUMENT')
    expect(await fails('slice([1], 0, 0.5)')).toBe('INVALID_ARGUMENT')
    // A null start is not an optional argument: no overload accepts it.
    expect(await fails('slice(s, x)', { s: 'abc', x: null })).toBe('NO_OVERLOAD')
  })

  it('splits text with an optional limit', async () => {
    expect(await ok('split("a,b,c", ",")')).toEqual(['a', 'b', 'c'])
    expect(await ok('split("a,b,c", ",", 2)')).toEqual(['a', 'b'])
    expect(await ok('split("a,b,c", ",", 0)')).toEqual([])
    expect(await ok('split("abc", "")')).toEqual(['a', 'b', 'c'])
    expect(await ok('split("a,b", ",", n)', { n: null })).toEqual(['a', 'b'])
    expect(await fails('split("a,b", ",", -1)')).toBe('INVALID_ARGUMENT')
    expect(await fails('split("a,b", ",", 1.5)')).toBe('INVALID_ARGUMENT')
  })

  it('never produces more parts than the list limit allows', async () => {
    const small = bonsai({ limits: { maxListLength: 3 } })
    expect(await both('split("a,b,c", ",")', {}, small)).toEqual({ value: ['a', 'b', 'c'] })
    expect(await both('split("a,b,c,d,e", ",")', {}, small)).toEqual({ error: 'LIST_LIMIT' })
  })

  it('replaces text literally (no patterns)', async () => {
    expect(await ok('replace("a.b.c", ".", "-")')).toBe('a-b.c')
    expect(await ok('replaceAll("a.b.c", ".", "-")')).toBe('a-b-c')
    expect(await ok('replace("abc", "z", "-")')).toBe('abc')
    expect(await ok('replaceAll("a.b.c", ".", "")')).toBe('abc')
    expect(await ok('replace("abc", "", "-")')).toBe('-abc')
    expect(await ok('replaceAll("abc", "", "-")')).toBe('-a-b-c-')
    expect(await ok('replaceAll("", "", "-")')).toBe('-')
  })

  it('checks replacement output against the string limit', async () => {
    const small = bonsai({ limits: { maxStringLength: 5 } })
    expect(await both('replaceAll("aaa", "a", "bb")', {}, small)).toEqual({ error: 'STRING_LIMIT' })
    expect(await both('replaceAll("aaa", "", "xx")', {}, small)).toEqual({ error: 'STRING_LIMIT' })
    expect(await both('replace("aaaa", "", "xx")', {}, small)).toEqual({ error: 'STRING_LIMIT' })
    expect(await both('replace("aaa", "a", "bb")', {}, small)).toEqual({ value: 'bbaa' })
  })

  it('pads with an optional fill', async () => {
    expect(await ok('padStart("5", 3, "0")')).toBe('005')
    expect(await ok('padEnd("5", 3)')).toBe('5  ')
    expect(await ok('padEnd("5", 4, "ab")')).toBe('5aba')
    expect(await ok('padStart("5", 3, f)', { f: null })).toBe('  5')
    expect(await ok('padStart("5", 3, "")')).toBe('5')
    expect(await ok('padStart("abc", 2)')).toBe('abc')
    expect(await fails('padStart("a", -1)')).toBe('INVALID_ARGUMENT')
    expect(await fails('padEnd("a", 1.5)')).toBe('INVALID_ARGUMENT')
    const small = bonsai({ limits: { maxStringLength: 5 } })
    expect(await both('padStart("a", 6)', {}, small)).toEqual({ error: 'STRING_LIMIT' })
  })

  it('repeats text within the string limit', async () => {
    expect(await ok('repeat("ab", 3)')).toBe('ababab')
    expect(await ok('repeat("ab", 0)')).toBe('')
    expect(await fails('repeat("ab", -1)')).toBe('INVALID_ARGUMENT')
    expect(await fails('repeat("ab", 0.5)')).toBe('INVALID_ARGUMENT')
    expect(await fails('repeat("ab", 1e6)')).toBe('STRING_LIMIT')
  })

  it('reads positions with at(), counting from the end when negative', async () => {
    expect(await ok('at("abc", 0)')).toBe('a')
    expect(await ok('at("abc", -1)')).toBe('c')
    expect(await ok('at("abc", 3)')).toBeNull()
    expect(await ok('at([1, 2, 3], -1)')).toBe(3)
    expect(await ok('at([1, 2, 3], 5)')).toBeNull()
    expect(await ok('at(xs, 0)', { xs: [undefined] })).toBeNull()
    expect(await fails('at([1], 0.5)')).toBe('INVALID_ARGUMENT')
    expect(await fails('at("a", 0.5)')).toBe('INVALID_ARGUMENT')
  })

  it('matches regular expressions and caches compiled patterns', async () => {
    expect(await ok('matches("abc", "^a.c$")')).toBe(true)
    expect(await ok('matches("ABC", p)', { p: '(?i)^abc$' })).toBe(true)
    expect(await fails('matches("a", p)', { p: '(a' })).toBe('INVALID_ARGUMENT')
    // Static patterns are validated at check time.
    expect(await fails('matches("a", "(a")')).toBe('CHECK')
    expect(env.check('matches(s, p)').ok).toBe(true)
  })

  it('keeps working after the pattern cache fills up', async () => {
    for (let i = 0; i < 300; i++) {
      expect(env.evaluateSync('matches(s, p)', { s: `x${i}`, p: `^x${i}$` })).toBe(true)
    }
    expect(await ok('matches("x1", p)', { p: '^x1$' })).toBe(true)
  })

  it('renders values as text with toString()', async () => {
    expect(await ok('toString(1.5)')).toBe('1.5')
    expect(await ok('toString(true)')).toBe('true')
    expect(await ok('toString(null)')).toBe('')
    expect(await ok('toString(d)', { d: new Date(0) })).toBe('1970-01-01T00:00:00.000Z')
    expect(await ok('toString(hours(1) + minutes(30))')).toBe('PT1H30M')
  })

  it('parses numbers with toNumber()', async () => {
    expect(await ok('toNumber(" 42 ")')).toBe(42)
    expect(await ok('toNumber("0x10")')).toBe(16)
    expect(await ok('toNumber(5)')).toBe(5)
    expect(await fails('toNumber("")')).toBe('INVALID_ARGUMENT')
    expect(await fails('toNumber("x")')).toBe('INVALID_ARGUMENT')
    expect(await fails('toNumber("Infinity")')).toBe('INVALID_ARGUMENT')
  })

  it('reports null receivers and honors ?. calls', async () => {
    expect(await fails('n.trim()', { n: null })).toBe('NULL_RECEIVER')
    expect(await fails('trim(n)', { n: null })).toBe('NULL_RECEIVER')
    expect(await ok('n?.trim()', { n: null })).toBeNull()
    expect(await fails('trim(n)', { n: 5 })).toBe('NO_OVERLOAD')
  })
})

describe('number functions', () => {
  it('rounds half away from zero, with optional digits', async () => {
    expect(await ok('round(2.5)')).toBe(3)
    expect(await ok('round(-2.5)')).toBe(-3)
    expect(await ok('round(0.4)')).toBe(0)
    expect(await ok('round(-0.4)')).toBe(0)
    expect(await ok('round(0, 2)')).toBe(0)
    expect(await ok('round(1.005, 2)')).toBe(1.01)
    expect(await ok('round(1234, -2)')).toBe(1200)
    expect(await ok('round(1.5, d)', { d: null })).toBe(2)
    expect(await fails('round(1.5, 16)')).toBe('INVALID_ARGUMENT')
    expect(await fails('round(1.5, -16)')).toBe('INVALID_ARGUMENT')
    expect(await fails('round(1.5, 0.5)')).toBe('INVALID_ARGUMENT')
  })

  it('reads non-finite host numbers without producing new ones', async () => {
    // A non-finite input is an error, not passed through (spec: no operation yields NaN or infinity).
    expect(await fails('round(x)', { x: Number.POSITIVE_INFINITY })).toBe('NON_FINITE')
    expect(await ok('x > 1', { x: Number.POSITIVE_INFINITY })).toBe(true)
  })

  it('floors, ceils, truncates, and takes absolute values', async () => {
    expect(await ok('floor(-1.5)')).toBe(-2)
    expect(await ok('ceil(-1.5)')).toBe(-1)
    expect(await ok('trunc(-1.5)')).toBe(-1)
    expect(await ok('abs(-3)')).toBe(3)
    expect(await ok('abs(hours(-1))')).toEqual({ duration: 'PT1H' })
    expect(await ok('abs(hours(1))')).toEqual({ duration: 'PT1H' })
  })

  it('takes square roots and clamps', async () => {
    expect(await ok('sqrt(16)')).toBe(4)
    expect(await fails('sqrt(-1)')).toBe('NON_FINITE')
    expect(await ok('clamp(5, 1, 3)')).toBe(3)
    expect(await ok('clamp(-5, 1, 3)')).toBe(1)
    expect(await ok('clamp(2, 1, 3)')).toBe(2)
    expect(await fails('clamp(5, 3, 1)')).toBe('INVALID_ARGUMENT')
  })

  it('formats fixed decimals consistently with round()', async () => {
    expect(await ok('toFixed(1.005, 2)')).toBe('1.01')
    expect(await ok('toFixed(2, 0)')).toBe('2')
    expect(await ok('toFixed(1, 20)')).toBe('1.00000000000000000000')
    expect(await fails('toFixed(1, 101)')).toBe('INVALID_ARGUMENT')
    expect(await fails('toFixed(1, -1)')).toBe('INVALID_ARGUMENT')
    expect(await fails('toFixed(1, 1.5)')).toBe('INVALID_ARGUMENT')
  })

  it('formats numbers with grouping, decimals, and locales', async () => {
    expect(await ok('formatNumber(1234.5)')).toBe('1,234.5')
    expect(await ok('formatNumber(1234.5, 2)')).toBe('1,234.50')
    expect(await ok('formatNumber(1234.5, 2, "de-DE")')).toBe('1.234,50')
    expect(await ok('formatNumber(1.005, 2)')).toBe('1.01')
    expect(await ok('formatNumber(1234.5, d, l)', { d: null, l: null })).toBe('1,234.5')
    expect(await fails('formatNumber(1, 21)')).toBe('INVALID_ARGUMENT')
    expect(await fails('formatNumber(1, -1)')).toBe('INVALID_ARGUMENT')
    expect(await fails('formatNumber(1, 2, "not a locale!!")')).toBe('INVALID_ARGUMENT')
  })

  // formatNumber documents up to 20 decimals, but 16-20 fail inside round().
  it('formats numbers with 16 to 20 decimals', async () => {
    expect(await ok('formatNumber(1.5, 20)')).toBe('1.50000000000000000000')
  })

  it('formats currencies', async () => {
    expect(await ok('formatCurrency(3.5, "EUR")')).toBe('€3.50')
    expect(await ok('formatCurrency(3.5, "USD", "en-US")')).toBe('$3.50')
    expect(await fails('formatCurrency(3.5, "EURO")')).toBe('INVALID_ARGUMENT')
  })

  it('keeps working after the number format cache fills up', async () => {
    for (let i = 0; i <= 15; i++) {
      for (const locale of LOCALES) {
        for (const style of [0, 1]) {
          const source = style === 0 ? 'formatNumber(1, d, l)' : 'formatCurrency(1, "EUR", l)'
          expect(typeof env.evaluateSync(source, { d: i, l: locale })).toBe('string')
        }
      }
    }
    expect(await ok('formatNumber(1, 0)')).toBe('1')
  })

  it('finds minimum and maximum values of lists and arguments', async () => {
    expect(await ok('min([3, 1, 2])')).toBe(1)
    expect(await ok('max([3, 1, 2])')).toBe(3)
    expect(await ok('min([null, 3, null, 1])')).toBe(1)
    expect(await ok('max(["b", "a", "c"])')).toBe('c')
    expect(await ok('min([])')).toBeNull()
    expect(await ok('min(3, 1, 2)')).toBe(1)
    expect(await ok('max(3, 1, 2)')).toBe(3)
    expect(await ok('max(4)')).toBe(4)
    expect(await fails('max(n, 1)', { n: null })).toBe('NULL_RECEIVER')
    expect(await fails('min(xs)', { xs: [1, 'a'] })).toBe('TYPE_ERROR')
  })

  it('sums numbers and durations, skipping nulls', async () => {
    expect(await ok('sum([1, 2, null, 3])')).toBe(6)
    expect(await ok('sum([])')).toBe(0)
    expect(await ok('sum([hours(1), null, minutes(30)])')).toEqual({ duration: 'PT1H30M' })
    expect(await fails('sum([1e308, 1e308])')).toBe('NON_FINITE')
    expect(await fails('sum(xs)', { xs: [1, 'a'] })).toBe('TYPE_ERROR')
    expect(await fails('sum(xs)', { xs: null })).toBe('NULL_RECEIVER')
  })

  it('averages numbers, skipping nulls', async () => {
    expect(await ok('avg([1, null, 2])')).toBe(1.5)
    expect(await ok('avg([])')).toBeNull()
    expect(await ok('avg([null])')).toBeNull()
    expect(await fails('avg(xs)', { xs: ['a'] })).toBe('TYPE_ERROR')
  })
})

describe('list functions', () => {
  it('counts items with and without a predicate', async () => {
    expect(await ok('count([1, 2, 3])')).toBe(3)
    expect(await ok('count([1, 2, 3], . > 1)')).toBe(2)
    expect(await ok('[1, 2, 3].count(x => x > 5)')).toBe(0)
  })

  it('folds with reduce', async () => {
    expect(await ok('reduce([1, 2, 3], (acc, x) => acc + x, 0)')).toBe(6)
    expect(await ok('xs.reduce((acc, x) => acc + x, 10)', { xs: [] })).toBe(10)
    expect(await ok('["a", "b"].reduce((acc, x) => acc + x, "")')).toBe('ab')
  })

  // An empty list literal has element type never; a lambda over it never runs,
  // so its body should check (as `[].filter(. > 1)` already does).
  it('checks arithmetic on the items of an empty list literal', async () => {
    expect(await ok('[].map(x => x + 1)')).toEqual([])
    expect(await ok('reduce([], (acc, x) => acc + x, 10)')).toBe(10)
  })

  it('sorts orderable values, with a direction', async () => {
    expect(await ok('sort([3, 1, 2])')).toEqual([1, 2, 3])
    expect(await ok('sort([3, 1, 2], "desc")')).toEqual([3, 2, 1])
    expect(await ok('sort(["b", "a"], "asc")')).toEqual(['a', 'b'])
    expect(await ok('sort(xs, d)', { xs: [2, 1], d: null })).toEqual([1, 2])
    expect(await ok('sort([])')).toEqual([])
    expect(await ok('sort([2, null, 1])')).toEqual([null, 1, 2])
    expect(await fails('sort(xs, d)', { xs: [1], d: 'up' })).toBe('NO_OVERLOAD')
    expect(await fails('sort(xs)', { xs: [1, 'a'] })).toBe('TYPE_ERROR')
    expect(await fails('sort([1, "a"])')).toBe('CHECK')
  })

  it('sorts by a key, stably', async () => {
    const people = [
      { name: 'b', age: 30 },
      { name: 'a', age: 20 },
      { name: 'c', age: 30 },
    ]
    expect(await ok('people.sortBy(.age).map(.name)', { people })).toEqual(['a', 'b', 'c'])
    expect(await ok('people.sortBy(.age, "desc").map(.name)', { people })).toEqual(['b', 'c', 'a'])
    expect(await fails('people.sortBy(.age, d)', { people, d: 'sideways' })).toBe('NO_OVERLOAD')
  })

  it('reverses, deduplicates, and flattens', async () => {
    expect(await ok('reverse([1, 2, 3])')).toEqual([3, 2, 1])
    expect(await ok('unique([1, 1, "1", null, null, [1], [1], { a: 1 }, { a: 1 }])')).toEqual([
      1,
      '1',
      null,
      [1],
      { a: 1 },
    ])
    expect(await ok('unique(xs)', { xs: [undefined, null] })).toEqual([null])
    expect(await ok('flat([[1, 2], 3, [[4]]])')).toEqual([1, 2, 3, [4]])
    expect(await ok('flat([])')).toEqual([])
  })

  it('bounds flattening by the list limit', async () => {
    const small = bonsai({ limits: { maxListLength: 3 } })
    expect(
      await both(
        'flat(xs)',
        {
          xs: [
            [1, 2],
            [3, 4],
          ],
        },
        small,
      ),
    ).toEqual({ error: 'LIST_LIMIT' })
    expect(await both('flat(xs)', { xs: [1, 2, 3, 4] }, small)).toEqual({ error: 'LIST_LIMIT' })
    expect(await both('flat(xs)', { xs: [1, [2], 3] }, small)).toEqual({ value: [1, 2, 3] })
  })

  it('reads the first and last items', async () => {
    expect(await ok('first([1, 2])')).toBe(1)
    expect(await ok('first([])')).toBeNull()
    expect(await ok('last([1, 2])')).toBe(2)
    expect(await ok('last([])')).toBeNull()
  })

  it('joins text-like items with a separator', async () => {
    expect(await ok('join([1, null, "a", true])')).toBe('1,,a,true')
    expect(await ok('join([hours(1), d], " | ")', { d: new Date(0) })).toBe(
      'PT1H | 1970-01-01T00:00:00.000Z',
    )
    expect(await ok('join(xs, sep)', { xs: ['a', 'b'], sep: null })).toBe('a,b')
    expect(await fails('join(xs)', { xs: [[1]] })).toBe('TYPE_ERROR')
    expect(await fails('join(xs)', { xs: [{ a: 1 }] })).toBe('TYPE_ERROR')
    expect(await fails('join([[1]])')).toBe('CHECK')
    const small = bonsai({ limits: { maxStringLength: 4 } })
    expect(await both('join(["ab", "cd"])', {}, small)).toEqual({ error: 'STRING_LIMIT' })
  })

  it('tests emptiness of lists, text, maps, and null', async () => {
    expect(await ok('isEmpty(n)', { n: null })).toBe(true)
    expect(await ok('isEmpty({})')).toBe(true)
    expect(await ok('isEmpty({ a: 1 })')).toBe(false)
    expect(await ok('isEmpty("")')).toBe(true)
    expect(await ok('isEmpty([1])')).toBe(false)
  })
})

describe('higher-order functions', () => {
  const nums = { xs: [3, 1, 2] }

  it('map, filter, find, findIndex', async () => {
    expect(await ok('xs.map((x, i) => x * 10 + i)', nums)).toEqual([30, 11, 22])
    expect(await ok('xs.filter(. > 1)', nums)).toEqual([3, 2])
    expect(await ok('xs.find(. < 3)', nums)).toBe(1)
    expect(await ok('xs.find(. > 9)', nums)).toBeNull()
    expect(await ok('xs.findIndex(. == 2)', nums)).toBe(2)
    expect(await ok('xs.findIndex(. == 9)', nums)).toBe(-1)
    expect(await ok('xs.find(. == null)', { xs: [1, undefined] })).toBeNull()
  })

  it('some, every, none', async () => {
    expect(await ok('xs.some(. > 2)', nums)).toBe(true)
    expect(await ok('xs.some(. > 5)', nums)).toBe(false)
    expect(await ok('xs.every(. > 0)', nums)).toBe(true)
    expect(await ok('xs.every(. > 1)', nums)).toBe(false)
    expect(await ok('xs.none(. > 5)', nums)).toBe(true)
    expect(await ok('xs.none(. > 2)', nums)).toBe(false)
  })

  it('treats a null predicate result as false and rejects non-booleans', async () => {
    expect(await ok('xs.filter(.ok)', { xs: [{ ok: true }, { ok: null }, {}] })).toEqual([
      { ok: true },
    ])
    expect(await fails('xs.filter(x => y)', { xs: [1], y: 1 })).toBe('TYPE_ERROR')
  })

  it('flatMap flattens list results one level', async () => {
    expect(await ok('xs.flatMap(x => [x, x])', { xs: [1, 2] })).toEqual([1, 1, 2, 2])
    expect(await ok('xs.flatMap(x => x)', { xs: [[1], 2, [[3]]] })).toEqual([1, 2, [3]])
    const small = bonsai({ limits: { maxListLength: 3 } })
    expect(await both('xs.flatMap(x => [x, x])', { xs: [1, 2] }, small)).toEqual({
      error: 'LIST_LIMIT',
    })
    expect(await both('xs.flatMap(x => x)', { xs: [1, 2, 3, 4] }, small)).toEqual({
      error: 'LIST_LIMIT',
    })
  })

  it('groupBy groups by string, number, or boolean keys', async () => {
    expect(await ok('xs.groupBy(. % 2 == 0)', { xs: [1, 2, 3] })).toEqual({
      false: [1, 3],
      true: [2],
    })
    expect(await ok('xs.groupBy(.k)', { xs: [{ k: 'toString' }, { k: 1 }] })).toEqual({
      toString: [{ k: 'toString' }],
      1: [{ k: 1 }],
    })
    expect(await fails('xs.groupBy(.k)', { xs: [{ k: null }] })).toBe('TYPE_ERROR')
    expect(await fails('xs.groupBy(.k)', { xs: [{ k: '__proto__' }] })).toBe('BLOCKED_PROPERTY')
  })

  it('names the failing item in lambda errors', () => {
    expect(() => env.evaluateSync('xs.map(. + 1)', { xs: [1, 'a'] })).toThrow(/at item 1/u)
  })
})

describe('async higher-order functions', () => {
  // The same host function, declared sync in one environment and async in the
  // other: the async variants of the higher-order functions must agree.
  const syncEnv = bonsai({
    functions: { id: fn({ params: [t.any()], returns: t.any(), run: (x) => x }) },
  })
  const asyncEnv = bonsai({
    functions: {
      id: fn({
        params: [t.any()],
        returns: t.any(),
        async: true,
        run: async (x) => {
          await Promise.resolve()
          return x
        },
      }),
    },
  })

  const cases: [string, Record<string, unknown>][] = [
    ['xs.map(x => id(x * 2))', { xs: [3, 1, 2] }],
    ['xs.filter(x => id(x > 1))', { xs: [3, 1, 2] }],
    ['xs.find(x => id(x < 3))', { xs: [3, 1, 2] }],
    ['xs.find(x => id(x > 9))', { xs: [3, 1, 2] }],
    ['xs.find(x => id(x == null))', { xs: [1, undefined] }],
    ['xs.findIndex(x => id(x == 2))', { xs: [3, 1, 2] }],
    ['xs.findIndex(x => id(x == 9))', { xs: [3, 1, 2] }],
    ['xs.some(x => id(x > 2))', { xs: [3, 1, 2] }],
    ['xs.some(x => id(x > 5))', { xs: [3, 1, 2] }],
    ['xs.every(x => id(x > 0))', { xs: [3, 1, 2] }],
    ['xs.every(x => id(x > 1))', { xs: [3, 1, 2] }],
    ['xs.none(x => id(x > 5))', { xs: [3, 1, 2] }],
    ['xs.none(x => id(x > 2))', { xs: [3, 1, 2] }],
    ['xs.flatMap(x => id([x, x]))', { xs: [1, 2] }],
    ['xs.flatMap(x => id(x))', { xs: [[1], 2] }],
    ['xs.sortBy(x => id(-x))', { xs: [3, 1, 2] }],
    ['xs.sortBy(x => id(x), "desc")', { xs: [3, 1, 2] }],
    ['xs.groupBy(x => id(x % 2 == 0))', { xs: [3, 1, 2] }],
    ['xs.count(x => id(x > 1))', { xs: [3, 1, 2] }],
    ['xs.reduce((acc, x) => acc + id(x), 0)', { xs: [3, 1, 2] }],
    ['xs.map((x, i) => id(i))', { xs: ['a', 'b'] }],
    ['xs.filter(x => id(x))', { xs: [1] }],
    ['xs.groupBy(x => id(x))', { xs: [null] }],
    ['xs.map(x => id(x) + 1)', { xs: [1, 'a'] }],
  ]

  for (const [source, context] of cases) {
    it(source, async () => {
      const expected = capture(() => syncEnv.evaluateSync(source, context))
      expect(asyncEnv.compile(source).async).toBe(true)
      expect(await captureAsync(() => asyncEnv.evaluate(source, context))).toEqual(expected)
    })
  }

  it('rejects evaluateSync for an async lambda body', () => {
    expect(capture(() => asyncEnv.evaluateSync('xs.map(x => id(x))', { xs: [1] }))).toEqual({
      error: 'ASYNC_IN_SYNC',
    })
  })

  it('bounds async flatMap by the list limit', async () => {
    const small = asyncEnv.extend({ limits: { maxListLength: 3 } })
    expect(
      await captureAsync(() => small.evaluate('xs.flatMap(x => id([x, x]))', { xs: [1, 2] })),
    ).toEqual({ error: 'LIST_LIMIT' })
    expect(
      await captureAsync(() => small.evaluate('xs.flatMap(x => id(x))', { xs: [1, 2, 3, 4] })),
    ).toEqual({ error: 'LIST_LIMIT' })
  })

  it('stops calling the lambda once the result is known', async () => {
    const seen: unknown[] = []
    const tracking = bonsai({
      functions: {
        check: fn({
          params: [t.number()],
          returns: t.boolean(),
          async: true,
          run: async (x) => {
            await Promise.resolve()
            seen.push(x)
            return x > 1
          },
        }),
      },
    })
    expect(await tracking.evaluate('xs.some(x => check(x))', { xs: [1, 2, 3] })).toBe(true)
    expect(seen).toEqual([1, 2])
  })
})

describe('map functions', () => {
  it('lists keys, values, and entries of own properties', async () => {
    expect(await ok('keys({ a: 1, b: 2 })')).toEqual(['a', 'b'])
    expect(await ok('values({ a: 1, b: null })')).toEqual([1, null])
    expect(await ok('entries({ a: 1 })')).toEqual([{ key: 'a', value: 1 }])
    expect(await ok('values(m)', { m: { a: undefined } })).toEqual([null])
    expect(await ok('entries(m)', { m: { a: undefined } })).toEqual([{ key: 'a', value: null }])
    const inherited = Object.create({ hidden: 1 }) as Record<string, unknown>
    inherited.own = 2
    expect(await ok('keys(m)', { m: inherited })).toEqual(['own'])
  })

  it('bounds keys() by the list limit', async () => {
    const small = bonsai({ limits: { maxListLength: 1 } })
    expect(await both('keys(m)', { m: { a: 1, b: 2 } }, small)).toEqual({ error: 'LIST_LIMIT' })
  })

  it('names the kind of any value', async () => {
    const context = { n: null, d: new Date(0), f: () => 1 }
    expect(await ok('type(n)', context)).toBe('null')
    expect(await ok('type(true)')).toBe('boolean')
    expect(await ok('type(1)')).toBe('number')
    expect(await ok('type("a")')).toBe('string')
    expect(await ok('type([])')).toBe('list')
    expect(await ok('type({})')).toBe('map')
    expect(await ok('type(d)', context)).toBe('timestamp')
    expect(await ok('type(hours(1))')).toBe('duration')
    expect(await ok('type(f)', context)).toBe('opaque')
  })

  it('infers value types for values(), entries(), and flat()', () => {
    const typed = bonsai({
      variables: {
        r: t.record(t.boolean()),
        nested: t.list(t.union(t.list(t.number()), t.string())),
        plain: t.list(t.list(t.number())),
      },
      strict: false,
    })
    expect(typed.compile('entries(r)').type).toEqual(
      t.list(t.object({ key: t.string(), value: t.boolean() })),
    )
    expect(typed.compile('values({})').type).toEqual(t.list(t.any()))
    expect(typed.compile('flat(nested)').type).toEqual(t.list(t.union(t.number(), t.string())))
    expect(typed.compile('flat(plain)').type).toEqual(t.list(t.number()))
    expect(typed.compile('flat(x)').type).toEqual(t.list(t.any()))
  })
})

describe('time functions', () => {
  const at = new Date('2024-03-10T15:04:05.678Z')
  const ctx = { at }

  it('reads now() once per evaluation from the clock', async () => {
    let calls = 0
    const clocked = bonsai({
      clock: () => {
        calls++
        return new Date(0)
      },
    })
    expect(await both('now() == now()', {}, clocked)).toEqual({ value: true })
    expect(calls).toBe(2)
  })

  it('builds timestamps from text, epoch milliseconds, and timestamps', async () => {
    expect(await ok('timestamp("2024-01-01T00:00:00Z")')).toEqual({
      iso: '2024-01-01T00:00:00.000Z',
    })
    expect(await ok('timestamp(0)')).toEqual({ iso: '1970-01-01T00:00:00.000Z' })
    expect(await ok('timestamp(at)', ctx)).toEqual({ iso: at.toISOString() })
    expect(await fails('timestamp(1e20)')).toBe('INVALID_ARGUMENT')
    expect(await fails('timestamp("yesterday")')).toBe('INVALID_ARGUMENT')
  })

  it('builds durations and converts them to numbers', async () => {
    expect(await ok('weeks(1)')).toEqual({ duration: 'P7D' })
    expect(await ok('minutes(1) == seconds(60)')).toBe(true)
    expect(await ok('milliseconds(5)')).toEqual({ duration: 'PT0.005S' })
    expect(await ok('inDays(hours(36))')).toBe(1.5)
    expect(await ok('inHours(days(1))')).toBe(24)
    expect(await ok('inMinutes(hours(1))')).toBe(60)
    expect(await ok('inSeconds(minutes(1))')).toBe(60)
    expect(await ok('inMilliseconds(seconds(1))')).toBe(1000)
    expect(await fails('days(1e308)')).toBe('NON_FINITE')
  })

  it('reads calendar fields in UTC and in a time zone', async () => {
    expect(
      await ok('[year(at), month(at), day(at), hour(at), minute(at), second(at)]', ctx),
    ).toEqual([2024, 3, 10, 15, 4, 5])
    expect(await ok('dayOfWeek(at)', ctx)).toBe(7)
    expect(await ok('hour(at, "America/New_York")', ctx)).toBe(11)
    expect(await ok('month(at, z)', { at, z: null })).toBe(3)
    expect(await fails('hour(at, "Mars/Olympus")', ctx)).toBe('INVALID_ARGUMENT')
  })

  it('finds the start of days, months, and years', async () => {
    expect(await ok('startOfDay(at)', ctx)).toEqual({ iso: '2024-03-10T00:00:00.000Z' })
    expect(await ok('startOfMonth(at)', ctx)).toEqual({ iso: '2024-03-01T00:00:00.000Z' })
    expect(await ok('startOfYear(at)', ctx)).toEqual({ iso: '2024-01-01T00:00:00.000Z' })
    expect(await ok('startOfDay(at, "Europe/Berlin")', ctx)).toEqual({
      iso: '2024-03-09T23:00:00.000Z',
    })
  })

  it('adds calendar days, months, and years', async () => {
    expect(await ok('addDays(at, 1)', ctx)).toEqual({ iso: '2024-03-11T15:04:05.678Z' })
    expect(await ok('addMonths(t, 1)', { t: new Date('2024-01-31T00:00:00Z') })).toEqual({
      iso: '2024-02-29T00:00:00.000Z',
    })
    expect(await ok('addMonths(t, -2)', { t: new Date('2024-01-15T00:00:00Z') })).toEqual({
      iso: '2023-11-15T00:00:00.000Z',
    })
    expect(await ok('addYears(t, 1)', { t: new Date('2024-02-29T00:00:00Z') })).toEqual({
      iso: '2025-02-28T00:00:00.000Z',
    })
    // Across the US DST change, adding a day keeps the wall-clock time.
    expect(
      await ok('addDays(t, 1, "America/New_York")', { t: new Date('2024-03-09T17:00:00Z') }),
    ).toEqual({ iso: '2024-03-10T16:00:00.000Z' })
    expect(await fails('addDays(at, 1.5)', ctx)).toBe('INVALID_ARGUMENT')
    expect(await fails('addMonths(at, 1.5)', ctx)).toBe('INVALID_ARGUMENT')
    expect(await fails('addYears(at, 0.5)', ctx)).toBe('INVALID_ARGUMENT')
    expect(await fails('addDays(at, 1e9)', ctx)).toBe('INVALID_ARGUMENT')
  })

  it('formats timestamps with every token', async () => {
    const pattern = "yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h a mm m ss s SSS 'literal' ''"
    expect(await ok(`formatDate(at, "${pattern}")`, ctx)).toBe(
      "2024 24 March Mar 03 3 10 10 Sunday Sun 15 15 03 3 PM 04 4 05 5 678 literal '",
    )
    expect(await ok('formatDate(t, "h a")', { t: new Date('2024-01-01T00:30:00Z') })).toBe('12 AM')
    expect(await ok('formatDate(at, "HH:mm", "Asia/Tokyo")', ctx)).toBe('00:04')
    expect(await fails('formatDate(at, "YYYY")', ctx)).toBe('CHECK')
    expect(await fails('formatDate(at, p)', { at, p: 'YYYY' })).toBe('INVALID_ARGUMENT')
    expect(await fails('formatDate(t, "yyyy")', { t: new Date(Number.NaN) })).toBe(
      'INVALID_ARGUMENT',
    )
  })
})
