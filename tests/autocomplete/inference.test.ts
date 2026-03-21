import { describe, it, expect } from 'vitest'
import { inferType, resolvePropertyChain, inferElementType, inferMethodReturnType, enumerateProperties } from '../../src/autocomplete/inference.js'

describe('inferType', () => {
  it('infers string', () => expect(inferType('hello')).toBe('string'))
  it('infers number', () => expect(inferType(42)).toBe('number'))
  it('infers boolean', () => expect(inferType(true)).toBe('boolean'))
  it('infers array', () => expect(inferType([1, 2])).toBe('array'))
  it('infers object', () => expect(inferType({ a: 1 })).toBe('object'))
  it('infers null', () => expect(inferType(null)).toBe('null'))
  it('infers undefined', () => expect(inferType(undefined)).toBe('undefined'))
})

describe('resolvePropertyChain', () => {
  const ctx = { user: { address: { city: 'London' } }, items: [1, 2, 3] }

  it('resolves single property', () => {
    const result = resolvePropertyChain(ctx, ['user'])
    expect(result).toEqual({ found: true, value: { address: { city: 'London' } } })
  })
  it('resolves nested chain', () => {
    const result = resolvePropertyChain(ctx, ['user', 'address'])
    expect(result).toEqual({ found: true, value: { city: 'London' } })
  })
  it('returns not-found for missing property', () => {
    const result = resolvePropertyChain(ctx, ['user', 'missing'])
    expect(result).toEqual({ found: false, reason: 'not-found' })
  })
  it('returns not-object for null in chain', () => {
    const result = resolvePropertyChain({ x: null }, ['x', 'y'])
    expect(result).toEqual({ found: false, reason: 'not-object' })
  })
  it('returns array for array property', () => {
    const result = resolvePropertyChain(ctx, ['items'])
    expect(result).toEqual({ found: true, value: [1, 2, 3] })
  })
  it('blocks __proto__ traversal', () => {
    const result = resolvePropertyChain(ctx, ['user', '__proto__'])
    expect(result).toEqual({ found: false, reason: 'blocked' })
  })
  it('blocks constructor traversal', () => {
    const result = resolvePropertyChain(ctx, ['user', 'constructor'])
    expect(result).toEqual({ found: false, reason: 'blocked' })
  })
  it('resolves property with value undefined (found: true)', () => {
    const result = resolvePropertyChain({ x: undefined }, ['x'])
    expect(result).toEqual({ found: true, value: undefined })
  })

  describe('with policy', () => {
    it('respects deniedProperties', () => {
      const result = resolvePropertyChain(
        { user: { name: 'Alice', secret: 'pw' } },
        ['user', 'secret'],
        { deniedProperties: new Set(['secret']) },
      )
      expect(result).toEqual({ found: false, reason: 'blocked' })
    })
    it('respects allowedProperties', () => {
      const result = resolvePropertyChain(
        { user: { name: 'Alice', secret: 'pw' } },
        ['user', 'secret'],
        { allowedProperties: new Set(['name', 'user']) },
      )
      expect(result).toEqual({ found: false, reason: 'blocked' })
    })
    it('allows when in allowedProperties', () => {
      const result = resolvePropertyChain(
        { user: { name: 'Alice' } },
        ['user', 'name'],
        { allowedProperties: new Set(['user', 'name']) },
      )
      expect(result).toEqual({ found: true, value: 'Alice' })
    })
  })
})

describe('inferElementType', () => {
  it('object array', () => {
    const result = inferElementType([{ name: 'Alice', age: 25 }])
    expect(result.type).toBe('object')
    expect(result.properties).toContain('name')
    expect(result.properties).toContain('age')
    if (result.type === 'object') {
      expect(result.value).toEqual({ name: 'Alice', age: 25 })
    }
  })
  it('number array', () => {
    const result = inferElementType([1, 2, 3])
    expect(result.type).toBe('number')
    if (result.type === 'number') {
      expect(result.value).toBe(1)
    }
  })
  it('empty array', () => {
    expect(inferElementType([]).type).toBe('unknown')
  })
  it('skips null first element', () => {
    expect(inferElementType([null, { x: 1 }]).type).toBe('object')
  })
  it('string array', () => {
    const result = inferElementType(['a', 'b'])
    expect(result.type).toBe('string')
    if (result.type === 'string') {
      expect(result.value).toBe('a')
    }
  })
  it('boolean array', () => {
    const result = inferElementType([true, false])
    expect(result.type).toBe('boolean')
  })
})

describe('inferMethodReturnType', () => {
  it('string.trim returns string', () => {
    expect(inferMethodReturnType('string', 'trim')).toBe('string')
  })
  it('string.split returns array', () => {
    expect(inferMethodReturnType('string', 'split')).toBe('array')
  })
  it('array.filter returns array', () => {
    expect(inferMethodReturnType('array', 'filter')).toBe('array')
  })
  it('array.join returns string', () => {
    expect(inferMethodReturnType('array', 'join')).toBe('string')
  })
  it('unknown method returns unknown', () => {
    expect(inferMethodReturnType('string', 'nonexistent')).toBe('unknown')
  })
})

describe('enumerateProperties', () => {
  it('enumerates object keys', () => {
    expect(enumerateProperties({ a: 1, b: 2 })).toEqual(['a', 'b'])
  })
  it('returns empty for null', () => {
    expect(enumerateProperties(null)).toEqual([])
  })
  it('returns empty for primitive', () => {
    expect(enumerateProperties(42)).toEqual([])
  })
})
