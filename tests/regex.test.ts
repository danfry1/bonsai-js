// The linear-time regular expression engine behind matches(): supported
// syntax agrees with JavaScript's RegExp (u flag), and unsupported or invalid
// syntax fails with a RegexSyntaxError naming the problem.
import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'
import { RegexSyntaxError, compileRegex, searchRegex } from '../src/runtime/regex.js'

function test(pattern: string, text: string): boolean {
  return searchRegex(compileRegex(pattern), text, () => undefined)
}

/** Asserts the engine agrees with JavaScript's RegExp (u flag) on each text. */
function agrees(pattern: string, texts: readonly string[], flags = 'u'): void {
  const source = pattern.startsWith('(?i)') ? pattern.slice(4) : pattern
  const native = new RegExp(source, pattern.startsWith('(?i)') ? `${flags}i` : flags)
  for (const text of texts) {
    expect(test(pattern, text), `/${pattern}/ on ${JSON.stringify(text)}`).toBe(native.test(text))
  }
}

function syntaxError(pattern: string): string {
  try {
    compileRegex(pattern)
  } catch (error) {
    expect(error).toBeInstanceOf(RegexSyntaxError)
    return (error as Error).message
  }
  throw new Error(`/${pattern}/ compiled`)
}

describe('escapes', () => {
  it('matches character class escapes', () => {
    agrees('^\\d+$', ['123', '12a', ''])
    agrees('^\\D+$', ['abc', 'a1'])
    agrees('^\\w+$', ['a_Z9', 'a-b'])
    agrees('^\\W$', ['-', 'a'])
    agrees('^\\s+$', [' \t\n\r\f\v', '\u00a0\u2028\u2029\ufeff\u3000\u1680', 'a '])
    agrees('^\\S$', ['a', ' '])
  })

  it('matches control and literal escapes', () => {
    agrees('a\\nb', ['a\nb', 'anb'])
    agrees('\\t\\r\\f\\v', ['\t\r\f\v', 'trfv'])
    agrees('\\0', ['\0', '0'])
    agrees('\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\\\/', ['.*+?()[]{}|^$\\/', 'x'])
    // More lenient than the u flag: an escaped non-letter is always that character.
    expect(test('^\\-\\"$', '-"')).toBe(true)
  })

  it('matches hex and unicode escapes', () => {
    agrees('\\x41', ['A', 'a'])
    agrees('\\u0041\\u00e9', ['A\u00e9', 'Ae'])
    agrees('\\u{1F600}', ['\u{1F600}', '\ud83d'])
    agrees('\\u{41}', ['A', 'B'])
    agrees('^.$', ['\u{1F600}', 'ab'])
    agrees('^[\\u{1F600}-\\u{1F64F}]$', ['\u{1F601}', 'a'])
  })

  it('rejects invalid escapes', () => {
    expect(syntaxError('\\x4')).toMatch(/Invalid \\x escape/u)
    expect(syntaxError('\\xZZ')).toMatch(/Invalid \\x escape/u)
    expect(syntaxError('\\u12')).toMatch(/Invalid \\u escape/u)
    expect(syntaxError('\\u{}')).toMatch(/Invalid \\u\{\.\.\.\} escape/u)
    expect(syntaxError('\\u{110000}')).toMatch(/Invalid \\u\{\.\.\.\} escape/u)
    expect(syntaxError('\\u{12')).toMatch(/Invalid \\u\{\.\.\.\} escape/u)
    expect(syntaxError('\\u{1234567}')).toMatch(/Invalid \\u\{\.\.\.\} escape/u)
    expect(syntaxError('\\q')).toMatch(/Unknown escape \\q/u)
    expect(syntaxError('a\\')).toMatch(/Trailing backslash/u)
  })

  it('rejects backreferences', () => {
    expect(syntaxError('(a)\\1')).toMatch(/Backreferences are not supported/u)
    expect(syntaxError('\\01')).toMatch(/Backreferences are not supported/u)
    expect(syntaxError('[\\9]')).toMatch(/Backreferences are not supported/u)
  })

  it('reports the position of an error, counting a (?i) prefix', () => {
    expect(syntaxError('ab\\q')).toMatch(/at position 4 in \/ab\\q\//u)
    expect(syntaxError('(?i)ab\\q')).toMatch(/at position 8/u)
  })
})

describe('classes', () => {
  it('matches sets, ranges, negations, and escapes inside classes', () => {
    agrees('^[abc]+$', ['abcba', 'abd'])
    agrees('^[a-c0-2]+$', ['a1c2', 'd'])
    agrees('^[^a-c]$', ['d', 'b'])
    agrees('^[\\d\\s]+$', ['1 2', '1a'])
    agrees('^[\\w-]+$', ['a-b_c', 'a b'])
    agrees('^[-a]+$', ['-a', 'b'])
    agrees('^[a-]+$', ['-a', 'b'])
    agrees('[\\b]', ['\b', 'b'])
    agrees('^[\\]]$', [']', '['])
    agrees('^[\\x41-\\x43]$', ['B', 'D'])
    agrees('^[.]$', ['.', 'a'])
  })

  it('matches nothing with [] and anything with [^]', () => {
    agrees('[]', ['', 'a'])
    agrees('^[^]$', ['a', '\n'])
  })

  it('rejects malformed classes', () => {
    expect(syntaxError('[z-a]')).toMatch(/Invalid class range/u)
    expect(syntaxError('[\\d-z]')).toMatch(/Invalid class range/u)
    expect(syntaxError('[a-\\w]')).toMatch(/Invalid class range/u)
    expect(syntaxError('[abc')).toMatch(/Missing \]/u)
    expect(syntaxError('[\\B]')).toMatch(/\\B in a class/u)
  })

  it('matches ranges case-insensitively with (?i)', () => {
    agrees('(?i)^[a-c]+$', ['ABC', 'abc', 'aBd'])
    agrees('(?i)^[A-C]+$', ['abc', 'ABC', 'D'])
    agrees('(?i)^[^a]$', ['A', 'a', 'b'])
    agrees('(?i)^hello$', ['HeLLo', 'help'])
    agrees('(?i)^[x]$', ['X', 'y'])
    agrees('(?i)^\\x41$', ['a', 'b'])
  })
})

