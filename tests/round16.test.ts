import { describe, expect, it } from 'vitest'
import { bonsai, fn, parse, print, t } from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

describe('round 16 notes', () => {
  it('accepts \\u{...} escapes with leading zeros, as JavaScript does', () => {
    const env = bonsai()
    expect(env.evaluateSync('"\\u{00000041}"', {})).toBe('A')
    expect(env.evaluateSync(`"\\u{${'0'.repeat(40)}10FFFF}"`, {})).toBe('\u{10FFFF}')
    expect(env.evaluateSync('"\\u{0}"', {})).toBe('\0')
    for (const source of ['"\\u{110000}"', '"\\u{000110000}"', '"\\u{}"', '"\\u{0041"']) {
      expect(() => env.evaluateSync(source, {})).toThrow(/Invalid \\u\{\.\.\.\} escape/u)
    }
  })

  it('prints a leading-zero escape back to text that parses to the same value', () => {
    const source = '"\\u{00000041}" + "\\u{0001F600}"'
    const printed = print(parse(source))
    expect(print(parse(printed))).toBe(printed)
    expect(bonsai().evaluateSync(printed, {})).toBe(bonsai().evaluateSync(source, {}))
    const service = createLanguageService(bonsai())
    expect(service.diagnostics(source)).toEqual([])
    for (let offset = 0; offset <= source.length; offset++) {
      expect(() => service.complete(source, offset)).not.toThrow()
      expect(() => service.hover(source, offset)).not.toThrow()
    }
  })

  it('says how to write an exponent when a number literal is read as `1.e3`', () => {
    const check = bonsai().check('1.e3')
    expect(check.ok).toBe(false)
    expect(check.diagnostics[0]?.code).toBe('TYPE_ERROR')
    expect(check.diagnostics[0]?.message).toBe(
      'Cannot read property "e3" of 1; for an exponent write 1e3 or 1.0e3',
    )
    expect(bonsai().check('2.E10').diagnostics[0]?.message).toContain('write 2E10 or 2.0E10')
    // Only an exponent-shaped name on a number literal gets the hint.
    expect(bonsai().check('1.foo').diagnostics[0]?.message).toBe('Cannot read property "foo" of 1')
  })

  it('checks a spread into a host function against every parameter (documented)', () => {
    const env = bonsai({
      functions: {
        pad: fn({
          params: [t.string(), t.optional(t.number())],
          required: 1,
          returns: t.string(),
          run: (s, n) => s + String(n),
        }),
      },
    })
    expect(env.check('pad(...["a", 2])').diagnostics[0]?.code).toBe('NO_OVERLOAD')
    expect(env.evaluateSync('pad("a", 2)', {})).toBe('a2')
  })
})
