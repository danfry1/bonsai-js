import { describe, expect, it } from 'vitest'
import { BonsaiError, Duration, bonsai, parse, print, t, type Node } from '../src/index.js'
import { analyze } from '../src/check/checker.js'
import { BUILTINS } from '../src/functions/builtins.js'

/** The code of what `run` throws, or `ok`; a raw JavaScript error shows as RAW. */
function outcome(run: () => unknown): string {
  try {
    run()
    return 'ok'
  } catch (error) {
    return error instanceof BonsaiError ? error.code : `RAW:${(error as Error).name}`
  }
}

describe('depth limits stay inside the call stack', () => {
  it('caps maxDepth and maxValueDepth', () => {
    expect(() => bonsai({ limits: { maxDepth: 257 } })).toThrow(RangeError)
    expect(() => bonsai({ limits: { maxValueDepth: 1025 } })).toThrow(RangeError)
    expect(() => bonsai().extend({ limits: { maxDepth: 1000 } })).toThrow(RangeError)
    expect(() => parse('1', { maxDepth: 257 })).toThrow(RangeError)
    expect(() => bonsai({ limits: { maxDepth: 256, maxValueDepth: 1024 } })).not.toThrow()
  })

  // At the cap, the forms that recurse most per level must still pass every stage.
  const shapes: Record<string, (levels: number) => string> = {
    'map chain': (d) => `xs${'.map(.)'.repeat(d)}`,
    'plus chain': (d) => Array<string>(d).fill('a').join(' + '),
    'nested calls': (d) => `${'abs('.repeat(d)}1${')'.repeat(d)}`,
    'nested lambdas': (d) =>
      `xs.map(x0 => ${Array.from({ length: d - 1 }, (_, i) => `xs.map(x${i + 1} => `).join('')}1${')'.repeat(d)}`,
    'nested lists': (d) => `${'['.repeat(d)}1${']'.repeat(d)}`,
    'nested maps': (d) => `${'{a:'.repeat(d)}1${'}'.repeat(d)}`,
    ternaries: (d) => `${Array<string>(d).fill('a > 0 ? 1 :').join(' ')} 2`,
    negations: (d) => `${'!'.repeat(d)}true`,
  }
  for (const [name, make] of Object.entries(shapes)) {
    it(`handles ${name} at maxDepth 256 in every stage`, async () => {
      const env = bonsai({ limits: { maxDepth: 256, maxNodes: 100_000, maxSteps: 0 } })
      // The deepest the parser accepts at the cap.
      let levels = 256
      while (outcome(() => env.parse(make(levels))) === 'TOO_DEEP') levels--
      const source = make(levels)
      const context = { a: 1, xs: [1] }
      const stages: Record<string, string> = {
        parse: outcome(() => parse(source, { maxDepth: 256, maxNodes: 100_000 })),
        print: outcome(() => print(env.parse(source))),
        check: env.check(source).ok ? 'ok' : 'failed',
        evaluateSync: outcome(() => env.evaluateSync(source, context)),
        explainSync: outcome(() => {
          const explanation = env.explainSync(source, context)
          if (!explanation.ok) throw explanation.error
          JSON.stringify(explanation)
          String(explanation)
        }),
        partial: outcome(() => env.partial(source, {}, { unknown: ['a', 'xs'] })),
      }
      try {
        await env.evaluate(source, context)
        stages.evaluate = 'ok'
      } catch (error) {
        stages.evaluate = error instanceof BonsaiError ? error.code : 'RAW'
      }
      for (const [stage, result] of Object.entries(stages)) {
        expect(result.startsWith('RAW'), `${name} ${stage}`).toBe(false)
        expect(result, `${name} ${stage}`).not.toBe('HOST_ERROR')
      }
    })
  }

  it('turns a stack overflow into TOO_DEEP, never a raw RangeError', () => {
    // A hand-built tree deeper than any stack.
    let tree: Node = { type: 'Literal', value: true, start: 0, end: 0 }
    for (let i = 0; i < 200_000; i++)
      tree = { type: 'Unary', operator: '!', operand: tree, start: 0, end: 0 }
    const env = {
      variables: undefined,
      strict: false,
      lookup: (name: string) => BUILTINS.get(name),
      *functionNames() {},
    }
    expect(outcome(() => analyze(tree, env))).toBe('TOO_DEEP')
    expect(() => print(tree)).toThrow(/nests/u)
    expect(() => print(tree)).toThrow(TypeError)
  })

  it('keeps try() from swallowing a stack overflow in host data', () => {
    const deep: Record<string, unknown> = {}
    Object.defineProperty(deep, 'x', {
      enumerable: true,
      get(): never {
        const loop = (): never => loop()
        return loop()
      },
    })
    const result = outcome(() => bonsai().evaluateSync('try(d.x, 0)', { d: deep }))
    expect(result).toBe('TOO_DEEP')
  })
})

describe('host durations are read by their own length', () => {
  class Loud extends Duration {
    override toString(): string {
      return 'HOST TEXT'
    }
  }
  const forged = Object.create(Duration.prototype, { ms: { value: 1e308 } }) as Duration
  const env = bonsai()

  it('formats a Duration subclass with the built-in format, never its own toString', () => {
    const d = new Loud(90 * 60_000)
    expect(env.evaluateSync('`${d}`', { d })).toBe('PT1H30M')
    expect(env.evaluateSync('[d].join(",")', { d })).toBe('PT1H30M')
    expect(env.evaluateSync('d.toString()', { d })).toBe('PT1H30M')
    expect(String(env.explainSync('`${d}`', { d }))).not.toContain('HOST TEXT')
  })

  it('treats a forged Duration as an opaque host value', () => {
    for (const source of ['`${d}`', '[d].join(",")', 'd + d', '[d].max()', '[d].sum()', '-d']) {
      expect(
        outcome(() => env.evaluateSync(source, { d: forged })),
        source,
      ).toBe('TYPE_ERROR')
    }
    expect(env.evaluateSync('d == d', { d: forged })).toBe(true)
    expect(String(env.explainSync('d', { d: forged }))).not.toContain('e+308')
  })
})

describe('check errors stay near the size of the source', () => {
  it('shortens large types in diagnostic messages', () => {
    const fields = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`field${i}`, t.number()]),
    )
    const env = bonsai({ variables: { u: t.object(fields) } })
    const source = `[${Array.from({ length: 2000 }, (_, i) => `u.q${i}`).join(',')}]`
    const result = env.check(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toHaveLength(2000)
    for (const diagnostic of result.diagnostics) expect(diagnostic.message.length).toBeLessThan(200)
    expect(result.diagnostics[0]?.message).toContain('…')
    expect(outcome(() => env.compile(source))).toBe('CHECK')
    try {
      env.compile(source)
    } catch (error) {
      // About 300 bytes per finding (on main, over 1,100 for this schema).
      expect(JSON.stringify(error).length).toBeLessThan(2000 * 400)
    }
  })
})

