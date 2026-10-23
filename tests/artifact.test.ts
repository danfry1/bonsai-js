import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bonsai, fn, t, toArtifact } from '../src/index.js'
import { bonsai as liteBonsai, toArtifact as liteToArtifact } from '../src/lite/index.js'
import { VERSION } from '../src/version.js'

const durations = bonsai({ variables: { xs: t.list(t.duration()) } })

describe('toArtifact', () => {
  it('records the source, the expected type, and no plans when every call uses all overloads', () => {
    const env = bonsai({ variables: { user: t.object({ age: t.number() }) } })
    const artifact = toArtifact(env.compile('user.age >= 18', { expect: t.boolean() }))
    expect(artifact).toEqual({
      bonsai: 1,
      by: VERSION,
      source: 'user.age >= 18',
      plans: [],
      expect: { kind: 'boolean' },
      guard: false,
      async: false,
      digest: expect.stringMatching(/^[0-9a-z]{14}$/u),
    })
  })

  it('records the overload the checker chose where static types narrowed it', () => {
    // sum's second overload sums durations: on an empty list only the static type tells them apart.
    const artifact = toArtifact(durations.compile('xs.filter(.inHours() > 5).sum()'))
    expect(artifact.plans).toEqual([[26, 'sum', 1]])
  })

  it('lists plans in source order, keyed by where the function name starts', () => {
    const env = bonsai({ variables: { s: t.string(), xs: t.list(t.number()) } })
    const artifact = toArtifact(env.compile('xs.includes(1) && s.includes("a")'))
    expect(artifact.plans).toEqual([
      [3, 'includes', 1],
      [20, 'includes', 0],
    ])
  })

  it('is plain JSON data, frozen, and the same object on every call', () => {
    const program = durations.compile('xs.sum() < hours(1)', { expect: t.boolean() })
    const artifact = toArtifact(program)
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact)
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.plans)).toBe(true)
    expect(toArtifact(program)).toBe(artifact)
  })

  it('records when the result must be checked at run time', () => {
    expect(toArtifact(bonsai().compile('x', { expect: t.boolean() })).guard).toBe(true)
    expect(toArtifact(bonsai().compile('x')).guard).toBe(false)
  })

  it('records async programs', () => {
    const env = bonsai({
      functions: {
        slow: fn({ params: [], returns: t.number(), async: true, run: () => Promise.resolve(1) }),
      },
    })
    expect(toArtifact(env.compile('slow() + 1')).async).toBe(true)
  })

  it('accepts programs from bonsai-js/lite and from check()', () => {
    expect(liteToArtifact(liteBonsai().compile('1 + 2')).source).toBe('1 + 2')
    const checked = bonsai().check('1 + 2')
    expect(checked.ok && toArtifact(checked.program).source).toBe('1 + 2')
  })

  it('refuses values that are not compiled programs', () => {
    expect(() => toArtifact({ source: '1' })).toThrow(TypeError)
  })

  it('refuses an expected type no runtime would load', () => {
    const values = Array.from({ length: 100_001 }, (_, i) => `v${i}`)
    const program = bonsai().compile('"v0"', { expect: t.enum(...values) })
    expect(() => toArtifact(program)).toThrow(RangeError)
  })
})

describe('artifact digest', () => {
  const digest = (
    source: string,
    options: Parameters<typeof bonsai>[0] = {},
    expectType?: Parameters<typeof t.list>[0],
  ): string =>
    toArtifact(
      bonsai(options).compile(
        source,
        expectType === undefined ? undefined : { expect: expectType },
      ),
    ).digest

  it('changes with the source, even when the plans stay the same', () => {
    const vars = { variables: { ds: t.list(t.duration()), ns: t.list(t.duration()) } }
    expect(digest('ds.sum() + hours(1)', vars)).not.toBe(digest('ns.sum() - hours(1)', vars))
  })

  it('changes with the expected type', () => {
    expect(digest('x', {}, t.boolean())).not.toBe(digest('x', {}, t.number()))
    expect(digest('x', {}, t.boolean())).not.toBe(digest('x'))
  })

  it('changes with the declared type of a variable the expression reads', () => {
    const numbers = { variables: { xs: t.list(t.number()) } }
    const durationsOnly = { variables: { xs: t.list(t.duration()) } }
    expect(digest('xs.sum()', numbers)).not.toBe(digest('xs.sum()', durationsOnly))
  })

  it('ignores variables and functions the expression does not use', () => {
    const base = { variables: { a: t.number() } }
    const more = {
      variables: { a: t.number(), b: t.string() },
      functions: { other: fn({ params: [], returns: t.number(), run: () => 1 }) },
    }
    expect(digest('a + 1', base)).toBe(digest('a + 1', more))
  })

  it('tells a host function from the built-in of the same name and signature', () => {
    const override = {
      variables: { d: t.timestamp() },
      functions: {
        year: fn({
          params: [t.timestamp(), t.optional(t.string())],
          required: 1,
          returns: t.number(),
          run: () => 2026,
        }),
      },
    }
    expect(digest('year(d) > 2000', override)).not.toBe(
      digest('year(d) > 2000', { variables: { d: t.timestamp() } }),
    )
  })

  it('does not depend on the order variables were declared in', () => {
    const ab = { variables: { a: t.object({ x: t.number(), y: t.string() }) } }
    const ba = { variables: { a: t.object({ y: t.string(), x: t.number() }) } }
    expect(digest('a.x', ab)).toBe(digest('a.x', ba))
  })
})

describe('VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
  })
})
