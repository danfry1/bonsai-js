import { describe, expect, it } from 'vitest'
import { bonsai, BonsaiSecurityError, type EvaluationOptions } from '../src/index.js'

describe('per-evaluation controls', () => {
  it('times out a Promise that never settles', async () => {
    const expr = bonsai({ timeout: 0 })
    expr.addFunction('never', () => new Promise<never>(() => {}))

    const started = performance.now()
    await expect(expr.evaluate('never()', undefined, { timeout: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('rejects an in-flight evaluation when its AbortSignal fires', async () => {
    const expr = bonsai()
    expr.addFunction('never', () => new Promise<never>(() => {}))
    const controller = new AbortController()

    const pending = expr.evaluate('never()', undefined, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honors an already-aborted signal in sync and async modes', async () => {
    const controller = new AbortController()
    controller.abort()
    const options: EvaluationOptions = { signal: controller.signal }
    const expr = bonsai()

    expect(() => expr.evaluateSync('1 + 2', undefined, options)).toThrow(
      expect.objectContaining({ code: 'ABORTED' }),
    )
    await expect(expr.evaluate('1 + 2', undefined, options)).rejects.toMatchObject({
      code: 'ABORTED',
    })
  })

  it('overrides maxSteps for one run without mutating the instance default', () => {
    const expr = bonsai({ maxSteps: 1_000 })
    const context = { items: Array.from({ length: 20 }, (_, x) => ({ x })) }

    expect(expr.evaluateSync('items.map(.x)', context)).toHaveLength(20)
    expect(() => expr.evaluateSync('items.map(.x)', context, { maxSteps: 5 })).toThrow(
      BonsaiSecurityError,
    )
    expect(expr.evaluateSync('items.map(.x)', context)).toHaveLength(20)
  })

  it('supports the same controls on compiled expressions', async () => {
    const expr = bonsai()
    expr.addFunction('never', () => new Promise<never>(() => {}))
    const compiled = expr.compile('never()')

    await expect(compiled.evaluate(undefined, { timeout: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })

  it('rejects invalid per-run controls', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('1', undefined, { maxSteps: -1 })).toThrow(RangeError)
    expect(() => expr.evaluateSync('1', undefined, { timeout: Number.NaN })).toThrow(RangeError)
    expect(() => expr.evaluateSync('1', undefined, { signal: {} as AbortSignal })).toThrow(
      TypeError,
    )
  })
})
