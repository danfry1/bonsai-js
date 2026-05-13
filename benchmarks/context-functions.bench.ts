import { describe, bench } from 'vitest'
import { bonsai } from '../src/index.js'

/**
 * Validate that:
 *   1. Pure function calls are unaffected by the context-functions feature
 *      (we want zero regression on the hot path for users who do not adopt it).
 *   2. Context function calls have predictable cost (one shallow-frozen copy
 *      per top-level evaluation, amortised across multiple calls).
 *   3. Lazy frozen-context caching genuinely avoids per-call freeze cost.
 */

const pureExpr = bonsai()
pureExpr.addFunction('id', (x) => x)

const ctxExpr = bonsai<{ value: number }>()
ctxExpr.addContextFunction('current', (ctx) => ctx.value)

const ctxExprMany = bonsai<{ value: number }>()
ctxExprMany.addContextFunction('current', (ctx) => ctx.value)

const compiledPure = pureExpr.compile('id(1)')
const compiledCtx = ctxExpr.compile('current()')
// Six calls in one expression. With lazy-cached freeze this should pay the
// freeze cost once, then five "free" calls.
const compiledCtxMany = ctxExprMany.compile('current() + current() + current() + current() + current() + current()')

describe('context-functions: zero-regression on pure path', () => {
  bench('pure function call: id(1)', () => {
    compiledPure.evaluateSync({})
  })
})

describe('context-functions: single call', () => {
  bench('context function call: current()', () => {
    compiledCtx.evaluateSync({ value: 42 })
  })
})

describe('context-functions: amortised freeze cost', () => {
  bench('six context calls in one expression (amortised freeze)', () => {
    compiledCtxMany.evaluateSync({ value: 42 })
  })
})

describe('context-functions: context realism', () => {
  const richExpr = bonsai<{ userId: string; perms: readonly string[]; tenantId: string; trace: { reqId: string } }>()
  richExpr.addContextFunction('hasPermission', (ctx, action) =>
    ctx.perms.includes(action as string))
  const compiledRich = richExpr.compile('hasPermission("write")')

  bench('hasPermission("write") with 4-field context', () => {
    compiledRich.evaluateSync({
      userId: 'u_1',
      perms: ['read', 'write'],
      tenantId: 't_1',
      trace: { reqId: 'r_1' },
    })
  })
})
