import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BonsaiError, bonsai, fn, t, type PartialResult } from '../src/index.js'

const userType = t.object({
  name: t.string(),
  score: t.optional(t.number()),
  profile: t.object({ city: t.string(), since: t.optional(t.number()) }),
  tags: t.list(t.string()),
})
const typed = bonsai({ variables: { user: userType, key: t.string(), n: t.number() } })
const open = bonsai()

describe('partial never decides from an object it was given only in part', () => {
  it('keeps a spread of a known object unknown', () => {
    const result = typed.compile('{...user}.score ?? 0').partial({ user: { name: 'a' } })
    expect(result.status).toBe('residual')
  })

  it('keeps the keys of a known object unknown, even when its declared fields are all there', () => {
    // `score` is optional, so { name, profile, tags } conforms to the declared type,
    // and the full context may still have it.
    const known = { user: { name: 'a', profile: { city: 'x' }, tags: [] } }
    const program = typed.compile('user.keys().length')
    const result = program.partial(known)
    expect(result.status).toBe('residual')
    const full = { user: { ...known.user, score: 1 }, key: '', n: 0 }
    if (result.status === 'residual') expect(result.evaluateSync(full)).toBe(4)
    expect(program.evaluateSync(full)).toBe(4)
  })

  it('keeps a let alias of a known object unknown', () => {
    const program = typed.compile('let q = user.profile; q.since ?? now()')
    const result = program.partial(
      { user: { name: 'a', profile: { city: 'x' }, tags: [] } },
      { now: new Date(0) },
    )
    expect(result.status).toBe('residual')
    const full = { user: { name: 'a', profile: { city: 'x', since: 5 }, tags: [] }, key: '', n: 0 }
    if (result.status === 'residual') expect(result.evaluateSync(full)).toBe(5)
  })

  it('applies the same rule in an open environment', () => {
    const result = open.compile('user.values().length').partial({ user: { a: 1 } })
    expect(result.status).toBe('residual')
  })

  it('still decides the fields that were given', () => {
    const result = typed
      .compile('user.name == "a" && user.profile.city == "x"')
      .partial({ user: { name: 'b' } })
    expect(result).toEqual({ status: 'value', value: false })
  })

  it('decides whole reads when an explicit unknown list says the rest is given', () => {
    const result = open.compile('user.keys().length').partial({ user: { a: 1 } }, { unknown: [] })
    expect(result).toEqual({ status: 'value', value: 1 })
  })

  it('decides a known key into a known object (tiers[level])', () => {
    const tiers = { gold: 1000 }
    const program = open.compile('order.total > tiers[level]')
    const decided = program.partial({ tiers, level: 'gold' })
    expect(decided.status === 'residual' && decided.source).toBe('order.total > 1000')
    // A key the known object does not have is unknown, not null.
    const gap = program.partial({ tiers, level: 'silver' })
    expect(gap.status === 'residual' && gap.dependsOn).toEqual(['order.total', 'tiers.silver'])
    if (gap.status === 'residual') {
      expect(gap.evaluateSync({ order: { total: 5 }, tiers: { gold: 1000, silver: 1 } })).toBe(true)
    }
  })

  it('does not walk a large known value to decide a read of it', () => {
    const env = bonsai({ variables: { cfg: t.object({ items: t.list(t.number()) }) } })
    const cfg = { items: Array.from({ length: 300_000 }, (_, i) => i) }
    const started = performance.now()
    expect(env.compile('cfg.items.length > 0').partial({ cfg })).toEqual({
      status: 'value',
      value: true,
    })
    expect(env.compile('cfg != null').partial({ cfg }).status).toBe('residual')
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('partial reads a literal key as the path it names', () => {
  it('treats user["age"] like user.age', () => {
    for (const source of ['user["age"]', 'user.age']) {
      const result = open.compile(source).partial({ user: { plan: 'free' } })
      expect(result.status).toBe('residual')
      if (result.status === 'residual') {
        expect(result.dependsOn).toEqual(['user.age'])
        expect(result.evaluateSync({ user: { plan: 'free', age: 3 } })).toBe(3)
      }
    }
  })

  it('decides user["age"] when it is given', () => {
    expect(open.compile('user["age"] + 1').partial({ user: { age: 2 } })).toEqual({
      status: 'value',
      value: 3,
    })
  })
})

describe('partial residuals of call: true host functions', () => {
  const env = bonsai({
    functions: {
      age: fn({
        params: [],
        returns: t.number(),
        call: true,
        run: (call) => (call.context.user as { age?: number } | undefined)?.age ?? -1,
      }),
    },
  })

  it('see the known part of a variable under the part the caller passes', () => {
    const program = env.compile('age() + (user.plan == "pro" ? 100 : 0)')
    const result = program.partial({ user: { age: 30 } })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    expect(result.readsContext).toBe(true)
    expect(result.evaluateSync({ user: { plan: 'pro' } })).toBe(130)
    expect(program.evaluateSync({ user: { age: 30, plan: 'pro' } })).toBe(130)
    // The caller's values win.
    expect(result.evaluateSync({ user: { plan: 'pro', age: 1 } })).toBe(101)
  })

  it('report readsContext false when no call: true function remains', () => {
    const result = env.compile('user.plan == "pro"').partial({})
    expect(result.status === 'residual' && result.readsContext).toBe(false)
  })

  it('charge the overlay of a large context against the step budget', () => {
    const result = env.compile('age() + n').partial({ user: { age: 1 } })
    expect(result.status).toBe('residual')
    if (result.status !== 'residual') return
    const context: Record<string, number> = { n: 1 }
    for (let i = 0; i < 100_000; i++) context[`k${i}`] = i
    expect(() => result.evaluateSync(context, { maxSteps: 100 })).toThrow(
      expect.objectContaining({ code: 'STEP_LIMIT' }),
    )
    expect(result.evaluateSync(context)).toBe(2)
  })

  it('keep a __proto__ key of the caller as a key', () => {
    const result = env.compile('age() + n').partial({ user: { age: 1 } })
    if (result.status !== 'residual') throw new Error('expected a residual')
    const context = JSON.parse('{"n": 1, "__proto__": {"x": 1}}') as Record<string, unknown>
    expect(result.evaluateSync(context)).toBe(2)
  })
})

describe('partial result lists', () => {
  const env = bonsai({
    variables: { order: t.object({ note: t.optional(t.string()), tags: t.list(t.string()) }) },
  })

  it('name the data a length is taken of, not the length', () => {
    const note = env.compile('order.note?.length').partial({})
    expect(note.status === 'residual' && note.dependsOn).toEqual(['order.note'])
    const tags = env.compile('order.tags.length').partial({})
    expect(tags.status === 'residual' && tags.dependsOn).toEqual(['order.tags'])
  })

  it('are frozen', () => {
    const result = env.compile('order.note?.length').partial({})
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(Object.isFrozen(result.dependsOn)).toBe(true)
    expect(Object.isFrozen(result.hostFunctions)).toBe(true)
  })
})

// === differential property: partial() never uses data it was not given ===

interface Full {
  user: { name: string; score?: number; profile: { city: string; since?: number }; tags: string[] }
  key: string
  n: number
}

const POOL = [
  'user.name == "a"',
  'user.score ?? 0',
  'user["score"] ?? -1',
  '{...user}.score ?? 0',
  '{...user.profile}.since ?? n',
  'user.keys().length',
  'user.profile.keys().length',
  'user.values().length',
  'user.entries().length',
  'let q = user.profile; q.since ?? q.city',
  'let q = user; q.score ?? q.name',
  'user.tags.length',
  'user.tags.map(. + user.name)',
  'user.tags.filter(. == user.name).length',
  'user[key] ?? "none"',
  'user.profile[key] ?? "none"',
  'has(user.score)',
  'has(user.profile.since)',
  'user == null',
  'user.profile == {city: "x"}',
  'n > 1 && user.profile.city == "x"',
  'n > 1 || user.profile.since == 3',
  '[user.profile].map(.since ?? 0)',
  'user.profile.since ?? n',
  'key == "name" ? user.score ?? 0 : n',
  'user.name.length + n',
  'user.profile.city.length > 1 && (user.score ?? 0) > 1',
  'try((user.score ?? 1) / n, -1)',
]

const full: fc.Arbitrary<Full> = fc.record({
  user: fc.record(
    {
      name: fc.constantFrom('a', 'b'),
      score: fc.integer({ min: 0, max: 3 }),
      profile: fc.record(
        { city: fc.constantFrom('x', 'y'), since: fc.integer({ min: 0, max: 3 }) },
        { requiredKeys: ['city'] },
      ),
      tags: fc.array(fc.constantFrom('a', 'b'), { maxLength: 2 }),
    },
    { requiredKeys: ['name', 'profile', 'tags'] },
  ),
  key: fc.constantFrom('name', 'score', 'city', 'since', 'other'),
  n: fc.integer({ min: 0, max: 3 }),
})

/** How much of a value is given: none of it, all of it, or (for an object) some of each key. */
type Mask =
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | { readonly kind: 'some'; readonly keys: readonly Mask[] }
const mask: fc.Arbitrary<Mask> = fc.letrec<{ mask: Mask }>((tie) => ({
  mask: fc.oneof(
    { depthSize: 'small' },
    fc.constant({ kind: 'none' } as const),
    fc.constant({ kind: 'all' } as const),
    fc.record({
      kind: fc.constant('some' as const),
      keys: fc.array(tie('mask'), { minLength: 6, maxLength: 6 }),
    }),
  ),
})).mask

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The part of `value` the mask gives; undefined when nothing is given. */
function given(value: unknown, m: Mask): unknown {
  if (m.kind === 'none') return undefined
  if (m.kind === 'all' || !isObject(value)) return value
  const out: Record<string, unknown> = {}
  Object.keys(value)
    .sort()
    .forEach((name, i) => {
      const part = given(value[name], m.keys[i % m.keys.length])
      if (part !== undefined) out[name] = part
    })
  return out
}

/** `base` with every value `known` gives put in at its path: another completion of `known`. */
function complete(base: unknown, known: unknown): unknown {
  if (known === undefined) return base
  if (!isObject(known) || !isObject(base)) return known
  const out: Record<string, unknown> = { ...base }
  for (const [name, part] of Object.entries(known)) out[name] = complete(base[name], part)
  return out
}

const outcomeOf = (run: () => unknown): unknown => {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof BonsaiError) return { error: error.code }
    throw error
  }
}

let cases = 0
let completions = 0
let decided = 0

describe('partial() differential property', () => {
  const programs = POOL.map((source) => ({
    typed: typed.compile(source),
    open: open.compile(source),
  }))

  it('agrees with evaluation on every completion of the known data', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: POOL.length - 1 }),
        fc.boolean(),
        full,
        full,
        mask,
        (index, useTyped, a, b, m) => {
          const program = useTyped ? programs[index].typed : programs[index].open
          const known = given(a, m) ?? {}
          const result: PartialResult = program.partial(known)
          cases++
          for (const context of [a, complete(b, known)]) {
            completions++
            const expected = outcomeOf(() => program.evaluateSync(context as never))
            if (result.status === 'value') {
              decided++
              expect({ value: result.value }).toEqual(expected)
            } else if (result.status === 'error') {
              decided++
              expect({ error: result.error.code }).toEqual(expected)
            } else {
              expect(outcomeOf(() => result.evaluateSync(context as never))).toEqual(expected)
            }
          }
        },
      ),
      { numRuns: 4000 },
    )
    // Recorded for the review: how many cases ran and how many were decided.
    expect(cases).toBe(4000)
    expect(completions).toBe(8000)
    expect(decided).toBeGreaterThan(800)
  })
})
