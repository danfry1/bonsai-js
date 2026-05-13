import { describe, it, expect } from 'vitest'
import {
  bonsai,
  type BonsaiInstance,
  type BonsaiPlugin,
  type CompiledExpression,
  type ContextFunctionFn,
} from '../src/index.js'

/**
 * Compile-time type assertions. These are validated by `tsc` during the
 * typecheck step rather than by runtime assertions. They lock the public
 * API generics in place against accidental regressions.
 */
describe('addContextFunction / bonsai<TCtx>() type surface', () => {
  it('infers ctx type from the instance generic', () => {
    interface Ctx { userId: string; perms: readonly string[] }
    const app = bonsai<Ctx>()
    app.addContextFunction('whoami', (ctx) => {
      // ctx is Readonly<Ctx> at compile time
      const id: string = ctx.userId
      const perms: readonly string[] = ctx.perms
      return `${id}:${perms.length}`
    })
    expect(app.evaluateSync('whoami()', { userId: 'u_1', perms: ['read'] })).toBe('u_1:1')
  })

  it('accepts a function with a narrower context type (parameter contravariance)', () => {
    interface Ctx { userId: string; perms: readonly string[]; tenantId: string }
    const app = bonsai<Ctx>()
    // Only declare the fields we care about. TS still accepts this because
    // every Ctx is assignable to { userId: string }.
    app.addContextFunction('whoami', (ctx) => ctx.userId)
    expect(app.evaluateSync('whoami()', { userId: 'u_1', perms: [], tenantId: 't' })).toBe('u_1')
  })

  it('rejects wrong-shape context at compile time (verified via ts-expect-error)', () => {
    interface Ctx { userId: string }
    const app = bonsai<Ctx>()
    app.addContextFunction('whoami', (ctx) => ctx.userId)

    // @ts-expect-error typed instances with required context fields require the context argument
    app.evaluateSync('whoami()')

    // @ts-expect-error context is missing the required userId field
    app.evaluateSync('whoami()', { wrongField: 'value' })

    // @ts-expect-error reading an unknown context field is rejected
    app.addContextFunction('bad', (ctx) => ctx.nonexistentField)

    // Sanity: the correct call works at runtime.
    expect(app.evaluateSync('whoami()', { userId: 'u_1' })).toBe('u_1')
  })

  it('default generic (untyped instance) accepts any Record<string, unknown> context', () => {
    const expr = bonsai()
    expr.addContextFunction('grab', (ctx) => ctx.anything)
    expect(expr.evaluateSync('grab()', { anything: 42 })).toBe(42)
    expect(expr.evaluateSync('grab()', { somethingElse: true })).toBe(undefined)
  })

  it('keeps the context argument optional when the context type has no required fields', () => {
    interface OptionalCtx { userId?: string }
    const expr = bonsai<OptionalCtx>()
    expr.addContextFunction('whoami', (ctx) => ctx.userId)
    expect(expr.evaluateSync('whoami()')).toBe(undefined)
    expect(expr.evaluateSync('whoami()', { userId: 'u_1' })).toBe('u_1')

    const compiled = expr.compile('whoami()')
    expect(compiled.evaluateSync()).toBe(undefined)
    expect(compiled.evaluateSync({ userId: 'u_2' })).toBe('u_2')
  })

  it('BonsaiInstance is generic over context', () => {
    interface Ctx { a: number }
    const typed: BonsaiInstance<Ctx> = bonsai<Ctx>()
    const untyped: BonsaiInstance = bonsai()
    expect(typeof typed.addContextFunction).toBe('function')
    expect(typeof untyped.addContextFunction).toBe('function')
  })

  it('CompiledExpression is generic over context', () => {
    interface Ctx { x: number }
    const app = bonsai<Ctx>()
    const compiled: CompiledExpression<Ctx> = app.compile('x')
    expect(compiled.evaluateSync({ x: 5 })).toBe(5)

    // @ts-expect-error typed compiled expressions with required context fields require the context argument
    compiled.evaluateSync()

    // @ts-expect-error wrong context shape on compiled expression
    compiled.evaluateSync({ wrongField: 'value' })
  })

  it('BonsaiPlugin is generic over context', () => {
    interface Ctx { tenantId: string }
    const plugin: BonsaiPlugin<Ctx> = (e) => {
      e.addContextFunction('tenant', (ctx) => ctx.tenantId)
    }
    const app = bonsai<Ctx>().use(plugin)
    expect(app.evaluateSync('tenant()', { tenantId: 't_1' })).toBe('t_1')
  })

  it('plugins typed against a narrower context can be used with a wider instance context', () => {
    interface PluginCtx { tenantId: string }
    interface AppCtx extends PluginCtx { userId: string }
    const plugin: BonsaiPlugin<PluginCtx> = (e) => {
      e.addContextFunction('tenant', (ctx) => ctx.tenantId)
    }
    const app = bonsai<AppCtx>().use(plugin)
    expect(app.evaluateSync('tenant()', { tenantId: 't_1', userId: 'u_1' })).toBe('t_1')

    // @ts-expect-error plugin requires tenantId, but this instance context does not provide it
    bonsai<{ userId: string }>().use(plugin)
  })

  it('untyped plugins work on typed instances without casts', () => {
    const plugin: BonsaiPlugin = (e) => {
      e.addFunction('two', () => 2)
    }
    const app = bonsai<{ x: number }>().use(plugin)
    expect(app.evaluateSync('two()', { x: 1 })).toBe(2)
  })

  it('ContextFunctionFn is exported and useful for explicit typing', () => {
    interface Ctx { value: number }
    const fn: ContextFunctionFn<Ctx> = (ctx, ...args) => (ctx.value * (args[0] as number))
    const app = bonsai<Ctx>()
    app.addContextFunction('multiply', fn)
    expect(app.evaluateSync('multiply(3)', { value: 7 })).toBe(21)
  })

  it('addFunction signature is unchanged (no TCtx leakage)', () => {
    interface Ctx { foo: string }
    const app = bonsai<Ctx>()
    app.addFunction('pure', (...args) => args.length)
    expect(app.evaluateSync('pure(1, 2, 3)', { foo: 'bar' })).toBe(3)
  })

  it('rejects non-object context generics', () => {
    // @ts-expect-error evaluation context must be object-shaped
    bonsai<number>()
    expect(true).toBe(true)
  })
})
