import { describe, expect, it, vi } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'
import type * as Parser from '../src/syntax/parser.js'

// Counts parses, so completion's cost can be checked without timing.
const parses = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/syntax/parser.js', async (importOriginal) => {
  const original = await importOriginal<typeof Parser>()
  return {
    ...original,
    parse: (...args: Parameters<typeof original.parse>) => {
      parses.count++
      return original.parse(...args)
    },
  }
})

/** The code of the error `run` throws, and its cause's code when it has one. */
function failure(run: () => unknown): { code: string; cause?: string } {
  try {
    run()
  } catch (error) {
    if (!(error instanceof BonsaiError)) throw error
    const cause: unknown = error.cause
    return cause instanceof BonsaiError
      ? { code: error.code, cause: cause.code }
      : { code: error.code }
  }
  throw new Error('expected a Bonsai error')
}

describe('completion parses within a fixed budget', () => {
  const rec = t.object({ a: t.number(), name: t.string() })
  const service = createLanguageService(
    bonsai({ variables: { o1: rec, b: t.boolean(), xs: t.list(rec) } }),
  )
  const tail = 'try(let v = b ? let v = (try(1, try({[{[{k: {[b ? o1.'

  it('costs at most 100 parses however the source nests', () => {
    parses.count = 0
    service.complete(tail, tail.length)
    expect(parses.count).toBeLessThanOrEqual(100)
  })

  it('costs a few parses of a long source', () => {
    const pad = `[${Array.from({ length: 16_000 }, () => '9e299').join(',')}].length > 0 && `
    const source = pad + tail
    parses.count = 0
    service.complete(source, source.length)
    expect(parses.count).toBeLessThanOrEqual(12)
  })

  it('still completes nested endings in a short source', () => {
    const items = service.complete('let v = try(o1.', 15).items.map((item) => item.label)
    expect(items).toEqual(expect.arrayContaining(['a', 'name']))
  })
})

describe('known roots skip blocked names', () => {
  it('does not require __proto__, constructor, or prototype in the context', () => {
    const env = bonsai({
      functions: { feat: fn({ params: [], returns: t.boolean(), call: true, run: () => true }) },
    })
    const program = env.compile('order.total > 1 && feat()')
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const known = JSON.parse(`{"${key}": 1, "a": 1}`) as Record<string, unknown>
      const residual = program.partial(known, { unknown: ['order'] })
      if (residual.status !== 'residual') throw new Error('expected a residual')
      expect(residual.evaluateSync({ order: { total: 5 }, a: 1 })).toBe(true)
    }
  })
})

describe('a Bonsai error from host data is the host data failing', () => {
  const inner = bonsai()
  const env = bonsai()
  const context = {
    get lazy(): unknown {
      return inner.evaluateSync('[1, 2, 3].map((x) => x * 2).length', {}, { maxSteps: 2 })
    },
    get bad(): unknown {
      return inner.evaluateSync('1 / 0')
    },
    get unparsable(): unknown {
      return inner.evaluateSync('1 +')
    },
  }

  it('reports a limit error from a getter as HOST_ERROR with the original as cause', () => {
    expect(failure(() => env.evaluateSync('lazy + 1', context))).toEqual({
      code: 'HOST_ERROR',
      cause: 'STEP_LIMIT',
    })
    expect(failure(() => env.evaluateSync('bad', context))).toEqual({
      code: 'HOST_ERROR',
      cause: 'DIVISION_BY_ZERO',
    })
    expect(failure(() => env.evaluateSync('unparsable', context))).toEqual({
      code: 'HOST_ERROR',
      cause: 'SYNTAX',
    })
  })

  it('lets try() recover from it, as from any host failure', () => {
    expect(env.evaluateSync('try(lazy, 0)', context)).toBe(0)
    expect(env.evaluateSync('try(bad, 7)', context)).toBe(7)
  })

  it('reports it as HOST_ERROR in explanations and async evaluation too', async () => {
    const explained = env.explainSync('lazy + 1', context)
    expect(explained.ok ? undefined : explained.error.code).toBe('HOST_ERROR')
    await expect(env.evaluate('lazy + 1', context)).rejects.toMatchObject({ code: 'HOST_ERROR' })
  })

  it('reports it as HOST_ERROR when context validation reads the getter', () => {
    const typed = bonsai({ variables: { lazy: t.number() }, validateContext: true })
    const typedContext = {
      get lazy(): number {
        return context.lazy as number
      },
    }
    expect(failure(() => typed.evaluateSync('lazy', typedContext))).toEqual({
      code: 'HOST_ERROR',
      cause: 'STEP_LIMIT',
    })
  })

  it('keeps the evaluation’s own errors as they are', () => {
    expect(failure(() => env.evaluateSync('1 / 0'))).toEqual({ code: 'DIVISION_BY_ZERO' })
    expect(
      failure(() => env.evaluateSync('[1, 2, 3].map((x) => x * 2)', {}, { maxSteps: 2 })),
    ).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(env.evaluateSync('try(1 / 0, 5)')).toBe(5)
  })
})
