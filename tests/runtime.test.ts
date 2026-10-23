import { describe, expect, it } from 'vitest'
import { artifactDigest } from '../src/artifact.js'
import { bindImplicit } from '../src/check/bind.js'
import { internalsOf } from '../src/environment.js'
import { bonsai, fn, t, toArtifact, type Artifact } from '../src/index.js'
import {
  BonsaiArtifactError,
  Duration,
  runtime,
  type ArtifactProblem,
} from '../src/runtime/index.js'
import { parse } from '../src/parse.js'

/** An artifact as a browser receives it: through JSON, mutable. */
const shipped = (artifact: Artifact): Record<string, unknown> =>
  JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>

/** Recomputes the digest of an edited artifact, as a careful forger would. */
const resigned = (
  artifact: Record<string, unknown>,
  options: Parameters<typeof bonsai>[0] = {},
) => {
  const { digest: _, ...fields } = artifact as unknown as Artifact
  const { lookup } = internalsOf(bonsai(options)).checkEnv
  const root = bindImplicit(parse(fields.source), lookup).root
  return { ...fields, digest: artifactDigest(fields, root, lookup, options.variables) }
}

/** The refusal reason, the name of any other error, or "loaded". */
const reasonOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiArtifactError) return error.reason
    return (error as Error).name
  }
  return 'loaded'
}

const durations = { variables: { xs: t.list(t.duration()) } }

