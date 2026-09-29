import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'
import { compileRegex, searchRegex } from '../src/runtime/regex.js'

const steps = (pattern: string, text: string): { result: boolean; charged: number } => {
  let charged = 0
  const result = searchRegex(compileRegex(pattern), text, (n) => {
    charged += n
  })
  return { result, charged }
}

describe('regex literal prefilter', () => {
  const line = `2026-09-28T12:34:56Z INFO request_id=abc ${'lorem ipsum '.repeat(80)} status=200 end`

  it('rules out a text that holds none of the required literals, for a fraction of the steps', () => {
    const full = steps('(?:ERROR|WARN|FATAL)[a-z]', line)
    expect(full.result).toBe(false)
    // A full NFA scan costs at least one step per character.
    expect(full.charged).toBeLessThan(line.length / 4)
  })

  it('still scans when a required literal is present', () => {
    expect(steps('status=2[0-9]{2}', line).result).toBe(true)
    expect(steps('status=5[0-9]{2}', line).result).toBe(false)
    expect(steps('request_id=[a-z]+ ', line).result).toBe(true)
  })

  it('jumps to the literal prefix and keeps assertions correct at the new position', () => {
    const text = `afoo${'z'.repeat(40)} foo`
    expect(steps('\\bfoo', text).result).toBe(true)
    expect(steps('\\bfoo\\b', `xfoo${'-'.repeat(40)}afoo`).result).toBe(false)
    expect(steps('\\Bfoo', ` foo${'-'.repeat(40)}xfoo`).result).toBe(true)
  })

  it('treats cased literals under (?i) as unknown and caseless ones as literals', () => {
    expect(compileRegex('(?i)error').required).toBeUndefined()
    expect(compileRegex('(?i)=500').required).toEqual(['=500'])
    expect(steps('(?i)ERROR', `${'x'.repeat(40)}error`).result).toBe(true)
  })

  it('agrees with RegExp on required alternatives and repeats', () => {
    for (const [pattern, text] of [
      ['(ab|cd)+e', `${'x'.repeat(40)}abcde`],
      ['(ab|cd)+e', `${'x'.repeat(40)}abcd`],
      ['a(?:bc)d', `${'y'.repeat(40)}abcd`],
      ['x{2}yz', `${'w'.repeat(40)}xxyz`],
      ['😀+ok', `${'w'.repeat(40)}😀😀ok`],
    ] as const) {
      expect(steps(pattern, text).result, pattern).toBe(new RegExp(pattern, 'u').test(text))
    }
  })

  it('charges the same steps on every run', () => {
    const env = bonsai()
    const minimal = (): number => {
      let low = 1
      let high = 1_000_000
      while (low < high) {
        const mid = (low + high) >>> 1
        try {
          env.evaluateSync('matches(s, "status=5[0-9]{2}")', { s: line }, { maxSteps: mid })
          high = mid
        } catch {
          low = mid + 1
        }
      }
      return low
    }
    expect(minimal()).toBe(minimal())
  })
})

describe('member reads', () => {
  const env = bonsai()

  it('reads plain objects inline and everything else through the general path', () => {
    expect(
      env.evaluateSync('xs.map(.a)', {
        xs: [{ a: 1 }, Object.assign(Object.create(null), { a: 2 })],
      }),
    ).toEqual([1, 2])
    expect(() => env.evaluateSync('xs.map(.size)', { xs: [new Map()] })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })

  it('reads member chains of plain objects', () => {
    expect(env.evaluateSync('a.b.missing', { a: { b: {} } })).toBeNull()
    expect(
      env.evaluateSync('a.b.c', { a: Object.assign(Object.create(null), { b: { c: 2 } }) }),
    ).toBe(2)
    expect(() => env.evaluateSync('a.m.size', { a: { m: new Map() } })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })
})
