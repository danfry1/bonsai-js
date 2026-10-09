import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

describe('partial treats data missing from a known object as unknown', () => {
  const env = bonsai({
    variables: {
      cart: t.object({ coupon: t.string(), total: t.number(), items: t.list(t.number()) }),
    },
  })

  it('does not decide from a field the known object leaves out', () => {
    const program = env.compile('cart.coupon == "TEN" || cart.total > 100')
    const result = program.partial({ cart: { coupon: 'NONE' } })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(result.dependsOn).toEqual(['cart.total'])
    expect(result.evaluateSync({ cart: { coupon: 'NONE', total: 500, items: [] } })).toBe(true)
    expect(program.evaluateSync({ cart: { coupon: 'NONE', total: 500, items: [] } })).toBe(true)
  })

  it('keeps a missing list field unknown instead of failing', () => {
    const result = env
      .compile('cart.coupon == "TEN" || cart.items.length > 0')
      .partial({ cart: { coupon: 'NONE' } })
    expect(result.status).toBe('residual')
    if (result.status === 'residual') {
      expect(result.evaluateSync({ cart: { coupon: 'NONE', total: 0, items: [1] } })).toBe(true)
    }
  })

  it('treats a whole read of an incomplete declared object as unknown', () => {
    const result = env.compile('cart["total"] > 100').partial({ cart: { coupon: 'NONE' } })
    expect(result.status).toBe('residual')
  })

  it('reads missing data as null when an explicit unknown list says the rest is known', () => {
    const result = env
      .compile('cart.coupon == "TEN" || cart.total > 100')
      .partial({ cart: { coupon: 'NONE' } }, { unknown: [] })
    expect(result).toEqual({ status: 'value', value: false })
  })
})

describe('residual explanations work for every residual', () => {
  const open = bonsai()
  const cases: [
    source: string,
    known: Record<string, unknown>,
    context: Record<string, unknown>,
  ][] = [
    ['xs.map(. + 1)', {}, { xs: [1, 2] }],
    ['xs.filter(. > limit).length > 0', { limit: 1 }, { xs: [1, 2] }],
    ['xs.some(x => x > limit)', { limit: 1 }, { xs: [1, 2] }],
    ['let q = xs; q.length + n', { n: 1 }, { xs: [1, 2, 3] }],
    ['try(xs.map(. + 1), fallback)', { fallback: [] }, { xs: [1, 2] }],
    ['xs.map(x => x * k).reduce((acc, y) => acc + y, 0)', { k: 2 }, { xs: [1, 2, 3] }],
    ['`${name}: ${xs.map(. * k).join(",")}`', { k: 3 }, { name: 'a', xs: [1, 2] }],
    ['let s = tags; s.map(t => t + suffix)', { tags: ['x', 'y'] }, { suffix: '!' }],
  ]

  for (const [source, known, context] of cases) {
    it(source, () => {
      const result = open.compile(source).partial(known)
      if (result.status !== 'residual') throw new Error(`expected a residual for ${source}`)
      const value = result.evaluateSync(context)
      const explanation = result.explainSync(context)
      expect(explanation.ok, String(explanation)).toBe(true)
      if (explanation.ok) expect(explanation.value).toEqual(value)
      expect(typeof String(explanation)).toBe('string')
      expect(() => JSON.stringify(explanation)).not.toThrow()
    })
  }

  it('never lets a non-Bonsai error escape', async () => {
    const result = open.compile('let q = xs; q.length + n').partial({ n: 1 })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(() => result.explainSync({ xs: [1] })).not.toThrow()
    await expect(result.explain({ xs: [1] })).resolves.toMatchObject({ ok: true, value: 2 })
  })
})

