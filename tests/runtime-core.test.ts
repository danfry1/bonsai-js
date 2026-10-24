import { describe, expect, it } from 'vitest'
import * as b from '../src/builtins/index.js'
import { BUILTINS } from '../src/functions/builtins.js'
import { BonsaiArtifactError, bonsai, fn, t, toArtifact } from '../src/index.js'
import { runtime as fullRuntime } from '../src/runtime/index.js'
import { runtime } from '../src/runtime/core.js'

const variables = { user: t.object({ name: t.string(), tags: t.list(t.string()) }) }
const user = { name: 'Ada', tags: ['beta', 'admin'] }
const builtins = [b.includes, b.toLowerCase, b.some]

const shipped = (source: string, env = bonsai({ variables, builtins })) =>
  JSON.parse(JSON.stringify(toArtifact(env.compile(source)))) as ReturnType<typeof toArtifact>

const reasonOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof BonsaiArtifactError) return error.reason
    return (error as Error).name
  }
  return 'loaded'
}

describe('bonsai-js/runtime/core', () => {
  it('evaluates with the built-ins passed, as bonsai-js/runtime does', () => {
    const source = 'user.tags.some(.toLowerCase().includes("adm"))'
    const artifact = shipped(source)
    expect(runtime({ variables, builtins }).load(artifact).evaluateSync({ user })).toBe(true)
    expect(fullRuntime({ variables }).load(artifact).evaluateSync({ user })).toBe(true)
  })

  it('has no built-ins by default, and runs rules that call none', () => {
    expect(runtime({ variables }).load(shipped('user.name == "Ada"')).evaluateSync({ user })).toBe(
      true,
    )
    const artifact = shipped('user.name.toLowerCase() == "ada"')
    expect(reasonOf(() => runtime({ variables }).load(artifact))).toBe('function')
    expect(() => runtime({ variables }).load(artifact)).toThrow(
      'The artifact calls toLowerCase(), which this runtime does not define',
    )
  })

  it('adds built-ins on extend, and keeps its own', () => {
    const base = runtime({ variables, builtins: [b.toLowerCase] })
    const artifact = shipped('user.tags.some(.toLowerCase() == "beta")')
    expect(reasonOf(() => base.load(artifact))).toBe('function')
    expect(
      base
        .extend({ builtins: [b.some] })
        .load(artifact)
        .evaluateSync({ user }),
    ).toBe(true)
    expect(base.extend({}).load(shipped('user.name.toLowerCase()')).evaluateSync({ user })).toBe(
      'ada',
    )
  })

  it('lets a host function replace a built-in of the same name', () => {
    const functions = { trim: fn({ params: [t.string()], returns: t.string(), run: () => 'host' }) }
    const artifact = shipped('trim(user.name)', bonsai({ variables, functions }))
    expect(runtime({ variables, functions }).load(artifact).evaluateSync({ user })).toBe('host')
    // A built-in of that name is not the host function: the digest differs.
    expect(reasonOf(() => runtime({ variables, builtins: [b.trim] }).load(artifact))).toBe('digest')
  })

  it('takes only built-ins from bonsai-js/builtins', () => {
    expect(() => runtime({ builtins: 'all' as never })).toThrow(TypeError)
    expect(() => runtime({ builtins: [{ name: 'trim' }] as never })).toThrow(
      'builtins must hold built-ins from bonsai-js/builtins',
    )
    const copy = { name: 'trim', [Symbol.for('bonsai-js.builtin')]: true }
    expect(() => runtime({ builtins: [copy] as never })).toThrow(
      'builtins holds trim from another copy of bonsai-js',
    )
    // bonsai-js/runtime has every built-in and does not take the option.
    expect(() => fullRuntime({ builtins: [b.trim] } as never)).toThrow('bonsai-js/runtime/core')
  })
})

describe('the builtins option of bonsai()', () => {
  it('makes a call to a built-in left out a check error', () => {
    const env = bonsai({ variables, builtins })
    expect(env.check('user.name.trim()').diagnostics[0]?.message).toBe(
      'Unknown function "trim"; trim is a built-in this environment does not include (add it to builtins)',
    )
    expect(env.check('user.tags.some(.includes("a"))').ok).toBe(true)
    expect(env.listFunctions().map((f) => f.name)).toEqual(['includes', 'toLowerCase', 'some'])
  })

  it('suggests only functions the environment has', () => {
    const contains = (env: {
      check: (source: string) => { diagnostics: readonly { suggestion?: string }[] }
    }) => env.check('user.name.contains("a")').diagnostics[0]
    expect(contains(bonsai({ variables }))?.suggestion).toBe('includes')
    expect(contains(bonsai({ variables, builtins: [b.trim] }))?.suggestion).not.toBe('includes')
  })

  it('adds to the base on extend', () => {
    const env = bonsai({ variables, builtins: [b.trim] }).extend({ builtins: [b.some] })
    expect(env.listFunctions().map((f) => f.name)).toEqual(['trim', 'some'])
    expect(
      bonsai()
        .extend({ builtins: [b.trim] })
        .listFunctions(),
    ).toHaveLength(BUILTINS.size)
  })
})

describe('bonsai-js/builtins', () => {
  it('exports every built-in by its name', () => {
    expect(Object.keys(b).sort()).toEqual([...BUILTINS.keys()].sort())
    for (const [name, def] of BUILTINS) expect(b[name as keyof typeof b], name).toBe(def)
  })
})
