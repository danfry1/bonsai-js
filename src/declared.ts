import type { Analysis } from './check/checker.js'
import type { FunctionDef } from './functions/define.js'
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

/** What a compiled program was checked against, for toArtifact. */
export interface CompiledFacts {
  readonly source: string
  readonly analysis: Analysis
  readonly expect: Type | undefined
  readonly lookup: (name: string) => FunctionDef | undefined
  readonly variables: Readonly<Record<string, Type>> | undefined
}

const compiled = new WeakMap<object, CompiledFacts>()

export function recordCompiled(program: object, facts: CompiledFacts): void {
  compiled.set(program, facts)
}

export function compiledFacts(program: object): CompiledFacts | undefined {
  return compiled.get(program)
}