describe('quantifiers', () => {
  it('matches every quantifier form, greedy and lazy', () => {
    agrees('^a*$', ['', 'aaa', 'ab'])
    agrees('^a+$', ['', 'a', 'aa'])
    agrees('^a?b$', ['b', 'ab', 'aab'])
    agrees('^a{2}$', ['a', 'aa', 'aaa'])
    agrees('^a{2,}$', ['a', 'aa', 'aaaa'])
    agrees('^a{1,3}$', ['', 'aaa', 'aaaa'])
    agrees('^a{0,0}b$', ['b', 'ab'])
    agrees('^a*?b+?c??$', ['aabbc', 'b', 'ac'])
    agrees('^a{2,3}?$', ['aa', 'aaaa'])
    agrees('^(ab)+$', ['abab', 'aba'])
    agrees('^(?:a|bc){2}$', ['abc', 'bca', 'bcbcx'])
  })

  it('rejects quantifiers with nothing to repeat', () => {
    expect(syntaxError('*a')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('a|+')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('(?)')).toMatch(/Lookaround and named groups/u)
    expect(syntaxError('a**')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('a{2}{3}')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('a+?+')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('^*')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('\\b+')).toMatch(/Nothing to repeat/u)
  })

  it('rejects invalid and oversized repeat counts', () => {
    expect(syntaxError('a{3,2}')).toMatch(/Invalid repeat range/u)
    expect(syntaxError('a{1001}')).toMatch(/Repeat count above 1000/u)
    expect(syntaxError('a{1,1001}')).toMatch(/Repeat count above 1000/u)
    expect(test('^a{1000}$', 'a'.repeat(1000))).toBe(true)
  })

  it('requires braces to be escaped when they are not a quantifier', () => {
    expect(syntaxError('a{')).toMatch(/Escape "\{"/u)
    expect(syntaxError('a{x}')).toMatch(/Escape "\{"/u)
    expect(syntaxError('}')).toMatch(/Escape "\}"/u)
    expect(syntaxError(']')).toMatch(/Escape "\]"/u)
  })
})

