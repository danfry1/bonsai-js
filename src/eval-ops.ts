import { suggest, BonsaiReferenceError, BonsaiSecurityError, BonsaiTypeError } from './errors.js'
import {
  isMethodAllowedOn,
  methodSignatureArgument,
  methodSignatureCode,
  methodSignatureHasRest,
  methodSignatureParamCount,
  methodSignatureRequired,
  safeMethodFor,
  type MethodArgumentCode,
} from './safe-methods.js'
import { coerceToNumber, coerceToString } from './coerce.js'
import type { ExecutionContext } from './execution-context.js'
import { isBonsaiLambda } from './lambda.js'
import { prepareArrayReceiver } from './array-data.js'
import { transformMaxArgs } from './plugins.js'
import type {
  ASTNode,
  BinaryExpressionOperator,
  RegisteredFunction,
  TransformFn,
  UnaryOperator,
} from './types.js'

type SafeMethod = (...args: unknown[]) => unknown

const ARRAY_INCLUDES = Array.prototype.includes as (this: unknown[], value: unknown) => boolean

// Error constructors live outside applyBinaryOp so the hot path allocates
// nothing on success (per-call closures capturing left/right showed up in
// profiles of arithmetic-heavy expressions).
function numberPairError(
  operator: BinaryExpressionOperator,
  left: unknown,
  right: unknown,
): BonsaiTypeError {
  return new BonsaiTypeError(operator, 'two numbers', typeof left !== 'number' ? left : right)
}

function orderedPairError(
  operator: BinaryExpressionOperator,
  left: unknown,
  right: unknown,
): BonsaiTypeError {
  return new BonsaiTypeError(
    operator,
    'two numbers or two strings of the same type',
    typeof left !== 'number' && typeof left !== 'string' ? left : right,
  )
}

export function applyBinaryOp(
  operator: BinaryExpressionOperator,
  left: unknown,
  right: unknown,
  guard?: ExecutionContext,
): unknown {
  switch (operator) {
    case '+':
      if (typeof left === 'number' && typeof right === 'number') return left + right
      if (typeof left === 'string' && typeof right === 'string') return left + right
      throw new BonsaiTypeError(
        '+',
        'two numbers or two strings (use a template literal to build text from mixed values)',
        typeof left !== 'number' && typeof left !== 'string' ? left : right,
      )
    case '-':
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw numberPairError(operator, left, right)
      }
      return left - right
    case '*':
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw numberPairError(operator, left, right)
      }
      return left * right
    case '/':
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw numberPairError(operator, left, right)
      }
      return left / right
    case '%':
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw numberPairError(operator, left, right)
      }
      return left % right
    case '**':
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw numberPairError(operator, left, right)
      }
      return left ** right
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '<':
      if (typeof left === 'number' && typeof right === 'number') return left < right
      if (typeof left === 'string' && typeof right === 'string') return left < right
      throw orderedPairError(operator, left, right)
    case '>':
      if (typeof left === 'number' && typeof right === 'number') return left > right
      if (typeof left === 'string' && typeof right === 'string') return left > right
      throw orderedPairError(operator, left, right)
    case '<=':
      if (typeof left === 'number' && typeof right === 'number') return left <= right
      if (typeof left === 'string' && typeof right === 'string') return left <= right
      throw orderedPairError(operator, left, right)
    case '>=':
      if (typeof left === 'number' && typeof right === 'number') return left >= right
      if (typeof left === 'string' && typeof right === 'string') return left >= right
      throw orderedPairError(operator, left, right)
    case 'in': {
      if (typeof right === 'string') {
        if (typeof left !== 'string') throw new BonsaiTypeError('in', 'a string search value', left)
        guard?.addSteps(right.length)
        return right.includes(left)
      }
      // Captured Array.prototype.includes reads length and indices only; it
      // never consults the receiver's iterator or own method properties.
      if (Array.isArray(right)) {
        guard?.addSteps(right.length)
        return ARRAY_INCLUDES.call(right, left)
      }
      throw new BonsaiTypeError('in', 'a string or array', right)
    }
    case 'not in': {
      if (typeof right === 'string') {
        if (typeof left !== 'string')
          throw new BonsaiTypeError('not in', 'a string search value', left)
        guard?.addSteps(right.length)
        return !right.includes(left)
      }
      if (Array.isArray(right)) {
        guard?.addSteps(right.length)
        return !ARRAY_INCLUDES.call(right, left)
      }
      throw new BonsaiTypeError('not in', 'a string or array', right)
    }
    case '&&':
    case '||':
    case '??':
    default:
      throw new Error(`Unknown binary operator: ${operator as string}`)
  }
}

