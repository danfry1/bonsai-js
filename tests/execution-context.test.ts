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
    ec.beginRun() // step accounting only runs inside an evaluation

    for (let i = 0; i < 999; i++) ec.step()

    now = 200
    expect(() => {
      ec.step()
    }).toThrow(BonsaiSecurityError)
  })

  it('does not count step()s outside an evaluation run', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    // A lambda closure retained by a host and invoked after the run ended: its
    // step() must be inert even once the deadline has passed.
    for (let i = 0; i < 5000; i++) ec.step()
    now = 200
    expect(() => {
      ec.step()
    }).not.toThrow()
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
    ec.beginRun()
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

// These tests pin the exact behaviour of each security guard, not merely that
// "an error is thrown". They were added to kill mutation-testing survivors in
// execution-context.ts (error codes, canonical-index boundaries, the timeout
// deadline boundary and sampling interval, and reset()).
describe('ExecutionContext security-guard invariants', () => {
  const codeOf = (fn: () => void): string => {
    try {
      fn()
    } catch (e) {
      if (e instanceof BonsaiSecurityError) return e.code
      throw e
    }
    throw new Error('expected a BonsaiSecurityError to be thrown')
  }

  it('reports the exact security code for each guard', () => {
    const blocked = new ExecutionContext(new SecurityPolicy())
    expect(
      codeOf(() => {
        blocked.checkNameAccess('__proto__', 'member')
      }),
    ).toBe('BLOCKED_PROPERTY')

    const allowed = new ExecutionContext(new SecurityPolicy({ allowedProperties: ['name'] }))
    expect(
      codeOf(() => {
        allowed.checkNameAccess('age', 'member')
      }),
    ).toBe('PROPERTY_NOT_ALLOWED')

    const denied = new ExecutionContext(new SecurityPolicy({ deniedProperties: ['secret'] }))
    expect(
      codeOf(() => {
        denied.checkNameAccess('secret', 'member')
      }),
    ).toBe('PROPERTY_DENIED')

    const depthEc = new ExecutionContext(new SecurityPolicy({ maxDepth: 1 }))
    depthEc.enterDepth()
    expect(
      codeOf(() => {
        depthEc.enterDepth()
      }),
    ).toBe('MAX_DEPTH')

    const arrEc = new ExecutionContext(new SecurityPolicy({ maxArrayLength: 1 }))
    expect(
      codeOf(() => {
        arrEc.checkArrayLength(2)
      }),
    ).toBe('MAX_ARRAY_LENGTH')

    const strEc = new ExecutionContext(new SecurityPolicy({ maxStringLength: 1 }))
    expect(
      codeOf(() => {
        strEc.checkStringLength(2)
      }),
    ).toBe('MAX_STRING_LENGTH')

    const objectEc = new ExecutionContext(new SecurityPolicy({ maxObjectProperties: 1 }))
    expect(
      codeOf(() => {
        objectEc.checkObjectProperties(2)
      }),
    ).toBe('MAX_OBJECT_PROPERTIES')

    const callEc = new ExecutionContext(new SecurityPolicy({ maxCallArguments: 1 }))
    expect(
      codeOf(() => {
        callEc.checkCallArguments(2)
      }),
    ).toBe('MAX_CALL_ARGUMENTS')

    let now = 0
    const timeoutEc = new ExecutionContext(new SecurityPolicy({ timeout: 10 }), () => now)
    now = 100
    expect(
      codeOf(() => {
        timeoutEc.checkTimeout()
      }),
    ).toBe('TIMEOUT')
  })

  it('includes the offending and limit values in size-guard messages', () => {
    const str = new ExecutionContext(new SecurityPolicy({ maxStringLength: 7 }))
    expect(() => {
      str.checkStringLength(8)
    }).toThrow(/String length.*8.*maximum.*7/u)
    const arr = new ExecutionContext(new SecurityPolicy({ maxArrayLength: 3 }))
    expect(() => {
      arr.checkArrayLength(9)
    }).toThrow(/Array length.*9.*maximum.*3/u)

    const object = new ExecutionContext(new SecurityPolicy({ maxObjectProperties: 5 }))
    expect(() => {
      object.checkObjectProperties(6)
    }).toThrow(/Object property count.*6.*maximum.*5/u)

    const call = new ExecutionContext(new SecurityPolicy({ maxCallArguments: 4 }))
    expect(() => {
      call.checkCallArguments(5)
    }).toThrow(/Call argument count.*5.*maximum.*4/u)
  })

  it('allows every structural count exactly at its configured limit', () => {
    const ec = new ExecutionContext(
      new SecurityPolicy({
        maxArrayLength: 2,
        maxStringLength: 2,
        maxObjectProperties: 2,
        maxCallArguments: 2,
      }),
    )
    expect(() => {
      ec.checkArrayLength(2)
      ec.checkStringLength(2)
      ec.checkObjectProperties(2)
      ec.checkCallArguments(2)
    }).not.toThrow()
  })

  describe('canonical-index detection (which keys may bypass allow/deny lists)', () => {
    const guard = () => new ExecutionContext(new SecurityPolicy({ allowedProperties: ['name'] }))

    it.each(['0', '1', '42', '10', '9999999999'])(
      'treats "%s" as a canonical index and bypasses the list',
      (key) => {
        expect(() => {
          guard().checkNameAccess(key, 'member')
        }).not.toThrow()
      },
    )

    it.each([
      ['', 'empty string'],
      ['01', 'leading zero, so String(n) !== key'],
      ['-1', 'negative, so n >= 0 fails'],
      ['1.5', 'non-integer'],
      ['99999999999', 'eleven digits, exceeds MAX_INDEX_DIGITS'],
      [' 1', 'leading whitespace'],
      ['1e2', 'exponent form'],
    ])('does NOT treat "%s" (%s) as a canonical index; it must obey the list', (key) => {
      expect(() => {
        guard().checkNameAccess(key, 'member')
      }).toThrow(BonsaiSecurityError)
    })
  })

  it('samples the timeout clock periodically, not on every step', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 10 }), () => now)
    ec.beginRun()
    now = 1000 // already well past the deadline
    // A single step must not sample the clock yet (the check interval is not
    // reached), so it must not throw. This pins periodic sampling: a mutant that
    // checks on every step would throw here.
    expect(() => {
      ec.step()
    }).not.toThrow()
  })

  it('fires the timeout exactly at the deadline (>= boundary)', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 50 }), () => now)
    now = 49
    expect(() => {
      ec.checkTimeout()
    }).not.toThrow()
    now = 50 // now === deadline
    expect(() => {
      ec.checkTimeout()
    }).toThrow(BonsaiSecurityError)
  })

  it('reset() clears accumulated depth so a pooled context can be reused', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxDepth: 2 }))
    ec.enterDepth()
    ec.enterDepth() // depth now at the limit
    ec.reset()
    // If reset did nothing, depth would still be 2 and the next enterDepth throws.
    expect(() => {
      ec.enterDepth()
      ec.enterDepth()
    }).not.toThrow()
  })

  it('reset() recomputes the timeout deadline from the current clock', () => {
    let now = 0
    const ec = new ExecutionContext(new SecurityPolicy({ timeout: 100 }), () => now)
    now = 1000
    ec.reset() // deadline becomes now() + timeout = 1100
    now = 1050
    expect(() => {
      ec.checkTimeout()
    }).not.toThrow()
    now = 1100
    expect(() => {
      ec.checkTimeout()
    }).toThrow(BonsaiSecurityError)
  })
})

