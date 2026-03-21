import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import { tokenize, parse, compile, type ASTNode } from '../src/index.js'
import * as stdlib from '../src/stdlib/index.js'

describe('public API stability', () => {
  it('exposes only the documented runtime root exports', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BonsaiReferenceError',
      'BonsaiSecurityError',
      'BonsaiTypeError',
      'ExpressionError',
      'bonsai',
      'compile',
      'evaluateExpression',
      'formatBonsaiError',
      'formatError',
      'parse',
      'tokenize',
    ])
  })

  it('exposes only the documented stdlib exports', () => {
    expect(Object.keys(stdlib).sort()).toEqual([
      'all',
      'arrays',
      'dates',
      'math',
      'strings',
      'types',
    ])
  })

  it('exports ASTNode type for consumer use', () => {
    const expr = api.bonsai()
    const result = expr.validate('1 + 2')
    expect(result.valid).toBe(true)
    if (result.valid) {
      const ast: ASTNode = result.ast!
      expect(ast.type).toBe('BinaryExpression')
    }
  })
})

describe('autocomplete API stability', () => {
  it('exports createAutocomplete from bonsai-js/autocomplete', async () => {
    const mod = await import('../src/autocomplete/index.js')
    expect(typeof mod.createAutocomplete).toBe('function')
  })

  it('getPolicy exists on instance', () => {
    const expr = api.bonsai()
    expect(typeof expr.getPolicy).toBe('function')
    const policy = expr.getPolicy()
    expect(policy).toBeDefined()
  })

  it('autocomplete instance has complete and setContext', async () => {
    const { createAutocomplete } = await import('../src/autocomplete/index.js')
    const expr = api.bonsai()
    const ac = createAutocomplete(expr, {})
    expect(typeof ac.complete).toBe('function')
    expect(typeof ac.setContext).toBe('function')
  })
})

describe('advanced API exports', () => {
  it('exports tokenize', () => {
    const tokens = tokenize('1 + 2')
    expect(tokens).toBeInstanceOf(Array)
    expect(tokens.length).toBe(4) // 1, +, 2, EOF
    expect(tokens[0]).toMatchObject({ type: 'Number', value: '1' })
  })

  it('exports parse', () => {
    const ast = parse('1 + 2')
    expect(ast.type).toBe('BinaryExpression')
  })

  it('exports compile', () => {
    const ast = parse('1 + 2')
    const optimized = compile(ast)
    expect(optimized.type).toBe('NumberLiteral')
    expect((optimized as unknown as { value: number }).value).toBe(3)
  })
})
