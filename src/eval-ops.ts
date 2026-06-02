import { suggest, BonsaiReferenceError, BonsaiSecurityError, BonsaiTypeError } from './errors.js'
import { isMethodAllowedOn } from './safe-methods.js'
import type { ExecutionContext } from './execution-context.js'
import type {
  ASTNode,
  BinaryExpressionOperator,
  RegisteredFunction,
  TransformFn,
  UnaryOperator,
} from './types.js'

type SafeMethod = (...args: unknown[]) => unknown

function toPropertyKey(value: unknown): string {
  return String(value)
}

export function applyBinaryOp(
  operator: BinaryExpressionOperator,
  left: unknown,
  right: unknown,
): unknown {
  switch (operator) {
    case '+':
      return (left as number) + (right as number)
    case '-':
      return (left as number) - (right as number)
    case '*':
      return (left as number) * (right as number)
    case '/':
      return (left as number) / (right as number)
    case '%':
      return (left as number) % (right as number)
    case '**':
      return (left as number) ** (right as number)
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '<':
      return (left as number) < (right as number)
    case '>':
      return (left as number) > (right as number)
    case '<=':
      return (left as number) <= (right as number)
    case '>=':
      return (left as number) >= (right as number)
    case 'in': {
      if (typeof right === 'string') return right.includes(left as string)
      if (Array.isArray(right)) return right.includes(left)
      throw new BonsaiTypeError('in', 'a string or array', right)
    }
    case 'not in': {
      if (typeof right === 'string') return !right.includes(left as string)
      if (Array.isArray(right)) return !right.includes(left)
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
      return -(operand as number)
    case '+':
      return Number(operand)
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
  if (!isMethodAllowedOn(obj, methodName)) {
    throw new BonsaiSecurityError(
      'METHOD_NOT_ALLOWED',
      `Method "${methodName}" is not allowed on ${typeof obj}`,
    )
  }
  const method = (obj as Record<string, unknown>)[methodName]
  if (typeof method !== 'function') throw new BonsaiTypeError(methodName, 'a method', method)
  return method as SafeMethod
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

export function expandSpreadValue(value: unknown, maxLength?: number): unknown[] {
  if (Array.isArray(value)) {
    if (maxLength !== undefined && value.length > maxLength) {
      throw new BonsaiSecurityError(
        'MAX_ARRAY_LENGTH',
        `Spread source length (${value.length}) exceeds maximum (${maxLength})`,
      )
    }
    return value
  }
  if (value != null) {
    const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
    if (typeof iterator === 'function') {
      const result: unknown[] = []
      for (const item of value as Iterable<unknown>) {
        result.push(item)
        if (maxLength !== undefined && result.length > maxLength) {
          throw new BonsaiSecurityError(
            'MAX_ARRAY_LENGTH',
            `Spread exceeds maximum array length (${maxLength})`,
          )
        }
      }
      return result
    }
  }
  throw new BonsaiTypeError('spread', 'an iterable value', value)
}

const REPLACE_METHODS = new Set(['replace', 'replaceAll'])
const MAX_REPEAT_COUNT = 100_000

// Array methods that take a callback. A non-function first argument here is a
// mistake (commonly `arr.map(fn(.x))`, where the lambda shorthand was passed to
// a function and evaluated to a value); fail with a typed error rather than
// leaking a raw native TypeError.
const HIGHER_ORDER_METHODS = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'some',
  'every',
  'flatMap',
])
const LAMBDA_CALLBACK_EXPECTED = 'a lambda or function callback (e.g. .field or . > value)'

export function validateMethodArgs(
  receiver: unknown,
  methodName: string,
  args: unknown[],
  guard: ExecutionContext,
): void {
  if (REPLACE_METHODS.has(methodName)) {
    for (const arg of args) {
      if (typeof arg === 'function') {
        throw new BonsaiTypeError(methodName, 'string arguments (callbacks are not allowed)', arg)
      }
      if (arg instanceof RegExp) {
        throw new BonsaiTypeError(methodName, 'string arguments (RegExp is not allowed)', arg)
      }
      if (arg != null && typeof arg === 'object') {
        throw new BonsaiTypeError(methodName, 'string arguments (objects are not allowed)', arg)
      }
    }
  }
  if (methodName === 'repeat') {
    const count = Number(args[0])
    if (!Number.isFinite(count) || count < 0 || count > MAX_REPEAT_COUNT) {
      throw new BonsaiTypeError('repeat', `a count between 0 and ${MAX_REPEAT_COUNT}`, args[0])
    }
    // Bound the produced string size, not just the count: a long receiver
    // repeated a permitted number of times can still blow past the limit.
    if (typeof receiver === 'string') {
      guard.checkStringLength(receiver.length * count)
    }
  }
  if (methodName === 'padStart' || methodName === 'padEnd') {
    // padStart/padEnd allocate up to the requested target length in a single
    // native call that the cooperative timeout cannot interrupt; cap it.
    guard.checkStringLength(Number(args[0]))
  }
  if (HIGHER_ORDER_METHODS.has(methodName) && typeof args[0] !== 'function') {
    throw new BonsaiTypeError(methodName, LAMBDA_CALLBACK_EXPECTED, args[0])
  }
}

/**
 * Enforce the array-size limit on a value produced by a method call. Array
 * literals and spread are checked at construction; array-returning methods
 * (split, map, flat, concat, toSorted, ...) are checked here so maxArrayLength
 * is a real ceiling on every array that flows through evaluation.
 */
export function checkResultArrayLength(result: unknown, guard: ExecutionContext): void {
  if (Array.isArray(result)) {
    guard.checkArrayLength(result.length)
  }
}

/**
 * Enforce the string-size limit on a value produced by a method call. The
 * argument-time checks on padStart/padEnd/repeat stop the worst single-call
 * amplifiers before allocation, but string-returning methods such as join,
 * concat, slice, and toUpperCase can still produce a string past the ceiling
 * (notably `arr.join(sep)`, whose output is array length times separator length
 * in a single native call). Checking the produced length here makes
 * maxStringLength a real ceiling on every string that flows through evaluation,
 * mirroring checkResultArrayLength.
 */
export function checkResultStringLength(result: unknown, guard: ExecutionContext): void {
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
    ? toPropertyKey(computedValue)
    : getIdentifierName(propertyNode, 'Expected identifier property')
  guard.checkNameAccess(key, 'member')
  return (object as Record<string, unknown>)?.[key]
}
