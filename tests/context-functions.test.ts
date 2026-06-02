import { describe, it, expect } from 'vitest'
import { bonsai, BonsaiReferenceError, type BonsaiPlugin } from '../src/index.js'

describe('addContextFunction', () => {
  describe('basic invocation', () => {
    it('receives the supplied context as its first argument', () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('whoami', (ctx) => ctx.userId)
      expect(expr.evaluateSync('whoami()', { userId: 'u_1' })).toBe('u_1')
    })

    it('receives call arguments after the context', () => {
      const expr = bonsai<{ name: string }>()
      expr.addContextFunction('greet', (ctx, salutation) =>
        `${String(salutation)}, ${ctx.name}`)
      expect(expr.evaluateSync('greet("Hello")', { name: 'Dan' })).toBe('Hello, Dan')
    })

    it('works with multiple call arguments', () => {
      const expr = bonsai<{ value: string }>()
      expr.addContextFunction('format', (ctx, prefix, suffix) =>
        `${String(prefix)}${ctx.value}${String(suffix)}`)
      expect(expr.evaluateSync('format("<", ">")', { value: 'x' })).toBe('<x>')
    })

    it('receives a default empty context object when none is provided', () => {
      const expr = bonsai()
      let captured: unknown
      expr.addContextFunction('grab', (ctx) => { captured = ctx; return null })
      expr.evaluateSync('grab()')
      expect(captured).toEqual({})
      expect(Object.isFrozen(captured)).toBe(false)
    })
  })

  describe('context delivery', () => {
    it('passes the live context object to the function by reference', () => {
      const expr = bonsai<{ a: number; b: string }>()
      let captured: Readonly<{ a: number; b: string }> | undefined
      expr.addContextFunction('grab', (ctx) => { captured = ctx; return null })
      const original = { a: 1, b: 'two' }
      expr.evaluateSync('grab()', original)
      // The context is handed over as-is: no defensive copy, no freeze. The
      // function receives the exact object the caller supplied.
      expect(captured).toBe(original)
      expect(Object.isFrozen(captured)).toBe(false)
    })

    it('treats the context as read-only by type, but writes reach the caller object', () => {
      // ctx is typed Readonly<TCtx> to signal read-only intent, yet it is the
      // live object. A function that deliberately casts away readonly and writes
      // mutates the caller's context. This test documents that contract.
      const expr = bonsai<{ name: string }>()
      expr.addContextFunction('inject', (ctx) => {
        const mutable = ctx as { name: string; injected?: string }
        mutable.injected = 'value'
        return null
      })
      const original: { name: string; injected?: string } = { name: 'Dan' }
      expr.evaluateSync('inject()', original)
      expect(original.injected).toBe('value')
    })

    it('passes the same context object to every context-function call in one evaluation', () => {
      const expr = bonsai<{ x: number }>()
      const captured: unknown[] = []
      expr.addContextFunction('snap', (ctx) => { captured.push(ctx); return ctx.x })
      const original = { x: 1 }
      expr.evaluateSync('snap() + snap() + snap()', original)
      expect(captured.length).toBe(3)
      expect(captured[0]).toBe(original)
      expect(captured[1]).toBe(original)
      expect(captured[2]).toBe(original)
    })

    it('passes through the exact context given to each top-level evaluation', () => {
      const expr = bonsai<{ x: number }>()
      const captured: unknown[] = []
      expr.addContextFunction('snap', (ctx) => { captured.push(ctx); return ctx.x })
      const first = { x: 1 }
      const second = { x: 2 }
      expr.evaluateSync('snap()', first)
      expr.evaluateSync('snap()', second)
      expect(captured[0]).toBe(first)
      expect(captured[1]).toBe(second)
    })

    it('does not pass context to pure functions registered via addFunction', () => {
      const expr = bonsai<{ extra: string }>()
      expr.addFunction('pure', (...args) => args.length)
      expr.addContextFunction('contextual', (_ctx, ...args) => args.length)
      expect(expr.evaluateSync('pure(1, 2)', { extra: 'ignored' })).toBe(2)
      expect(expr.evaluateSync('contextual(1, 2)', { extra: 'ignored' })).toBe(2)
    })
  })

  describe('async invocation', () => {
    it('works with async context functions via evaluate', async () => {
      const expr = bonsai<{ tier: 'pro' | 'free' }>()
      expr.addContextFunction('asyncLookup', async (ctx) => {
        await new Promise(resolve => { setTimeout(resolve, 1) })
        return ctx.tier
      })
      const result = await expr.evaluate('asyncLookup() == "pro"', { tier: 'pro' })
      expect(result).toBe(true)
    })

    it('rejects async context functions in evaluateSync with a helpful error', () => {
      const expr = bonsai<{ value: number }>()
      expr.addContextFunction('lookup', async (ctx) => ctx.value)
      expect(() => expr.evaluateSync('lookup()', { value: 1 })).toThrow(/lookup/u)
    })

    it('supports parallel-safe context across async functions', async () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('slow', async (ctx) => {
        await new Promise(r => { setTimeout(r, 5) })
        return ctx.userId
      })

      const results = await Promise.all([
        expr.evaluate<string>('slow()', { userId: 'u_1' }),
        expr.evaluate<string>('slow()', { userId: 'u_2' }),
        expr.evaluate<string>('slow()', { userId: 'u_3' }),
      ])
      expect(results).toEqual(['u_1', 'u_2', 'u_3'])
    })
  })

  describe('compiled expressions', () => {
    it('preserves context-function behavior across compile + evaluateSync', () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('whoami', (ctx) => ctx.userId)
      const compiled = expr.compile('whoami()')
      expect(compiled.evaluateSync({ userId: 'u_1' })).toBe('u_1')
      expect(compiled.evaluateSync({ userId: 'u_2' })).toBe('u_2')
    })

    it('preserves context-function behavior across compile + async evaluate', async () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('whoami', async (ctx) => ctx.userId)
      const compiled = expr.compile('whoami()')
      expect(await compiled.evaluate({ userId: 'u_1' })).toBe('u_1')
      expect(await compiled.evaluate({ userId: 'u_2' })).toBe('u_2')
    })
  })

  describe('namespace and introspection', () => {
    it('addContextFunction(name) overwrites a prior addFunction(name)', () => {
      const expr = bonsai<{ value: string }>()
      expr.addFunction('x', () => 'pure')
      expr.addContextFunction('x', (ctx) => `ctx:${ctx.value}`)
      expect(expr.evaluateSync('x()', { value: 'hi' })).toBe('ctx:hi')
      expect(expr.isContextFunction('x')).toBe(true)
    })

    it('addFunction(name) overwrites a prior addContextFunction(name)', () => {
      const expr = bonsai<{ value: string }>()
      expr.addContextFunction('x', (ctx) => `ctx:${ctx.value}`)
      expr.addFunction('x', () => 'pure')
      expect(expr.evaluateSync('x()', { value: 'hi' })).toBe('pure')
      expect(expr.isContextFunction('x')).toBe(false)
    })

    it('hasFunction returns true for context-registered names', () => {
      const expr = bonsai<{ value: number }>()
      expr.addContextFunction('x', (ctx) => ctx.value)
      expect(expr.hasFunction('x')).toBe(true)
    })

    it('removeFunction removes context-registered names', () => {
      const expr = bonsai<{ value: number }>()
      expr.addContextFunction('x', (ctx) => ctx.value)
      expect(expr.removeFunction('x')).toBe(true)
      expect(expr.hasFunction('x')).toBe(false)
      expect(expr.isContextFunction('x')).toBe(false)
    })

    it('listFunctions includes both pure and context-aware names without duplicates', () => {
      const expr = bonsai<{ x: number }>()
      expr.addFunction('a', () => 1)
      expr.addContextFunction('b', (ctx) => ctx.x)
      expr.addContextFunction('a', (ctx) => ctx.x)
      const names = expr.listFunctions().sort()
      expect(names).toEqual(['a', 'b'])
    })

    it('isContextFunction returns false for pure functions', () => {
      const expr = bonsai()
      expr.addFunction('pure', () => 1)
      expect(expr.isContextFunction('pure')).toBe(false)
    })

    it('isContextFunction returns false for unknown names', () => {
      const expr = bonsai()
      expect(expr.isContextFunction('missing')).toBe(false)
    })
  })

  describe('reference resolution', () => {
    it('throws a helpful BonsaiReferenceError for unknown function names', () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('lookupUser', (ctx) => ctx.userId)
      expect(() => expr.evaluateSync('lookupUsr()', { userId: 'u_1' })).toThrow(BonsaiReferenceError)
    })

    it('suggests context-registered names in reference errors', () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('lookupUser', (ctx) => ctx.userId)
      try {
        expr.evaluateSync('lookpUser()', { userId: 'u_1' })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(BonsaiReferenceError)
        expect((err as Error).message).toMatch(/lookupUser/u)
      }
    })

    it('suggests across both pure and context registries when name is unknown', () => {
      const expr = bonsai<{ x: number }>()
      expr.addFunction('purefn', () => 0)
      expr.addContextFunction('ctxfn', (ctx) => ctx.x)
      try {
        expr.evaluateSync('ctxfm()', { x: 1 })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(BonsaiReferenceError)
        // The suggestion should reach into the context-function namespace too
        expect((err as Error).message).toMatch(/ctxfn/u)
      }
    })
  })

  describe('error semantics', () => {
    it('missing context fields resolve to undefined inside the function (no throw)', () => {
      // Matches bonsai's general behavior: unsupplied identifiers are undefined,
      // not errors. Stays consistent for context functions.
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('whoami', (ctx) => ctx.userId)
      // Cast removes the readonly-shape requirement so we can simulate a call
      // from JS where no context object is supplied at all.
      const noCtx = expr as unknown as { evaluateSync: (s: string) => unknown }
      expect(noCtx.evaluateSync('whoami()')).toBe(undefined)
    })

    it('errors thrown from the function propagate as-is', () => {
      // Plain user errors propagate without modification. Bonsai only decorates
      // its own typed errors (BonsaiTypeError, BonsaiSecurityError,
      // BonsaiReferenceError) with source-location formatting.
      const expr = bonsai<{ userId: string }>()
      const sentinel = new Error('intentional')
      expr.addContextFunction('boom', () => { throw sentinel })
      try {
        expr.evaluateSync('1 + boom()', { userId: 'u_1' })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBe(sentinel)
      }
    })

    it('errors thrown from async functions propagate via the returned promise', async () => {
      const expr = bonsai<{ userId: string }>()
      expr.addContextFunction('boom', async () => { throw new Error('async-boom') })
      await expect(expr.evaluate('boom()', { userId: 'u_1' })).rejects.toThrow(/async-boom/u)
    })

    it('reports the function name when evaluateSync sees a promise from a context function', () => {
      const expr = bonsai<{ tier: string }>()
      expr.addContextFunction('asyncCtx', async (ctx) => ctx.tier)
      expect(() => expr.evaluateSync('asyncCtx()', { tier: 'pro' })).toThrow(/asyncCtx/u)
    })
  })

  describe('plugin integration', () => {
    it('plugins can register context-aware functions', () => {
      interface Ctx { tenantId: string }
      const tenancy: BonsaiPlugin<Ctx> = (e) => {
        e.addContextFunction('currentTenant', (ctx) => ctx.tenantId)
      }
      const app = bonsai<Ctx>()
      app.use(tenancy)
      expect(app.evaluateSync('currentTenant()', { tenantId: 't_42' })).toBe('t_42')
    })

    it('plugins typed against a narrower context work on wider instances', () => {
      interface PluginCtx { tenantId: string }
      interface AppCtx extends PluginCtx { userId: string }
      const tenancy: BonsaiPlugin<PluginCtx> = (e) => {
        e.addContextFunction('currentTenant', (ctx) => ctx.tenantId)
      }
      const app = bonsai<AppCtx>()
      app.use(tenancy)
      expect(app.evaluateSync('currentTenant()', { tenantId: 't_42', userId: 'u_1' })).toBe('t_42')
    })

    it('untyped plugins continue to work on typed instances via default generic', () => {
      const plugin: BonsaiPlugin = (e) => {
        e.addFunction('two', () => 2)
      }
      const app = bonsai<{ x: number }>()
      app.use(plugin)
      expect(app.evaluateSync('two()', { x: 1 })).toBe(2)
    })
  })

  describe('integration with other features', () => {
    it('composes with pipe transforms', () => {
      const expr = bonsai<{ userName: string }>()
      expr.addContextFunction('userName', (ctx) => ctx.userName)
      expr.addTransform('upper', (v) => String(v).toUpperCase())
      expect(expr.evaluateSync('userName() |> upper', { userName: 'dan' })).toBe('DAN')
    })

    it('can be used inside conditional expressions', () => {
      const expr = bonsai<{ tier: 'pro' | 'free' }>()
      expr.addContextFunction('isPro', (ctx) => ctx.tier === 'pro')
      expect(expr.evaluateSync('isPro() ? "yes" : "no"', { tier: 'pro' })).toBe('yes')
      expect(expr.evaluateSync('isPro() ? "yes" : "no"', { tier: 'free' })).toBe('no')
    })

    it('can be used inside lambdas (array.filter with bonsai lambda syntax)', () => {
      interface Ctx { minAge: number; users: readonly { age: number }[] }
      const expr = bonsai<Ctx>()
      expr.addContextFunction('threshold', (ctx) => ctx.minAge)
      const result = expr.evaluateSync(
        'users.filter(.age >= threshold())',
        { minAge: 18, users: [{ age: 16 }, { age: 21 }, { age: 19 }] },
      )
      expect(result).toEqual([{ age: 21 }, { age: 19 }])
    })
  })
})
