import { suggest, BonsaiReferenceError, BonsaiSecurityError, BonsaiTypeError } from './errors.js'
import type { ExecutionContext } from './execution-context.js'
import type {
  ASTNode,
  BinaryExpressionOperator,
  TransformFn,
  FunctionFn,
  UnaryOperator,
} from './types.js'

type SafeMethod = (...args: unknown[]) => unknown

/** Receiver type check for safe methods. */
function isAllowedReceiver(obj: unknown, methodName: string): boolean {
  const t = typeof obj
  switch (methodName) {
    // String-only
    case 'startsWith': case 'endsWith': case 'substring':
    case 'charAt': case 'charCodeAt': case 'repeat':
    case 'trim': case 'trimStart': case 'trimEnd':
    case 'toLowerCase': case 'toUpperCase':
    case 'replace': case 'replaceAll':
    case 'padStart': case 'padEnd':
    case 'split':
      return t === 'string'
    // String + Array
    case 'includes': case 'indexOf': case 'lastIndexOf':
    case 'slice': case 'at': case 'concat':
      return t === 'string' || Array.isArray(obj)
    // Array-only (higher-order)
    case 'filter': case 'map': case 'find': case 'findIndex':
    case 'some': case 'every': case 'flatMap':
      return Array.isArray(obj)
    // Array-only (non-callback, non-mutating)
    case 'join': case 'flat':
    case 'toReversed': case 'toSorted': case 'toSpliced': case 'with':
      return Array.isArray(obj)
    // Number
    case 'toFixed':
      return t === 'number'
    // Number + String
    case 'toString':
      return t === 'string' || t === 'number'
    default:
      return false
  }
}

export function toPropertyKey(value: unknown): string {
  return String(value)
}

export function applyBinaryOp(operator: BinaryExpressionOperator, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '+': return (left as number) + (right as number)
    case '-': return (left as number) - (right as number)
    case '*': return (left as number) * (right as number)
    case '/': return (left as number) / (right as number)
    case '%': return (left as number) % (right as number)
    case '**': return (left as number) ** (right as number)
    case '==': return left === right
    case '!=': return left !== right
    case '<': return (left as number) < (right as number)
    case '>': return (left as number) > (right as number)
    case '<=': return (left as number) <= (right as number)
    case '>=': return (left as number) >= (right as number)
    case 'in': {
      if (typeof right === 'string') return (right as string).includes(left as string)
      if (Array.isArray(right)) return right.includes(left)
      throw new BonsaiTypeError('in', 'a string or array', right)
    }
    case 'not in': {
      if (typeof right === 'string') return !(right as string).includes(left as string)
      if (Array.isArray(right)) return !right.includes(left)
      throw new BonsaiTypeError('not in', 'a string or array', right)
    }
    default: throw new Error(`Unknown binary operator: ${operator}`)
  }
}

export function applyUnaryOp(operator: UnaryOperator, operand: unknown): unknown {
  switch (operator) {
    case '!': return !operand
    case '-': return -(operand as number)
    case '+': return Number(operand)
    default: throw new Error(`Unknown unary operator: ${operator}`)
  }
}

export function validateMethodCall(
  obj: unknown,
  methodName: string,
  guard: ExecutionContext,
): SafeMethod {
  guard.checkNameAccess(methodName, 'method')
  if (obj == null) throw new BonsaiTypeError(methodName, 'a non-null value', obj)
  if (!isAllowedReceiver(obj, methodName)) {
    throw new BonsaiSecurityError(
      'METHOD_NOT_ALLOWED',
      `Method "${methodName}" is not allowed on ${typeof obj}`,
    )
  }
  const method = (obj as Record<string, unknown>)[methodName]
  if (typeof method !== 'function') throw new BonsaiTypeError(methodName, 'a method', method)
  return method as SafeMethod
}

export function resolveTransform(name: string, transforms: Record<string, TransformFn>): TransformFn {
  if (!Object.hasOwn(transforms, name)) {
    const suggestion = suggest(name, Object.keys(transforms))
    throw new BonsaiReferenceError('transform', name, suggestion)
  }
  return transforms[name]
}

export function resolveFunction(name: string, functions: Record<string, FunctionFn>): FunctionFn {
  if (!Object.hasOwn(functions, name)) {
    const suggestion = suggest(name, Object.keys(functions))
    throw new BonsaiReferenceError('function', name, suggestion)
  }
  return functions[name]
}

export function getIdentifierName(node: ASTNode, message = 'Expected identifier'): string {
  if (node.type !== 'Identifier') {
    throw new Error(message)
  }
  return node.name
}

export function getObjectLiteralKeyName(node: ASTNode, message = 'Expected identifier or string literal'): string {
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

export function validateMethodArgs(methodName: string, args: unknown[]): void {
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
  }
}

export function accessMember(
  object: unknown,
  propertyNode: ASTNode,
  computed: boolean,
  computedValue: unknown,
  guard: ExecutionContext,
): unknown {
  const key = computed ? toPropertyKey(computedValue) : getIdentifierName(propertyNode, 'Expected identifier property')
  guard.checkNameAccess(key, 'member')
  return (object as Record<string, unknown>)?.[key]
}
