import { describe, it, expect } from 'vitest'
import { generateCompletions, type CompletionEnv } from '../../src/autocomplete/completions.js'
import type { CursorContext } from '../../src/autocomplete/context.js'

function env(overrides: Partial<CompletionEnv> = {}): CompletionEnv {
  return {
    transforms: [],
    functions: [],
    policy: {},
    ...overrides,
  }
}

describe('generateCompletions', () => {
  describe('top-level-member', () => {
    it('returns property completions for object values', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({ member: { resolvedValue: { name: 'Alice', age: 25 }, resolvedType: 'object' } }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('name')
      expect(labels).toContain('age')
    })

    it('returns method completions for string type', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({ member: { resolvedType: 'string' } }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('trim')
      expect(labels).toContain('toUpperCase')
    })

    it('returns method completions for array type', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({ member: { resolvedType: 'array' } }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('filter')
      expect(labels).toContain('map')
    })

    it('filters by prefix', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: 'to', precedingTokens: [] }
      const result = generateCompletions(ctx, env({ member: { resolvedType: 'string' } }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('toLowerCase')
      expect(labels).toContain('toUpperCase')
      expect(labels).not.toContain('trim')
    })

    it('returns properties and methods together', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({
        member: { resolvedValue: { length: 5 }, resolvedType: 'object' },
      }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('length')
    })
  })

  describe('lambda-start', () => {
    it('returns element property completions', () => {
      const ctx: CursorContext = { kind: 'lambda-start', prefix: '', depth: 1 }
      const result = generateCompletions(ctx, env({ lambda: { elementProperties: ['name', 'age', 'email'] } }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('name')
      expect(labels).toContain('age')
      expect(labels).toContain('email')
      expect(labels).toHaveLength(3)
    })

    it('filters element properties by prefix', () => {
      const ctx: CursorContext = { kind: 'lambda-start', prefix: 'na', depth: 1 }
      const result = generateCompletions(ctx, env({ lambda: { elementProperties: ['name', 'age', 'email'] } }))
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe('name')
    })
  })

  describe('pipe-transform', () => {
    it('returns registered transforms', () => {
      const ctx: CursorContext = { kind: 'pipe-transform', prefix: '' }
      const result = generateCompletions(ctx, env({ transforms: ['trim', 'upper', 'lower'] }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('trim')
      expect(labels).toContain('upper')
      expect(labels).toContain('lower')
    })

    it('filters transforms by prefix', () => {
      const ctx: CursorContext = { kind: 'pipe-transform', prefix: 'up' }
      const result = generateCompletions(ctx, env({ transforms: ['trim', 'upper', 'lower'] }))
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe('upper')
    })
  })

  describe('identifier', () => {
    it('returns context keys, functions, and keywords', () => {
      const ctx: CursorContext = { kind: 'identifier', prefix: '' }
      const result = generateCompletions(ctx, env({
        identifier: { contextKeys: ['user', 'items'], contextValues: { user: {}, items: [] } },
        functions: ['sum', 'avg'],
      }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('user')
      expect(labels).toContain('items')
      expect(labels).toContain('sum')
      expect(labels).toContain('true')
      expect(labels).toContain('false')
    })

    it('filters identifiers by prefix', () => {
      const ctx: CursorContext = { kind: 'identifier', prefix: 'us' }
      const result = generateCompletions(ctx, env({
        identifier: { contextKeys: ['user', 'items'], contextValues: { user: {}, items: [] } },
      }))
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe('user')
    })
  })

  describe('none', () => {
    it('returns empty array', () => {
      const ctx: CursorContext = { kind: 'none' }
      const result = generateCompletions(ctx, env())
      expect(result).toEqual([])
    })
  })

  describe('security filtering', () => {
    it('blocks __proto__', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({
        member: { resolvedValue: { __proto__: {}, name: 'x' }, resolvedType: 'object' },
      }))
      const labels = result.map(c => c.label)
      expect(labels).not.toContain('__proto__')
      expect(labels).toContain('name')
    })

    it('blocks constructor and prototype', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({
        member: { resolvedValue: { constructor: null, prototype: null, safe: 1 }, resolvedType: 'object' },
      }))
      const labels = result.map(c => c.label)
      expect(labels).not.toContain('constructor')
      expect(labels).not.toContain('prototype')
      expect(labels).toContain('safe')
    })

    it('respects allowedProperties policy', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({
        member: { resolvedValue: { name: 'x', secret: 'y' }, resolvedType: 'object' },
        policy: { allowedProperties: new Set(['name']) },
      }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('name')
      expect(labels).not.toContain('secret')
    })

    it('respects deniedProperties policy', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({
        member: { resolvedValue: { name: 'x', secret: 'y' }, resolvedType: 'object' },
        policy: { deniedProperties: new Set(['secret']) },
      }))
      const labels = result.map(c => c.label)
      expect(labels).toContain('name')
      expect(labels).not.toContain('secret')
    })

    it('allowedProperties does NOT block method completions', () => {
      const ctx: CursorContext = { kind: 'top-level-member', prefix: '', precedingTokens: [] }
      const result = generateCompletions(ctx, env({
        member: { resolvedValue: 'hello', resolvedType: 'string' },
        policy: { allowedProperties: new Set(['name']) },
      }))
      const methods = result.filter(c => c.kind === 'method')
      expect(methods.length).toBeGreaterThan(0)
      expect(methods.map(c => c.label)).toContain('trim')
      expect(methods.map(c => c.label)).toContain('toLowerCase')
    })
  })
})
