/**
 * `bonsai-js/runtime`: loads and evaluates artifacts made by `toArtifact()`
 * from `bonsai-js`, without the parser's checker. Check and compile rules where
 * the full toolchain runs (a server, CI, an admin backend), ship the artifacts,
 * and evaluate them here with the same results.
 */
import { assertExpectSize, type Artifact } from '../artifact.js'
import {
  ProgramCache,
  expectOption,
  settingsFrom,
  type Args,
  type ContextFor,
  type EnvironmentOptions,
  type Library,
  type NoVariables,
  type Settings,
} from '../environment.js'
import { artifactKey, loadArtifact, loadedRunner, readArtifact } from '../load.js'
import type { AnyType, Infer, Type } from '../types.js'

/** The options of `runtime()`: those of `bonsai()` that affect evaluation. */
export type RuntimeOptions<
  V extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
  L extends readonly Library[] = readonly Library[],
> = Omit<EnvironmentOptions<V, L>, 'strict'>

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
export interface Runtime<Ctx = any> {
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
  /** A runtime with more or replaced definitions; see `bonsai().extend`. */
  extend: <V2 extends Readonly<Record<string, Type>>, L2 extends readonly Library[]>(
    options: RuntimeOptions<V2, L2>,
  ) => Runtime<Ctx & ContextFor<V2, L2>>
}

const RUNTIME_KEYS = [
  'variables',
  'functions',
  'libraries',
  'limits',
  'cacheSize',
  'clock',
  'validateContext',
]

/**
 * The runtime takes bonsai()'s options except `strict`, which only affects
 * checking. An explicit `strict: undefined` is allowed, so options shared with
 * an environment can be spread in.
 */
function assertRuntimeOptions(options: unknown): void {
  if (typeof options !== 'object' || options === null) return
  let keys: string[]
  try {
    keys = Object.keys(options).filter(
      (key) => key !== 'strict' || (options as { strict?: unknown }).strict !== undefined,
    )
  } catch (error) {
    throw new TypeError('Runtime options could not be read', { cause: error })
  }
  for (const key of keys) {
    if (!RUNTIME_KEYS.includes(key))
      throw new TypeError(
        key === 'strict'
          ? 'Unknown runtime option key "strict" (it only affects checking, which the runtime does not do)'
          : `Unknown runtime option key "${key}" (expected one of: ${RUNTIME_KEYS.join(', ')})`,
      )
  }
}

function createRuntime<Ctx>(settings: Settings): Runtime<Ctx> {
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
      assertRuntimeOptions(options)
      return createRuntime(settingsFrom(settings, options))
    },
  }
  return Object.freeze(rt)
}

/**
 * Creates a runtime: the host functions, variables, and limits artifacts are
 * loaded and evaluated against. Declare them in a module the producing
 * environment shares, since an artifact loads only where its called functions
 * and read variables are declared exactly as where it was made.
 *
 * ```ts
 * const rt = runtime({ variables, functions })
 * const rule = rt.load(artifact, { expect: t.boolean() })
 * rule.evaluateSync({ user: { age: 30 } }) // true
 * ```
 */
export function runtime<
  const V extends Readonly<Record<string, Type>> = NoVariables,
  const L extends readonly Library[] = [],
>(options: RuntimeOptions<V, L> = {}): Runtime<ContextFor<V, L>> {
  assertRuntimeOptions(options)
  return createRuntime<ContextFor<V, L>>(settingsFrom(undefined, options))
}

export { fn, withContext } from '../environment.js'
export type {
  AbortSignalLike,
  EvaluateOptions,
  FnSpec,
  HostCall,
  HostFunction,
  Library,
  Limits,
} from '../environment.js'
export type { Artifact, Plan } from '../artifact.js'
export { t, formatType } from '../types.js'
export type { Infer, InferVariables, Type } from '../types.js'
export { Duration } from './values.js'
export {
  BonsaiError,
  BonsaiArtifactError,
  BonsaiLimitError,
  BonsaiRuntimeError,
  isBonsaiError,
} from '../errors.js'
export type {
  ArtifactProblem,
  BonsaiErrorJSON,
  BonsaiErrorName,
  ErrorCode,
  Span,
} from '../errors.js'
