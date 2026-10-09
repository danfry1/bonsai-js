import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import { BonsaiError, bonsai, fn, forEachChild, t, withContext, type Node } from '../src/index.js'

function spanOf(run: () => unknown): { start: number; end: number } | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiError) return error.span
    throw error
  }
  throw new Error('expected an error')
}

describe('strict by default with declared variables', () => {
  const variables = { user: t.object({ age: t.number() }) }

  it('keeps an explicit choice through extend(), and defaults when variables arrive', () => {
    expect(bonsai({ strict: false }).extend({ variables }).strict).toBe(false)
    expect(bonsai().extend({ variables }).strict).toBe(true)
    expect(bonsai({ variables }).extend({ strict: false }).strict).toBe(false)
  })
})

describe('option validation', () => {
  it('takes cacheSize as a top-level option', () => {
    let calls = 0
    const counting = fn({ params: [], returns: t.number(), run: () => ++calls })
    const uncached = bonsai({ cacheSize: 0, functions: { counting } })
    expect(uncached.evaluateSync('counting()')).toBe(1)
    expect(() => bonsai({ limits: { cacheSize: 0 } } as never)).toThrow(TypeError)
    expect(() => bonsai({ cacheSize: -1 })).toThrow(RangeError)
  })

  it('rejects unknown option and limit keys', () => {
    expect(() => bonsai({ limit: { maxSteps: 1 } } as never)).toThrow(
      /Unknown options key "limit"/u,
    )
    expect(() => bonsai({ limits: { maxStep: 1 } } as never)).toThrow(
      /Unknown limits key "maxStep"/u,
    )
    expect(() => bonsai({ strict: 'yes' } as never)).toThrow(TypeError)
    expect(() => bonsai({ clock: new Date() } as never)).toThrow(TypeError)
    expect(() => bonsai(null as never)).toThrow(TypeError)
  })

  it('uses TypeError for a wrong type and RangeError for an out-of-range number', () => {
    expect(() => bonsai({ limits: { maxSteps: '10' } } as never)).toThrow(TypeError)
    expect(() => bonsai({ limits: { maxSteps: -1 } })).toThrow(RangeError)
    expect(() => bonsai({ limits: { maxDepth: 0 } })).toThrow(
      expect.objectContaining({
        name: 'RangeError',
        message: expect.stringMatching(/positive integer/u),
      }),
    )
    expect(() => bonsai({ limits: { maxSteps: 1.5 } })).toThrow(RangeError)
    expect(() => bonsai({ limits: { timeout: -0.5 } })).toThrow(RangeError)
    expect(() => bonsai({ limits: { timeout: Number.NaN } })).toThrow(RangeError)
    expect(() => bonsai({ limits: { timeout: Number.POSITIVE_INFINITY } })).toThrow(RangeError)
    // A timeout is milliseconds, fractions included: only 0 turns it off.
    expect(bonsai({ limits: { timeout: 1.5 } }).evaluateSync('1 + 1')).toBe(2)
    expect(bonsai({ limits: { maxSteps: 0, timeout: 0 } }).evaluateSync('1 + 1')).toBe(2)
  })

  it('validates declared variable types deeply', () => {
    const untyped: unknown = { variables: { x: 'number' } }
    expect(() => bonsai(untyped as never)).toThrow(/Variable "x" must be a type built with t/u)
    expect(() => bonsai({ variables: { x: t.list({ kind: 'nope' } as never) } })).toThrow(
      /unsupported type kind "nope"/u,
    )
    expect(() => bonsai({ variables: { x: t.object({ a: undefined as never }) } })).toThrow(
      /Variable "x".fields.a/u,
    )
  })

  it('validates host function declarations when they are made', () => {
    expect(() => fn({ params: 'x' as never, returns: t.number(), run: () => 1 })).toThrow(
      /needs a params array/u,
    )
    expect(() =>
      fn({ params: [], returns: t.number(), run: () => 1, return: t.number() } as never),
    ).toThrow(/unknown option "return"/u)
    expect(() =>
      fn({
        params: [t.optional(t.number())],
        required: 2,
        returns: t.number(),
        run: () => 1,
      }),
    ).toThrow(RangeError)
    expect(() => fn({ params: [], returns: 'number', run: () => 1 } as never)).toThrow(
      /returns type of fn\(\)/u,
    )
    expect(() => withContext()({ params: [], returns: t.number() } as never)).toThrow(
      /needs a run function/u,
    )
  })

  it('validates hand-written host functions passed to bonsai()', () => {
    expect(() => bonsai({ functions: { f: { params: 'x', run: () => 1 } as never } })).toThrow(
      /Function "f" needs a params array/u,
    )
    expect(() => bonsai({ libraries: [{ functions: {} }] } as never)).toThrow(/needs a name/u)
  })
})