describe('ExecutionContext per-run state and cancellation invariants', () => {
  const signalLike = (overrides: Partial<AbortSignal> = {}): AbortSignal =>
    ({
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
      ...overrides,
    }) as AbortSignal

  it('validates each independent field of an AbortSignal-like object', () => {
    const policy = new SecurityPolicy()
    const invalid = [
      null,
      {},
      { aborted: false, addEventListener() {} },
      { aborted: false, removeEventListener() {} },
      { aborted: 'false', addEventListener() {}, removeEventListener() {} },
      { aborted: false, addEventListener: true, removeEventListener() {} },
      { aborted: false, addEventListener() {}, removeEventListener: true },
    ]

    for (const signal of invalid) {
      expect(
        () => new ExecutionContext(policy, undefined, { signal: signal as unknown as AbortSignal }),
      ).toThrow('bonsai: "signal" must be an AbortSignal')
    }
    expect(() => new ExecutionContext(policy, undefined, { signal: signalLike() })).not.toThrow()
  })

  it('validates per-run maxSteps and timeout boundaries with stable diagnostics', () => {
    const policy = new SecurityPolicy()
    for (const maxSteps of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ExecutionContext(policy, undefined, { maxSteps })).toThrow(
        /"maxSteps" must be a non-negative integer/u,
      )
    }
    for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ExecutionContext(policy, undefined, { timeout })).toThrow(
        /"timeout" must be a non-negative, finite number/u,
      )
    }
    expect(() => new ExecutionContext(policy, undefined, { maxSteps: 0, timeout: 0 })).not.toThrow()
  })

  it('derives accounting and deadline state independently from every control', () => {
    const none = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 0 }))
    expect(none.needsAccounting).toBe(false)
    expect(none.hasDeadline).toBe(false)

    const steps = new ExecutionContext(new SecurityPolicy({ maxSteps: 1, timeout: 0 }))
    expect(steps.needsAccounting).toBe(true)
    expect(steps.hasDeadline).toBe(false)

    const timeout = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 1_000 }))
    expect(timeout.needsAccounting).toBe(true)
    expect(timeout.hasDeadline).toBe(true)

    const signal = new ExecutionContext(
      new SecurityPolicy({ maxSteps: 0, timeout: 0 }),
      undefined,
      {
        signal: signalLike(),
      },
    )
    expect(signal.needsAccounting).toBe(true)
    expect(signal.hasDeadline).toBe(false)

    const explicitNone = new ExecutionContext(
      new SecurityPolicy({ maxSteps: 10, timeout: 10 }),
      undefined,
      { maxSteps: 0, timeout: 0 },
    )
    explicitNone.beginRun()
    explicitNone.step()
    explicitNone.addSteps(10)
    expect(explicitNone.needsAccounting).toBe(false)
    expect(explicitNone.stepsTaken).toBe(0)
  })

  it('computes a per-run timeout deadline by adding the override to the current clock', () => {
    let now = 100
    const ec = new ExecutionContext(new SecurityPolicy(), () => now, { timeout: 50 })
    now = 149
    expect(() => {
      ec.checkTimeout()
    }).not.toThrow()
    now = 150
    expect(() => {
      ec.checkTimeout()
    }).toThrow(BonsaiSecurityError)
  })

  it('endRun disarms both single and bulk step accounting', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 1 }))
    ec.beginRun()
    ec.step()
    ec.endRun()
    ec.step()
    ec.addSteps(1_000)
    expect(ec.stepsTaken).toBe(1)
  })

  it('bulk accounting requires both an active limit and an active run', () => {
    const inactiveRun = new ExecutionContext(new SecurityPolicy({ maxSteps: 1 }))
    inactiveRun.addSteps(10)
    expect(inactiveRun.stepsTaken).toBe(0)

    const noAccounting = new ExecutionContext(new SecurityPolicy({ maxSteps: 0, timeout: 0 }))
    noAccounting.beginRun()
    noAccounting.addSteps(10)
    expect(noAccounting.stepsTaken).toBe(0)
  })

  it('waitFor removes its abort listener after fulfillment and rejection', async () => {
    let listener: (() => void) | undefined
    let adds = 0
    let removes = 0
    const signal = signalLike({
      addEventListener(_type: string, callback: EventListenerOrEventListenerObject) {
        adds++
        listener = callback as () => void
      },
      removeEventListener(_type: string, callback: EventListenerOrEventListenerObject) {
        if (callback === listener) removes++
      },
    })
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 0 }), undefined, { signal })

    await expect(ec.waitFor(Promise.resolve('ok'))).resolves.toBe('ok')
    expect(adds).toBe(1)
    expect(removes).toBe(1)

    const reason = new Error('host rejection')
    await expect(ec.waitFor(Promise.reject(reason))).rejects.toBe(reason)
    expect(adds).toBe(2)
    expect(removes).toBe(2)
  })

  it('waitFor closes the add-listener race for a signal aborted during subscription', async () => {
    const state = { aborted: false }
    const signal = {
      get aborted() {
        return state.aborted
      },
      addEventListener() {
        state.aborted = true
      },
      removeEventListener() {},
    } as unknown as AbortSignal
    const ec = new ExecutionContext(new SecurityPolicy({ maxSteps: 0 }), undefined, { signal })

    await expect(ec.waitFor(new Promise<never>(() => {}))).rejects.toMatchObject({
      code: 'ABORTED',
      message: 'Evaluation aborted',
    })
  })
})

