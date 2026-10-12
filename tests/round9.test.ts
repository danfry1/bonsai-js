import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t, type Trace } from '../src/index.js'
import { toMongo, toSQL } from '../src/query/index.js'

/** The code of the Bonsai error `run` throws, or `value` when it returns. */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'value'
  } catch (error) {
    return error instanceof BonsaiError ? error.code : 'RAW'
  }
}

describe('the reason a host call is aborted with', () => {
  it("is never another evaluation's own error", async () => {
    const plain = bonsai()
    let inner: unknown
    const env = bonsai({
      functions: {
        slow: fn({
          params: [],
          returns: t.number(),
          async: true,
          call: true,
          run: async (call) => {
            await new Promise((resolve) => {
              call.signal.addEventListener('abort', resolve)
            })
            // A getter that rethrows the abort reason inside another evaluation.
            const context = {
              x: {
                get y(): number {
                  throw call.signal.reason
                },
              },
            }
            inner = plain.evaluateSync('try(x.y, 0)', context)
            return 1
          },
        }),
      },
    })
    const outer = await env.evaluate('slow()', {}, { timeout: 20 }).then(
      () => 'value',
      (error: unknown) => (error instanceof BonsaiError ? error.code : 'RAW'),
    )
    // The inner evaluation recovers from a host failure; the outer keeps its own TIMEOUT.
    expect(inner).toBe(0)
    expect(outer).toBe('TIMEOUT')
  })
})

describe('partial() and known data that throws when read', () => {
  const env = bonsai()
  const lazy = (): { readonly y: number } => ({
    get y(): number {
      throw new Error('lazy field unavailable')
    },
  })

  it('decides what evaluation decides without reaching the read', () => {
    const skipped = env.compile('n > 5 && x.y > 1').partial({ n: 2, x: lazy() })
    expect(skipped.status === 'value' && skipped.value).toBe(false)
    const recovered = env.compile('try(x.y, 0)').partial({ n: 2, x: lazy() })
    expect(recovered.status === 'value' && recovered.value).toBe(0)
  })

  it('fails as evaluation does when the read is always reached', () => {
    const program = env.compile('x.y > 1')
    expect(codeOf(() => program.evaluateSync({ x: lazy() }))).toBe('HOST_ERROR')
    const result = program.partial({ x: lazy() })
    expect(result.status === 'error' && result.error.code).toBe('HOST_ERROR')
  })

  it('never runs a getter to decide which variables a call: true residual needs', () => {
    let reads = 0
    const known = (): Record<string, unknown> => ({
      b: true,
      get u(): never {
        reads++
        throw new Error('getter failed')
      },
    })
    const withHost = bonsai({
      functions: {
        hcx: fn({ params: [], returns: t.string(), call: true, run: () => 'abc' }),
        hr: fn({ params: [t.any()], returns: t.number(), run: () => 1 }),
      },
    })
    const program = withHost.compile('try(hcx().length + hr(u.name), 0)')
    expect(program.evaluateSync(known())).toBe(0)
    reads = 0
    const result = program.partial(known(), { unknown: [] })
    // Folding may read u.name, as evaluation does; collecting the known roots never does.
    expect(reads).toBeLessThanOrEqual(1)
    expect(result.status).toBe('residual')
    if (result.status === 'residual') expect(result.evaluateSync(known())).toBe(0)
  })
})

describe('serializing an explanation', () => {
  /** A Proxy with `keys` keys whose descriptor lookups are counted. */
  function countingProxy(keys: number): { value: object; descriptorReads: () => number } {
    const names = Array.from({ length: keys }, (_, i) => `k${i}`)
    let reads = 0
    const value = new Proxy(
      {},
      {
        ownKeys: () => names,
        getOwnPropertyDescriptor: (_target, key) => {
          reads++
          return typeof key === 'string' && key.startsWith('k')
            ? { value: 1, enumerable: true, configurable: true, writable: true }
            : undefined
        },
      },
    )
    return { value, descriptorReads: () => reads }
  }

  it('costs the same however many keys a map has, and however the traces are picked out', () => {
    /** Descriptor reads while serializing (not evaluating) an explanation of a `keys`-key map. */
    const serializingReads = (keys: number): number => {
      const { value, descriptorReads } = countingProxy(keys)
      const source = Array.from({ length: 200 }, () => 'm.a == 1').join(' && ')
      const explanation = bonsai({ limits: { maxSourceLength: 50_000 } }).explainSync(
        source,
        { m: value },
        { exhaustive: true },
      )
      const evaluated = descriptorReads()
      JSON.stringify(explanation.reasons())
      JSON.stringify(explanation.reasons().filter((reason) => reason.kind === 'Binary'))
      JSON.stringify({ why: [...explanation.reasons()] })
      JSON.stringify(explanation.trace.children)
      String(explanation)
      return descriptorReads() - evaluated
    }
    // A listing looks at the first keys only, once per explanation, so a larger
    // map never costs more (its listing is charged more, so it may cost less).
    expect(serializingReads(100_000)).toBeLessThanOrEqual(serializingReads(1_000))
  })

  it('serializes lambda runs boundedly, cycles included', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const explanation = bonsai().explainSync('xs.filter(.a == 1).length', { xs: [cyclic, cyclic] })
    const withRuns = (trace: Trace): Trace | undefined =>
      trace.iterations === undefined
        ? trace.children.map(withRuns).find((found) => found !== undefined)
        : trace
    const call = withRuns(explanation.trace)
    expect(call?.iterations).toHaveLength(2)
    expect(JSON.stringify(call?.iterations)).toContain('[Circular]')
  })

  it('keeps plain objects for traces', () => {
    const explanation = bonsai().explainSync('a + 1', { a: 1 })
    expect(Object.getPrototypeOf(explanation.trace)).toBe(Object.prototype)
    expect(Object.keys(explanation.trace)).not.toContain('toJSON')
  })
})

describe('translating known data that throws when read', () => {
  it('keeps the host error as the cause', () => {
    const env = bonsai({
      variables: { x: t.object({ y: t.number() }), row: t.object({ a: t.number() }) },
    })
    const program = env.compile('row.a > x.y')
    const failure = new Error('db down')
    const x = {
      get y(): number {
        throw failure
      },
    }
    for (const translate of [
      () =>
        toSQL(program, { row: 'row', columns: { a: 'number' }, dialect: 'sqlite', known: { x } }),
      () => toMongo(program, { row: 'row', fields: { a: 'number' }, known: { x } }),
    ]) {
      let caught: unknown
      try {
        translate()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(BonsaiError)
      expect((caught as BonsaiError).code).toBe('UNTRANSLATABLE')
      expect((caught as BonsaiError).cause).toBe(failure)
    }
  })
})
