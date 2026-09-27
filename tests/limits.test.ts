import { describe, expect, it } from 'vitest'
import { BonsaiLimitError, bonsai, fn, t } from '../src/index.js'

const code = (f: () => unknown): string | undefined => {
  try {
    f()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('parse limits', () => {
  it('bounds source length, depth, and node count', () => {
    const env = bonsai({ limits: { maxSourceLength: 10, maxDepth: 5, maxNodes: 20 } })
    expect(code(() => env.evaluateSync('1 + 2 + 3 + 4'))).toBe('SOURCE_TOO_LONG')
    const deep = bonsai({ limits: { maxDepth: 5 } })
    expect(code(() => deep.evaluateSync('((((((1))))))'))).toBe('TOO_DEEP')
    const wide = bonsai({ limits: { maxNodes: 20 } })
    expect(code(() => wide.evaluateSync(Array.from({ length: 30 }, () => '1').join('+')))).toBe(
      'TOO_MANY_NODES',
    )
  })

  it('fails closed on deeply nested templates without overflowing the stack', () => {
    const nested = `${'`${'.repeat(40)}1${'}`'.repeat(40)}`
    expect(['TOO_DEEP', 'TOO_MANY_NODES']).toContain(code(() => bonsai().evaluateSync(nested)))
  })

  it('fails closed on pathological unary chains', () => {
    expect(code(() => bonsai().evaluateSync(`${'!'.repeat(10_000)}true`))).toBe('TOO_DEEP')
  })
})

describe('step budget', () => {
  it('charges lambda invocations', () => {
    const env = bonsai({ limits: { maxSteps: 100 } })
    const xs = Array.from({ length: 1000 }, (_, i) => i)
    expect(code(() => env.evaluateSync('xs.map(. + 1)', { xs }))).toBe('STEP_LIMIT')
    expect(env.evaluateSync('xs.slice(0, 10).map(. + 1).length', { xs })).toBe(10)
  })

  it('charges operator work proportional to data', () => {
    const env = bonsai({ limits: { maxSteps: 1000 } })
    const big = Array.from({ length: 5000 }, (_, i) => i)
    expect(code(() => env.evaluateSync('a == b', { a: big, b: [...big] }))).toBe('STEP_LIMIT')
    expect(code(() => env.evaluateSync('-1 in a', { a: big }))).toBe('STEP_LIMIT')
    expect(code(() => env.evaluateSync('a + a', { a: big }))).toBe('STEP_LIMIT')
    expect(code(() => env.evaluateSync('[...a]', { a: big }))).toBe('STEP_LIMIT')
  })

  it('bounds quadratic expressions', () => {
    const xs = Array.from({ length: 2000 }, (_, i) => i)
    expect(code(() => bonsai().evaluateSync('xs.map(x => xs.filter(. == x).length)', { xs }))).toBe(
      'STEP_LIMIT',
    )
  })

  it('can be overridden per evaluation', () => {
    const env = bonsai()
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const program = env.compile('xs.map(. * 2).length')
    expect(program.evaluateSync({ xs })).toBe(100)
    expect(code(() => program.evaluateSync({ xs }, { maxSteps: 10 }))).toBe('STEP_LIMIT')
  })
})

describe('size limits', () => {
  it('checks string growth before allocating', () => {
    const env = bonsai({ limits: { maxStringLength: 1000 } })
    expect(code(() => env.evaluateSync('"ab".repeat(1000)'))).toBe('STRING_LIMIT')
    expect(code(() => env.evaluateSync('"x".padStart(1_000_000_000)'))).toBe('STRING_LIMIT')
    expect(
      code(() =>
        env.evaluateSync('let a = s + s; let b = a + a; let c = b + b; c + c', {
          s: 'x'.repeat(100),
        }),
      ),
    ).toBe('STRING_LIMIT')
    expect(code(() => env.evaluateSync('`${s}${s}`', { s: 'x'.repeat(600) }))).toBe('STRING_LIMIT')
    expect(
      code(() => env.evaluateSync('xs.join("-")', { xs: Array.from({ length: 600 }, () => 'ab') })),
    ).toBe('STRING_LIMIT')
  })

  it('checks list growth', () => {
    const env = bonsai({ limits: { maxListLength: 100 } })
    const xs = Array.from({ length: 60 }, (_, i) => i)
    expect(code(() => env.evaluateSync('xs + xs', { xs }))).toBe('LIST_LIMIT')
    expect(code(() => env.evaluateSync('[...xs, ...xs]', { xs }))).toBe('LIST_LIMIT')
    expect(code(() => env.evaluateSync('xs.flatMap([., .])', { xs }))).toBe('LIST_LIMIT')
    expect(code(() => env.evaluateSync('"a,".repeat(200).split(",")'))).toBe('LIST_LIMIT')
  })

  it('does not reject large host data that is only read', () => {
    const env = bonsai({ limits: { maxListLength: 10, maxStringLength: 10 } })
    const xs = Array.from({ length: 100 }, (_, i) => i)
    expect(env.evaluateSync('xs', { xs })).toBe(xs)
    expect(env.evaluateSync('s.length', { s: 'x'.repeat(100) })).toBe(100)
  })
})

describe('cyclic and deep data', () => {
  it('equality on cyclic data fails closed', () => {
    const a: Record<string, unknown> = { v: 1 }
    a.self = a
    const b: Record<string, unknown> = { v: 1 }
    b.self = b
    expect(code(() => bonsai().evaluateSync('a == b', { a, b }))).toBe('TOO_DEEP')
    expect(bonsai().evaluateSync('a == a', { a })).toBe(true)
  })
})

describe('time limits', () => {
  it('times out synchronous work', () => {
    const env = bonsai({ limits: { timeout: 5, maxSteps: 0 } })
    const xs = Array.from({ length: 3000 }, (_, i) => i)
    expect(code(() => env.evaluateSync('xs.map(x => xs.some(. == x + 0.5)).length', { xs }))).toBe(
      'TIMEOUT',
    )
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
    expect(code(() => env.evaluateSync('block()'))).toBe('TIMEOUT')
  })

  it('stops waiting on a hanging async host call', async () => {
    const env = bonsai({
      functions: {
        hang: fn({
          params: [],
          returns: t.number(),
          async: true,
          run: () =>
            new Promise<number>(() => {
              // never settles
            }),
        }),
      },
    })
    await expect(env.evaluate('hang()', {}, { timeout: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    const controller = new AbortController()
    const pending = env.evaluate('hang()', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(BonsaiLimitError)
  })

  it('rejects an already-aborted signal before running', () => {
    const controller = new AbortController()
    controller.abort()
    expect(code(() => bonsai().evaluateSync('1', {}, { signal: controller.signal }))).toBe(
      'ABORTED',
    )
  })

  it('try() never catches limit errors', () => {
    const env = bonsai({ limits: { maxSteps: 10 } })
    const xs = Array.from({ length: 100 }, (_, i) => i)
    expect(code(() => env.evaluateSync('try(xs.map(. + 1), [])', { xs }))).toBe('STEP_LIMIT')
  })
})