describe('deterministic cancellation after waitFor delivers a verdict', () => {
  it('checkTimeout throws the delivered TIMEOUT even when the clock disagrees', async () => {
    // Freeze the monotonic clock before the deadline: the waitFor timer fires
    // on real time, but a later checkpoint sampling the frozen clock would
    // conclude "not timed out yet" and let one more extension call through.
    // The cancellation flag makes the delivered verdict sticky.
    const policy = new SecurityPolicy({ timeout: 5 })
    const ec = new ExecutionContext(policy, () => 0)
    const pending = new Promise(() => {
      /* never settles */
    })

    await expect(ec.waitFor(pending)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(() => {
      ec.checkTimeout()
    }).toThrow(/timeout/iu)
  })

  it('checkTimeout throws the delivered ABORTED after an abort rejection', async () => {
    const controller = new AbortController()
    const policy = new SecurityPolicy({})
    const ec = new ExecutionContext(policy, () => 0, { signal: controller.signal })
    const pending = new Promise(() => {
      /* never settles */
    })

    const waited = ec.waitFor(pending)
    controller.abort()
    await expect(waited).rejects.toMatchObject({ code: 'ABORTED' })
    expect(() => {
      ec.checkTimeout()
    }).toThrow(/aborted/iu)
  })

  it('reset clears a delivered cancellation for pooled reuse', async () => {
    const policy = new SecurityPolicy({ timeout: 5 })
    const ec = new ExecutionContext(policy, () => 0)
    await expect(
      ec.waitFor(
        new Promise(() => {
          /* never settles */
        }),
      ),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    ec.reset({ timeout: 0 })
    expect(() => {
      ec.checkTimeout()
    }).not.toThrow()
  })
})
