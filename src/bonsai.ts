import {
  environmentWith,
  type ContextFor,
  type Environment,
  type EnvironmentOptions,
  type Library,
  type NoVariables,
} from './environment.js'
import { explainAndPartial } from './features.js'
import type { Type } from './types.js'

/**
 * Creates an environment: the variables, functions, and limits expressions are
 * checked and evaluated against.
 *
 * ```ts
 * const env = bonsai({ variables: { user: t.object({ age: t.number() }) } })
 * const adult = env.compile('user.age >= 18', { expect: t.boolean() })
 * adult.evaluateSync({ user: { age: 30 } }) // true
 * ```
 */
export function bonsai<
  const V extends Readonly<Record<string, Type>> = NoVariables,
  const L extends readonly Library[] = [],
  const S extends boolean | undefined = undefined,
>(
  options: EnvironmentOptions<V, L> & { readonly strict?: S } = {},
): Environment<ContextFor<V, L, S>> {
  return environmentWith<ContextFor<V, L, S>>(explainAndPartial, options)
}
