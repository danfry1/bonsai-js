import { describe, expect, it } from 'vitest'
import { bonsai, fn, t, type Trace } from '../src/index.js'

const env = bonsai()
const ctx = {
  user: { age: 25, plan: 'free', address: null },
  orders: [
    { total: 50, paid: true },
    { total: 80, paid: false },
    { total: 120, paid: true },
  ],
}

const find = (trace: Trace, text: string): Trace | undefined => {
  if (trace.text === text) return trace
  for (const child of trace.children) {
    const found = find(child, text)
    if (found !== undefined) return found
  }
  for (const iteration of trace.iterations ?? []) {
    const found = find(iteration.trace, text)
    if (found !== undefined) return found
  }
  return undefined
}

describe('explain', () => {
  it('records the value of every sub-expression', () => {
    const explanation = env.explainSync('user.age >= 18 && user.plan == "pro"', ctx)
    expect(explanation.ok).toBe(true)
    expect(explanation.ok && explanation.value).toBe(false)
    expect(find(explanation.trace, 'user.age')?.value).toBe(25)
    expect(find(explanation.trace, 'user.plan')?.value).toBe('free')
    expect(find(explanation.trace, 'user.plan == "pro"')).toMatchObject({
      evaluated: true,
      value: false,
    })
  })

  it('marks sub-expressions skipped by short-circuiting', () => {
    const { trace } = env.explainSync('user.age < 18 && user.plan == "pro"', ctx)
    expect(find(trace, 'user.plan == "pro"')).toMatchObject({ evaluated: false })
    const ternary = env.explainSync('user.age > 18 ? "adult" : user.plan', ctx).trace
    expect(find(ternary, 'user.plan')).toMatchObject({ evaluated: false })
  })

  it('records each lambda run as an iteration', () => {
    const { trace } = env.explainSync('orders.some(.total > 100 && !.paid)', ctx)
    const call = find(trace, 'orders.some(.total > 100 && !.paid)')
    expect(call?.iterations?.map((i) => [i.index, i.trace.children[0]?.value])).toEqual([
      [0, false],
      [1, false],
      [2, false],
    ])
    expect(call?.iterations?.[2]?.item).toEqual({ total: 120, paid: true })
  })

  it('caps recorded iterations and counts the rest', () => {
    const xs = Array.from({ length: 50 }, (_, i) => i)
    const explanation = env.explainSync('xs.map(. * 2)', { xs }, { maxIterations: 3 })
    const call = explanation.trace
    expect(call.iterations).toHaveLength(3)
    expect(call.omittedIterations).toBe(47)
    expect(explanation.ok && explanation.value).toEqual(xs.map((x) => x * 2))
    expect(explanation.toString()).toContain('... 47 more items')
  })

  it('returns errors instead of throwing, marking where they happened', () => {
    const explanation = env.explainSync('user.age / 0 > 1', ctx)
    expect(explanation.ok).toBe(false)
    expect(!explanation.ok && explanation.error.code).toBe('DIVISION_BY_ZERO')
    expect(find(explanation.trace, 'user.age / 0')?.error?.code).toBe('DIVISION_BY_ZERO')
    expect(find(explanation.trace, 'user.age')?.value).toBe(25)
  })

  it('shows the failure try() recovered from', () => {
    const explanation = env.explainSync('try(user.age / 0, 0)', ctx)
    expect(explanation.ok && explanation.value).toBe(0)
    expect(find(explanation.trace, 'user.age / 0')?.error?.code).toBe('DIVISION_BY_ZERO')
  })

  it('renders a readable tree', () => {
    expect(env.explainSync('user.age >= 18 && user.plan == "pro"', ctx).toString()).toBe(
      [
        'user.age >= 18 && user.plan == "pro"  → false',
        '├─ user.age >= 18  → true',
        '│  └─ user.age  → 25',
        '└─ user.plan == "pro"  → false',
        '   └─ user.plan  → "free"',
      ].join('\n'),
    )
  })

  it('produces plain JSON', () => {
    const { trace } = env.explainSync('orders.filter(.paid).length', ctx)
    expect(JSON.parse(JSON.stringify(trace))).toMatchObject({
      kind: 'Member',
      text: 'orders.filter(.paid).length',
      value: 2,
    })
  })

  it('explains async expressions with explain', async () => {
    const asyncEnv = bonsai({
      functions: {
        rate: fn({
          params: [t.string()],
          returns: t.number(),
          async: true,
          run: (c) => Promise.resolve(c === 'EUR' ? 2 : 1),
        }),
      },
    })
    const program = asyncEnv.compile('orders.map(rate("EUR") * .total).sum()')
    const explanation = await program.explain(ctx)
    expect(explanation.ok && explanation.value).toBe(500)
    expect(
      explanation.trace.children[0]?.iterations?.[0]?.trace.children[0]?.children[0],
    ).toMatchObject({ text: 'rate("EUR")', value: 2 })
    const sync = program.explainSync(ctx)
    expect(!sync.ok && sync.error.code).toBe('ASYNC_IN_SYNC')
    expect(!sync.ok && sync.error.message).toContain('use explain() instead of explainSync()')
  })

  it('names the async and sync forms as evaluate does', async () => {
    const explanation = await env.explain('1 + 2')
    expect(explanation.ok && explanation.value).toBe(3)
    expect(env.explainSync('1 + 2').ok).toBe(true)
    // Syntax and check errors reject, as env.evaluate does, rather than throwing.
    const pending = env.explain('1 +')
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toMatchObject({ code: 'SYNTAX' })
    expect(() => env.explainSync('1 +')).toThrow(expect.objectContaining({ code: 'SYNTAX' }))
  })

  it('reports context validation failures without evaluating', () => {
    const typed = bonsai({ validateContext: true, variables: { n: t.number() } })
    const explanation = typed.explainSync('n + 1', { n: 'x' } as never)
    expect(!explanation.ok && explanation.error.code).toBe('INVALID_CONTEXT')
    expect(explanation.trace.evaluated).toBe(false)
  })

  it('agrees with evaluate for values and errors', () => {
    for (const source of [
      'orders.map(.total).sum()',
      'user.address.city ?? "?"',
      'orders[5].total',
      'user.age.trim()',
    ]) {
      const explanation = env.explainSync(source, ctx)
      let expected: unknown
      try {
        expected = { ok: true, value: env.evaluateSync(source, ctx) }
      } catch (error) {
        expected = { ok: false, code: (error as { code: string }).code }
      }
      expect(
        explanation.ok
          ? { ok: true, value: explanation.value }
          : { ok: false, code: explanation.error.code },
      ).toEqual(expected)
    }
  })
})

