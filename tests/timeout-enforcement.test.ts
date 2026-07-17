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

  // Spreading a materialized array is a single bulk charge, not a per-element
  // loop, so its guarantee is that the whole length is charged against the step
  // budget (which the timeout, and a future maxSteps, sample). stepsTaken makes
  // that charge directly observable, which a wall-clock assertion cannot on a
  // sub-millisecond operation. A never-firing deadline keeps accounting live.
  const LEN = 60_000
  const bigArray = Array.from({ length: LEN }, (_, i) => i)
  const liveGuard = () => new ExecutionContext(new SecurityPolicy({ timeout: 100_000 }))

  it('sync: charges an array-literal spread of a plain array against the budget', () => {
    const ec = liveGuard()
    evaluate(parse('[...items]'), { items: bigArray }, noBindings, ec)
    expect(ec.stepsTaken).toBeGreaterThanOrEqual(LEN)
  })

  it('async: charges an array-literal spread of a plain array against the budget', async () => {
    const ec = liveGuard()
    await evaluateAsync(parse('[...items]'), { items: bigArray }, noBindings, ec)
    expect(ec.stepsTaken).toBeGreaterThanOrEqual(LEN)
  })

  it('sync: charges a call-argument spread of a plain array against the budget', () => {
    const ec = liveGuard()
    const count: RegisteredFunction = { kind: 'pure', fn: (...args: unknown[]) => args.length }
    evaluate(
      parse('count(...items)'),
      { items: bigArray },
      { transforms: {}, functions: { count } },
      ec,
    )
    expect(ec.stepsTaken).toBeGreaterThanOrEqual(LEN)
  })

  it('sync: charges an array whose Symbol.iterator is overridden (no unguarded re-iteration)', () => {
    // An array with an overridden iterator still takes the by-index array path,
    // so its whole length is charged and the hostile iterator is never invoked.
    const weird = Array.from({ length: LEN }, (_, i) => i)
    let iteratorCalls = 0
    Object.defineProperty(weird, Symbol.iterator, {
      *value(this: number[]) {
        iteratorCalls++
        for (let i = 0; i < this.length; i++) yield this[i]
      },
    })
    const ec = liveGuard()
    evaluate(parse('[...weird]'), { weird }, noBindings, ec)
    expect(ec.stepsTaken).toBeGreaterThanOrEqual(LEN)
    expect(iteratorCalls).toBe(0)
  })
})

describe('array-method callbacks and the deadline', () => {
  const advancingClock = (): (() => number) => {
    let now = 0
    return () => (now += 2)
  }
  const bigItems = Array.from({ length: 60_000 }, (_, i) => ({ x: i }))

  it('a bonsai-lambda callback is pre-empted mid-loop (its closure charges step)', () => {
    // `.x` compiles to an accessor closure that charges step() per call, so a
    // native map over a large array is interrupted without touching the method.
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), advancingClock())
    expectTimeout(() => evaluate(parse('items.map(.x)'), { items: bigItems }, noBindings, ec))
  })

  it('a native method with a host-function callback is checked at return', () => {
    // The evaluator does not interpose on the native method, so enforcement is
    // at method return, not mid-iteration. Bounded because an array method runs
    // at most maxArrayLength callbacks; here the callback elapses the deadline.
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    const cb = (item: unknown): unknown => {
      now += 60
      return item
    }
    expectTimeout(() => evaluate(parse('items.map(cb)'), { items: [1, 2, 3], cb }, noBindings, ec))
  })
})

