import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiSecurityError } from '../src/index.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'

// maxSteps is a default-on deterministic bound on evaluator work: it caps the
// number of accounted steps a single evaluation may take, independent of the
// wall-clock timeout. It is what protects callers who never set a timeout —
// notably a higher-order method over a large *context* array, whose receiver
// size maxArrayLength does not cap.

const expectMaxSteps = (fn: () => unknown): void => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BonsaiSecurityError)
    expect((e as BonsaiSecurityError).code).toBe('MAX_STEPS')
    return
  }
  throw new Error('expected the evaluation to throw MAX_STEPS')
}

describe('ExecutionContext maxSteps', () => {
  it('throws MAX_STEPS once the budget is exceeded, without a timeout', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 100 }))
    ec.beginRun()
    expectMaxSteps(() => {
      for (let i = 0; i < 200; i++) ec.step()
    })
  })

  it('allows exactly maxSteps and throws on the next', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 10 }))
    ec.beginRun()
    for (let i = 0; i < 10; i++) ec.step() // exactly at the budget
    expect(ec.stepsTaken).toBe(10)
    expect(() => {
      ec.step()
    }).toThrow(BonsaiSecurityError)
  })

  it('charges a bulk addSteps against the budget', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 100 }))
    ec.beginRun()
    expectMaxSteps(() => {
      ec.addSteps(500)
    })
  })

  it('does not count steps taken outside a run', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 10 }))
    // No beginRun(): a retained closure invoked after the run must not accrue.
    for (let i = 0; i < 1000; i++) ec.step()
    expect(() => {
      ec.step()
    }).not.toThrow()
  })

  it('is disabled when maxSteps is 0', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 0 }))
    ec.beginRun()
    for (let i = 0; i < 100_000; i++) ec.step()
    expect(() => {
      ec.step()
    }).not.toThrow()
  })
})

describe('maxSteps through the public API', () => {
  it('is on by default and bounds a higher-order method over a large context array', () => {
    // The receiver array is a context value, which maxArrayLength does not cap.
    // Without maxSteps this would run to completion; the default budget stops it.
    const expr = bonsai() // no options: default maxSteps applies
    const items = Array.from({ length: 5_000_000 }, (_, i) => i)
    expectMaxSteps(() => expr.evaluateSync('items.map(.x)', { items }))
  })

  it('does not falsely trip a normal expression', () => {
    const expr = bonsai()
    expect(
      expr.evaluateSync('user.age >= 18 && user.verified', { user: { age: 20, verified: true } }),
    ).toBe(true)
  })

  it('does not falsely trip a legitimate pipeline over a full maxArrayLength-sized array', () => {
    // A realistic heavy case: chained lambdas over an array at the default
    // maxArrayLength (100k). The default maxSteps must have headroom for this.
    const expr = bonsai()
    const items = Array.from({ length: 100_000 }, (_, i) => ({ x: i, y: i % 2 }))
    expect(() => expr.evaluateSync('items.filter(.y).map(.x)', { items })).not.toThrow()
  })

  it('a caller can lower the budget explicitly', () => {
    const expr = bonsai({ maxSteps: 50 })
    const items = Array.from({ length: 1000 }, (_, i) => i)
    expectMaxSteps(() => expr.evaluateSync('items.map(.x)', { items }))
  })

  it('async evaluation is bounded too', async () => {
    const expr = bonsai({ maxSteps: 50 })
    const items = Array.from({ length: 1000 }, (_, i) => i)
    await expect(expr.evaluate('items.map(.x)', { items })).rejects.toMatchObject({
      code: 'MAX_STEPS',
    })
  })
})
