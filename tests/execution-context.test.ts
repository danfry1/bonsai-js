import { describe, it, expect } from 'vitest'
import { SecurityPolicy, ExecutionContext, BLOCKED_PROPERTIES } from '../src/execution-context.js'
import { BonsaiSecurityError } from '../src/errors.js'

describe('SecurityPolicy', () => {
  it('normalizes arrays to sets', () => {
    const policy = new SecurityPolicy({
      allowedProperties: ['name', 'age'],
      deniedProperties: ['secret'],
    })
    const ec = new ExecutionContext(policy)
    expect(() => {
      ec.checkNameAccess('name', 'member')
    }).not.toThrow()
    expect(() => {
      ec.checkNameAccess('secret', 'member')
    }).toThrow(BonsaiSecurityError)
  })

  it('uses defaults when no options provided', () => {
    const policy = new SecurityPolicy()
    const ec = new ExecutionContext(policy)
    expect(() => {
      ec.checkNameAccess('anything', 'member')
    }).not.toThrow()
  })
})

describe('ExecutionContext', () => {
  it('blocks __proto__, constructor, prototype for all access kinds', () => {
    const policy = new SecurityPolicy()
    for (const blocked of BLOCKED_PROPERTIES) {
      for (const kind of ['identifier', 'member', 'method', 'object-key'] as const) {
        const ec = new ExecutionContext(policy)
        expect(() => {
          ec.checkNameAccess(blocked, kind)
        }).toThrow(BonsaiSecurityError)
      }
    }
  })

  it('does NOT apply allow/deny lists to identifiers', () => {
    const policy = new SecurityPolicy({ deniedProperties: ['secret'] })
    const ec = new ExecutionContext(policy)
    expect(() => {
      ec.checkNameAccess('secret', 'identifier')
    }).not.toThrow()
    expect(() => {
      ec.checkNameAccess('secret', 'member')
    }).toThrow(BonsaiSecurityError)
  })

  it('does NOT apply allow/deny lists to object-key', () => {
    const policy = new SecurityPolicy({ allowedProperties: ['name'] })
    const ec = new ExecutionContext(policy)
    expect(() => {
      ec.checkNameAccess('age', 'object-key')
    }).not.toThrow()
    expect(() => {
      ec.checkNameAccess('__proto__', 'object-key')
    }).toThrow(BonsaiSecurityError)
  })

  it('applies allow/deny to member and method', () => {
    const policy = new SecurityPolicy({ allowedProperties: ['name'] })
    const ec = new ExecutionContext(policy)
    for (const kind of ['member', 'method'] as const) {
      expect(() => {
        ec.checkNameAccess('name', kind)
      }).not.toThrow()
      expect(() => {
        ec.checkNameAccess('age', kind)
      }).toThrow(BonsaiSecurityError)
    }
  })

  it('canonical numeric indices bypass allow/deny lists', () => {
    const policy = new SecurityPolicy({ allowedProperties: ['name'] })
    const ec = new ExecutionContext(policy)
    expect(() => {
      ec.checkNameAccess('0', 'member')
    }).not.toThrow()
    expect(() => {
      ec.checkNameAccess('1', 'member')
    }).not.toThrow()
    expect(() => {
      ec.checkNameAccess('42', 'member')
    }).not.toThrow()
    expect(() => {
      ec.checkNameAccess('age', 'member')
    }).toThrow(BonsaiSecurityError)
  })

  it('enforces depth limits', () => {
    const policy = new SecurityPolicy({ maxDepth: 3 })
    const ec = new ExecutionContext(policy)
    ec.enterDepth()
    ec.enterDepth()
    ec.enterDepth()
    expect(() => {
      ec.enterDepth()
    }).toThrow('Maximum expression depth')
  })

  it('exitDepth decrements correctly', () => {
    const policy = new SecurityPolicy({ maxDepth: 2 })
    const ec = new ExecutionContext(policy)
    ec.enterDepth()
    ec.enterDepth()
    ec.exitDepth()
    expect(() => {
      ec.enterDepth()
    }).not.toThrow()
  })

  it('withDepth exits even on throw', () => {
    const policy = new SecurityPolicy({ maxDepth: 2 })
    const ec = new ExecutionContext(policy)
    ec.enterDepth()
    try {
      ec.withDepth(() => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    expect(() => {
      ec.enterDepth()
    }).not.toThrow()
  })

  it('enforces array length', () => {
    const policy = new SecurityPolicy({ maxArrayLength: 5 })
    const ec = new ExecutionContext(policy)
    expect(() => {
      ec.checkArrayLength(3)
    }).not.toThrow()
    expect(() => {
      ec.checkArrayLength(10)
    }).toThrow('Array length')
  })

  it('enforces timeout via step() with injectable clock', () => {
    let now = 0
    const policy = new SecurityPolicy({ timeout: 100 })
    const ec = new ExecutionContext(policy, () => now)

    for (let i = 0; i < 999; i++) ec.step()

    now = 200
    expect(() => {
      ec.step()
    }).toThrow(BonsaiSecurityError)
  })

  it('checkTimeout() always checks wall clock', () => {
    let now = 0
    const policy = new SecurityPolicy({ timeout: 100 })
    const ec = new ExecutionContext(policy, () => now)
    expect(() => {
      ec.checkTimeout()
    }).not.toThrow()
    now = 200
    expect(() => {
      ec.checkTimeout()
    }).toThrow(BonsaiSecurityError)
  })

  it('does not enforce timeout when timeout is 0', () => {
    let now = 0
    const policy = new SecurityPolicy({ timeout: 0 })
    const ec = new ExecutionContext(policy, () => now)
    now = 999999
    for (let i = 0; i < 2000; i++) ec.step()
    expect(() => {
      ec.checkTimeout()
    }).not.toThrow()
  })

  it('each ExecutionContext has independent state', () => {
    const policy = new SecurityPolicy({ maxDepth: 2 })
    const ec1 = new ExecutionContext(policy)
    const ec2 = new ExecutionContext(policy)
    ec1.enterDepth()
    ec1.enterDepth()
    expect(() => {
      ec2.enterDepth()
    }).not.toThrow()
  })
})
