import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t } from '../src/index.js'

/** A value or the code of the error evaluation raised. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { code: error.code }
    throw error
  }
}

/** The value at a dotted path of a context, or null. */
function at(context: unknown, path: string): unknown {
  let value = context
  for (const key of path.split('.')) {
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined
  }
  return value ?? null
}

/** A call: true host function returning the context's value at a path (objects as "object"). */
const cv = fn({
  params: [t.string()],
  returns: t.any(),
  call: true,
  run: (call, path) => {
    const value = at(call.context, path)
    return typeof value === 'object' && value !== null ? 'object' : value
  },
})

/** Heap in use after a full collection, so retained memory is measured, not garbage. */
setFlagsFromString('--expose_gc')
const collect = runInNewContext('gc') as () => void
function heapAfterGc(): number {
  collect()
  return process.memoryUsage().heapUsed
}

describe('call: true residuals see the context they are given', () => {
  const env = bonsai({ functions: { cv } })

  it('read paths listed as unknown from the given context only', () => {
    const program = env.compile('cv("user.score") ?? "absent"')
    const known = { user: { name: 'x', score: 'STALE' } }
    const data = { user: { name: 'x' } }
    expect(program.evaluateSync(data)).toBe('absent')
    const listed = program.partial(known, { unknown: ['user.score'] })
    expect(listed.status).toBe('residual')
    if (listed.status === 'residual') expect(listed.evaluateSync(data)).toBe('absent')
    // A variable listed whole is not required.
    const whole = program.partial(known, { unknown: ['user'] })
    if (whole.status === 'residual') {
      expect(whole.evaluateSync(data)).toBe('absent')
      expect(whole.evaluateSync({})).toBe('absent')
    }
    const both = env.compile('[user.score ?? "absent", cv("user.score") ?? "absent"]')
    const residual = both.partial(known, { unknown: ['user.score'] })
    if (residual.status === 'residual')
      expect(residual.evaluateSync(data)).toEqual(['absent', 'absent'])
  })

  it('require every variable known to partial()', () => {
    const shared = { x: 'kept', y: 1 }
    const result = env.compile('[cv("a.x"), cv("b.x"), n]').partial(
      { a: shared, b: shared },
      {
        unknown: ['a.x', 'n'],
      },
    )
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(outcome(() => result.evaluateSync({ a: { x: 'new' }, n: 1 }))).toEqual({
      code: 'INVALID_CONTEXT',
    })
    expect(result.evaluateSync({ a: { x: 'new' }, b: shared, n: 1 })).toEqual(['new', 'kept', 1])
  })

  it('see deep and cyclic data as it is', () => {
    const nest = (leaf: object, levels: number): object => {
      let value = leaf
      for (let i = 0; i < levels; i++) value = { d: value }
      return value
    }
    const deep = env.compile(`cv("u${'.d'.repeat(70)}.k.m") ?? n`)
    const result = deep.partial({ u: nest({ k: { m: 1 } }, 70) })
    if (result.status === 'residual')
      expect(result.evaluateSync({ u: nest({ k: { m: 1 } }, 70), n: 0 })).toBe(1)
    const cycle: Record<string, unknown> = { x: 1 }
    cycle.self = cycle
    const cyclic = env.compile('[cv("u.self.x"), n]').partial({ u: cycle })
    if (cyclic.status === 'residual')
      expect(cyclic.evaluateSync({ u: cycle, n: 0 })).toEqual([1, 0])
  })
})

