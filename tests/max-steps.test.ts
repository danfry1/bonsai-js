import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiSecurityError } from '../src/index.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { evaluate } from '../src/evaluator.js'
import { evaluateAsync } from '../src/evaluator-async.js'
import { parse } from '../src/parser.js'

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

describe('sync and async consume the same step budget (dense arrays, built-in methods)', () => {
  const noBindings = { transforms: {}, functions: {} }
  const stepsFor = async (expr: string, ctx: Record<string, unknown>) => {
    // A live budget (timeout, no cap) so accounting runs without tripping.
    const sc = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 100_000 }))
    evaluate(parse(expr), ctx, noBindings, sc)
    const ac = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 100_000 }))
    await evaluateAsync(parse(expr), ctx, noBindings, ac)
    return { sync: sc.stepsTaken, async: ac.stepsTaken }
  }

  const items = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i % 2 }))

  it.each([
    'items.map(.x)',
    'items.filter(.y)',
    'items.filter(.y).map(.x)',
    'items.some(.y)',
    'items.every(.y)',
    'items.find(.x)',
    'items.findIndex(.x)',
  ])('charges identical steps for %s', async (expr) => {
    const r = await stepsFor(expr, { items })
    expect(r.async).toBe(r.sync)
  })

  it('a budget at the boundary passes (or fails) the same way in both modes', () => {
    // items.map(.x) over 100 items charges the same in both, so a budget just
    // above the count passes both and just below fails both — no mode skew.
    const enough = bonsai({ maxSteps: 250 })
    const tooLow = bonsai({ maxSteps: 50 })
    const ctx = { items }
    expect(() => enough.evaluateSync('items.map(.x)', ctx)).not.toThrow()
    expectMaxSteps(() => tooLow.evaluateSync('items.map(.x)', ctx))
  })

  it('the same boundary holds for async', async () => {
    const enough = bonsai({ maxSteps: 250 })
    const tooLow = bonsai({ maxSteps: 50 })
    const ctx = { items }
    await expect(enough.evaluate('items.map(.x)', ctx)).resolves.toBeDefined()
    await expect(tooLow.evaluate('items.map(.x)', ctx)).rejects.toMatchObject({ code: 'MAX_STEPS' })
  })
})

describe('sparse-array budget parity', () => {
  it('charges the same steps synchronously and asynchronously', async () => {
    const sparse: number[] = []
    sparse[99] = 1 // 1 real element, 99 holes
    const bindings = { transforms: {}, functions: {} }
    const syncGuard = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 100_000 }))
    evaluate(parse('items.map(.x)'), { items: sparse }, bindings, syncGuard)
    const asyncGuard = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 100_000 }))
    await evaluateAsync(parse('items.map(.x)'), { items: sparse }, bindings, asyncGuard)
    expect(asyncGuard.stepsTaken).toBe(syncGuard.stepsTaken)
  })

  it('overridden methods are ignored consistently by both evaluators', async () => {
    const arr = [1, 2, 3, 4, 5]
    Object.defineProperty(arr, 'map', { value: () => 'overridden' })
    const expr = bonsai({ maxSteps: 2 })
    expect(() => expr.evaluateSync('items.map(.x)', { items: arr })).toThrow(BonsaiSecurityError)
    await expect(expr.evaluate('items.map(.x)', { items: arr })).rejects.toMatchObject({
      code: 'MAX_STEPS',
    })
  })
})
