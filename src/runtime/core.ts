/**
 * `bonsai-js/runtime/core`: bonsai-js/runtime with only the built-ins passed
 * in `builtins`, so a bundle carries just the functions its rules call.
 *
 * ```ts
 * import { runtime } from 'bonsai-js/runtime/core'
 * import * as b from 'bonsai-js/builtins'
 *
 * const rt = runtime({ variables, builtins: [b.includes, b.some] })
 * ```
 */
import { settingsFrom, type ContextFor, type Library, type NoVariables } from '../environment.js'
import type { Type } from '../types.js'
import {
  assertRuntimeOptions,
  createRuntime,
  type CoreRuntime,
  type CoreRuntimeOptions,
} from './create.js'

/**
 * Creates a runtime with the built-ins in `builtins` (default none). An
 * artifact that calls a function the runtime does not define is refused with
 * reason `function`, so pass the same list to the bonsai() that checks the
 * rules, which then reports such a call when the rule is saved.
 */
export function runtime<
  const V extends Readonly<Record<string, Type>> = NoVariables,
  const L extends readonly Library[] = [],
  const S extends boolean | undefined = undefined,
>(
  options: CoreRuntimeOptions<V, L> & { readonly strict?: S } = {},
): CoreRuntime<ContextFor<V, L, S>> {
  assertRuntimeOptions(options, true)
  // createRuntime builds both kinds; with `core`, its extend takes `builtins`.
  return createRuntime<ContextFor<V, L, S>>(
    settingsFrom(undefined, options),
    true,
  ) as unknown as CoreRuntime<ContextFor<V, L, S>>
}

export type { CoreRuntime, CoreRuntimeOptions } from './create.js'
export type { Builtin } from '../environment.js'
export * from './exports.js'
