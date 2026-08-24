import { describe, expect, it } from 'vitest'
import { evaluateAsync } from '../src/evaluator-async.js'
import { ExecutionContext, SecurityPolicy } from '../src/execution-context.js'
import { parse } from '../src/parser.js'
import type { Bindings } from '../src/plugins.js'
import {
  bonsai,
  BonsaiReferenceError,
  BonsaiSecurityError,
  type BonsaiTypeError,
} from '../src/index.js'
import type { RegisteredFunction } from '../src/types.js'

const EMPTY_BINDINGS: Bindings = {
  transforms: Object.create(null) as Record<string, (...args: unknown[]) => unknown>,
  functions: Object.create(null) as Record<string, RegisteredFunction>,
}

function runParsed(
  expression: string,
  context: Record<string, unknown> = {},
  source?: string,
  policy = new SecurityPolicy(),
): Promise<unknown> {
  return evaluateAsync(
    parse(expression, policy),
    context,
    EMPTY_BINDINGS,
    new ExecutionContext(policy),
    source,
  )
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected evaluation to reject')
}

describe('async evaluator direct contract', () => {
  it.each([
    ['number literal', '42', {}, 42],
    ['string literal', '"value"', {}, 'value'],
    ['boolean literal', 'false', {}, false],
    ['null literal', 'null', {}, null],
    ['undefined literal', 'undefined', {}, undefined],
    ['identifier', 'value', { value: 7 }, 7],
    ['unary expression', '!value', { value: 0 }, true],
    ['binary expression', 'left + right', { left: 2, right: 5 }, 7],
    ['conditional expression', 'test ? yes : no', { test: false, yes: 1, no: 2 }, 2],
    ['named member', 'value.name', { value: { name: 'bonsai' } }, 'bonsai'],
    ['computed member', 'value[key]', { value: { name: 'bonsai' }, key: 'name' }, 'bonsai'],
    ['optional member', 'value?.name', { value: { name: 'bonsai' } }, 'bonsai'],
    ['optional short circuit', 'value?.name', { value: null }, undefined],
    ['array and spread', '[0, ...values, 3]', { values: [1, 2] }, [0, 1, 2, 3]],
    ['object and computed key', '{ [key]: value }', { key: 'answer', value: 42 }, { answer: 42 }],
    ['template literal', '`a:${value}:z`', { value: 5 }, 'a:5:z'],
  ])('evaluates a parsed %s AST', async (_label, expression, context, expected) => {
    await expect(runParsed(expression, context)).resolves.toEqual(expected)
  })

  it('treats root identifiers as identifiers under an empty property allow-list', async () => {
    const policy = new SecurityPolicy({ allowedProperties: [] })
    await expect(runParsed('root', { root: 1 }, undefined, policy)).resolves.toBe(1)
  })

  it('lets object literal keys bypass member allow-lists', async () => {
    const policy = new SecurityPolicy({ allowedProperties: [] })
    await expect(runParsed('{ visible: 1 }', {}, undefined, policy)).resolves.toEqual({
      visible: 1,
    })
  })

  it('evaluates function, context-function, method, and both transform forms', async () => {
    const expr = bonsai()
    expr.addFunction('add', (a: unknown, b: unknown) => Promise.resolve(Number(a) + Number(b)))
    expr.addContextFunction('read', (ctx, key) => Promise.resolve(ctx[String(key)]))
    expr.addTransform('double', (value: unknown) => Promise.resolve(Number(value) * 2))
    expr.addTransform('plus', (value: unknown, amount: unknown) =>
      Promise.resolve(Number(value) + Number(amount)),
    )

    await expect(expr.evaluate('add(2, 3)')).resolves.toBe(5)
    await expect(expr.evaluate('read("answer")', { answer: 42 })).resolves.toBe(42)
    await expect(expr.evaluate('"bonsai".slice(1, 4)')).resolves.toBe('ons')
    await expect(expr.evaluate('[1].concat([2])')).resolves.toEqual([1, 2])
    await expect(expr.evaluate('3 |> double')).resolves.toBe(6)
    await expect(expr.evaluate('3 |> plus(4)')).resolves.toBe(7)
  })

  it('expands spread arguments and enforces the post-expansion argument limit', async () => {
    const expr = bonsai({ maxCallArguments: 2 })
    expr.addFunction('args', (...args: unknown[]) => Promise.resolve(args))

    await expect(expr.evaluate('args(...values)', { values: [1, 2] })).resolves.toEqual([1, 2])
    await expect(expr.evaluate('args(0, ...values)', { values: [1, 2] })).rejects.toMatchObject({
      name: 'BonsaiSecurityError',
      code: 'MAX_CALL_ARGUMENTS',
    })
  })

  it('pins exact computed-name and object-key error identities', async () => {
    const methodError = await rejected(bonsai().evaluate('"x"[key]()', { key: {} }))
    expect(methodError).toMatchObject({
      name: 'BonsaiTypeError',
      transform: 'computed method name',
    })

    const objectError = await rejected(bonsai().evaluate('{ [key]: 1 }', { key: {} }))
    expect(objectError).toMatchObject({
      name: 'BonsaiTypeError',
      transform: 'computed object key',
    })
  })

  it('covers the internal non-callable and invalid-transform guards', async () => {
    await expect(runParsed('(1 + 2)()')).rejects.toThrow('Cannot call non-identifier')
    await expect(runParsed('5 |> 42')).rejects.toThrow('Invalid transform expression')
  })

  it('short-circuits computed optional members before evaluating their key', async () => {
    await expect(runParsed('value?.[missing()]', { value: null })).resolves.toBeUndefined()
  })

  it('balances compound depth across array siblings', async () => {
    const policy = new SecurityPolicy({ maxDepth: 2 })
    await expect(runParsed('[1 + 1, 2 + 2]', {}, undefined, policy)).resolves.toEqual([2, 4])
  })

  it('pre-charges linear native methods against the async step budget', async () => {
    const expr = bonsai({ maxSteps: 5 })
    await expect(
      expr.evaluate('values.slice()', { values: Array.from({ length: 10 }) }),
    ).rejects.toMatchObject({
      name: 'BonsaiSecurityError',
      code: 'MAX_STEPS',
    })
  })

  it('disarms a retained async lambda when its evaluation finishes', async () => {
    let retained: ((value: unknown) => unknown) | undefined
    const expr = bonsai({ maxSteps: 10 })
    expr.addFunction('retain', (callback: unknown) => {
      retained = callback as (value: unknown) => unknown
      return Promise.resolve('retained')
    })

    await expect(expr.evaluate('retain(.value)')).resolves.toBe('retained')
    expect(retained).toBeTypeOf('function')
    for (let index = 0; index < 20; index++) {
      expect(retained?.({ value: index })).toBe(index)
    }
  })

  it.each([
    ['number', 'values.map(. > 0 ? 2 : 3)', [2]],
    ['string', 'values.map(. > 0 ? "yes" : "no")', ['yes']],
    ['boolean', 'values.map(. > 0 ? true : false)', [true]],
    ['null', 'values.map(. > 0 ? null : 1)', [null]],
    ['undefined', 'values.map(. > 0 ? undefined : 1)', [undefined]],
    ['outer identifier', 'values.map(. > 0 ? external : 1)', [8]],
  ])('evaluates a %s leaf inside an async lambda body', async (_, expression, expected) => {
    await expect(bonsai().evaluate(expression, { values: [1], external: 8 })).resolves.toEqual(
      expected,
    )
  })

  it('evaluates nested named, computed, and optional members from a lambda item', async () => {
    const values = [{ child: { value: 2 } }, { child: null }]
    await expect(bonsai().evaluate('values.map(.child.value)', { values })).resolves.toEqual([
      2,
      undefined,
    ])
    await expect(
      bonsai().evaluate('values.map(.child?.[key])', { values, key: 'value' }),
    ).resolves.toEqual([2, undefined])
  })
})

