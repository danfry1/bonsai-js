import { describe, expect, it } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'
import { codeOf } from './helpers.js'

describe('parse limits', () => {
  it('bounds source length, depth, and node count', () => {
    const env = bonsai({ limits: { maxSourceLength: 10, maxDepth: 5, maxNodes: 20 } })
    expect(codeOf(() => env.evaluateSync('1 + 2 + 3 + 4'))).toBe('SOURCE_TOO_LONG')
    const deep = bonsai({ limits: { maxDepth: 5 } })
    expect(codeOf(() => deep.evaluateSync('((((((1))))))'))).toBe('TOO_DEEP')
    const wide = bonsai({ limits: { maxNodes: 20 } })
    expect(codeOf(() => wide.evaluateSync(Array.from({ length: 30 }, () => '1').join('+')))).toBe(
      'TOO_MANY_NODES',
    )
  })

  it('fails closed on deeply nested templates without overflowing the stack', () => {
    const nested = `${'`${'.repeat(40)}1${'}`'.repeat(40)}`
    expect(['TOO_DEEP', 'TOO_MANY_NODES']).toContain(codeOf(() => bonsai().evaluateSync(nested)))
  })
})

describe('step budget', () => {
  it('charges lambda invocations', () => {
    const env = bonsai({ limits: { maxSteps: 100 } })
    const xs = Array.from({ length: 1000 }, (_, i) => i)
    expect(codeOf(() => env.evaluateSync('xs.map(. + 1)', { xs }))).toBe('STEP_LIMIT')
    expect(env.evaluateSync('xs.slice(0, 10).map(. + 1).length', { xs })).toBe(10)
  })

  it('bounds quadratic expressions', () => {
    const xs = Array.from({ length: 2000 }, (_, i) => i)
    expect(
      codeOf(() => bonsai().evaluateSync('xs.map(x => xs.filter(. == x).length)', { xs })),
    ).toBe('STEP_LIMIT')
  })
})

describe('size limits', () => {
  it('checks string growth before allocating', () => {
    const env = bonsai({ limits: { maxStringLength: 1000 } })
    expect(codeOf(() => env.evaluateSync('"x".padStart(1_000_000_000)'))).toBe('STRING_LIMIT')
  })

  it('checks list growth from spreads', () => {
    const env = bonsai({ limits: { maxListLength: 100 } })
    const xs = Array.from({ length: 60 }, (_, i) => i)
    expect(codeOf(() => env.evaluateSync('[...xs, ...xs]', { xs }))).toBe('LIST_LIMIT')
  })

  it('does not reject large host data that is only read', () => {
    const env = bonsai({ limits: { maxListLength: 10, maxStringLength: 10 } })
    const xs = Array.from({ length: 100 }, (_, i) => i)
    expect(env.evaluateSync('xs', { xs })).toBe(xs)
  })
})

describe('cyclic and deep data', () => {
  it('equality on cyclic data fails closed', () => {
    const a: Record<string, unknown> = { v: 1 }
    a.self = a
    const b: Record<string, unknown> = { v: 1 }
    b.self = b
    expect(codeOf(() => bonsai().evaluateSync('a == b', { a, b }))).toBe('VALUE_DEPTH_LIMIT')
    expect(bonsai().evaluateSync('a == a', { a })).toBe(true)
  })
})

describe('time limits', () => {
  it('times out synchronous work', () => {
    const env = bonsai({ limits: { timeout: 5, maxSteps: 0 } })
    const xs = Array.from({ length: 3000 }, (_, i) => i)
    expect(
      codeOf(() => env.evaluateSync('xs.map(x => xs.some(. == x + 0.5)).length', { xs })),
    ).toBe('TIMEOUT')
  })

  it('checks the deadline after a slow host call returns', () => {
    const env = bonsai({
      limits: { timeout: 5 },
      functions: {
        block: fn({
          params: [],
          returns: t.number(),
          run: () => {
            const end = performance.now() + 20
            while (performance.now() < end) {
              // busy
            }
            return 1
          },
        }),
      },
    })
    expect(codeOf(() => env.evaluateSync('block()'))).toBe('TIMEOUT')
  })
})
