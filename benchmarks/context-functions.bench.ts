import { describe, bench } from 'vitest'
import { bonsai } from '../src/index.js'

/**
 * Validate that:
 *   1. Pure function calls are unaffected by the context-functions feature
 *      (we want zero regression on the hot path for users who do not adopt it).
 *   2. Context function calls add negligible overhead: the context is passed
 *      by reference, so there is no per-call or per-evaluation copy.
 *   3. Many context calls in one expression scale linearly with the call count.
 */

const pureExpr = bonsai()
pureExpr.addFunction('id', (x) => x)

const ctxExpr = bonsai<{ value: number }>()
ctxExpr.addContextFunction('current', (ctx) => ctx.value)

const ctxExprMany = bonsai<{ value: number }>()
ctxExprMany.addContextFunction('current', (ctx) => ctx.value)

const compiledPure = pureExpr.compile('id(1)')
const compiledCtx = ctxExpr.compile('current()')
// Six context-function calls in one expression. The context is passed by
// reference, so each call is the same cheap hand-off with no copy.
const compiledCtxMany = ctxExprMany.compile(
  'current() + current() + current() + current() + current() + current()',
)

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

describe('context-functions: many calls in one expression', () => {
  bench('six context calls in one expression', () => {
    compiledCtxMany.evaluateSync({ value: 42 })
  })
})

describe('context-functions: context realism', () => {
  const richExpr = bonsai<{
    userId: string
    perms: readonly string[]
    tenantId: string
    trace: { reqId: string }
  }>()
  richExpr.addContextFunction('hasPermission', (ctx, action) =>
    ctx.perms.includes(action as string),
  )
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