describe('min, max, and avg take durations as sum does', () => {
  const minute = new Duration(60_000)
  const typed = bonsai({ variables: { d: t.duration(), ds: t.list(t.duration()) } })

  it('orders durations given one by one, as in a list', () => {
    expect(typed.check('max(d, -d)').type).toEqual(t.duration())
    expect(String(typed.evaluateSync('max(d, -d)', { d: minute, ds: [] }))).toBe('PT1M')
    expect(String(typed.evaluateSync('min(d, -d, d * 2)', { d: minute, ds: [] }))).toBe('-PT1M')
    expect(String(bonsai().evaluateSync('max("a", "b")'))).toBe('b')
    expect(outcome(() => typed.compile('max(1, "a")'))).toBe('CHECK')
  })

  it('averages durations', () => {
    expect(typed.check('ds.avg()').type).toEqual(t.optional(t.duration()))
    expect(String(typed.evaluateSync('[d, null, d * 3].avg()', { d: minute, ds: [] }))).toBe('PT2M')
    expect(typed.evaluateSync('ds.avg()', { d: minute, ds: [] })).toBe(null)
    expect(String(bonsai().evaluateSync('xs.avg()', { xs: [minute, minute] }))).toBe('PT1M')
    expect(outcome(() => bonsai().evaluateSync('xs.avg()', { xs: [minute, 1] }))).toBe('TYPE_ERROR')
  })
})

