/**
 * `bonsai-js/runtime`: loads and evaluates artifacts made by `toArtifact()`
 * from `bonsai-js`, without the parser's checker. Check and compile rules where
 * the full toolchain runs (a server, CI, an admin backend), ship the artifacts,
 * and evaluate them here with the same results. Every built-in is included;
 * bonsai-js/runtime/core includes only those passed in `builtins`.
 */
import { settingsFrom, type ContextFor, type Library, type NoVariables } from '../environment.js'
import { BUILTINS } from '../functions/builtins.js'
import type { Type } from '../types.js'
import { assertRuntimeOptions, createRuntime, type Runtime, type RuntimeOptions } from './create.js'

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
  const S extends boolean | undefined = undefined,
>(options: RuntimeOptions<V, L> & { readonly strict?: S } = {}): Runtime<ContextFor<V, L, S>> {
  assertRuntimeOptions(options, false)
  return createRuntime<ContextFor<V, L, S>>(settingsFrom(undefined, options, BUILTINS), false)
}

export type { Runtime, RuntimeOptions } from './create.js'
export * from './exports.js'