describe('runtime().load()', () => {
  it('evaluates an artifact as the checked program does, including overloads chosen by static type', () => {
    const env = bonsai(durations)
    const rt = runtime(durations)
    const empty = { xs: [] }
    for (const source of ['xs.filter(.inHours() > 5).sum()', 'xs.sum() < hours(1)']) {
      const program = env.compile(source)
      const loaded = rt.load(shipped(toArtifact(program)) as unknown as Artifact)
      expect(loaded.evaluateSync(empty)).toEqual(program.evaluateSync(empty))
    }
    // An open environment, without the static types, sums an empty list as a number.
    expect(bonsai().evaluateSync('xs.sum()', empty)).toBe(0)
    expect(rt.load(toArtifact(env.compile('xs.sum()'))).evaluateSync(empty)).toBeInstanceOf(
      Duration,
    )
  })

  it('evaluates async programs and refuses them synchronously', async () => {
    const functions = {
      rate: fn({
        params: [t.string()],
        returns: t.number(),
        async: true,
        run: () => Promise.resolve(2),
      }),
    }
    const program = bonsai({ functions }).compile('rate("EUR") * 10')
    const loaded = runtime({ functions }).load(toArtifact(program))
    expect(loaded.async).toBe(true)
    await expect(loaded.evaluate()).resolves.toBe(20)
    expect(() => loaded.evaluateSync()).toThrow(expect.objectContaining({ code: 'ASYNC_IN_SYNC' }))
  })

  it('types and checks the result against the expected type the host passes', () => {
    const artifact = toArtifact(bonsai().compile('x', { expect: t.boolean() }))
    const loaded = runtime().load(artifact, { expect: t.boolean() })
    expect(loaded.evaluateSync({ x: true })).toBe(true)
    expect(() => loaded.evaluateSync({ x: 5 })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })

  it('checks results against the host expected type even when the artifact says not to', () => {
    // A forged artifact claims a boolean and no run-time check, with a recomputed digest.
    const forged = resigned({
      ...shipped(toArtifact(bonsai().compile('true', { expect: t.boolean() }))),
      source: '"yes"',
    })
    const loaded = runtime().load(forged, { expect: t.boolean() })
    expect(() => loaded.evaluateSync()).toThrow(expect.objectContaining({ code: 'TYPE_ERROR' }))
  })

  it('refuses an artifact compiled for another expected type than the host passes', () => {
    const artifact = toArtifact(bonsai().compile('1', { expect: t.number() }))
    expect(reasonOf(() => runtime().load(artifact, { expect: t.boolean() }))).toBe('expect')
    expect(
      reasonOf(() => runtime().load(toArtifact(bonsai().compile('1')), { expect: t.number() })),
    ).toBe('expect')
  })
})

describe('refusing artifacts', () => {
  const base = shipped(toArtifact(bonsai({ variables: { n: t.number() } }).compile('n + 1')))
  const load = (
    artifact: unknown,
    options: Parameters<typeof runtime>[0] = { variables: { n: t.number() } },
  ) => runtime(options).load(artifact as Artifact)

  it('refuses a built-in run where the producer had a host function of the same name and signature', () => {
    const functions = {
      year: fn({
        params: [t.timestamp(), t.optional(t.string())],
        required: 1,
        returns: t.number(),
        run: () => 2026,
      }),
    }
    const variables = { d: t.timestamp() }
    const artifact = toArtifact(bonsai({ variables, functions }).compile('year(d) > 2025'))
    expect(reasonOf(() => runtime({ variables }).load(artifact))).toBe('digest')
    expect(reasonOf(() => runtime({ variables, functions }).load(artifact))).toBe('loaded')
  })

  it('refuses an edited source, also after the original was evaluated through the cache', () => {
    const rt = runtime({ variables: { n: t.number() } })
    expect(rt.evaluateSync(base as unknown as Artifact, { n: 1 })).toBe(2)
    const edited = { ...base, source: 'n + 2' }
    expect(reasonOf(() => rt.evaluateSync(edited as unknown as Artifact, { n: 1 }))).toBe('digest')
  })

  it('refuses a changed variable declaration', () => {
    expect(reasonOf(() => load(base, { variables: { n: t.optional(t.number()) } }))).toBe('digest')
  })

  it.each<[string, Record<string, unknown>, ArtifactProblem]>([
    ['a newer format', { ...base, bonsai: 2 }, 'version'],
    ['a field this runtime does not know', { ...base, extra: 1 }, 'version'],
    ['a field of the wrong type', { ...base, guard: 'no' }, 'shape'],
    ['a non-integer format', { ...base, bonsai: 1.5 }, 'shape'],
    ['source it cannot parse', { ...base, source: 'n +' }, 'syntax'],
    ['a call to a function it lacks', { ...base, source: 'missing(n)' }, 'function'],
  ])('refuses %s', (_, artifact, reason) => {
    expect(reasonOf(() => load(artifact))).toBe(reason)
  })

  it('refuses sources and plans past its limits before parsing', () => {
    expect(
      reasonOf(() =>
        load({ ...base, source: 'n'.repeat(11) }, { limits: { maxSourceLength: 10 } }),
      ),
    ).toBe('limit')
    const plans = Array.from({ length: 30 }, (_, i) => [i, 'f', 0])
    expect(reasonOf(() => load({ ...base, plans }, { limits: { maxNodes: 20 } }))).toBe('limit')
  })

  it('refuses a "." the checker would reject, even with a matching digest', () => {
    const forged = resigned({ ...base, source: '[1, 2].map((x) => .y)' })
    expect(reasonOf(() => load(forged, {}))).toBe('binding')
  })

  it('refuses plans that match no call or name no narrower overload set', () => {
    const env = bonsai(durations)
    const artifact = shipped(toArtifact(env.compile('xs.sum()')))
    expect(artifact.plans).toEqual([[3, 'sum', 1]])
    for (const plans of [
      [[4, 'sum', 1]],
      [[3, 'avg', 1]],
      [[3, 'sum', 2]],
      [[3, 'sum', 0, 1]],
      [[3, 'sum']],
    ]) {
      expect(reasonOf(() => load(resigned({ ...artifact, plans }, durations), durations))).toBe(
        'plan',
      )
    }
  })

  it('throws TypeError for values that are not artifacts', () => {
    for (const value of [null, 'x', [], { source: '1' }, { bonsai: 1, source: '1' }])
      expect(reasonOf(() => load(value))).toBe('TypeError')
  })

  it('reads each property once, runs no getter, and keeps a __proto__ field', () => {
    const reads: string[] = []
    const proxy = new Proxy(base, {
      getOwnPropertyDescriptor(target, key) {
        reads.push(String(key))
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expect(reasonOf(() => load(proxy))).toBe('loaded')
    expect(reads.filter((key) => key === 'source')).toHaveLength(1)

    const withGetter = Object.defineProperty({ ...base }, 'digest', {
      get: () => 'x',
      enumerable: true,
    })
    expect(reasonOf(() => load(withGetter))).toBe('shape')

    const proto = JSON.parse('{"kind":"map","fields":{"__proto__":{"kind":"number"}}}') as unknown
    const program = bonsai().compile('x', { expect: proto as never })
    const artifact = shipped(toArtifact(program))
    expect(reasonOf(() => runtime().load(artifact as unknown as Artifact))).toBe('loaded')
  })

  it('reports why in the error and its JSON', () => {
    try {
      load({ ...base, bonsai: 2 })
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ARTIFACT',
        reason: 'version',
        name: 'BonsaiArtifactError',
      })
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        code: 'ARTIFACT',
        reason: 'version',
      })
    }
  })

  it('rejects the strict option, which only affects checking', () => {
    expect(() => runtime({ strict: true } as never)).toThrow(TypeError)
  })
})