export function applyUnaryOp(operator: UnaryOperator, operand: unknown): unknown {
  switch (operator) {
    case '!':
      return !(operand as boolean)
    case '-':
      if (typeof operand !== 'number') throw new BonsaiTypeError('-', 'a number', operand)
      return -operand
    case '+':
      return coerceToNumber(operand, '+')
    default:
      throw new Error(`Unknown unary operator: ${operator as string}`)
  }
}

export function validateMethodCall(
  obj: unknown,
  methodName: string,
  guard: ExecutionContext,
): SafeMethod {
  guard.checkNameAccess(methodName, 'method')
  if (obj == null) throw new BonsaiTypeError(methodName, 'a non-null value', obj)
  const method = safeMethodFor(obj, methodName)
  if (method === undefined) {
    if (isMethodAllowedOn(obj, methodName)) {
      // Allow-listed but the intrinsic was missing when Bonsai loaded: an
      // older host without, for example, ES2023 toSorted/toReversed/with.
      throw new BonsaiTypeError(
        methodName,
        `a JavaScript runtime that implements ${methodName} for ${typeof obj} values (not available in this host)`,
        obj,
      )
    }
    throw new BonsaiSecurityError(
      'METHOD_NOT_ALLOWED',
      `Method "${methodName}" is not allowed on ${typeof obj}`,
    )
  }
  return method
}

/**
 * Enforce a transform's declared argument cap at the call site. A surplus
 * argument would be silently ignored by the implementation (`total |> round(2)`
 * returning the unrounded integer), which is the worst failure mode for a
 * rules language; declared metadata makes the mistake detectable, so fail loud.
 * Transforms without declared parameters keep accepting anything.
 */
export function checkTransformArity(fn: TransformFn, name: string, argCount: number): void {
  const max = transformMaxArgs(fn)
  if (max !== undefined && argCount > max) {
    const cap =
      max === 0
        ? 'no transform arguments'
        : `at most ${max} transform argument${max === 1 ? '' : 's'}`
    throw new BonsaiTypeError(name, cap, argCount, String(argCount))
  }
}

export function resolveTransform(
  name: string,
  transforms: Record<string, TransformFn>,
): TransformFn {
  if (!Object.hasOwn(transforms, name)) {
    const suggestion = suggest(name, Object.keys(transforms))
    throw new BonsaiReferenceError('transform', name, suggestion)
  }
  return transforms[name]
}

/**
 * Resolve a callable by name in the shared function namespace. Pure and context
 * functions occupy one registry keyed by name, so a single lookup returns the
 * tagged entry; the call site uses `kind` to decide how to invoke it (pure
 * functions take only call args; context functions receive the evaluation
 * context first, then call args).
 */
export function resolveCallable(
  name: string,
  functions: Record<string, RegisteredFunction>,
): RegisteredFunction {
  if (Object.hasOwn(functions, name)) {
    return functions[name]
  }
  const suggestion = suggest(name, Object.keys(functions))
  throw new BonsaiReferenceError('function', name, suggestion)
}

export function getIdentifierName(node: ASTNode, message = 'Expected identifier'): string {
  if (node.type !== 'Identifier') {
    throw new Error(message)
  }
  return node.name
}

export function getObjectLiteralKeyName(
  node: ASTNode,
  message = 'Expected identifier or string literal',
): string {
  if (node.type === 'Identifier' || node.type === 'StringLiteral') {
    return node.type === 'Identifier' ? node.name : node.value
  }
  throw new Error(message)
}

