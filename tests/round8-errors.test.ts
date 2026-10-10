import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BonsaiError,
  BonsaiLimitError,
  BonsaiRuntimeError,
  bonsai,
  fn,
  parse,
  t,
} from '../src/index.js'
import { toMongo, toSQL } from '../src/query/index.js'

/** The error of a failed explanation, or undefined for anything else. */
function explanationError(result: unknown): unknown {
  if (typeof result === 'object' && result !== null && 'ok' in result && 'error' in result)
    return result.ok === false ? result.error : undefined
  return undefined
}

/** The error `run` throws (or the error of the failed explanation it returns), or undefined. */
function caught(run: () => unknown): unknown {
  try {
    return explanationError(run())
  } catch (error) {
    return error
  }
}

async function caughtAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return explanationError(await run())
  } catch (error) {
    return error
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof BonsaiError ? error.code : undefined
}

interface LazyContext {
  readonly lazy: number
  readonly x: number
}

/** A context whose `lazy` getter throws what `make` throws. */
function lazyContext(make: () => unknown): LazyContext {
  const context = Object.defineProperty({ x: 1 }, 'lazy', {
    enumerable: true,
    get() {
      return make()
    },
  })
  return context as unknown as LazyContext
}

const row = bonsai({ variables: { row: t.object({ total: t.number() }) } })
const filter = row.compile('row.total > 1 && row.total < 5')
const inner = bonsai()

/** The Bonsai error `run` throws, for building one a getter can throw. */
function errorFrom(run: () => unknown): BonsaiError {
  const error = caught(run)
  if (!(error instanceof BonsaiError)) throw new Error('expected a Bonsai error')
  return error
}

/**
 * Bonsai errors that are not the reading evaluation's own: each maker builds
 * a fresh one, from every place outside an evaluation a host could get one.
 */
const foreign: Record<string, () => BonsaiError> = {
  parse: () => errorFrom(() => parse('1 +')),
  parseLimit: () => errorFrom(() => parse(`${'('.repeat(300)}1${')'.repeat(300)}`)),
  compile: () => errorFrom(() => inner.compile('nope(')),
  check: () => errorFrom(() => inner.compile('1 + "a"')),
  sqlSteps: () =>
    errorFrom(() =>
      toSQL(filter, { row: 'row', columns: { total: 'number' }, dialect: 'sqlite', maxSteps: 1 }),
    ),
  mongoUntranslatable: () =>
    errorFrom(() =>
      toMongo(row.compile('try(row.total, 1) > 0'), { row: 'row', fields: { total: 'number' } }),
    ),
  evaluation: () => errorFrom(() => inner.evaluateSync('1 / 0')),
  evaluationLimit: () =>
    errorFrom(() => inner.evaluateSync('[1, 2, 3].map(. * 2)', {}, { maxSteps: 2 })),
  builtRuntime: () => new BonsaiRuntimeError('DIVISION_BY_ZERO', 'built by the host'),
  builtLimit: () => new BonsaiLimitError('STEP_LIMIT', 'built by the host'),
}

const variables = { lazy: t.number(), x: t.number() }
const plain = bonsai({ variables })
const validated = bonsai({ variables, validateContext: true })

describe('a Bonsai error from host data is the host data failing', () => {
  for (const [name, make] of Object.entries(foreign)) {
    it(`reports ${name} thrown by a getter as HOST_ERROR, with it as the cause`, () => {
      const entries: Record<string, (ctx: LazyContext) => unknown> = {
        evaluateSync: (ctx) => plain.evaluateSync('lazy + 1', ctx),
        'validated evaluateSync': (ctx) => validated.evaluateSync('lazy + 1', ctx),
        explainSync: (ctx) => plain.explainSync('lazy + 1', ctx),
        partial: (ctx) => plain.compile('lazy + x').partial(ctx),
        'validated partial': (ctx) => validated.compile('lazy + x').partial(ctx),
      }
      for (const [entry, run] of Object.entries(entries)) {
        let thrown: BonsaiError | undefined
        const error = caught(() =>
          run(
            lazyContext(() => {
              thrown = make()
              throw thrown
            }),
          ),
        )
        expect(error, entry).toBeInstanceOf(BonsaiRuntimeError)
        expect(codeOf(error), entry).toBe('HOST_ERROR')
        expect((error as BonsaiError).cause, entry).toBe(thrown)
      }
    })

    it(`lets try() recover from ${name} thrown by a getter`, () => {
      const ctx = lazyContext(() => {
        throw make()
      })
      expect(plain.evaluateSync('try(lazy, 0)', ctx)).toBe(0)
      expect(plain.evaluateSync('try([x].map((i) => lazy), [])', ctx)).toEqual([])
    })
  }

  it('reports a translation limit a getter ran into as HOST_ERROR', () => {
    const ctx = lazyContext(() =>
      toSQL(filter, { row: 'row', columns: { total: 'number' }, dialect: 'sqlite', maxSteps: 1 }),
    )
    const error = caught(() => plain.evaluateSync('lazy + 1', ctx))
    expect(codeOf(error)).toBe('HOST_ERROR')
    expect(codeOf((error as BonsaiError).cause)).toBe('STEP_LIMIT')
  })
})

