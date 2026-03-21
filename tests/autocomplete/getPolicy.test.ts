import { describe, it, expect } from 'vitest'
import { bonsai } from '../../src/index.js'

describe('getPolicy', () => {
  it('returns empty policy for default instance', () => {
    const expr = bonsai()
    const policy = expr.getPolicy()
    expect(policy).toEqual({})
  })

  it('returns allowedProperties as readonly array', () => {
    const expr = bonsai({ allowedProperties: ['age', 'name'] })
    const policy = expr.getPolicy()
    expect(policy.allowedProperties).toEqual(['age', 'name'])
  })

  it('returns deniedProperties as readonly array', () => {
    const expr = bonsai({ deniedProperties: ['secret'] })
    const policy = expr.getPolicy()
    expect(policy.deniedProperties).toEqual(['secret'])
  })

  it('returns both when both configured', () => {
    const expr = bonsai({ allowedProperties: ['age'], deniedProperties: ['secret'] })
    const policy = expr.getPolicy()
    expect(policy.allowedProperties).toEqual(['age'])
    expect(policy.deniedProperties).toEqual(['secret'])
  })

  it('is a function on the instance', () => {
    const expr = bonsai()
    expect(typeof expr.getPolicy).toBe('function')
  })
})
