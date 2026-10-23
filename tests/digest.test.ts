import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { encodeFunction, encodeType, hash64 } from '../src/digest.js'
import { internalsOf } from '../src/environment.js'
import type { FunctionDef } from '../src/functions/define.js'
import { BUILTINS } from '../src/functions/builtins.js'
import { bonsai, fn, t, type Type } from '../src/index.js'

const hostDef = (name: string, spec: Parameters<typeof fn>[0]): FunctionDef => {
  const env = bonsai({ functions: { [name]: fn(spec) } })
  return internalsOf(env).checkEnv.lookup(name) as FunctionDef
}
const builtin = (name: string): FunctionDef => BUILTINS.get(name) as FunctionDef
const sameCode = (a: Type, b: Type): boolean => encodeType(a) === encodeType(b)

describe('encodeType', () => {
  it('ignores the order object fields were written in', () => {
    expect(
      sameCode(
        t.object({ a: t.number(), b: t.string() }),
        t.object({ b: t.string(), a: t.number() }),
      ),
    ).toBe(true)
  })

  it('flattens nested unions and ignores member order', () => {
    const flat = t.union(t.number(), t.string(), t.null())
    expect(sameCode(t.union(t.number(), t.union(t.string(), t.null())), flat)).toBe(true)
    expect(sameCode(t.union(t.null(), t.string(), t.number()), flat)).toBe(true)
    expect(sameCode(t.optional(t.union(t.number(), t.string())), flat)).toBe(true)
  })

  it.each<[string, Type, Type]>([
    ['literal kinds', t.literal(1), t.literal('1')],
    ['literal values', t.literal('a'), t.literal('b')],
    ['optional and required', t.optional(t.number()), t.number()],
    [
      'optional and required fields',
      t.object({ a: t.optional(t.number()) }),
      t.object({ a: t.number() }),
    ],
    ['record and empty object', t.record(t.number()), t.object({})],
    ['list element types', t.list(t.number()), t.list(t.duration())],
    ['opaque names', t.opaque('Ebo1yq2oa'), t.opaque('En8vhf9dq')],
    [
      'field names with separators',
      t.object({ 'a=b': t.number() }),
      t.object({ a: t.literal('b') }),
    ],
  ])('distinguishes %s', (_, a, b) => {
    expect(encodeType(a)).not.toBe(encodeType(b))
    expect(hash64(encodeType(a))).not.toBe(hash64(encodeType(b)))
  })

  it('distinguishes types that differ past the text diagnostics show', () => {
    const profile = (score: Type) =>
      t.object({
        accountIdentifier: t.string(),
        billingCountry: t.string(),
        createdAt: t.timestamp(),
        subscriptionPlan: t.enum('free', 'pro', 'team'),
        lastLoginAt: t.optional(t.timestamp()),
        score,
      })
    expect(encodeType(profile(t.number()))).not.toBe(encodeType(profile(t.string())))
  })
})

describe('encodeFunction', () => {
  it('tells a host function from the built-in it replaces, with the same signature', () => {
    const override = hostDef('year', {
      params: [t.timestamp(), t.optional(t.string())],
      required: 1,
      returns: t.number(),
      run: () => 2026,
    })
    const yearBuiltin = builtin('year')
    expect(override.overloads[0].required).toBe(yearBuiltin.overloads[0].required ?? 2)
    expect(encodeFunction(override)).not.toBe(encodeFunction(yearBuiltin))
  })

  it('normalizes flags a built-in leaves unset', () => {
    const plain = hostDef('f', { params: [t.number()], returns: t.number(), run: (n) => n })
    const explicit = hostDef('f', {
      params: [t.number()],
      required: 1,
      returns: t.number(),
      async: false,
      call: false,
      run: (n) => n,
    })
    expect(encodeFunction(plain)).toBe(encodeFunction(explicit))
  })

  it.each<[string, Parameters<typeof fn>[0]]>([
    ['async', { params: [], returns: t.number(), async: true, run: () => Promise.resolve(1) }],
    ['call', { params: [], returns: t.number(), call: true, run: () => 1 }],
    [
      'required count',
      { params: [t.optional(t.number())], required: 0, returns: t.number(), run: () => 1 },
    ],
    ['result type', { params: [], returns: t.string(), run: () => '1' }],
  ])('changes with %s', (_, spec) => {
    const base = hostDef('f', { params: spec.params, returns: t.number(), run: () => 1 })
    expect(encodeFunction(hostDef('f', spec))).not.toBe(encodeFunction(base))
  })
})

describe('hash64', () => {
  // The encoding and the hash are part of the artifact format: a change to
  // either needs a new format version.
  it('is pinned', () => {
    expect(hash64('')).toBe('0ztntfp0ztntfp')
    expect(hash64(encodeType(t.object({ user: t.object({ age: t.number() }) })))).toBe(
      '1bp4jtv1wpl5c3',
    )
    expect(hash64(encodeFunction(builtin('sum')))).toBe('1vdq3oq1pe5gzm')
  })

  test.prop([fc.string({ unit: 'binary' })])('is 14 base-36 characters', (value) => {
    expect(hash64(value)).toMatch(/^[0-9a-z]{14}$/u)
  })

  test.prop([fc.string({ unit: 'binary', minLength: 1 })])(
    'changes when one code unit changes',
    (value) => {
      const flipped = String.fromCharCode(value.charCodeAt(0) ^ 1) + value.slice(1)
      expect(hash64(flipped)).not.toBe(hash64(value))
    },
  )
})
