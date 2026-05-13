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

    it('returns an empty frozen object when no context is provided', () => {
      const expr = bonsai()
      let captured: unknown
      expr.addContextFunction('grab', (ctx) => { captured = ctx; return null })
      expr.evaluateSync('grab()')
      expect(captured).toEqual({})
      expect(Object.isFrozen(captured)).toBe(true)
    })
  })

  describe('isolation', () => {
    it('passes a frozen context to the function', () => {
      const expr = bonsai<{ a: number; b: string }>()
      let captured: Readonly<{ a: number; b: string }> | undefined
      expr.addContextFunction('grab', (ctx) => { captured = ctx; return null })
      expr.evaluateSync('grab()', { a: 1, b: 'two' })
      expect(Object.isFrozen(captured)).toBe(true)
    })

    it('does not mutate the original context object when the function tries to write', () => {
      const expr = bonsai<{ name: string }>()
      expr.addContextFunction('mutate', (ctx) => {
        // Attempt to mutate the frozen copy. Throws in strict mode (ESM modules
        // are always strict), so swallow to assert isolation regardless.
        try { (ctx as { name: string; injected?: string }).injected = 'bad' } catch { /* expected */ }
        return null
      })
      const original = { name: 'Dan' }
      expr.evaluateSync('mutate()', original)
      expect(original).toEqual({ name: 'Dan' })
      expect(Object.isFrozen(original)).toBe(false)
    })

    it('shares one frozen snapshot across multiple context-function calls in one evaluation', () => {
      const expr = bonsai<{ x: number }>()
      const captured: unknown[] = []
      expr.addContextFunction('snap', (ctx) => { captured.push(ctx); return ctx.x })
      expr.evaluateSync('snap() + snap() + snap()', { x: 1 })
      expect(captured.length).toBe(3)
      expect(captured[0]).toBe(captured[1])
      expect(captured[1]).toBe(captured[2])
    })

    it('creates a fresh snapshot per top-level evaluation', () => {
      const expr = bonsai<{ x: number }>()
      const captured: unknown[] = []
      expr.addContextFunction('snap', (ctx) => { captured.push(ctx); return ctx.x })
      expr.evaluateSync('snap()', { x: 1 })
      expr.evaluateSync('snap()', { x: 2 })
      expect(captured[0]).not.toBe(captured[1])
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