describe('explain: review findings and extras', () => {
  it('keeps nested lambda traces correct past the iteration cap', () => {
    const explanation = env.explainSync(
      'xs.map(ys.map(. * 2).sum() + .)',
      { xs: [1, 2, 3], ys: [1, 2] },
      { maxIterations: 1 },
    )
    expect(explanation.trace.omittedIterations).toBe(2)
    expect(explanation.trace.children.map((c) => c.kind)).toEqual(['Variable'])
  })

  it('shows the path has() tested rather than marking it skipped', () => {
    const { trace } = env.explainSync('has(u.a.b)', { u: { a: { b: 1 } } })
    expect(trace.children.map((c) => [c.text, c.evaluated])).toEqual([['u.a', true]])
  })

  it('records reduce runs with the item, index, and accumulator', () => {
    const explanation = env.explainSync('xs.reduce((a, x) => a / x, 100)', { xs: [5, 2, 0] })
    expect(!explanation.ok && explanation.error.message).toContain('at item 2')
    expect(explanation.trace.iterations?.map((i) => [i.index, i.item, i.accumulator])).toEqual([
      [0, 5, 100],
      [1, 2, 20],
      [2, 0, 10],
    ])
    expect(explanation.trace.iterations?.[2]?.error?.code).toBe('DIVISION_BY_ZERO')
    expect(explanation.trace.iterations?.[0]?.result).toBe(20)
  })

  it('lists every failing condition with exhaustive', () => {
    const user = { age: 16, plan: 'free', country: 'US', verified: false }
    const source =
      'user.age >= 18 && user.plan == "pro" && user.country in ["DE", "FR"] && user.verified'
    expect(
      env
        .explainSync(source, { user })
        .reasons()
        .map((r) => r.text),
    ).toEqual(['user.age >= 18'])
    const all = env.explainSync(source, { user }, { exhaustive: true })
    expect(all.ok && all.value).toBe(false)
    expect(all.reasons().map((r) => r.text)).toEqual([
      'user.age >= 18',
      'user.plan == "pro"',
      'user.country in ["DE", "FR"]',
      'user.verified',
    ])
    expect(find(all.trace, 'user.plan == "pro"')?.extra).toBe(true)
  })

  it('ignores errors on parts evaluated only for the explanation', () => {
    const explanation = env.explainSync('x > 1 && x / 0 > 1', { x: 0 }, { exhaustive: true })
    expect(explanation.ok && explanation.value).toBe(false)
    expect(find(explanation.trace, 'x / 0')?.error?.code).toBe('DIVISION_BY_ZERO')
  })

  it('reasons() follows || and ! and points at errors', () => {
    expect(
      env
        .explainSync('!(a || b)', { a: false, b: true })
        .reasons()
        .map((r) => r.text),
    ).toEqual(['b'])
    expect(
      env
        .explainSync('a > 1 && b / 0 > 1', { a: 2, b: 1 })
        .reasons()
        .map((r) => r.text),
    ).toEqual(['b / 0'])
  })

  it('caps the total number of recorded nodes', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const explanation = env.explainSync(
      'xs.map(ys => xs.map(. + ys).sum())',
      { xs },
      { maxTraceNodes: 50, maxIterations: 100 },
    )
    expect(explanation.truncated).toBe(true)
    expect(explanation.ok).toBe(true)
    expect(String(explanation)).toContain('trace truncated')
  })

  it('serializes safely without running getters', () => {
    let ran = 0
    const value: Record<string, unknown> = {
      a: 1,
      big: 10n,
      get secret(): string {
        ran++
        return 'x'
      },
    }
    value.self = value
    const explanation = env.explainSync('v != null', { v: value })
    const json = JSON.parse(JSON.stringify(explanation)) as {
      trace: { children: { value: unknown }[] }
    }
    expect(json.trace.children[0]?.value).toEqual({
      a: 1,
      big: '10n',
      secret: '[getter]',
      self: '[Circular]',
    })
    expect(String(explanation)).toContain('[getter]')
    expect(ran).toBe(0)
  })

  it('validates options', () => {
    expect(() => env.explainSync('1', {}, { maxIterations: Number.NaN })).toThrow(
      /non-negative integer/u,
    )
    expect(() => env.explainSync('1', {}, { maxTraceNodes: -1 })).toThrow(/non-negative integer/u)
  })

  it('reports failing host getters as HOST_ERROR, which try() recovers from', () => {
    const g = {
      get bad(): number {
        throw new Error('boom')
      },
    }
    expect(() => env.evaluateSync('g.bad', { g })).toThrow(
      expect.objectContaining({ code: 'HOST_ERROR' }),
    )
    expect(env.evaluateSync('try(g.bad, 1)', { g })).toBe(1)
    const explanation = env.explainSync('g.bad + 1', { g })
    expect(!explanation.ok && explanation.error.code).toBe('HOST_ERROR')
  })
})