describe('programs are immutable', () => {
  it('freezes the syntax tree, types, warnings, and references', () => {
    const env = bonsai({ variables: { user: t.object({ age: t.number() }) } })
    const program = env.compile('user.age > 18')
    expect(Object.isFrozen(program.ast)).toBe(true)
    expect(Object.isFrozen(program.references.variables)).toBe(true)
    const ast = program.ast as { operator?: string; left?: { name?: string } }
    expect(() => {
      ast.operator = '<'
    }).toThrow(TypeError)
    expect(() => {
      ;(program.references.variables as string[]).push('x')
    }).toThrow(TypeError)
    // Compiled after the attempted changes: still the original rule.
    expect(program.evaluateSync({ user: { age: 30 } })).toBe(true)
  })

  it('leaves env.parse() output to the caller', () => {
    expect(Object.isFrozen(bonsai().parse('1 + 2'))).toBe(false)
  })
})

describe('public exports', () => {
  it('exports forEachChild as a value and no internal helpers', () => {
    const names: string[] = []
    forEachChild(bonsai().parse('f(a, [b])'), (child: Node) => {
      names.push(child.type)
    })
    expect(names).toEqual(['Variable', 'List'])
    for (const internal of ['fieldOf', 'nonNull', 'widen', 'typeKey', 'unionOf', 'overlaps']) {
      expect(internal in api).toBe(false)
    }
  })
})

describe('syntax', () => {
  const env = bonsai()

  it('accepts separators in radix literals, including next to e and E', () => {
    expect(env.evaluateSync('0xde_ad_be_ef')).toBe(0xdeadbeef)
    expect(env.evaluateSync('0x1_e + 0xe_1 + 0xDE_AD')).toBe(0x1e + 0xe1 + 0xdead)
    expect(env.evaluateSync('0b1_0 + 0o7_7')).toBe(2 + 63)
  })

  it('rejects misplaced radix separators with the literal span', () => {
    expect(spanOf(() => env.parse('0x_1'))).toEqual({ start: 0, end: 4 })
    expect(spanOf(() => env.parse('0x1__2'))).toEqual({ start: 0, end: 6 })
    expect(spanOf(() => env.parse('1 + 0x1_'))).toEqual({ start: 4, end: 8 })
  })

  it('keeps every syntax error span inside the source, and never zero-width after input', () => {
    for (const source of ['{', 'user.', 'user.plan ==', 'let', 'let x', 'f(', '[1,', '"\\u{12']) {
      const span = spanOf(() => env.parse(source))
      expect(span, source).toBeDefined()
      expect(span?.end, source).toBeLessThanOrEqual(source.length)
      expect(span?.start, source).toBeLessThanOrEqual(span?.end as number)
      if (source.length > 0) expect(span?.end, source).toBeGreaterThan(span?.start as number)
    }
    expect(spanOf(() => env.parse('let'))).toEqual({ start: 0, end: 3 })
    expect(spanOf(() => env.parse('"\\u{12"'))).toEqual({ start: 1, end: 7 })
  })

  it('does not look past the escape for the closing brace of \\u{...}', () => {
    expect(spanOf(() => env.parse('"\\u{12" + {a: 1}'))).toEqual({ start: 1, end: 7 })
  })

  it('allows a leading byte order mark', () => {
    expect(env.evaluateSync('﻿1 + 2')).toBe(3)
  })

  it('names invisible characters by code point', () => {
    expect(() => env.parse('1 + 2')).toThrow(/Unexpected character U\+00A0/u)
    expect(() => env.parse('a​')).toThrow(/U\+200B/u)
    expect(() => env.parse('1 + 2﻿')).toThrow(/U\+FEFF/u)
    expect(spanOf(() => env.parse('1 + \u{1F600}'))).toEqual({ start: 4, end: 6 })
  })
})
