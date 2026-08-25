import type { ASTNode, BinaryExpressionOperator } from './types.js'

const DEFAULT_MAX_STRING_LENGTH = 100_000

export function compile(ast: ASTNode, limits: { maxStringLength?: number } = {}): ASTNode {
  return optimize(ast, limits.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH)
}

/**
 * Build a separate, deeply frozen public view of a private compiled tree.
 * Evaluators retain the private tree's fast object shapes; exposing that same
 * object would let a caller mutate one artifact and poison later evaluations.
 */
export function frozenAstView(ast: ASTNode, limits: { maxStringLength?: number } = {}): ASTNode {
  return deepFreeze(optimize(ast, limits.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH))
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function optimize(root: ASTNode, maxStringLength: number): ASTNode {
  return visit(root)

  function visit(node: ASTNode): ASTNode {
    switch (node.type) {
      case 'BinaryExpression': {
        const left = visit(node.left)
        const right = visit(node.right)

        // Constant folding
        if (isConstant(left) && isConstant(right)) {
          const result = evalConstant(node.operator, valueOf(left), valueOf(right))
          // A fold must never manufacture a literal the size policy would have
          // rejected: a folded concat is still a produced string, so leave the
          // node in place and let evaluation raise MAX_STRING_LENGTH.
          const oversized = typeof result === 'string' && result.length > maxStringLength
          if (result !== undefined && !oversized) {
            return makeConstant(result, node.start, node.end)
          }
        }

        return { ...node, left, right }
      }

      case 'ConditionalExpression': {
        const test = visit(node.test)

        // Dead branch elimination
        if (isConstant(test)) {
          const value = valueOf(test)
          return isTruthy(value) ? visit(node.consequent) : visit(node.alternate)
        }

        return {
          ...node,
          test,
          consequent: visit(node.consequent),
          alternate: visit(node.alternate),
        }
      }

      case 'UnaryExpression': {
        const operand = visit(node.operand)
        if (isConstant(operand)) {
          const val = valueOf(operand)
          if (node.operator === '!' && typeof val === 'boolean') {
            return { type: 'BooleanLiteral', value: !val, start: node.start, end: node.end }
          }
          if (node.operator === '-' && typeof val === 'number') {
            return { type: 'NumberLiteral', value: -val, start: node.start, end: node.end }
          }
        }
        return { ...node, operand }
      }

      case 'PipeExpression':
        return { ...node, input: visit(node.input), transform: visit(node.transform) }

      case 'ArrayLiteral':
        return { ...node, elements: node.elements.map((e) => visit(e)) }

      case 'ObjectLiteral':
        return {
          ...node,
          properties: node.properties.map((property) => ({
            ...property,
            key: visit(property.key),
            value: visit(property.value),
          })),
        }

      case 'TemplateLiteral':
        return { ...node, parts: node.parts.map((part) => visit(part)) }

      case 'SpreadElement':
        return { ...node, argument: visit(node.argument) }

      case 'CallExpression':
        return { ...node, callee: visit(node.callee), args: node.args.map((a) => visit(a)) }

      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return {
          ...node,
          object: visit(node.object),
          property: visit(node.property),
        }

      case 'LambdaExpression':
        return { ...node, body: visit(node.body) }

      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'UndefinedLiteral':
      case 'Identifier':
      case 'LambdaAccessor':
      case 'LambdaIdentity':
        return { ...node }

      default:
        return node
    }
  }
}

// Reproduce JS truthiness for a constant value without an implicit
// boolean coercion (satisfies strict-boolean-expressions / no-extra-boolean-cast
// while preserving the exact dead-branch-elimination semantics).
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (typeof value === 'string') return value !== ''
  return true
}

function isConstant(node: ASTNode): boolean {
  return (
    node.type === 'NumberLiteral' ||
    node.type === 'StringLiteral' ||
    node.type === 'BooleanLiteral' ||
    node.type === 'NullLiteral'
  )
}

function valueOf(node: ASTNode): unknown {
  if (node.type === 'NumberLiteral') return node.value
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'BooleanLiteral') return node.value
  if (node.type === 'NullLiteral') return null
  return undefined
}

function evalConstant(op: BinaryExpressionOperator, left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') {
    switch (op) {
      case '+':
        return left + right
      case '-':
        return left - right
      case '*':
        return left * right
      case '/':
        return left / right
      case '%':
        return left % right
      case '**':
        return left ** right
      case '<':
        return left < right
      case '>':
        return left > right
      case '<=':
        return left <= right
      case '>=':
        return left >= right
      case '==':
        return left === right
      case '!=':
        return left !== right
      case '&&':
      case '||':
      case '??':
      case 'in':
      case 'not in':
        break
    }
  }
  if (typeof left === 'string' && typeof right === 'string' && op === '+') {
    return left + right
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    if (op === '&&') return left && right
    if (op === '||') return left || right
  }
  if (op === '==') return left === right
  if (op === '!=') return left !== right
  return undefined
}

function makeConstant(value: unknown, start: number, end: number): ASTNode {
  if (typeof value === 'number') return { type: 'NumberLiteral', value, start, end }
  if (typeof value === 'string') return { type: 'StringLiteral', value, start, end }
  if (typeof value === 'boolean') return { type: 'BooleanLiteral', value, start, end }
  if (value === null) return { type: 'NullLiteral', value: null, start, end }
  return { type: 'UndefinedLiteral', value: undefined, start, end }
}