describe('explain on the hardened engine', () => {
  it('bounds toJSON however large or shared the values are', () => {
    const big = new Uint8Array(20_000_000)
    const start = performance.now()
    const json = JSON.stringify(env.explainSync('try(b.length, -1)', { b: big }))
    expect(performance.now() - start).toBeLessThan(2000)
    expect(json).toContain('[Uint8Array]')
    const cube = Array.from({ length: 50 }, () =>
      Array.from({ length: 50 }, () => Array.from({ length: 50 }, (_, i) => i)),
    )
    const shared = `[${Array.from({ length: 500 }, () => 'd').join(', ')}].length`
    expect(JSON.stringify(env.explainSync(shared, { d: cube })).length).toBeLessThan(2_000_000)
  })

  it('never runs getters or lets a throwing Proxy break toJSON', () => {
    let calls = 0
    const list = [1, 2]
    Object.defineProperty(list, 0, {
      enumerable: true,
      get() {
        calls++
        return 1
      },
    })
    const json = JSON.stringify(env.explainSync('xs', { xs: list }))
    expect(calls).toBe(0)
    expect(json).toContain('[getter]')
    const hostile = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error('ownKeys trap')
        },
      },
    )
    const explanation = env.explainSync('try(p.a, 0)', { p: hostile })
    expect(explanation.ok).toBe(true)
    expect(() => JSON.stringify(explanation)).not.toThrow()
  })

  it('ignores host failures in the extra work of exhaustive explanations', () => {
    const x = Object.defineProperty({}, 'a', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    expect(env.evaluateSync('true || x.a', { x })).toBe(true)
    const explanation = env.explainSync('true || x.a', { x }, { exhaustive: true })
    expect(explanation.ok && explanation.value).toBe(true)
  })

  it('validates options like evaluate does', () => {
    const run = (options: unknown): void => {
      env.explainSync('1', {}, options as never)
    }
    expect(() => {
      run({ maxIterations: -1 })
    }).toThrow(RangeError)
    expect(() => {
      run({ maxTraceNodes: Number.POSITIVE_INFINITY })
    }).toThrow(RangeError)
    expect(() => {
      run({ maxIterations: 'x' })
    }).toThrow(TypeError)
    expect(() => {
      run({ exhaustive: 'yes' })
    }).toThrow(TypeError)
    expect(() => {
      run({ maxIteration: 1 })
    }).toThrow(/maxIterations/u)
    expect(() => {
      run({ maxSteps: -1 })
    }).toThrow(RangeError)
    const unreadable = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap')
        },
      },
    )
    expect(() => {
      run(unreadable)
    }).toThrow(TypeError)
  })
})

describe('explain text cuts', () => {
  // With the u flag a surrogate class matches only a surrogate that is not half of a pair.
  const loneSurrogate = /[\uD800-\uDFFF]/u
  const emoji = '\u{1F600}'

  it('never splits a surrogate pair in node text, value previews, or recorded strings', () => {
    const plain = bonsai()
    // The emoji straddles each cut: node text at 60, previews at 120, recorded strings at 1,000.
    const literal = `"${'a'.repeat(58)}${emoji}"`
    const explained = plain.explainSync(`${literal} == s`, { s: `${'a'.repeat(118)}${emoji}` })
    const long = plain.explainSync('s', { s: `${'a'.repeat(999)}${emoji}` })
    expect(String(explained)).toContain('a...')
    expect(loneSurrogate.test(String(explained))).toBe(false)
    const json = JSON.stringify(long)
    expect(loneSurrogate.test(json)).toBe(false)
    expect(json).toContain(`"${'a'.repeat(999)}..."`)
  })
})
