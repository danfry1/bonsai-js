import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { artifactDigest } from '../src/artifact.js'
import { bindImplicit } from '../src/check/bind.js'
import { internalsOf } from '../src/environment.js'
import { bonsai, fn, t, toArtifact, type Artifact } from '../src/index.js'
import {
  BonsaiArtifactError,
  isBonsaiError,
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
    for (const value of [null, 'x', [], { source: '1' }])
      expect(reasonOf(() => load(value))).toBe('TypeError')
    // A format 1 artifact missing its other fields is malformed, not something else.
    expect(reasonOf(() => load({ bonsai: 1, source: '1' }))).toBe('shape')
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
    expect(reads.filter((key) => key === 'bonsai')).toHaveLength(1)

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

  it('refuses reading an undeclared variable when strict, as the checker does', () => {
    const variables = { user: t.object({ age: t.number() }) }
    const context = { user: { age: 30 }, session: { token: 'secret' } }
    const source = 'session.token'
    // A forged artifact: the digest is a checksum, so anyone can recompute it.
    const loose = toArtifact(bonsai({ variables, strict: false }).compile(source))
    expect(() => bonsai({ variables }).compile(source)).toThrow('Unknown variable "session"')
    expect(reasonOf(() => runtime({ variables }).load(loose))).toBe('variable')
    expect(reasonOf(() => runtime({ variables, strict: true }).load(loose))).toBe('variable')
    expect(reasonOf(() => runtime({ strict: true }).load(loose))).toBe('variable')
    expect(runtime({ variables, strict: false }).load(loose).evaluateSync(context)).toBe('secret')
    // Let bindings and lambda parameters are not variables.
    const locals = toArtifact(
      bonsai({ variables }).compile('let y = user.age; [1].map(x => x + y)'),
    )
    expect(runtime({ variables }).load(locals).evaluateSync(context)).toEqual([31])
  })
})

describe('overload choices', () => {
  // The checker's overload choices change results only for sum and avg of an
  // empty list, and for data that does not match its declared type. Both are
  // generated here, for every built-in with more than one overload.
  const declared = {
    number: t.number(),
    string: t.string(),
    duration: t.duration(),
    numbers: t.list(t.number()),
    durations: t.list(t.duration()),
    strings: t.list(t.string()),
  }
  const values = fc.oneof(
    fc.integer({ min: -5, max: 5 }),
    fc.constantFrom('', 'ab', 'b'),
    fc.constantFrom(new Duration(0), new Duration(7_200_000)),
    fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 3 }),
    fc.array(fc.constantFrom(new Duration(0), new Duration(60_000)), { maxLength: 3 }),
    fc.array(fc.constantFrom('a', 'b'), { maxLength: 3 }),
  )
  const sources = [
    'x.abs()',
    'x.sum()',
    'x.avg()',
    'x.sum() == hours(0)',
    'x.includes(1)',
    'x.includes("a")',
    'x.indexOf("b")',
    'x.lastIndexOf(1)',
    'x.slice(0, 1)',
    'x.at(0)',
    'min(x)',
    'max(x)',
    'x.count()',
    'timestamp(x)',
    'duration(x)',
  ]

  const outcome = (run: () => unknown): unknown => {
    try {
      return { value: run() }
    } catch (error) {
      return { error: (error as { code?: string }).code ?? String(error) }
    }
  }

  test.prop([fc.constantFrom(...Object.keys(declared)), fc.constantFrom(...sources), values], {
    numRuns: 2000,
  })(
    'a loaded artifact matches the checked program for any declared type and data',
    (kind, source, x) => {
      const variables = { x: declared[kind as keyof typeof declared] }
      const env = bonsai({ variables })
      if (!env.check(source).ok) return
      const program = env.compile(source)
      const loaded = runtime({ variables }).load(
        shipped(toArtifact(program)) as unknown as Artifact,
      )
      expect(outcome(() => loaded.evaluateSync({ x }))).toEqual(
        outcome(() => program.evaluateSync({ x })),
      )
    },
  )
})