describe('expect means "has at least these fields"', () => {
  it('warns about, and keeps, extra fields of a map literal', () => {
    const env = bonsai()
    const expected = { expect: t.object({ a: t.number() }) }
    const checked = env.check('{ a: 1, b: 2 }', expected)
    expect(checked.ok).toBe(true)
    expect(checked.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['EXPECTED_TYPE', 'warning'],
    ])
    const program = env.compile('{ a: 1, b: 2 }', expected)
    expect(program.evaluateSync()).toEqual({ a: 1, b: 2 })
    expect(outcome(() => env.compile('{ b: 2 }', expected))).toBe('CHECK')
  })
})

describe('checking and parsing guidance', () => {
  const codes = (
    env: {
      check: (source: string) => { diagnostics: readonly { code: string; severity: string }[] }
    },
    source: string,
  ): string[] => env.check(source).diagnostics.map((d) => `${d.code}:${d.severity}`)

  it('checks literal locales and currencies before anything runs', () => {
    const env = bonsai()
    expect(codes(env, 'formatNumber(1, 2, "xx-nope")')).toEqual(['INVALID_ARGUMENT:error'])
    expect(codes(env, '1.formatNumber(2, "zz")')).toEqual(['INVALID_ARGUMENT:error'])
    expect(codes(env, 'formatCurrency(1, "EURO")')).toEqual(['INVALID_ARGUMENT:error'])
    expect(codes(env, 'formatCurrency(1, "EUR", "en-GB")')).toEqual([])
    expect(codes(env, 'formatNumber(1, 2, locale)')).toEqual([])
  })

  it('suggests ** for ^ and != for <>', () => {
    expect(() => parse('2 ^ 3')).toThrow(/use \*\* for powers/u)
    expect(() => parse('a <> b')).toThrow(/use != for "not equal"/u)
  })

  it('warns about an undeclared name one edit from a declared one when not strict', () => {
    const env = bonsai({ variables: { price: t.number(), quantity: t.number() }, strict: false })
    const [warning] = env.check('prise * 2').diagnostics
    expect(warning).toMatchObject({
      code: 'UNKNOWN_VARIABLE',
      severity: 'warning',
      suggestion: 'price',
    })
    expect(codes(env, 'qty * 2')).toEqual([])
    expect(codes(bonsai(), 'prise * 2')).toEqual([])
  })

  it('reads ISO-8601 duration text with duration()', () => {
    const env = bonsai()
    expect(String(env.evaluateSync('duration("PT1H30M")'))).toBe('PT1H30M')
    expect(String(env.evaluateSync('duration("-P2DT0.5S")'))).toBe('-P2DT0.5S')
    expect(env.evaluateSync('duration(hours(36).toString()) == hours(36)')).toBe(true)
    expect(codes(env, 'duration("P1M")')).toEqual(['INVALID_ARGUMENT:error'])
    expect(outcome(() => env.evaluateSync('duration(s)', { s: 'P1Y' }))).toBe('INVALID_ARGUMENT')
    expect(outcome(() => env.evaluateSync('duration(s)', { s: 'PT' }))).toBe('INVALID_ARGUMENT')
  })

  it('says why a side of several kinds cannot be ordered', () => {
    const env = bonsai({ variables: { s: t.optional(t.string()) } })
    expect(env.check('(s ?? 0) > 1').diagnostics[0]?.message).toContain(
      'the left side may be a string or a number',
    )
  })
})

describe('reserved words are never method names', () => {
  it('rejects them at parse, so every parsed tree prints', () => {
    for (const source of [
      'a.not(b)',
      'a.in(b)',
      'a.let(b)',
      'a.null(b)',
      'a?.true()',
      'xs.map(.not(1))',
    ]) {
      expect(
        outcome(() => parse(source)),
        source,
      ).toBe('SYNTAX')
    }
    // Reserved words stay valid property names.
    for (const source of ['a.not', 'a.null', 'a?.true', '{ not: 1 }.not']) {
      expect(print(parse(source)), source).toBe(source)
    }
  })
})