describe('groups and alternation', () => {
  it('matches alternations of any width, including empty branches', () => {
    agrees('^(cat|dog|bird)$', ['dog', 'bird', 'cow'])
    agrees('^(a|)$', ['', 'a', 'b'])
    agrees('^(|a)b$', ['b', 'ab'])
    agrees('a||b', ['', 'x'])
    agrees('^()$', ['', 'a'])
  })

  it('rejects unbalanced groups, lookaround, named groups, and inline flags', () => {
    expect(syntaxError('(a')).toMatch(/Missing \)/u)
    expect(syntaxError('a)')).toMatch(/Unmatched \)/u)
    expect(syntaxError(')')).toMatch(/Unmatched \)/u)
    expect(syntaxError('(?=a)')).toMatch(/Lookaround and named groups/u)
    expect(syntaxError('(?!a)')).toMatch(/Lookaround and named groups/u)
    expect(syntaxError('(?<=a)b')).toMatch(/Lookaround and named groups/u)
    expect(syntaxError('(?<name>a)')).toMatch(/Lookaround and named groups/u)
    expect(syntaxError('a(?i)b')).toMatch(/only supported at the start/u)
  })
})

describe('assertions', () => {
  it('anchors at the start and end of the text', () => {
    agrees('^ab', ['abc', 'cab'])
    agrees('ab$', ['cab', 'abc'])
    agrees('^$', ['', 'a'])
    agrees('a^b', ['ab', 'a^b'])
    agrees('(^a|b$)', ['ax', 'xb', 'xa'])
  })

  it('matches word boundaries and non-boundaries', () => {
    agrees('\\bcat\\b', ['a cat!', 'concat', 'cat'])
    agrees('\\Bcat', ['concat', 'cat'])
    agrees('cat\\B', ['cats', 'cat.'])
    agrees('^\\b$', [''])
    agrees('\\B', ['', ' ', 'a'])
  })
})

describe('limits', () => {
  it('rejects groups nested deeper than 100', () => {
    expect(test(`${'('.repeat(100)}a${')'.repeat(100)}`, 'a')).toBe(true)
    expect(syntaxError(`${'('.repeat(101)}a${')'.repeat(101)}`)).toMatch(
      /Groups nest deeper than 100/u,
    )
  })

  it('rejects patterns whose program would be too large', () => {
    expect(syntaxError('(a{1000}){1000}')).toMatch(/Pattern is too complex/u)
    expect(syntaxError('((a|b|c){100}){100}')).toMatch(/Pattern is too complex/u)
    expect(syntaxError('(\\b{1000}){10}')).toMatch(/Nothing to repeat/u)
    expect(syntaxError('(){1000}(){1000}(){1000}(){1000}(){1000}(){1000}')).toMatch(
      /Pattern is too complex/u,
    )
    expect(syntaxError('(a{0,1000})'.repeat(3))).toMatch(/Pattern is too complex/u)
    expect(test('(a|b){100}', 'ab'.repeat(50))).toBe(true)
  })

  it('charges work in proportion to live threads', () => {
    let charged = 0
    // A class (not a literal) at the end, so no literal prefilter can rule the text out.
    searchRegex(compileRegex('(a|b|c|d|e|f|g|h|i)*[yz]'), 'abcdefghi'.repeat(10), (n) => {
      charged += n
    })
    expect(charged).toBeGreaterThan(90)
  })

  it('stops a match through the evaluation step budget', () => {
    const env = bonsai({ limits: { maxSteps: 1000 } })
    expect(() => env.evaluateSync('matches(s, "(a|b)*[cd]")', { s: 'ab'.repeat(5000) })).toThrow(
      /step limit/u,
    )
  })
})
