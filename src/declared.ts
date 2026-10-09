import type { Type } from './types.js'

/**
 * The variables the environment of each compiled program declares. Internal:
 * the query translators read it to check declared columns against them.
 */
const declared = new WeakMap<object, Readonly<Record<string, Type>>>()

export function recordDeclared(
  program: object,
  variables: Readonly<Record<string, Type>> | undefined,
): void {
  if (variables !== undefined) declared.set(program, variables)
}

export function declaredVariables(program: object): Readonly<Record<string, Type>> | undefined {
  return declared.get(program)
}