describe('async evaluator error locations', () => {
  const sites: [label: string, expression: string, context: Record<string, unknown>][] = [
    ['member', 'value.__proto__', { value: {} }],
    ['optional member', 'value?.__proto__', { value: {} }],
    ['pipe', '5 |> missing', {}],
    ['method', 'value.missing()', { value: 'x' }],
    ['function', 'missing()', {}],
  ]

  it.each(sites)(
    'attaches the exact supplied source for a %s failure',
    async (_, expression, ctx) => {
      const error = await rejected(runParsed(expression, ctx, expression))
      expect(error).toBeInstanceOf(Error)
      expect(
        (error as BonsaiReferenceError | BonsaiSecurityError | BonsaiTypeError).location,
      ).toEqual({
        source: expression,
        start: expect.any(Number),
        end: expect.any(Number),
      })
    },
  )

  it.each(sites)(
    'does not invent a location without source for a %s failure',
    async (_, expr, ctx) => {
      const error = await rejected(runParsed(expr, ctx))
      expect(error).toBeInstanceOf(
        expr.includes('__proto__') || expr.includes('.missing')
          ? BonsaiSecurityError
          : BonsaiReferenceError,
      )
      expect(
        (error as BonsaiReferenceError | BonsaiSecurityError | BonsaiTypeError).location,
      ).toBeUndefined()
    },
  )

  it.each(sites)('treats empty source as absent for a %s failure', async (_, expression, ctx) => {
    const error = await rejected(runParsed(expression, ctx, ''))
    expect(error).toBeInstanceOf(
      expression.includes('__proto__') || expression.includes('.missing')
        ? BonsaiSecurityError
        : BonsaiReferenceError,
    )
    expect(
      (error as BonsaiReferenceError | BonsaiSecurityError | BonsaiTypeError).location,
    ).toBeUndefined()
  })
})

describe('async sparse-array method semantics', () => {
  it('preserves holes in map and skips them in filter/flatMap/some/every', async () => {
    const sparse = new Array<unknown>(3)
    sparse[1] = 4
    const expr = bonsai()

    const mapped = (await expr.evaluate('values.map(. ?? undefined)', {
      values: sparse,
    })) as unknown[]
    expect(mapped).toHaveLength(3)
    expect([0, 1, 2].map((index) => Object.hasOwn(mapped, index))).toEqual([false, true, false])
    expect(mapped[1]).toBe(4)

    await expect(
      expr.evaluate('values.filter(. == undefined)', { values: sparse }),
    ).resolves.toEqual([])
    await expect(
      expr.evaluate('values.flatMap(. == undefined ? [9] : [4])', { values: sparse }),
    ).resolves.toEqual([4])
    await expect(expr.evaluate('values.some(. == undefined)', { values: sparse })).resolves.toBe(
      false,
    )
    await expect(expr.evaluate('values.every(. != undefined)', { values: sparse })).resolves.toBe(
      true,
    )
  })

  it('matches find/findIndex hole visitation and end boundaries', async () => {
    const expr = bonsai()
    const sparse = new Array<unknown>(2)
    sparse[1] = 4

    await expect(
      expr.evaluate('values.findIndex(. == undefined)', { values: sparse }),
    ).resolves.toBe(0)
    await expect(expr.evaluate('values.find(. == 4)', { values: sparse })).resolves.toBe(4)
    await expect(expr.evaluate('values.findIndex(. == undefined)', { values: [1] })).resolves.toBe(
      -1,
    )
  })
})
