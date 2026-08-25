import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'

describe('extension environment lifecycle', () => {
  it('supports self-describing transform and function definitions', () => {
    const expr = bonsai<{ offset: number }>()
      .defineTransform({
        name: 'double',
        evaluate: (value) => Number(value) * 2,
        inputType: { kind: 'number' },
        returnType: { kind: 'number' },
        description: 'Double a number',
      })
      .defineFunction({
        name: 'one',
        evaluate: () => 1,
        returnType: { kind: 'number' },
      })
      .defineContextFunction({
        name: 'offset',
        evaluate: (context, value) => context.offset + Number(value),
        returnType: { kind: 'number' },
      })

    expect(expr.evaluateSync('one() |> double', { offset: 0 })).toBe(2)
    expect(expr.evaluateSync('offset(2)', { offset: 3 })).toBe(5)
    expect(expr.getTransformMetadata('double')).toEqual({
      inputType: { kind: 'number' },
      returnType: { kind: 'number' },
      description: 'Double a number',
    })
    expect(expr.getFunctionMetadata('one')).toEqual({ returnType: { kind: 'number' } })
  })

  it('permanently seals every registry mutation while preserving evaluation', () => {
    const expr = bonsai()
      .addFunction('answer', () => 42)
      .seal()

    expect(expr.isSealed()).toBe(true)
    expect(expr.seal()).toBe(expr)
    expect(expr.evaluateSync('answer()')).toBe(42)
    expect(() => expr.addTransform('x', (value) => value)).toThrow(/sealed/u)
    expect(() => expr.defineTransform({ name: 'x', evaluate: (value) => value })).toThrow(/sealed/u)
    expect(() => expr.addFunction('x', () => 1)).toThrow(/sealed/u)
    expect(() => expr.defineFunction({ name: 'x', evaluate: () => 1 })).toThrow(/sealed/u)
    expect(() => expr.addContextFunction('x', () => 1)).toThrow(/sealed/u)
    expect(() => expr.removeTransform('missing')).toThrow(/sealed/u)
    expect(() => expr.removeFunction('answer')).toThrow(/sealed/u)
    expect(() =>
      expr.use((registry) => {
        registry.addFunction('x', () => 1)
      }),
    ).toThrow(/sealed/u)
  })

  it('binds compiled expressions to the registry revision they were compiled against', () => {
    const expr = bonsai().addFunction('value', () => 1)
    const first = expr.compile('value()')

    expr.replaceFunction('value', () => 2)
    const second = expr.compile('value()')

    expect(first.evaluateSync()).toBe(1)
    expect(second.evaluateSync()).toBe(2)
    expect(expr.evaluateSync('value()')).toBe(2)
    expect(second).not.toBe(first)
    expect(expr.compile('value()')).toBe(second)
  })
})