export function expandSpreadValue(
  value: unknown,
  maxLength?: number,
  guard?: ExecutionContext,
): unknown[] {
  // Arrays are materialized into a fresh array by index rather than returned
  // as-is. The caller spreads the result natively (a second read of its
  // iterator), so returning the source would let a Proxy-wrapped array or one
  // with an overridden Symbol.iterator pass a one-time identity check here and
  // then hand the caller's native spread a different, unbounded iterator
  // (TOCTOU). Reading only indices 0..length-1 never touches Symbol.iterator and
  // is bounded by the same length that the maxArrayLength check gates. Sparse
  // holes read as undefined, matching native array spread.
  if (Array.isArray(value)) {
    const length = value.length
    if (maxLength !== undefined && length > maxLength) {
      throw new BonsaiSecurityError(
        'MAX_ARRAY_LENGTH',
        `Spread source length (${length}) exceeds maximum (${maxLength})`,
      )
    }
    guard?.addSteps(length)
    const out: unknown[] = new Array<unknown>(length)
    for (let i = 0; i < length; i++) out[i] = value[i]
    return out
  }
  throw new BonsaiTypeError('spread', 'an array', value)
}

/**
 * Resolve the receiver that a captured array intrinsic is invoked on.
 *
 * Ordinary arrays without relevant own hooks are used as-is. Subclasses and
 * own constructor/spreadability hooks are copied into a neutral receiver first.
 * The common JSON-array path therefore remains allocation-free without allowing
 * the receiver to provide a species constructor.
 */
export function arrayMethodReceiver(
  value: unknown[],
  methodName: string,
  guard: ExecutionContext,
): unknown[] {
  return prepareArrayReceiver(value, methodName, guard)
}

const MAX_REPEAT_COUNT = 100_000
const MAX_FIXED_DIGITS = 100
const MAX_RADIX = 36
const LAMBDA_CALLBACK_EXPECTED = 'a Bonsai lambda callback (e.g. .field or . > value)'

function receiverTypeForSignature(receiver: unknown): 'string' | 'number' | 'array' | undefined {
  if (typeof receiver === 'string') return 'string'
  if (typeof receiver === 'number') return 'number'
  if (Array.isArray(receiver)) return 'array'
  return undefined
}

function matchesMethodArgument(value: unknown, kind: MethodArgumentCode): boolean {
  switch (kind) {
    case 's':
      return typeof value === 'string'
    case 'n':
      return typeof value === 'number'
    case 'p':
      return (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )
    case 'a':
      return Array.isArray(value) || matchesMethodArgument(value, 'p')
    case 'l':
      return isBonsaiLambda(value)
    case 'u':
      return true
  }
  return false
}

function methodArityDescription(required: number, maximum: number): string {
  const plural = (count: number): string => (count === 1 ? 'argument' : 'arguments')
  if (maximum === Infinity) return `at least ${String(required)} ${plural(required)}`
  if (required === maximum) return `${String(required)} ${plural(required)}`
  return `${String(required)} to ${String(maximum)} arguments`
}

function methodArgumentDescription(kind: MethodArgumentCode): string {
  switch (kind) {
    case 'a':
      return 'an array or primitive value'
    case 'l':
      return LAMBDA_CALLBACK_EXPECTED
    case 's':
      return 'a string argument'
    case 'n':
      return 'a number argument'
    case 'p':
      return 'a primitive argument'
    case 'u':
      return 'a data argument'
  }
  return 'a data argument'
}