describe('explanation text is bounded', () => {
  const texts = (trace: { text: string; children: readonly unknown[] }, out: string[] = []) => {
    out.push(trace.text)
    for (const child of trace.children) texts(child as typeof trace, out)
    return out
  }

  it('caps the text of each trace record and the JSON snapshot', () => {
    const long = 'a'.repeat(2000)
    const source = `xs.map((a) => xs.map((b) => xs.map((c) => ("${long}").length + c)))`
    const xs = Array.from({ length: 20 }, (_, i) => i)
    const explanation = bonsai().explainSync(source, { xs })
    expect(explanation.ok).toBe(true)
    expect(JSON.stringify(explanation).length).toBeLessThan(3_000_000)
    for (const text of texts(explanation.trace)) expect(text.length).toBeLessThanOrEqual(123)
  })

  it('explains a residual with long values within bounded text', () => {
    const value = '\u0001'.repeat(200)
    const items = Array.from({ length: 3000 }, () => 'x').join(',')
    const source = `let x = "${value}"; [[${items}, u]].length`
    const result = bonsai().partial(source, {}, { unknown: ['u'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.source.length).toBeLessThan(40_000)
    const explanation = result.explainSync({ u: 1 }, { timeout: 1000 })
    expect(explanation.ok).toBe(true)
    for (const text of texts(explanation.trace)) expect(text.length).toBeLessThanOrEqual(123)
  })
})

describe('call: true host functions in a residual', () => {
  const env = bonsai({
    functions: {
      hasRole: fn({
        params: [t.string()],
        returns: t.boolean(),
        call: true,
        run: (call, role) => ((call.context.roles as string[] | undefined) ?? []).includes(role),
      }),
    },
  })

  it('see the known data overlaid with the context given to the residual', () => {
    const program = env.compile('hasRole("admin") && order.total > 100')
    const result = program.partial({ roles: ['admin'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.evaluateSync({ order: { total: 150 } })).toBe(true)
    expect(result.explainSync({ order: { total: 150 } })).toMatchObject({ ok: true, value: true })
    // The caller's keys win over known ones.
    expect(result.evaluateSync({ roles: [], order: { total: 150 } })).toBe(false)
  })
})

describe('partial residual size', () => {
  it('binds a repeated long string once instead of copying it to every use', () => {
    const value = 'v'.repeat(150)
    const uses = Array.from({ length: 200 }, () => 'x').join(', ')
    const result = bonsai().partial(`let x = "${value}"; [${uses}, u]`, {}, { unknown: ['u'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(result.source.length).toBeLessThan(10_000)
    expect(Object.keys(result.bindings)).toHaveLength(1)
    expect(result.evaluateSync({ u: 1 })).toHaveLength(201)
  })

  it('reports a residual longer than maxSourceLength as a limit error', () => {
    const env = bonsai({ limits: { maxSourceLength: 2000 } })
    const uses = Array.from({ length: 200 }, (_, i) => `a${i % 2}`).join(',')
    expect(uses.length).toBeLessThan(2000)
    expect(() =>
      env.partial(`[${uses}, u]`, { a0: 'p'.repeat(12), a1: 'q'.repeat(12) }, { unknown: ['u'] }),
    ).toThrow(expect.objectContaining({ code: 'SOURCE_TOO_LONG' }))
  })
})

describe('the program cache', () => {
  it('cannot be primed to skip an expected type', () => {
    const env = bonsai({ variables: { secret: t.string() } })
    const user = '"not a boolean: " + secret //'
    const poisoned = `${user}\u0000${JSON.stringify(t.boolean())}`
    expect(env.evaluateSync(poisoned, { secret: 's' })).toBe('not a boolean: s')
    expect(() => env.compile(user, { expect: t.boolean() })).toThrow(
      expect.objectContaining({ code: 'CHECK' }),
    )
  })
})

describe('diagnostic code frames', () => {
  it('stay short on a long line and cheap for many findings', () => {
    const env = bonsai({ variables: { a: t.number() } })
    const source = `[${Array.from({ length: 3000 }, (_, i) => `b${i}`).join(', ')}]`
    const { diagnostics } = env.check(source)
    expect(diagnostics.length).toBeGreaterThan(1000)
    const start = performance.now()
    let total = 0
    for (const d of diagnostics) total += d.formatted.length
    expect(performance.now() - start).toBeLessThan(500)
    expect(total / diagnostics.length).toBeLessThan(400)
    expect(diagnostics[0]?.formatted).toContain('^')
  })

  it('keep the full line and caret for a short line', () => {
    const d = bonsai({ variables: { order: t.number() } }).check('ordr + 1').diagnostics[0]
    expect(d?.formatted).toBe(`${d?.message}\n1 | ordr + 1\n  | ^^^^`)
  })
})

describe('errors from residual explanations are Bonsai errors', () => {
  it('reports evaluation errors in the explanation', () => {
    const result = bonsai().compile('xs.map(. / d)').partial({ d: 0 })
    if (result.status !== 'residual') throw new Error('expected a residual')
    const explanation = result.explainSync({ xs: [1] })
    expect(explanation.ok).toBe(false)
    if (!explanation.ok) expect(explanation.error).toBeInstanceOf(BonsaiError)
  })
})
