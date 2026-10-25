import { describe, expect, it } from 'vitest'
import { BonsaiLimitError, bonsai } from '../src/index.js'
import { DEFAULT_RUNTIME_LIMITS, State } from '../src/runtime/state.js'

// What the per-evaluation state guarantees: where the step limit falls, what a
// limit or an abort reports, and that costly resources are built, charged, and
// failed once per evaluation.

const fresh = (maxSteps = DEFAULT_RUNTIME_LIMITS.maxSteps): State => {
  const state = new State(DEFAULT_RUNTIME_LIMITS, () => new Date(0))
  state.reset({}, 'source', 0, maxSteps, 0, undefined)
  return state
}

const thrown = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('the step limit', () => {
  it('allows exactly maxSteps steps, and stops on the next', () => {
    const state = fresh(100)
    state.steps = 100
    expect(() => {
      state.sample()
    }).not.toThrow()
    state.steps = 101
    expect(
      thrown(() => {
        state.sample()
      }),
    ).toMatchObject({
      code: 'STEP_LIMIT',
      message: 'Evaluation exceeded the step limit of 100',
    })
  })
})

describe('limit messages', () => {
  it('name the length and the limit', () => {
    const state = fresh()
    expect(
      thrown(() => {
        state.stringLimit(100_001)
      }),
    ).toMatchObject({
      code: 'STRING_LIMIT',
      message: 'String of length 100001 exceeds the limit of 100000',
    })
    expect(
      thrown(() => {
        state.listLimit(100_001)
      }),
    ).toMatchObject({
      code: 'LIST_LIMIT',
      message: 'List of length 100001 exceeds the limit of 100000',
    })
    expect(() => {
      state.stringLimit(100_000)
    }).not.toThrow()
  })

  it('say a deadline passed', () => {
    const state = fresh()
    state.deadline = performance.now() - 1
    expect(
      thrown(() => {
        state.checkTime()
      }),
    ).toMatchObject({
      code: 'TIMEOUT',
      message: 'Evaluation timed out',
    })
  })
})

describe('an abort', () => {
  it("carries the signal's reason and the source", () => {
    const controller = new AbortController()
    controller.abort('stop')
    const error = thrown(() => bonsai().evaluateSync('1 + 2', {}, { signal: controller.signal }))
    expect(error).toBeInstanceOf(BonsaiLimitError)
    expect(error).toMatchObject({
      code: 'ABORTED',
      message: 'Evaluation was aborted',
      cause: 'stop',
      source: '1 + 2',
    })
  })

  it('fails closed with the error a signal throws, as its cause', () => {
    // Valid when the options are checked, then throwing when evaluation reads it.
    const listeners = { addEventListener: () => {}, removeEventListener: () => {} }
    const boom = new Error('aborted getter')
    let reads = 0
    const throwing = {
      ...listeners,
      get aborted(): boolean {
        reads++
        if (reads > 1) throw boom
        return false
      },
    }
    expect(thrown(() => bonsai().evaluateSync('1', {}, { signal: throwing }))).toMatchObject({
      code: 'ABORTED',
      cause: boom,
    })

    const reasonless = new Error('reason getter')
    const noReason = {
      ...listeners,
      aborted: true,
      get reason(): unknown {
        throw reasonless
      },
    }
    expect(thrown(() => bonsai().evaluateSync('1', {}, { signal: noReason }))).toMatchObject({
      code: 'ABORTED',
      cause: reasonless,
    })
  })
})

describe('resources', () => {
  it('are built and charged once per evaluation', () => {
    const state = fresh()
    let built = 0
    const make = (): object => {
      built++
      return {}
    }
    const first = state.resource('k', 10, make, () => 5)
    expect(state.resource('k', 10, make, () => 5)).toBe(first)
    expect(built).toBe(1)
    expect(state.steps).toBe(15)
  })

  it('that failed throw the same error again, for the cost of an error', () => {
    const state = fresh()
    const failure = new Error('bad pattern')
    let built = 0
    const make = (): never => {
      built++
      throw failure
    }
    expect(thrown(() => state.resource('k', 10, make))).toBe(failure)
    const before = state.steps
    expect(thrown(() => state.resource('k', 10, make))).toBe(failure)
    expect(built).toBe(1)
    expect(state.steps - before).toBe(64)
  })

  it('that failed in a rule fail the same way each time', () => {
    // The pattern comes from the context: a literal bad pattern is a check error.
    const source = '[try(matches("a", p), "first"), try(matches("a", p), "second")]'
    expect(bonsai().evaluateSync(source, { p: '(' })).toEqual(['first', 'second'])
  })
})