function validateMethodSignature(receiver: unknown, methodName: string, args: unknown[]): void {
  const receiverType = receiverTypeForSignature(receiver)
  if (receiverType === undefined) return
  const signature = methodSignatureCode(receiverType, methodName)
  if (signature === undefined) return
  const required = methodSignatureRequired(signature)
  const maximum = methodSignatureHasRest(signature)
    ? Infinity
    : methodSignatureParamCount(signature)
  if (args.length < required || args.length > maximum) {
    throw new BonsaiTypeError(
      methodName,
      methodArityDescription(required, maximum),
      args.length,
      String(args.length),
    )
  }
  for (let index = 0; index < args.length; index++) {
    const kind = methodSignatureArgument(signature, index)
    if (kind !== undefined && !matchesMethodArgument(args[index], kind)) {
      throw new BonsaiTypeError(methodName, methodArgumentDescription(kind), args[index])
    }
  }
}

const LINEAR_STRING_METHODS: ReadonlySet<string> = new Set([
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'slice',
  'substring',
  'repeat',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'replace',
  'replaceAll',
  'padStart',
  'padEnd',
  'split',
  'concat',
])

const LINEAR_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'includes',
  'indexOf',
  'lastIndexOf',
  'slice',
  'concat',
  'join',
  'flat',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
])

/**
 * The number of elements `slice(start?, end?)` copies from a receiver of
 * `length`, per the ECMAScript index-normalization rules. Arguments have been
 * type-validated as numbers before charging.
 */
function normalizeSliceIndex(length: number, index: unknown, fallback: number): number {
  if (typeof index !== 'number') return fallback
  const truncated = Math.trunc(index)
  if (truncated < 0) return Math.max(length + truncated, 0)
  return Math.min(truncated, length)
}

function sliceSpan(length: number, start: unknown, end: unknown): number {
  const from = normalizeSliceIndex(length, start, 0)
  const to = normalizeSliceIndex(length, end, length)
  return Math.max(to - from, 0)
}

/** Pre-charge native work that cannot be interrupted once the intrinsic starts. */
export function chargeNativeMethod(
  receiver: unknown,
  methodName: string,
  args: readonly unknown[],
  guard: ExecutionContext,
): void {
  let length: number | undefined
  if (typeof receiver === 'string' && LINEAR_STRING_METHODS.has(methodName)) {
    length = receiver.length
  } else if (Array.isArray(receiver) && LINEAR_ARRAY_METHODS.has(methodName)) {
    length = receiver.length
  }
  if (length === undefined) return
  // slice copies only its normalized span; charging the whole receiver would
  // both overtax tight budgets (`nums.slice(0, 3)` rejected on a big array)
  // and trip the periodic clock checkpoint on every call.
  if (methodName === 'slice') {
    guard.addSteps(sliceSpan(length, args[0], args[1]))
    return
  }
  guard.addSteps(length)
}