describe('a residual validates the context it runs on', () => {
  const env = bonsai({
    variables: {
      org: t.object({ tier: t.string(), pct: t.number() }),
      user: t.object({ id: t.string() }),
    },
    validateContext: true,
    functions: {
      rollout: fn({
        params: [t.string(), t.number()],
        returns: t.boolean(),
        run: (id, pct) => id.length < pct,
      }),
    },
  })
  const program = env.compile('org.tier == "enterprise" || rollout(user.id, org.pct)')
  const result = program.partial({ org: { tier: 'free', pct: 5 } })

  it('accepts a context holding exactly dependsOn', () => {
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(result.dependsOn).toEqual(['user.id'])
    expect(result.evaluateSync({ user: { id: 'abc' } })).toBe(true)
    expect(result.explainSync({ user: { id: 'abc' } }).ok).toBe(true)
  })

  it('rejects a value it reads that does not match its type', () => {
    if (result.status !== 'residual') return
    // Data from outside, which the types cannot vouch for.
    const wrongId: unknown = { user: { id: 1 } }
    expect(outcome(() => result.evaluateSync(wrongId as never))).toEqual({
      code: 'INVALID_CONTEXT',
    })
    expect(outcome(() => result.evaluateSync({}))).toEqual({ code: 'INVALID_CONTEXT' })
  })
})

describe('a residual shares its bindings with the known data', () => {
  it('binds the values partial() read, not copies', () => {
    const env = bonsai()
    class Sku {
      readonly code: string
      constructor(code: string) {
        this.code = code
      }
    }
    const blocked = [new Sku('XX')]
    const program = env.compile('user.age >= 18 && user.country not in org.blocked')
    const result = program.partial({ org: { blocked } })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    const bound = Object.values(result.bindings)
    expect(bound[0]).toBe(blocked)
    expect(Object.isFrozen(blocked)).toBe(false)
    expect(Object.isFrozen(result.bindings)).toBe(true)
  })

  it('keeps data that throws when read, failing where evaluation reads it', () => {
    const env = bonsai()
    const throwing = {
      get x(): number {
        throw new Error('boom')
      },
    }
    const program = env.compile('k == n')
    const result = program.partial({ k: throwing }, { unknown: ['n'] })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(Object.values(result.bindings)[0] === throwing).toBe(true)
    expect(outcome(() => result.evaluateSync({ n: { x: 1 } }))).toEqual({ code: 'HOST_ERROR' })
    expect(outcome(() => program.evaluateSync({ k: throwing, n: { x: 1 } }))).toEqual({
      code: 'HOST_ERROR',
    })
  })
})

describe('partial evaluation keeps memory in proportion to its work', () => {
  it('keeps an index of the tree, not a set of names per node', () => {
    let source = `[${Array.from({ length: 9000 }, (_, i) => `a${i}`).join(',')}]`
    for (let k = 0; k < 120; k++) source = `[${source}, b${k}]`
    const program = bonsai({ limits: { maxSteps: 10_000 } }).compile(source)
    const before = heapAfterGc()
    expect(outcome(() => program.partial({ a0: 1 }))).toEqual({ code: 'STEP_LIMIT' })
    expect(heapAfterGc() - before).toBeLessThan(10_000_000)
    const roomy = bonsai().compile(source)
    const start = heapAfterGc()
    expect(roomy.partial({ a0: 1 }).status).toBe('residual')
    // The index and a residual of 9,000 names; per-node name sets took about 50 MB.
    expect(heapAfterGc() - start).toBeLessThan(25_000_000)
  })

  it('does not keep a compiled subtree for every set of known data', () => {
    let source = `(u.z && [${Array.from({ length: 3400 }, () => '1+1').join(',')}].length > 0)`
    for (let k = 119; k >= 0; k--) source = `u.f${k}&&(${source})`
    const program = bonsai().compile(source)
    const before = heapAfterGc()
    for (let k = 119; k >= 1; k--) {
      const u: Record<string, boolean> = { z: false }
      for (let j = k; j < 120; j++) u[`f${j}`] = true
      expect(program.partial({ u }).status).toBe('residual')
    }
    // Each call closes a different subtree; keeping them all took about 190 MB.
    expect(heapAfterGc() - before).toBeLessThan(40_000_000)
  })

  it('charges compiling a closed subtree, on every call alike', () => {
    const source = `false && [${Array.from({ length: 4000 }, () => '1').join(',')}].length > 0`
    const program = bonsai().compile(source)
    expect(outcome(() => program.partial({}, { maxSteps: 500 }).status)).toEqual({
      code: 'STEP_LIMIT',
    })
    expect(program.partial({}, { maxSteps: 5000 }).status).toBe('value')
    expect(program.partial({}, { maxSteps: 5000 }).status).toBe('value')
  })
})

