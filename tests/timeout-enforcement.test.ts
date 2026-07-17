import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/evaluator.js'
import { evaluateAsync } from '../src/evaluator-async.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { bonsai, BonsaiSecurityError } from '../src/index.js'
import type { RegisteredFunction, TransformFn } from '../src/types.js'

// Characterization tests for the timeout bypasses confirmed in the 2026-07-17
// package audit. The wall-clock timeout used to be sampled only every 1,000
// compound-node steps, so evaluations doing their work inside host calls or
// flat per-element loops (native array methods driving lambda closures, spread
// materialization) could run far past the deadline and still return normally.
//
// Each test drives the evaluator with an injected fake clock so no test
// depends on real elapsed time. The exit criterion from the implementation
// plan: an evaluation that exceeds its configured timeout is rejected even
// when it contains fewer than 1,000 compound AST nodes.

const expectTimeout = (fn: () => unknown): void => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BonsaiSecurityError)
    expect((e as BonsaiSecurityError).code).toBe('TIMEOUT')
    return
  }
  throw new Error('expected the evaluation to throw TIMEOUT')
}

const noBindings = { transforms: {}, functions: {} }

describe('sync timeout enforcement after host calls', () => {
  it('rejects after a registered function returns past the deadline', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    const slow: RegisteredFunction = {
      kind: 'pure',
      fn: () => {
        now = 500
        return 'done'
      },
    }
    expectTimeout(() => evaluate(parse('slow()'), {}, { transforms: {}, functions: { slow } }, ec))
  })

  it('rejects after a transform returns past the deadline', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    const slow: TransformFn = (value) => {
      now = 500
      return value
    }
    expectTimeout(() =>
      evaluate(parse('x |> slow'), { x: 1 }, { transforms: { slow }, functions: {} }, ec),
    )
  })

  it('rejects after a native method driven by a host callback overruns', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    const cb = (item: unknown): unknown => {
      now += 60
      return item
    }
    expectTimeout(() => evaluate(parse('items.map(cb)'), { items: [1, 2, 3], cb }, noBindings, ec))
  })

  it('rejects at sync completion even with a single compound node', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    const leak: RegisteredFunction = {
      kind: 'pure',
      fn: () => {
        now = 500
        return true
      },
    }
    // One CallExpression: far fewer than the 1,000-step sampling interval.
    expectTimeout(() => evaluate(parse('leak()'), {}, { transforms: {}, functions: { leak } }, ec))
  })
})

describe('per-element accounting in flat loops', () => {
  // A clock that advances on every read: the only way the deadline can be
  // noticed mid-loop is if the loop actually samples the clock, which requires
  // per-element step accounting. Before the fix, `items.map(.x)` performed no
  // steps at all, so the clock was never read during evaluation.
  const advancingClock = (): (() => number) => {
    let now = 0
    return () => (now += 2)
  }

  const bigItems = Array.from({ length: 60_000 }, (_, i) => ({ x: i }))

  it('sync: rejects a lambda-accessor map that overruns mid-loop', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    expectTimeout(() => evaluate(parse('items.map(.x)'), { items: bigItems }, noBindings, ec))
  })

  it('async: rejects a lambda-accessor map that overruns mid-loop', async () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    await expect(
      evaluateAsync(parse('items.map(.x)'), { items: bigItems }, noBindings, ec),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('sync: rejects spread materialization of a slow iterable mid-loop', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    const gen = {
      *[Symbol.iterator]() {
        for (let i = 0; i < 60_000; i++) yield i
      },
    }
    expectTimeout(() => evaluate(parse('[...gen]'), { gen }, noBindings, ec))
  })

  const bigArray = Array.from({ length: 60_000 }, (_, i) => i)

  it('sync: charges an array-literal spread of a plain array against the budget', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    expectTimeout(() => evaluate(parse('[...items]'), { items: bigArray }, noBindings, ec))
  })

  it('async: charges an array-literal spread of a plain array against the budget', async () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    await expect(
      evaluateAsync(parse('[...items]'), { items: bigArray }, noBindings, ec),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('sync: charges a call-argument spread of a plain array against the budget', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    const count: RegisteredFunction = { kind: 'pure', fn: (...args: unknown[]) => args.length }
    expectTimeout(() =>
      evaluate(
        parse('count(...items)'),
        { items: bigArray },
        { transforms: {}, functions: { count } },
        ec,
      ),
    )
  })

  it('sync: materializes an array with a custom iterator through the guarded loop', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    // An array whose own Symbol.iterator overrides the native one: returning it
    // as-is would let the caller's native spread re-run host code unguarded.
    const weird = Array.from({ length: 60_000 }, (_, i) => i)
    Object.defineProperty(weird, Symbol.iterator, {
      *value(this: number[]) {
        for (let i = 0; i < this.length; i++) yield this[i]
      },
    })
    expectTimeout(() => evaluate(parse('[...weird]'), { weird }, noBindings, ec))
  })
})

describe('end-to-end timeout through the public API', () => {
  it('evaluateSync rejects an expression whose host function busy-waits past the timeout', () => {
    const expr = bonsai({ timeout: 5 })
    expr.addFunction('busy', () => {
      const start = performance.now()
      while (performance.now() - start < 25) {
        // burn wall-clock time
      }
      return true
    })
    expectTimeout(() => expr.evaluateSync('busy()'))
  })
})
