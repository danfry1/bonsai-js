/**
 * What bonsai-js/runtime and bonsai-js/runtime/core share: loading and
 * evaluating artifacts made by `toArtifact()`. They differ only in their
 * built-ins: every one, or those passed in `builtins`.
 */
import { assertExpectSize, type Artifact } from '../artifact.js'
import {
  ProgramCache,
  expectOption,
  settingsFrom,
  type Args,
  type EnvironmentOptions,
  type Extended,
  type Library,
  type NoVariables,
  type Settings,
} from '../environment.js'
import { artifactKey, loadArtifact, loadedRunner, readArtifact } from '../load.js'
import type { AnyType, Infer, Type } from '../types.js'

/**
 * The options of `runtime()`: those of `bonsai()` that affect evaluation.
 * `strict` has bonsai()'s default and must match the producer's: a strict
 * runtime refuses artifacts that read undeclared variables. Every built-in is
 * available; bonsai-js/runtime/core takes `builtins` instead.
 */
export type RuntimeOptions<
  V extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
  L extends readonly Library[] = readonly Library[],
> = Omit<EnvironmentOptions<V, L>, 'builtins'> & {
  /** Not an option here: bonsai-js/runtime has every built-in (see bonsai-js/runtime/core). */
  readonly builtins?: never
}

/**
 * The options of bonsai-js/runtime/core's `runtime()`: those of
 * bonsai-js/runtime, and `builtins`, the built-ins available (default none).
 */
export type CoreRuntimeOptions<
  V extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
  L extends readonly Library[] = readonly Library[],
> = EnvironmentOptions<V, L>

/** A loaded artifact: evaluates as the program it was made from does. Immutable. */
// oxlint-disable-next-line typescript/no-explicit-any -- the erased context, as for Program
export interface RuntimeProgram<Ctx = any, R = unknown> {
  readonly source: string
  /** Whether the expression calls an async host function (evaluateSync rejects it). */
  readonly async: boolean
  evaluate: (...args: Args<Ctx>) => Promise<R>
  evaluateSync: (...args: Args<Ctx>) => R
}

export interface LoadOptions<E extends Type = Type> {
  /**
   * The type the host relies on the result having. The artifact must have been
   * compiled for exactly this type, and every result is checked against it.
   */
  readonly expect?: E | undefined
}

/** Loads and evaluates artifacts against one set of definitions. Immutable. */
// oxlint-disable-next-line typescript/no-explicit-any -- the erased context, as for Environment
export interface Runtime<Ctx = any> extends Loader<Ctx> {
  /** A runtime with more or replaced definitions; see `bonsai().extend`. */
  extend: <
    const V2 extends Readonly<Record<string, Type>> = NoVariables,
    const L2 extends readonly Library[] = [],
    const S2 extends boolean | undefined = undefined,
  >(
    options: RuntimeOptions<V2, L2> & { readonly strict?: S2 },
  ) => Runtime<Extended<Ctx, V2, L2, S2>>
}

/** A runtime from bonsai-js/runtime/core. Immutable. */
// oxlint-disable-next-line typescript/no-explicit-any -- the erased context, as for Environment
export interface CoreRuntime<Ctx = any> extends Loader<Ctx> {
  /** A runtime with more or replaced definitions; `builtins` are added to this one's. */
  extend: <
    const V2 extends Readonly<Record<string, Type>> = NoVariables,
    const L2 extends readonly Library[] = [],
    const S2 extends boolean | undefined = undefined,
  >(
    options: CoreRuntimeOptions<V2, L2> & { readonly strict?: S2 },
  ) => CoreRuntime<Extended<Ctx, V2, L2, S2>>
}

// oxlint-disable-next-line typescript/no-explicit-any -- the erased context, as for Environment
interface Loader<Ctx = any> {
  /**
   * Loads an artifact. Throws BonsaiArtifactError (code ARTIFACT, with a
   * `reason`) when the artifact does not reproduce the checked program with
   * this runtime's definitions, and TypeError when the value is not an artifact.
   */
  load: <E extends Type = AnyType>(
    artifact: Artifact,
    options?: LoadOptions<E>,
  ) => RuntimeProgram<Ctx, Infer<E>>
  /** Loads (cached) and evaluates. `R` is an unchecked type, as for `env.evaluate`. */
  evaluate: <R = unknown>(artifact: Artifact, ...args: Args<Ctx>) => Promise<R>
  /** Loads (cached) and evaluates synchronously. */
  evaluateSync: <R = unknown>(artifact: Artifact, ...args: Args<Ctx>) => R
}

const RUNTIME_KEYS = [
  'variables',
  'functions',
  'libraries',
  'limits',
  'cacheSize',
  'clock',
  'validateContext',
  'strict',
]

/** The runtime takes bonsai()'s options (`builtins` only in bonsai-js/runtime/core). */
export function assertRuntimeOptions(options: unknown, core: boolean): void {
  if (typeof options !== 'object' || options === null) return
  let keys: string[]
  try {
    keys = Object.keys(options)
  } catch (error) {
    throw new TypeError('Runtime options could not be read', { cause: error })
  }
  const allowed = core ? [...RUNTIME_KEYS, 'builtins'] : RUNTIME_KEYS
  for (const key of keys) {
    if (!allowed.includes(key))
      throw new TypeError(
        key === 'builtins'
          ? 'Unknown runtime option key "builtins" (bonsai-js/runtime has every built-in; import runtime from bonsai-js/runtime/core to choose them)'
          : `Unknown runtime option key "${key}" (expected one of: ${allowed.join(', ')})`,
      )
  }
}

export function createRuntime<Ctx>(settings: Settings, core: boolean): Runtime<Ctx> {
  const cache = new ProgramCache<RuntimeProgram<Ctx>>(settings.cacheSize)

  function load<R>(artifact: Artifact, expect: Type | undefined): RuntimeProgram<Ctx, R> {
    const loaded = loadArtifact(artifact, settings, expect)
    const { runSync, runAsync } = loadedRunner<R>(loaded, settings)
    return Object.freeze({
      source: loaded.source,
      async: loaded.analysis.async,
      evaluate: (...args: Args<Ctx>) => runAsync(args[0], args[1]),
      evaluateSync: (...args: Args<Ctx>) => runSync(args[0], args[1]),
    })
  }

  function cached(artifact: unknown): RuntimeProgram<Ctx> {
    const read = readArtifact(artifact, settings)
    const key = artifactKey(read)
    const known = cache.get(key)
    if (known !== undefined) return known
    const program = load(read, undefined)
    cache.set(key, program)
    return program
  }

  const rt: Runtime<Ctx> = {
    load: <E extends Type = AnyType>(artifact: Artifact, options?: LoadOptions<E>) => {
      const expect = expectOption(options, 'Load')
      if (expect !== undefined) assertExpectSize(expect, 'Load option "expect"')
      return load<Infer<E>>(readArtifact(artifact, settings), expect)
    },
    evaluate<R>(artifact: Artifact, ...args: Args<Ctx>): Promise<R> {
      try {
        return cached(artifact).evaluate(...args) as Promise<R>
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    evaluateSync: <R>(artifact: Artifact, ...args: Args<Ctx>) =>
      cached(artifact).evaluateSync(...args) as R,
    extend: (options) => {
      assertRuntimeOptions(options, core)
      return createRuntime(settingsFrom(settings, options), core)
    },
  }
  return Object.freeze(rt)
}