describe('call: true residuals differential property', () => {
  const env = bonsai({ functions: { cv } })
  const PATHS = [
    'u.a',
    'u.b',
    'u.a.a',
    'u.a.b',
    'u.b.a',
    'v.a',
    'v.b.a',
    's1.k',
    's2.k',
    's2.m',
    'c.k',
    'c.self.k',
    'c.self.self.k',
    'missing.x',
  ]
  const UNKNOWN = ['u.a', 'u.b', 'u.a.a', 'u.b.a', 'v', 'v.a', 'v.b']
  const leaf = fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constantFrom('a', 'b'))
  const tree = fc.letrec<{ node: unknown }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.record({ a: tie('node'), b: tie('node') }, { requiredKeys: [] }),
    ),
  })).node
  const scenario = fc.record({
    u: tree,
    v: tree,
    shared: fc.record({ k: leaf, m: leaf }),
    cycle: leaf,
    n: fc.integer({ min: 0, max: 3 }),
    paths: fc.array(fc.constantFrom(...PATHS), { minLength: 1, maxLength: 4 }),
    unknown: fc.subarray(UNKNOWN),
    explicit: fc.boolean(),
  })

  /** A copy of `value` with `path` set (parents created as needed). */
  const setAt = (root: Record<string, unknown>, path: string, value: unknown): void => {
    const keys = path.split('.')
    let holder = root
    for (const key of keys.slice(0, -1)) {
      const next = holder[key]
      if (typeof next !== 'object' || next === null) holder[key] = {}
      holder = holder[key] as Record<string, unknown>
    }
    holder[keys.at(-1) as string] = value
  }
  const deepCopy = (value: unknown): unknown =>
    typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepCopy(v)]))
      : value

  it('agrees with evaluation of the full context, and rejects one missing known data', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const shared = { ...s.shared }
        const cycle: Record<string, unknown> = { k: s.cycle }
        cycle.self = cycle
        const full = { u: s.u, v: s.v, s1: shared, s2: shared, c: cycle, n: s.n }
        const source = `[${s.paths.map((p) => `cv("${p}")`).join(', ')}, n]`
        const program = env.compile(source)
        const expected = program.evaluateSync(full)
        // Known: everything except n; listed paths hold stale values.
        const known: Record<string, unknown> = {
          u: deepCopy(s.u),
          v: deepCopy(s.v),
          s1: shared,
          s2: shared,
          c: cycle,
        }
        // A listed path lies in an object the data has (its value may be absent),
        // and known holds a stale value there.
        const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null
        const listed = s.explicit
          ? s.unknown.filter((path) => {
              const parent = path.split('.').slice(0, -1).join('.')
              return parent === '' || isObject(at(full, parent))
            })
          : []
        for (const path of listed) {
          const parent = path.split('.').slice(0, -1).join('.')
          if (parent === '' || isObject(at(known, parent))) setAt(known, path, 'STALE')
        }
        const result = s.explicit
          ? program.partial(known, { unknown: [...listed, 'n'] })
          : program.partial(known)
        if (result.status !== 'residual') return result.status === 'value' && false
        // The whole context; and only the unknown part of it, which lacks the
        // known data a call: true function would read.
        const minimal: Record<string, unknown> = { n: s.n }
        for (const path of listed) {
          const value = at(full, path)
          if (value !== null) setAt(minimal, path, value)
        }
        expect(result.evaluateSync(full)).toEqual(expected)
        const lacking = Object.keys(known).some(
          (name) => !listed.includes(name) && !Object.hasOwn(minimal, name),
        )
        if (lacking)
          expect(outcome(() => result.evaluateSync(minimal))).toEqual({ code: 'INVALID_CONTEXT' })
        else expect(result.evaluateSync(minimal)).toEqual(expected)
        return true
      }),
      { numRuns: 1500, seed: 5 },
    )
  })
})