describe('hostile artifacts', () => {
  const variables = { xs: t.list(t.duration()), n: t.number() }
  const base = shipped(
    toArtifact(bonsai({ variables }).compile('xs.sum() < hours(n)', { expect: t.boolean() })),
  )
  const rt = runtime({ variables, limits: { maxSteps: 10_000 } })
  const junk = fc.oneof(
    fc.jsonValue({ maxDepth: 3 }),
    fc.string({ unit: 'binary', maxLength: 40 }),
    fc.constantFrom(-0, 2 ** 53, -1, 1.5, '__proto__', 'constructor'),
  )
  const plan = fc.tuple(
    fc.integer({ min: -2, max: 40 }),
    fc.constantFrom('sum', 'hours', 'x', ''),
    fc.array(fc.integer({ min: -1, max: 3 }), { maxLength: 3 }),
  )
  const field = fc.constantFrom(...Object.keys(base), 'extra')
  const mutated = fc.record({
    edits: fc.array(fc.tuple(field, fc.oneof(junk, fc.array(plan, { maxLength: 3 }))), {
      maxLength: 3,
    }),
    drop: fc.array(field, { maxLength: 2 }),
    resign: fc.boolean(),
  })

  test.prop([mutated], { numRuns: 1500 })(
    'only load, a Bonsai error, or a TypeError',
    ({ edits, drop, resign }) => {
      let artifact: Record<string, unknown> = { ...base }
      for (const [key, value] of edits) artifact[key] = value
      for (const key of drop) delete artifact[key]
      if (resign && typeof artifact.source === 'string' && Array.isArray(artifact.plans)) {
        try {
          artifact = resigned(artifact, { variables })
        } catch {
          // Not every edit leaves something a forger could sign.
        }
      }
      try {
        rt.load(artifact as unknown as Artifact).evaluateSync({ xs: [], n: 1 })
      } catch (error) {
        expect(isBonsaiError(error) || error instanceof TypeError, String(error)).toBe(true)
      }
    },
  )
})

