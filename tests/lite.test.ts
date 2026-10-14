import { describe, expect, it } from 'vitest'
import * as main from '../src/index.js'
import * as lite from '../src/lite/index.js'
import type { LiteEnvironment, LiteProgram } from '../src/lite/index.js'
import { createLanguageService } from '../src/service/index.js'

const variables = {
  user: main.t.object({
    name: main.t.string(),
    age: main.t.number(),
    tags: main.t.list(main.t.string()),
    zone: main.t.optional(main.t.string()),
  }),
  orders: main.t.list(main.t.object({ total: main.t.number(), placed: main.t.timestamp() })),
}
const functions = {
  double: main.fn({ params: [main.t.number()], returns: main.t.number(), run: (n) => n * 2 }),
  rate: main.fn({
    params: [main.t.string()],
    returns: main.t.number(),
    async: true,
    run: (code) => Promise.resolve(code === 'EUR' ? 1.1 : 1),
  }),
}
const context = {
  user: { name: 'Ada', age: 36, tags: ['vip', 'beta'], zone: 'Europe/Berlin' },
  orders: [
    { total: 120, placed: new Date('2026-01-02T03:04:05Z') },
    { total: 30, placed: new Date('2026-02-03T04:05:06Z') },
  ],
}

const full = main.bonsai({ variables, functions })
const small = lite.bonsai({ variables, functions })

const SOURCES = [
  'user.age >= 18 && "vip" in user.tags',
  'orders.filter(.total > 50).map(.total).sum()',
  'double(user.age) + orders.length',
  '`${user.name.toUpperCase()} has ${user.tags.length} tags`',
  'orders.map(o => dayOfWeek(o.placed, user.zone ?? "UTC"))',
  'try(user.age / 0, -1)',
  'user.age / 0',
  'user.tags.sortBy(.length).join(",")',
  'let n = orders.length; n > 1 ? "many" : "few"',
  '"x".repeat(100000000)',
]

/** A value or an error, comparable across entry points. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    return main.isBonsaiError(error)
      ? { code: error.code, message: error.message, span: error.span }
      : { thrown: String(error) }
  }
}

async function outcomeAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: await run() }
  } catch (error) {
    return main.isBonsaiError(error)
      ? { code: error.code, message: error.message, span: error.span }
      : { thrown: String(error) }
  }
}

describe('bonsai-js/lite', () => {
  it('evaluates as the main entry does, step budgets included', () => {
    for (const source of SOURCES) {
      for (const maxSteps of [0, 5, 50, 500]) {
        expect(
          outcome(() => small.evaluateSync(source, context, { maxSteps })),
          source,
        ).toEqual(outcome(() => full.evaluateSync(source, context, { maxSteps })))
      }
    }
  })

  it('evaluates async host functions as the main entry does', async () => {
    const source = 'rate("EUR") * orders.map(.total).sum()'
    expect(await outcomeAsync(() => small.evaluate(source, context))).toEqual(
      await outcomeAsync(() => full.evaluate(source, context)),
    )
    expect(outcome(() => small.evaluateSync(source, context))).toEqual(
      outcome(() => full.evaluateSync(source, context)),
    )
  })

  it('checks as the main entry does', () => {
    for (const source of [...SOURCES, 'user.agee > 1', 'user.zone.toUpperCase()', 'a ?? b || c']) {
      const fromLite = small.check(source, { expect: main.t.boolean() })
      const fromMain = full.check(source, { expect: main.t.boolean() })
      expect(fromLite.ok, source).toBe(fromMain.ok)
      expect(fromLite.diagnostics, source).toEqual(fromMain.diagnostics)
      expect(fromLite.type, source).toEqual(fromMain.type)
    }
  })

  it('validates the context as the main entry does', () => {
    const strict = lite.bonsai({ variables, validateContext: true })
    const reference = main.bonsai({ variables, validateContext: true })
    // Untrusted data typed as the context, as it arrives from JSON.
    const bad = { ...context, user: { ...context.user, age: '36' } } as unknown as typeof context
    expect(outcome(() => strict.evaluateSync('user.age', bad))).toEqual(
      outcome(() => reference.evaluateSync('user.age', bad)),
    )
  })

  it('has no explain or partial, at run time', () => {
    const program = small.compile('user.age >= 18')
    for (const name of ['explain', 'explainSync', 'partial']) {
      expect(name in small, name).toBe(false)
      expect(name in program, name).toBe(false)
      expect(name in small.extend({ variables: { extra: main.t.number() } }), name).toBe(false)
    }
    const checked = small.check('user.age >= 18')
    if (!checked.ok) throw new Error('expected the check to pass')
    expect('partial' in checked.program).toBe(false)
    expect(Object.isFrozen(program)).toBe(true)
    expect(Object.isFrozen(small)).toBe(true)
  })

  it('keeps explain and partial on the main entry', () => {
    const program = full.compile('user.age >= 18')
    expect(program.explainSync(context).ok).toBe(true)
    expect(program.partial({}).status).toBe('residual')
    expect(full.partial('user.age >= 18', { user: { age: 3 } })).toEqual({
      status: 'value',
      value: false,
    })
  })

  it('has no explain or partial in its types', () => {
    const program: LiteProgram = small.compile('user.age >= 18')
    // A program from the main entry is also a lite program.
    const fromMain: LiteProgram = full.compile('user.age >= 18')
    const environment: LiteEnvironment = full
    expect([program, fromMain, environment].length).toBe(3)
    // Never called: the lines only have to fail to type-check.
    const typed = (): void => {
      // @ts-expect-error a lite program has no explain()
      void program.explain(context)
      // @ts-expect-error a lite environment has no partial()
      void small.partial('user.age', {})
      // @ts-expect-error extending keeps the environment lite
      void small.extend({}).explainSync('1')
    }
    expect(typeof typed).toBe('function')
  })

  it('works with the language service', () => {
    const service = createLanguageService(small)
    expect(service.diagnostics('user.agee')[0]?.suggestion).toBe('age')
    expect(service.complete('user.', 5).items.map((item) => item.label)).toContain('age')
  })

  it('shares values, errors, and helpers with the main entry', () => {
    expect(lite.t).toBe(main.t)
    expect(lite.fn).toBe(main.fn)
    expect(lite.BonsaiError).toBe(main.BonsaiError)
    expect(lite.Duration).toBe(main.Duration)
    expect(lite.print(lite.parse('a.b + 1'))).toBe('a.b + 1')
  })
})
