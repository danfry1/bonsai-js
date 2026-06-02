import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { bonsai, BonsaiSecurityError } from '../src/index.js'

// These generalize the hand-picked cases in adversarial.test.ts into invariants
// that hold across many generated shapes. The sandbox guarantees are the
// library's core promise, so a regression here is a real escape, not a quirk.
// Fixed seeds keep CI deterministic; fast-check shrinks any failure to the
// smallest breaking expression.
const SEED_PROTO_ACCESS = 0x5ec0de
const SEED_NULL_PROTO = 0xc0de01
const SEED_OWN_ONLY = 0xc0de02

const SANDBOX_CONTEXT = {
  obj: { safe: 1 },
  user: { name: 'Dan', profile: { city: 'London', code: 42 } },
  items: [1, 2, 3],
  text: 'hello',
} as const

const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'] as const

// Bases reachable under the default policy, spanning object/array/string
// receivers and literals, so the dangerous-key check is exercised regardless of
// what it is anchored to.
const NAVIGABLE_BASES = [
  'obj',
  'user',
  'user.profile',
  'items',
  'text',
  '{ safe: 1 }',
  '[1, 2, 3]',
] as const

const dangerousAccessArbitrary = fc
  .tuple(
    fc.constantFrom(...NAVIGABLE_BASES),
    fc.constantFrom(...DANGEROUS_KEYS),
    fc.constantFrom('dot', 'computed'),
  )
  .map(([base, key, form]) =>
    form === 'dot' ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`,
  )

describe('security property: prototype-access is always blocked', () => {
  const expr = bonsai()

  it.prop([dangerousAccessArbitrary], { seed: SEED_PROTO_ACCESS, numRuns: 150 })(
    'throws BonsaiSecurityError (sync and async) for any dangerous-key access',
    async (source) => {
      expect(() => expr.evaluateSync(source, { ...SANDBOX_CONTEXT })).toThrow(BonsaiSecurityError)
      await expect(expr.evaluate(source, { ...SANDBOX_CONTEXT })).rejects.toBeInstanceOf(
        BonsaiSecurityError,
      )
    },
  )
})

// Object-literal source generator: safe identifier keys, atom or nested-object
// values. maxDepth bounds nesting so the value rule terminates at an atom.
const { objectSource } = fc.letrec<{ value: string; objectSource: string }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 2, depthSize: 'small' },
    { weight: 4, arbitrary: fc.constantFrom('0', '1', 'true', '"s"', 'num', 'items[0]') },
    { weight: 1, arbitrary: tie('objectSource') },
  ),
  objectSource: fc
    .array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'x', 'y', 'name', 'value'), tie('value')), {
      minLength: 1,
      maxLength: 3,
    })
    .map((entries) => `{ ${entries.map(([key, value]) => `${key}: ${value}`).join(', ')} }`),
}))

function assertNullPrototypeDeep(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNullPrototypeDeep)
    return
  }
  if (value !== null && typeof value === 'object') {
    expect(Object.getPrototypeOf(value)).toBeNull()
    for (const nested of Object.values(value)) assertNullPrototypeDeep(nested)
  }
}

describe('security property: evaluated objects have null prototypes', () => {
  const expr = bonsai()

  it.prop([objectSource], { seed: SEED_NULL_PROTO, numRuns: 200 })(
    'every object produced by an object literal, nested included, has a null prototype',
    (source) => {
      const result = expr.evaluateSync(source, { num: 7, items: [1, 2, 3] })
      assertNullPrototypeDeep(result)
    },
  )
})

// Names placed only on the prototype of the context object. None are own
// properties, so resolving the bare identifier must miss.
const INHERITED_NAMES = [
  'alpha',
  'beta',
  'gamma',
  'secret',
  'token',
  'role',
  'admin',
  'inherited',
] as const

describe('security property: inherited context properties never resolve', () => {
  const expr = bonsai()

  it.prop([fc.constantFrom(...INHERITED_NAMES), fc.constantFrom('LEAK', 42, true)], {
    seed: SEED_OWN_ONLY,
    numRuns: 100,
  })(
    'a property present only on the prototype resolves to undefined, not the inherited value',
    (name, sentinel) => {
      const proto = { [name]: sentinel }
      const ctx = Object.create(proto) as Record<string, unknown>
      ctx.own = 'safe'

      expect(expr.evaluateSync(name, ctx)).toBeUndefined()
      expect(expr.evaluateSync('own', ctx)).toBe('safe')
    },
  )
})
