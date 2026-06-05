import { describe, it, expect } from 'vitest'
import { bonsai, type BonsaiPlugin, type PluginRegistrar } from '../src/index.js'
import { arrays, strings, all } from '../src/stdlib/index.js'

/**
 * Compile-time assertions for plugin/context variance. Validated by `tsc` during
 * the typecheck step, not at runtime. They pin the sound-by-construction design:
 *
 *   - Plugins receive a `PluginRegistrar<TCtx>` (registration surface only), not
 *     the full instance. That view is covariant in `TCtx` because `TCtx` only
 *     appears in the `ctx` parameter of an `addContextFunction` callback.
 *   - `use(plugin: BonsaiPlugin<TCtx>)` is therefore a single, sound arm: it
 *     accepts exactly the plugins whose required context `TCtx` satisfies, with
 *     no union, no cast, and no dependence on `interface`-vs-`type`.
 *   - A plugin that requires context the instance does not provide is rejected.
 */
describe('plugin/context variance', () => {
  interface IFaceCtx {
    items: number[]
  }
  // Intentionally a `type` alias to assert it behaves identically to the interface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  type LiteralCtx = { items: number[] }
  interface NarrowCtx {
    tenantId: string
  }
  interface WideCtx extends NarrowCtx {
    userId: string
  }

  // Context-agnostic plugin: default requirement is `object`, so it applies anywhere.
  const agnostic: BonsaiPlugin = (r) => {
    r.addTransform('double', (v) => (v as number) * 2)
    r.addFunction('two', () => 2)
  }
  const tenantPlugin: BonsaiPlugin<NarrowCtx> = (r) => {
    r.addContextFunction('tenant', (ctx) => ctx.tenantId)
  }

  it('applies context-agnostic and stdlib plugins to any context shape without a cast', () => {
    const iface = bonsai<IFaceCtx>().use(agnostic).use(arrays).use(strings).use(all)
    expect(iface.evaluateSync('items |> count', { items: [1, 2, 3] })).toBe(3)
    expect(iface.evaluateSync('two()', { items: [] })).toBe(2)

    const literal = bonsai<LiteralCtx>().use(agnostic).use(arrays)
    expect(literal.evaluateSync('items |> count', { items: [1] })).toBe(1)

    const untyped = bonsai().use(agnostic).use(arrays)
    expect(untyped.evaluateSync('two()')).toBe(2)
  })

  it('accepts a narrower-context plugin on a wider context', () => {
    const app = bonsai<WideCtx>().use(tenantPlugin)
    expect(app.evaluateSync('tenant()', { tenantId: 't_1', userId: 'u_1' })).toBe('t_1')
  })

  it('composes plugins through the registrar', () => {
    const combined: BonsaiPlugin = (r) => {
      r.use(agnostic).use(arrays)
    }
    const app = bonsai<IFaceCtx>().use(combined)
    expect(app.evaluateSync('two()', { items: [] })).toBe(2)
  })

  it('rejects plugins whose context requirement the instance cannot satisfy', () => {
    // Disjoint: instance has no tenantId.
    // @ts-expect-error plugin requires tenantId, which this instance does not provide
    bonsai<{ userId: string }>().use(tenantPlugin)
    // @ts-expect-error interface instance lacks tenantId
    bonsai<IFaceCtx>().use(tenantPlugin)

    // Superset: the plugin needs a field beyond what the instance declares.
    const greedy: BonsaiPlugin<{ items: number[]; secret: string }> = (r) => {
      r.addContextFunction('s', (ctx) => ctx.secret)
    }
    // @ts-expect-error plugin requires `secret`, which this instance does not provide
    bonsai<IFaceCtx>().use(greedy)

    expect(true).toBe(true)
  })

  it('hands plugins a registrar, not the full instance', () => {
    const probe: BonsaiPlugin<IFaceCtx> = (r) => {
      r.addTransform('noop', (v) => v)
      // A plugin cannot evaluate against a context it did not supply. These assert
      // the registrar's type surface; the trivial expression keeps the call (which
      // still reaches the real instance at runtime) harmless.
      // @ts-expect-error `evaluateSync` is not part of the plugin registration surface
      r.evaluateSync('1')
      // @ts-expect-error `compile` is not part of the plugin registration surface
      r.compile('1')
    }
    bonsai<IFaceCtx>().use(probe)
    expect(true).toBe(true)
  })

  it('checks addContextFunction readers against the declared context', () => {
    const app = bonsai<WideCtx>()
    // Reading a subset is fine.
    app.addContextFunction('ok', (ctx) => ctx.tenantId)
    // A reader that touches a field the context does not declare is rejected.
    // Extracted to a const so the asserted line stays single-line and stable.
    const readSecret = (ctx: Readonly<{ tenantId: string; secret: string }>) => ctx.secret
    // @ts-expect-error reads `secret`, which the instance context does not declare
    app.addContextFunction('bad', readSecret)
    expect(true).toBe(true)
  })

  it('makes PluginRegistrar exactly covariant in its context (not bivariant)', () => {
    const wide = {} as PluginRegistrar<{ a: number; b: string }>
    const narrow = {} as PluginRegistrar<{ a: number }>
    // Wider context registrar is usable where a narrower one is expected.
    const widened: PluginRegistrar<{ a: number }> = wide
    // The reverse is unsound and must be rejected.
    // @ts-expect-error a narrower-context registrar is not a wider-context registrar
    const narrowed: PluginRegistrar<{ a: number; b: string }> = narrow
    void widened
    void narrowed
    expect(true).toBe(true)
  })

  it('keeps the context argument required/optional consistent on an interface context', () => {
    const app = bonsai<IFaceCtx>().use(arrays)

    // The argument is mandatory at the type level for a required-field context.
    // These assert the *signature*; the trivial expression keeps the call (which
    // still executes despite @ts-expect-error) harmless at runtime.
    // @ts-expect-error required-field interface context must be supplied
    app.evaluateSync('1')
    expect(app.evaluateSync('items |> count', { items: [1, 2, 3] })).toBe(3)

    const compiled = app.compile('1')
    // @ts-expect-error compiled expression requires the context too
    compiled.evaluateSync()
    expect(compiled.evaluateSync({ items: [9] })).toBe(1)

    interface OptionalIFace {
      items?: number[]
    }
    const optional = bonsai<OptionalIFace>().use(arrays)
    // No argument required when every field is optional.
    expect(optional.evaluateSync('1')).toBe(1)
  })
})