describe("an evaluation's own errors keep their code", () => {
  it('keeps runtime, limit, validation, and contract errors', async () => {
    const env = bonsai({ variables: { n: t.number() }, validateContext: true })
    expect(codeOf(caught(() => env.evaluateSync('1 / n', { n: 0 })))).toBe('DIVISION_BY_ZERO')
    expect(
      codeOf(caught(() => env.evaluateSync('[n, n].map(. + 1)', { n: 1 }, { maxSteps: 2 }))),
    ).toBe('STEP_LIMIT')
    const wrong = { n: 'a' } as unknown as { n: number }
    expect(codeOf(caught(() => env.evaluateSync('n', wrong)))).toBe('INVALID_CONTEXT')
    expect(
      codeOf(caught(() => env.evaluateSync('n', { n: 1 }, { signal: AbortSignal.abort() }))),
    ).toBe('ABORTED')
    const clockless = bonsai({ clock: () => 'never' as unknown as Date })
    expect(codeOf(caught(() => clockless.evaluateSync('now()')))).toBe('HOST_CONTRACT')
    const liar = bonsai({
      functions: {
        h: fn({ params: [], returns: t.number(), run: () => 'not a number' as unknown as number }),
      },
    })
    expect(codeOf(caught(() => liar.evaluateSync('h()')))).toBe('HOST_CONTRACT')
    expect(codeOf(await caughtAsync(() => env.evaluate('1 / n', { n: 0 })))).toBe(
      'DIVISION_BY_ZERO',
    )
  })

  it("keeps a residual's own errors, and the missing-root error", () => {
    const env = bonsai({
      functions: {
        feature: fn({
          params: [t.string()],
          returns: t.boolean(),
          call: true,
          run: (call, name) => {
            const context = call.context as { tenant?: { features?: string[] } }
            return (context.tenant?.features ?? []).includes(name)
          },
        }),
      },
    })
    const result = env
      .compile('order.total / order.count > 1 && feature("bulk")')
      .partial({ tenant: { features: ['bulk'] } })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(codeOf(caught(() => result.evaluateSync({ order: { total: 4, count: 2 } })))).toBe(
      'INVALID_CONTEXT',
    )
    expect(
      codeOf(
        caught(() =>
          result.evaluateSync({ order: { total: 4, count: 0 }, tenant: { features: [] } }),
        ),
      ),
    ).toBe('DIVISION_BY_ZERO')
  })

  it('keeps its own step limit while it reads a getter', () => {
    const env = bonsai()
    const ctx = {
      get items() {
        return [1, 2, 3]
      },
    }
    expect(
      codeOf(caught(() => env.evaluateSync('items.map(. * 2).length', ctx, { maxSteps: 3 }))),
    ).toBe('STEP_LIMIT')
  })
})

describe('host data that throws a Bonsai error, at random', () => {
  const makers = Object.values(foreign)
  const sources = ['lazy + 1', 'lazy ?? 1', '[x].map((i) => lazy).length', 'x > 0 && lazy > 0']
  type Entry = (env: typeof plain, source: string, ctx: LazyContext) => unknown
  const entries: Entry[] = [
    (env, source, ctx) => caught(() => env.evaluateSync(source, ctx)),
    (env, source, ctx) => caughtAsync(() => env.evaluate(source, ctx)),
    (env, source, ctx) => caught(() => env.explainSync(source, ctx)),
    (env, source, ctx) => caughtAsync(() => env.explain(source, ctx)),
    (env, source, ctx) => caught(() => env.explainSync(source, ctx, { exhaustive: true })),
    (env, source, ctx) => caught(() => env.compile(source).partial(ctx)),
    (env, source, ctx) => {
      const result = env.compile(source).partial({ x: 1 }, { unknown: ['lazy'] })
      if (result.status !== 'residual') throw new Error('expected a residual')
      return caught(() => result.evaluateSync(ctx))
    },
  ]

  it('is always HOST_ERROR with the thrown error as its cause', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: makers.length - 1 }),
        fc.nat({ max: entries.length - 1 }),
        fc.nat({ max: sources.length - 1 }),
        fc.boolean(),
        async (maker, entry, source, validate) => {
          let thrown: BonsaiError | undefined
          const ctx = lazyContext(() => {
            thrown = makers[maker]()
            throw thrown
          })
          const error = await entries[entry](validate ? validated : plain, sources[source], ctx)
          expect(codeOf(error)).toBe('HOST_ERROR')
          expect((error as BonsaiError).cause).toBe(thrown)
        },
      ),
      { numRuns: 400 },
    )
  })
})
