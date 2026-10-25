/**
 * How a partial-evaluation residual runs: its bindings, and the checks on the
 * caller's context in place of whole-context validation. Only partial()
 * builds residuals, so only the features import this module.
 */
import type { ResidualOf, Settings } from './environment.js'
import { BonsaiRuntimeError } from './errors.js'
import { describeMismatch, type ValidationBudget } from './functions/define.js'
import {
  invalidContext,
  validateContext,
  validationBudget,
  validationLimits,
  type ValidationLimits,
} from './program.js'
import { raised } from './runtime/attribution.js'
import type { State } from './runtime/state.js'
import { isMap } from './runtime/values.js'
import type { Type } from './types.js'

/**
 * Why the value read along `segments` (from index `at`) does not conform, or
 * undefined. Each step is judged by its own declared type: an absent or null
 * value is fine only where that type is nullable; a declared field is followed
 * (a missing required one fails); an undeclared key of an object (objects are
 * open) or an absent record entry ends the check; past a type that is not a
 * map, and at the end of the path, the value is checked whole, as a context is.
 * Fields the path does not name are not checked.
 */
function describeAlong(
  value: unknown,
  type: Type,
  segments: readonly string[],
  at: number,
  path: string,
  budget: ValidationBudget,
): string | undefined {
  if (at === segments.length) return describeMismatch(value, type, path, budget)
  if (--budget.remaining < 0) budget.onExhausted('steps')
  if (type.kind === 'union') {
    let first: string | undefined
    for (const member of type.types) {
      const problem = describeAlong(value, member, segments, at, path, budget)
      if (problem === undefined) return undefined
      first ??= problem
    }
    return first
  }
  const actual = value === undefined ? null : value
  if (type.kind !== 'map' || !isMap(actual)) return describeMismatch(value, type, path, budget)
  const key = segments[at]
  const field = Object.hasOwn(actual, key) ? actual[key] : undefined
  if (Object.hasOwn(type.fields, key))
    return describeAlong(field, type.fields[key], segments, at + 1, `${path}.${key}`, budget)
  if (type.rest === undefined || field === undefined) return undefined
  return describeAlong(field, type.rest, segments, at + 1, `${path}.${key}`, budget)
}

/**
 * Validates the values a residual reads: each path in `dependsOn`, step by
 * step against the types declared along it (see describeAlong), so a context
 * holding exactly those paths passes and invalid data on them fails as it
 * would for the program.
 */
function validatePaths(
  ctx: Record<string, unknown>,
  variables: Readonly<Record<string, Type>>,
  paths: readonly string[],
  source: string,
  limits: ValidationLimits,
): void {
  const budget = validationBudget(source, limits)
  for (const path of paths) {
    const segments = path.split('.')
    const name = segments[0]
    if (!Object.hasOwn(variables, name)) continue
    const value = Object.hasOwn(ctx, name) ? ctx[name] : undefined
    invalidContext(describeAlong(value, variables[name], segments, 1, name, budget), source)
  }
}

export interface ResidualInput {
  /** The program's source, which its context errors name. */
  readonly source: string
  readonly settings: Settings
  /** The residual's printed source: the text of its explanations. */
  readonly residualSource: string
  /** Values partial() knew, read in place of the context. */
  readonly bindings: ReadonlyMap<string, unknown>
  /** Whether `call: true` host functions read the context it is given. */
  readonly readsContext: boolean
  /** The variables known to partial(), which a context read whole must hold. */
  readonly knownRoots: readonly string[]
  /** The context paths it reads: all a context it does not read whole needs. */
  readonly dependsOn: readonly string[]
  /** Size and depth of the lists and maps partial() built into its bindings. */
  readonly shapes: WeakMap<object, number> | undefined
}

export function makeResidual({
  source,
  settings,
  residualSource,
  bindings,
  readsContext,
  knownRoots,
  dependsOn,
  shapes,
}: ResidualInput): ResidualOf {
  return {
    source: residualSource,
    constant: (name) => {
      if (!bindings.has(name)) return undefined
      const value = bindings.get(name)
      // A residual nests the lists and maps partial() built as the original
      // expression would, not as host data.
      const shape = typeof value === 'object' && value !== null ? shapes?.get(value) : undefined
      if (shape === undefined) return () => value
      return (s: State) => {
        ;(s.shapes ??= new WeakMap()).set(value as object, shape)
        return value
      }
    },
    prepare: (state, ctx, variables, limits) => {
      if (readsContext) {
        // call: true functions read the whole context, which must then hold
        // the variables partial() knew, as the program's context would.
        state.charge(knownRoots.length)
        // In a strict environment, a known key that is not a declared variable is
        // not part of any context the program accepts, so it is not required.
        const declared = settings.strict ? settings.variables : undefined
        // Decided from the property itself, never running a getter: an accessor is
        // present, and so is a data property unless it holds undefined.
        const missing = knownRoots.find((name) => {
          if (declared !== undefined && !Object.hasOwn(declared, name)) return false
          const descriptor = Object.getOwnPropertyDescriptor(ctx, name)
          return (
            descriptor === undefined || ('value' in descriptor && descriptor.value === undefined)
          )
        })
        if (missing !== undefined) {
          throw raised(
            new BonsaiRuntimeError(
              'INVALID_CONTEXT',
              `Invalid context: ${missing} is missing; this residual calls a call: true host function, so pass the full context, as for the program`,
              { source },
            ),
          )
        }
      }
      if (variables === undefined) return
      const budget = validationLimits(settings, limits)
      if (readsContext) validateContext(ctx, variables, source, budget)
      else validatePaths(ctx, variables, dependsOn, source, budget)
    },
  }
}
