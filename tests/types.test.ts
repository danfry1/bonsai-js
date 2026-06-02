import { describe, it, expect } from 'vitest'
import type { NumberLiteral, BinaryExpression } from '../src/types.js'

describe('types', () => {
  it('should allow constructing a NumberLiteral node', () => {
    const node: NumberLiteral = {
      type: 'NumberLiteral',
      value: 42,
      start: 0,
      end: 2,
    }
    expect(node.type).toBe('NumberLiteral')
    expect(node.value).toBe(42)
  })

  it('should allow constructing a BinaryExpression node', () => {
    const node: BinaryExpression = {
      type: 'BinaryExpression',
      operator: '+',
      left: { type: 'NumberLiteral', value: 1, start: 0, end: 1 },
      right: { type: 'NumberLiteral', value: 2, start: 4, end: 5 },
      start: 0,
      end: 5,
    }
    expect(node.operator).toBe('+')
  })
})