export function validateMethodArgs(
  receiver: unknown,
  methodName: string,
  args: unknown[],
  guard: ExecutionContext,
): void {
  // The shared catalog is the single argument contract for runtime and checker.
  // Rejecting non-data arguments here, before any intrinsic call, prevents all
  // built-in conversion/callback hooks without a second method-specific policy.
  validateMethodSignature(receiver, methodName, args)

  switch (methodName) {
    case 'concat':
      if (!Array.isArray(receiver)) break
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (Array.isArray(arg)) args[index] = prepareArrayReceiver(arg, 'concat', guard)
      }
      break
    case 'repeat': {
      const count = coerceToNumber(args[0], 'repeat')
      if (!Number.isFinite(count) || count < 0 || count > MAX_REPEAT_COUNT) {
        throw new BonsaiTypeError('repeat', `a count between 0 and ${MAX_REPEAT_COUNT}`, args[0])
      }
      // Bound the produced string size, not just the count: a long receiver
      // repeated a permitted number of times can still blow past the limit.
      if (typeof receiver === 'string') guard.checkStringLength(receiver.length * count)
      break
    }
    case 'padStart':
    case 'padEnd':
      // These allocate in one native call that a cooperative timeout cannot interrupt.
      guard.checkStringLength(coerceToNumber(args[0], methodName))
      break
    case 'toFixed':
      if (typeof receiver === 'number' && args.length > 0) {
        const digits = args[0] as number
        if (
          !Number.isFinite(digits) ||
          Math.trunc(digits) < 0 ||
          Math.trunc(digits) > MAX_FIXED_DIGITS
        ) {
          throw new BonsaiTypeError('toFixed', `digits between 0 and ${MAX_FIXED_DIGITS}`, digits)
        }
      }
      break
    case 'toString':
      if (typeof receiver === 'number' && args.length > 0) {
        const radix = args[0] as number
        if (!Number.isFinite(radix) || Math.trunc(radix) < 2 || Math.trunc(radix) > MAX_RADIX) {
          throw new BonsaiTypeError('toString', `a radix between 2 and ${MAX_RADIX}`, radix)
        }
      }
      break
    case 'with':
      if (Array.isArray(receiver)) {
        const index = args[0] as number
        const integerIndex = Math.trunc(index)
        if (
          !Number.isFinite(index) ||
          integerIndex < -receiver.length ||
          integerIndex >= receiver.length
        ) {
          throw new BonsaiTypeError(
            'with',
            `an index between ${String(-receiver.length)} and ${String(receiver.length - 1)}`,
            index,
          )
        }
      }
      break
    case 'flat':
      if (Array.isArray(receiver) && args.length > 0) {
        const depth = args[0] as number
        if (!Number.isFinite(depth)) throw new BonsaiTypeError('flat', 'a finite depth', depth)
        if (Math.trunc(depth) > guard.policy.maxDepth) {
          throw new BonsaiSecurityError(
            'MAX_DEPTH',
            `flat depth exceeded maximum evaluation depth (${String(guard.policy.maxDepth)})`,
          )
        }
      }
      break
    case 'join':
    case 'toSorted':
      if (Array.isArray(receiver)) {
        // Index loop rather than for...of: never consult the receiver's iterator.
        // oxlint-disable-next-line typescript/prefer-for-of
        for (let index = 0; index < receiver.length; index++) {
          const value = receiver[index]
          if (
            value !== null &&
            value !== undefined &&
            typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean'
          ) {
            throw new BonsaiTypeError(
              methodName,
              'array elements with primitive string representations',
              value,
            )
          }
        }
      }
      break
    default:
      break
  }
}

/**
 * Enforce the array-size limit on a value produced by a method call. Array
 * literals and spread are checked at construction; array-returning methods
 * (split, map, flat, concat, toSorted, ...) are checked here so maxArrayLength
 * is a real ceiling on every array that flows through evaluation.
 */
export function checkResultLimits(result: unknown, guard: ExecutionContext): void {
  if (Array.isArray(result)) {
    guard.checkArrayLength(result.length)
  }
  if (typeof result === 'string') {
    guard.checkStringLength(result.length)
  }
}

export function accessMember(
  object: unknown,
  propertyNode: ASTNode,
  computed: boolean,
  computedValue: unknown,
  guard: ExecutionContext,
): unknown {
  const key = computed
    ? coerceToString(computedValue)
    : getIdentifierName(propertyNode, 'Expected identifier property')
  guard.checkNameAccess(key, 'member')
  return readOwnProperty(object, key)
}

/**
 * Fast path for non-computed member access (`obj.prop`), where the property
 * name is statically known on the AST node. Skips the computed/identifier
 * branch and the getIdentifierName call that `accessMember` performs. The guard
 * check and access semantics are identical to `accessMember`.
 */
export function accessMemberByName(object: unknown, key: string, guard: ExecutionContext): unknown {
  guard.checkNameAccess(key, 'member')
  return readOwnProperty(object, key)
}

/**
 * Read an own property of a context value.
 *
 * Inherited members are never visible: an expression sees the data an object
 * carries, not its prototype chain, so prototype pollution and inherited
 * host methods cannot leak in as values. A nullish receiver reads as
 * undefined so `a.b.c` over sparse data does not throw (method calls on a
 * nullish receiver still throw; see validateMethodCall). Own getters defined
 * by the host are invoked like any other own property; the context is the
 * host's trusted container (see docs/threat-model.md).
 */
export function readOwnProperty(object: unknown, key: string): unknown {
  if (object == null) return undefined
  return Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined
}
