import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/evaluator.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { BonsaiReferenceError } from '../src/errors.js'
import type { TransformFn, FunctionFn } from '../src/types.js'

function run(
  expr: string,
  context: Record<string, unknown> = {},
  transforms: Record<string, TransformFn> = {},
  functions: Record<string, FunctionFn> = {},
) {
  const ast = parse(expr)
  const ec = new ExecutionContext(new SecurityPolicy())
  const mappedFunctions = Object.fromEntries(
    Object.entries(functions).map(([key, value]) => {
      return [key, {allowCtx:false, f: value}];
    })
  )
  return evaluate(ast, context, transforms, mappedFunctions, ec)
}

describe('evaluator - functions', () => {
  it('should call registered functions', () => {
    const result = run('isAdult()', {}, {}, {
      isAdult: () => true,
    })
    expect(result).toBe(true)
  })

  it('should pass arguments to functions', () => {
    const result = run('max(3, 7)', {}, {}, {
      max: (a: unknown, b: unknown) => Math.max(a as number, b as number),
    })
    expect(result).toBe(7)
  })

  it('should throw on unknown function with suggestion', () => {
    expect(() => run('isAdlt()', {}, {}, { isAdult: () => true }))
      .toThrow()
  })
})

describe('evaluator - transforms (pipes)', () => {
  it('should apply simple transform', () => {
    const result = run('name |> upper', { name: 'dan' }, {
      upper: (val: unknown) => (val as string).toUpperCase(),
    })
    expect(result).toBe('DAN')
  })

  it('should chain transforms', () => {
    const result = run('name |> trim |> upper', { name: '  dan  ' }, {
      trim: (val: unknown) => (val as string).trim(),
      upper: (val: unknown) => (val as string).toUpperCase(),
    })
    expect(result).toBe('DAN')
  })

  it('should pass extra args to transforms', () => {
    const result = run('value |> default("N/A")', { value: null }, {
      default: (val: unknown, fallback: unknown) => val ?? fallback,
    })
    expect(result).toBe('N/A')
  })

  it('should throw BonsaiReferenceError on unknown transform with suggestion', () => {
    expect(() => run('x |> uper', { x: 'hi' }, { upper: (v: unknown) => v }))
      .toThrow(BonsaiReferenceError)
  })
})

describe('evaluator - lambda accessors in transforms', () => {
  it('should support filter with lambda accessor', () => {
    const users = [
      { name: 'Alice', active: true },
      { name: 'Bob', active: false },
      { name: 'Charlie', active: true },
    ]
    const result = run('users |> filter(.active)', { users }, {
      filter: (val: unknown, predicate: unknown) => {
        return (val as unknown[]).filter(item => {
          if (typeof predicate === 'function') return predicate(item)
          return false
        })
      },
    })
    expect(result).toEqual([
      { name: 'Alice', active: true },
      { name: 'Charlie', active: true },
    ])
  })
})