describe('the timeout option must not change successful evaluation semantics', () => {
  // The evaluator runs native methods untouched, so results must be identical
  // with and without a timeout. Earlier approaches broke this only when a
  // timeout was set: reimplementing methods dropped index/array args, iterated
  // sparse holes, ignored thisArg, and bypassed overrides; wrapping every
  // function argument corrupted function-valued *data* arguments and callback
  // identity. These pin both boundaries.
  const withTimeout = bonsai({ timeout: 10_000 })
  const noTimeout = bonsai()
  const bothAgree = (expr: string, ctx: Record<string, unknown>): unknown => {
    const a = noTimeout.evaluateSync(expr, ctx)
    const b = withTimeout.evaluateSync(expr, ctx)
    expect(b).toEqual(a)
    return a
  }

  it('forwards the element index to the callback', () => {
    const r = bothAgree('items.map(f)', { items: [10, 20, 30], f: (_v: number, i: number) => i })
    expect(r).toEqual([0, 1, 2])
  })

  it('skips sparse-array holes instead of invoking the callback for them', () => {
    let calls = 0
    const f = (v: number) => {
      calls++
      return v
    }
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3] as number[]
    noTimeout.evaluateSync('items.map(f)', { items: sparse, f })
    const withoutTimeout = calls
    calls = 0
    withTimeout.evaluateSync('items.map(f)', { items: sparse, f })
    expect(calls).toBe(withoutTimeout)
    expect(calls).toBe(2) // the hole at index 1 is skipped
  })

  it('honors an explicit thisArg', () => {
    const r = bothAgree('items.map(f, t)', {
      items: [1, 2, 3],
      f(this: { mult: number }, v: number) {
        return v * this.mult
      },
      t: { mult: 10 },
    })
    expect(r).toEqual([10, 20, 30])
  })

  it('uses an overridden array method rather than a reimplementation', () => {
    const arr = [1, 2, 3]
    Object.defineProperty(arr, 'map', { value: () => 'OVERRIDDEN' })
    const r = bothAgree('items.map(f)', { items: arr, f: (v: number) => v })
    expect(r).toBe('OVERRIDDEN')
  })

  // A function passed as data, not a callback: its identity must be preserved.
  it('preserves a function-valued argument to includes (identity search)', () => {
    const fn = (): number => 1
    expect(bothAgree('items.includes(fn)', { items: [fn, 2, 3], fn })).toBe(true)
  })

  it('preserves a function-valued argument to concat', () => {
    const fn = (): number => 1
    const r = bothAgree('items.concat(fn)', { items: [1, 2], fn }) as unknown[]
    expect(r[2]).toBe(fn) // same identity, not a wrapper
  })

  it('preserves a function-valued argument to with', () => {
    const fn = (): number => 1
    const r = bothAgree('items.with(0, fn)', { items: [1, 2, 3], fn }) as unknown[]
    expect(r[0]).toBe(fn)
  })

  it('preserves callback identity for an override that inspects it', () => {
    const fn = (v: number): number => v
    const arr = [1, 2, 3]
    // An override that returns whether it received the exact function it was given.
    Object.defineProperty(arr, 'map', { value: (cb: unknown) => cb === fn })
    expect(bothAgree('items.map(fn)', { items: arr, fn })).toBe(true)
  })
})

describe('retained lambda closures do not corrupt the pooled context', () => {
  it('a host-retained accessor invoked after the run is an inert getter', () => {
    const expr = bonsai({ timeout: 50 })
    let stored: ((item: unknown) => unknown) | undefined
    expr.addFunction('defer', (accessor: unknown) => {
      stored = accessor as (item: unknown) => unknown
      return 0
    })
    expr.evaluateSync('defer(.x)')
    // Hammer the retained closure long after the pooled context's deadline would
    // have lapsed. Pre-fix this stepped the pooled context and threw a spurious
    // TIMEOUT once the accumulated steps crossed a check boundary.
    let last: unknown
    for (let i = 0; i < 5000; i++) last = stored?.({ x: 42 })
    expect(last).toBe(42)
    // The pooled context is still usable for normal evaluations.
    expect(expr.evaluateSync('1 + 1')).toBe(2)
  })
})

describe('timeout does not mask an async-in-sync misuse', () => {
  it('a sync function returning a Promise past the deadline reports the misuse, not TIMEOUT', () => {
    const expr = bonsai({ timeout: 1 })
    expr.addFunction('bad', () => {
      const start = performance.now()
      while (performance.now() - start < 5) {
        // elapse the 1ms deadline before returning
      }
      return Promise.resolve(1)
    })
    try {
      expr.evaluateSync('bad()')
      throw new Error('expected a throw')
    } catch (e) {
      // The descriptive async-misuse error, not a TIMEOUT that hides the real bug.
      expect((e as { code?: string }).code).not.toBe('TIMEOUT')
      expect((e as Error).message).toContain('evaluate()')
    }
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
