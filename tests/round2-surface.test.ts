import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BonsaiError,
  bonsai,
  fn,
  parse,
  print,
  t,
  withContext,
  type BinaryOperator,
  type Explanation,
  type PartialData,
  type PartialResult,
  type UnaryOperator,
} from '../src/index.js'

/** What JSON.stringify makes of a value, parsed back. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const caught = (run: () => unknown): BonsaiError => {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiError) return error
    throw error
  }
  throw new Error('expected a Bonsai error')
}

describe('errors have one JSON form', () => {
  const env = bonsai()

  it('serializes a thrown error with its code, message, span, and position', () => {
    const error = caught(() => env.evaluateSync('1 / (n - 1)', { n: 1 }))
    expect(json(error)).toEqual({
      name: 'BonsaiRuntimeError',
      code: 'DIVISION_BY_ZERO',
      message: 'Division by zero',
      span: { start: error.span?.start, end: error.span?.end },
      position: { line: 1, column: 1 },
    })
    expect(JSON.stringify(error)).not.toContain('source')
  })

  it('serializes an error the same way in an explanation and a partial result', () => {
    const thrown = json(caught(() => env.evaluateSync('1 / (n - 1)', { n: 1 })))
    const explained = json(env.explainSync('1 / (n - 1)', { n: 1 })) as { error: unknown }
    const partial = json(env.compile('1 / (n - 1)').partial({ n: 1 })) as { error: unknown }
    expect(explained.error).toEqual(thrown)
    expect(partial.error).toEqual(thrown)
  })

  it('adds the limit of a limit error and the findings of a check error', () => {
    const limit = json(caught(() => env.evaluateSync('[1, 2, 3].map(. * 2)', {}, { maxSteps: 1 })))
    expect(limit).toMatchObject({ code: 'STEP_LIMIT', limit: 'maxSteps' })
    const typed = bonsai({ variables: { a: t.number() } })
    const check = json(caught(() => typed.compile('b')))
    expect(check).toMatchObject({
      code: 'CHECK',
      diagnostics: [{ code: 'UNKNOWN_VARIABLE', start: 0, end: 1 }],
    })
    expect(JSON.stringify(check)).not.toContain('formatted')
  })
})

describe('parse() without an environment', () => {
  it('parses as env.parse does, with the same limits and validation', () => {
    const source = 'user.age >= 18 && user.plan == "pro"'
    expect(parse(source)).toEqual(bonsai().parse(source))
    expect(print(parse('a+b*2'))).toBe('a + b * 2')
    expect(() => parse('((1))', { maxDepth: 2 })).toThrow(
      expect.objectContaining({ code: 'TOO_DEEP', limit: 'maxDepth' }),
    )
    expect(() => parse('1 +')).toThrow(expect.objectContaining({ code: 'SYNTAX' }))
    expect(() => parse('1', { maxSteps: 1 } as never)).toThrow(TypeError)
    expect(() => parse('1', { maxNodes: 0 })).toThrow(RangeError)
    expect(() => parse(1 as never)).toThrow(TypeError)
  })
})

describe('results are frozen to match their read-only types', () => {
  it('freezes check results, their diagnostics, and partial results', () => {
    const env = bonsai({ variables: { a: t.number() } })
    const failed = env.check('b')
    expect(Object.isFrozen(failed)).toBe(true)
    expect(Object.isFrozen(failed.diagnostics)).toBe(true)
    expect(Object.isFrozen(failed.diagnostics[0])).toBe(true)
    expect(failed.diagnostics[0]?.formatted).toContain('b')
    const passed = env.check('a + 1')
    expect(Object.isFrozen(passed)).toBe(true)
    expect(passed.ok && passed.program.evaluateSync({ a: 1 })).toBe(2)
    expect(Object.isFrozen(env.check('1 +').diagnostics)).toBe(true)
    expect(Object.isFrozen(env.compile('a + 1').partial({ a: 1 }))).toBe(true)
    expect(Object.isFrozen(env.compile('1 / (a - 1)').partial({ a: 1 }))).toBe(true)
  })
})

describe('the surface says what users of partial evaluation and explain need', () => {
  it('gives a residual the async flag and result type of its program', () => {
    const env = bonsai({ variables: { a: t.number(), b: t.number() } })
    const program = env.compile('a + b > 1', { expect: t.boolean() })
    const result = program.partial({ a: 1 })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.async).toBe(false)
    expect(result.type).toEqual(program.type)
  })

  it('exports PartialData and defaults the result type parameters', () => {
    expectTypeOf<PartialData<{ a: { b: number } }>>().toEqualTypeOf<{
      a?: { b?: number | undefined } | undefined
    }>()
    const env = bonsai()
    const loose: PartialResult = env.compile('x').partial({})
    const explained: Explanation = env.explainSync('1')
    expect(loose.status).toBe('residual')
    expect(explained.ok).toBe(true)
  })

  it('types trace operators and describes call functions', () => {
    const env = bonsai({
      functions: {
        who: withContext<{ user: string }>()({
          params: [],
          returns: t.string(),
          call: true,
          run: (call) => call.context.user,
        }),
        cheap: fn({ params: [], returns: t.number(), cost: 2, run: () => 1 }),
      },
    })
    expect(env.evaluateSync('who()', { user: 'ada' })).toBe('ada')
    expect(env.describeFunction('who')).toMatchObject({ call: true })
    expect(env.describeFunction('cheap')).toMatchObject({ call: false, cost: 2 })
    expect(env.describeFunction('toUpperCase')).toMatchObject({ call: false })
    const trace = env.explainSync('1 + 2').trace
    expectTypeOf(trace.operator).toEqualTypeOf<BinaryOperator | UnaryOperator | undefined>()
    expect(trace.operator).toBe('+')
  })
})
