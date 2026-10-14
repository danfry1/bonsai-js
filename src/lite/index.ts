/**
 * `bonsai-js/lite`: the `bonsai-js` API without explaining and partial
 * evaluation, for bundles that only check and evaluate expressions.
 * Environments and programs from this entry point have no `explain`,
 * `explainSync`, or `partial`; everything else behaves as in `bonsai-js`.
 */
import {
  environmentWith,
  type ContextFor,
  type EnvironmentOptions,
  type Library,
  type LiteEnvironment,
  type NoVariables,
} from '../environment.js'
import type { Type } from '../types.js'

/**
 * Creates an environment without explaining and partial evaluation: the
 * variables, functions, and limits expressions are checked and evaluated against.
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
): LiteEnvironment<ContextFor<V, L, S>> {
  return environmentWith<ContextFor<V, L, S>>(undefined, options)
}

export { fn, withContext } from '../environment.js'
export type {
  AbortSignalLike,
  CompileOptions,
  EnvironmentOptions,
  EvaluateOptions,
  FnSpec,
  FunctionInfo,
  HostCall,
  HostFunction,
  Library,
  Limits,
  LiteCheckResult,
  LiteEnvironment,
  LiteProgram,
} from '../environment.js'
export { t, formatType, isAssignable } from '../types.js'
export type {
  AnyType,
  BooleanType,
  DurationType,
  FunctionType,
  Infer,
  InferVariables,
  ListType,
  LiteralType,
  MapType,
  NeverType,
  NullType,
  NumberType,
  OpaqueType,
  StringType,
  TimestampType,
  Type,
  TypeVar,
  UnionType,
} from '../types.js'
export { Duration } from '../runtime/values.js'
export {
  BonsaiError,
  BonsaiSyntaxError,
  BonsaiCheckError,
  BonsaiLimitError,
  BonsaiRuntimeError,
  isBonsaiError,
} from '../errors.js'
export type {
  BonsaiErrorJSON,
  BonsaiErrorName,
  Diagnostic,
  DiagnosticJSON,
  DiagnosticCode,
  ErrorCode,
  LimitName,
  Span,
} from '../errors.js'
export { forEachChild, mapChildren } from '../syntax/ast.js'
export type {
  BinaryNode,
  BinaryOperator,
  CallNode,
  CallStyle,
  ConditionalNode,
  HasNode,
  IndexNode,
  ItNode,
  LambdaNode,
  LetNode,
  ListNode,
  LiteralNode,
  LocalNode,
  MapEntry,
  MapNode,
  MemberNode,
  Node,
  SpreadNode,
  TemplateNode,
  TryNode,
  UnaryNode,
  UnaryOperator,
  VariableNode,
} from '../syntax/ast.js'
export { parse, type ParseOptions } from '../parse.js'
export { print, type PrintOptions } from '../syntax/printer.js'