describe('round 3 regressions', () => {
  it('loads artifacts whose expected type is a checked map literal type, which is exact', () => {
    const env = bonsai()
    const shape = env.compile('{ a: 1 }').type
    const program = env.compile('{ a: 2 }', { expect: shape })
    const loaded = runtime().load(shipped(toArtifact(program)) as unknown as Artifact)
    expect(loaded.evaluateSync()).toEqual({ a: 2 })
    // A declared type with the same JSON is not served the exact program from the cache.
    const declared = env.compile('{ a: 2 }', { expect: t.object({ a: t.number() }) })
    expect(() => runtime().load(shipped(toArtifact(declared)) as unknown as Artifact)).not.toThrow()
  })

  it('loads artifacts reading a variable declared with an exact type and shared as JSON', () => {
    const shape = bonsai().compile('{ a: 1 }').type
    const program = bonsai({ variables: { o: shape } }).compile('o.a + 1')
    const variables = { o: JSON.parse(JSON.stringify(shape)) as typeof shape }
    expect(
      runtime({ variables })
        .load(toArtifact(program))
        .evaluateSync({ o: { a: 1 } }),
    ).toBe(2)
  })

  it('validates load options as compile() validates its own', () => {
    const artifact = toArtifact(bonsai().compile('1', { expect: t.number() }))
    expect(() => runtime().load(artifact, { expct: t.number() } as never)).toThrow(
      'Unknown load option key "expct"',
    )
    for (const expectType of [null, { kind: 'nope' }, { kind: 'map', fields: null }])
      expect(() => runtime().load(artifact, { expect: expectType } as never)).toThrow(
        'Load option "expect"',
      )
    const throwing = Object.defineProperty({}, 'expect', {
      enumerable: true,
      get: () => {
        throw new Error('boom')
      },
    })
    expect(() => runtime().load(artifact, throwing)).toThrow('Load options could not be read')
  })

  it('counts an expected type the same way when making and loading an artifact', () => {
    // 34,000 objects are 68,001 type nodes, which loads; counting each field
    // record too (102,001 parts) used to refuse it.
    const members = Array.from({ length: 34_000 }, (_, i) => t.object({ [`k${i}`]: t.number() }))
    const program = bonsai().compile('x', { expect: t.union(...members) })
    const artifact = toArtifact(program)
    expect(() => runtime().load(shipped(artifact) as unknown as Artifact)).not.toThrow()
  })

  it('turns anything a hostile Proxy throws into a TypeError', () => {
    const base = shipped(toArtifact(bonsai().compile('1')))
    const throwing = (value: unknown) =>
      new Proxy(base, {
        ownKeys() {
          throw value
        },
      })
    for (const value of [new Error('boom'), 'boom', 42]) {
      let error: unknown
      try {
        runtime().load(throwing(value) as never)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).cause).toBe(value)
    }
    const { proxy, revoke } = Proxy.revocable(base, {})
    revoke()
    expect(reasonOf(() => runtime().load(proxy as never))).toBe('TypeError')
  })

  it('refuses an oversized plans array without reading its elements', () => {
    const base = shipped(toArtifact(bonsai().compile('1')))
    const plans = new Array<unknown>(1_000_000).fill([0, 'x', 0])
    const started = performance.now()
    expect(reasonOf(() => runtime().load({ ...base, plans } as never))).toBe('limit')
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('reports different definitions as a digest mismatch, even when they would bind differently', () => {
    const artifact = toArtifact(bonsai().compile('[1].filter(. > 0)'))
    const functions = {
      filter: fn({ params: [t.list(t.number()), t.boolean()], returns: t.number(), run: () => 1 }),
    }
    expect(reasonOf(() => runtime({ functions }).load(artifact))).toBe('digest')
  })

  it('refuses a later format as a version, whatever fields it has', () => {
    expect(
      reasonOf(() => runtime().load({ bonsai: 2, source: '1', signature: 'x' } as never)),
    ).toBe('version')
  })

  it('names only runtime options in errors', () => {
    expect(() => runtime({ strict: undefined })).not.toThrow()
    expect(() => runtime({ bogus: 1 } as never)).toThrow(
      'Unknown runtime option key "bogus" (expected one of: variables, functions, libraries, limits, cacheSize, clock, validateContext, strict)',
    )
  })
})

describe('round 4 regressions', () => {
  it('records the checked expected type, not extra keys or what toJSON says', () => {
    const extra = { kind: 'number', description: 'age', title: 'Age' }
    const withExtra = toArtifact(bonsai().compile('o', { expect: extra as never }))
    expect(withExtra.expect).toEqual({ kind: 'number' })
    expect(
      runtime()
        .load(shipped(withExtra) as unknown as Artifact)
        .evaluateSync({ o: 3 }),
    ).toBe(3)

    const lying = { kind: 'number', toJSON: () => ({ kind: 'string' }) }
    const program = bonsai().compile('o', { expect: lying as never })
    const loaded = runtime().load(shipped(toArtifact(program)) as unknown as Artifact)
    expect(() => program.evaluateSync({ o: 'x' })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
    expect(() => loaded.evaluateSync({ o: 'x' })).toThrow(
      expect.objectContaining({ code: 'TYPE_ERROR' }),
    )
  })

  it('refuses a later format as a version however many fields it has', () => {
    const later = Object.fromEntries([
      ['bonsai', 2],
      ...Array.from({ length: 30 }, (_, i) => [`f${i}`, i]),
    ])
    expect(reasonOf(() => runtime().load(later as never))).toBe('version')
  })

  it('refuses a self-containing expected type quickly', () => {
    const base = toArtifact(bonsai().compile('1'))
    const union: { kind: string; types: unknown[] } = { kind: 'union', types: [] }
    union.types.push(union, ...Array.from({ length: 99_998 }, () => ({ kind: 'number' })))
    const artifact = structuredClone({ ...base, expect: union })
    const started = performance.now()
    expect(reasonOf(() => runtime().load(artifact as never))).toBe('limit')
    expect(performance.now() - started).toBeLessThan(150)
  })

  it('passes through only its own errors while reading an artifact', () => {
    const base = shipped(toArtifact(bonsai().compile('1')))
    const fake = { [Symbol.for('bonsai-js.error')]: true, message: 'fake' }
    const real = bonsai().compile('1 / 0')
    let runtimeError: unknown
    try {
      real.evaluateSync()
    } catch (error) {
      runtimeError = error
    }
    for (const thrown of [fake, runtimeError]) {
      const proxy = new Proxy(base, {
        ownKeys() {
          throw thrown
        },
      })
      expect(reasonOf(() => runtime().load(proxy as never))).toBe('TypeError')
    }
  })

  it('accepts an expected type that is written differently but means the same', () => {
    const artifact = toArtifact(bonsai().compile('1', { expect: t.number() }))
    for (const same of [t.union(t.number(), t.number()), t.union(t.number(), t.never())])
      expect(runtime().load(artifact, { expect: same }).evaluateSync()).toBe(1)
  })
})

describe('round 5 regressions', () => {
  it('refuses an expected union with a hole when compiling and loading', () => {
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the point
    const holey = { kind: 'union', types: [, t.number()] }
    expect(() => bonsai().compile('o', { expect: holey as never })).toThrow('types[0]')
    const artifact = toArtifact(bonsai().compile('1', { expect: t.number() }))
    expect(() => runtime().load(artifact, { expect: holey as never })).toThrow('types[0]')
  })

  it('caches artifacts by their expected type as written, so messages match the environment', () => {
    const rt = runtime()
    const written = [t.number(), t.union(t.number(), t.never()), t.union(t.string(), t.number())]
    for (const expectType of written) {
      const program = bonsai().compile('o', { expect: expectType })
      const artifact = shipped(toArtifact(program)) as unknown as Artifact
      let fromEnv = ''
      let fromRuntime = ''
      try {
        program.evaluateSync({ o: true })
      } catch (error) {
        fromEnv = (error as Error).message
      }
      try {
        rt.evaluateSync(artifact, { o: true })
      } catch (error) {
        fromRuntime = (error as Error).message
      }
      expect(fromRuntime).toBe(fromEnv)
    }
  })

  it('wraps a loader error from another load thrown by a Proxy trap', () => {
    const base = shipped(toArtifact(bonsai().compile('1')))
    let earlier: unknown
    try {
      runtime().load({ bonsai: 7 } as never)
    } catch (error) {
      earlier = error
    }
    const rethrowing = new Proxy(base, {
      ownKeys() {
        throw earlier
      },
    })
    expect(reasonOf(() => runtime().load(rethrowing as never))).toBe('TypeError')
    const nested = new Proxy(base, {
      ownKeys() {
        runtime().load({ bonsai: 1, source: 1 } as never)
        return []
      },
    })
    expect(reasonOf(() => runtime().load(nested as never))).toBe('TypeError')
  })

  it('wraps refusals from a load that a Proxy trap runs while reading, not only read errors', () => {
    const rt = runtime()
    const base = shipped(toArtifact(bonsai().compile('1')))
    for (const inner of [
      { ...base, digest: 'x' },
      { ...base, source: 'missing()' },
      { ...base, source: '1 +' },
    ]) {
      const hostile = new Proxy(base, {
        ownKeys(target) {
          rt.load(inner as never)
          return Reflect.ownKeys(target)
        },
      })
      expect(reasonOf(() => rt.load(hostile as never))).toBe('TypeError')
    }
  })
})
