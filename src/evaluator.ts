import type { ASTNode, ObjectProperty, RegisteredFunction, TransformFn } from './types.js'
import type { Bindings } from './plugins.js'
import type { ExecutionContext } from './execution-context.js'
import { attachLocation, BonsaiTypeError } from './errors.js'
import {
  accessMember,
  applyBinaryOp,
  applyUnaryOp,
  checkResultArrayLength,
  checkResultStringLength,
  expandSpreadValue,
  getIdentifierName,
  getObjectLiteralKeyName,
  resolveCallable,
  resolveTransform,
  validateMethodArgs,
  validateMethodCall,
} from './eval-ops.js'

function rejectPromise(
  value: unknown,
  kind: 'function' | 'method' | 'transform',
  name: string,
): unknown {
  if (value instanceof Promise) {
    throw new BonsaiTypeError(
      name,
      `a synchronous ${kind} result — use evaluate() instead of evaluateSync() for async`,
      value,
    )
  }
  return value
}

export interface EvalEnv {
  ctx: Record<string, unknown>
  tr: Record<string, TransformFn>
  fn: Record<string, RegisteredFunction>
  g: ExecutionContext
  s?: string
}

export function evaluate(
  node: ASTNode,
  context: Record<string, unknown>,
  bindings: Bindings,
  guard: ExecutionContext,
  source?: string,
): unknown {
  return evalNode(node, {
    ctx: context,
    tr: bindings.transforms,
    fn: bindings.functions,
    g: guard,
    s: source,
  })
}

/**
 * Pooled-env entry point for the hot synchronous path. The caller owns `env`
 * and is responsible for preventing reentrant reuse (see the `syncEnv` pooling
 * in index.ts, gated by the same flag that pools the ExecutionContext). This
 * lets repeated evaluateSync calls avoid allocating an EvalEnv per call.
 */
export function evaluatePooled(node: ASTNode, env: EvalEnv): unknown {
  return evalNode(node, env)
}

function evalNode(node: ASTNode, env: EvalEnv): unknown {
  // Fast path for leaf nodes — no depth tracking or step counting needed
  switch (node.type) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'UndefinedLiteral':
      return undefined
    case 'Identifier':
      env.g.checkNameAccess(node.name, 'identifier')
      return Object.hasOwn(env.ctx, node.name) ? env.ctx[node.name] : undefined
    case 'UnaryExpression':
    case 'BinaryExpression':
    case 'ConditionalExpression':
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'ArrayLiteral':
    case 'ObjectLiteral':
    case 'CallExpression':
    case 'PipeExpression':
    case 'TemplateLiteral':
    case 'SpreadElement':
    case 'LambdaAccessor':
    case 'LambdaIdentity':
    case 'LambdaExpression':
      break
  }

  // Compound nodes: full depth tracking
  return evalCompound(node, env)
}

function evalCompound(node: ASTNode, env: EvalEnv): unknown {
  const { g, s } = env
  g.enterDepth()
  g.step()

  try {
    switch (node.type) {
      case 'UnaryExpression':
        return applyUnaryOp(node.operator, evalNode(node.operand, env))

      case 'BinaryExpression': {
        const op = node.operator
        if (op === '&&') {
          const left = evalNode(node.left, env)
          return (left as boolean) ? evalNode(node.right, env) : left
        }
        if (op === '||') {
          const left = evalNode(node.left, env)
          return (left as boolean) ? left : evalNode(node.right, env)
        }
        if (op === '??') {
          const left = evalNode(node.left, env)
          return left ?? evalNode(node.right, env)
        }
        return applyBinaryOp(op, evalNode(node.left, env), evalNode(node.right, env))
      }

      case 'ConditionalExpression':
        return (evalNode(node.test, env) as boolean)
          ? evalNode(node.consequent, env)
          : evalNode(node.alternate, env)

      case 'MemberExpression': {
        const object = evalNode(node.object, env)
        const computedValue = node.computed ? evalNode(node.property, env) : undefined
        try {
          return accessMember(object, node.property, node.computed, computedValue, g)
        } catch (e) {
          if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'OptionalMemberExpression': {
        const object = evalNode(node.object, env)
        if (object == null) return undefined
        const computedValue = node.computed ? evalNode(node.property, env) : undefined
        try {
          return accessMember(object, node.property, node.computed, computedValue, g)
        } catch (e) {
          if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'ArrayLiteral': {
        const elements: unknown[] = []
        for (const el of node.elements) {
          if (el.type === 'SpreadElement') {
            elements.push(...expandSpreadValue(evalNode(el.argument, env), g.policy.maxArrayLength))
          } else {
            elements.push(evalNode(el, env))
          }
        }
        g.checkArrayLength(elements.length)
        return elements
      }

      case 'ObjectLiteral': {
        const obj = Object.create(null) as Record<string, unknown>
        for (const prop of node.properties) {
          const key = getObjectPropertyKey(prop, env)
          obj[key] = evalNode(prop.value, env)
        }
        return obj
      }

      case 'CallExpression':
        return evalCallExpression(node, env)

      case 'PipeExpression': {
        const input = evalNode(node.input, env)
        try {
          return evalPipe(input, node.transform, env)
        } catch (e) {
          if (s !== undefined && s !== '')
            attachLocation(e, s, node.transform.start, node.transform.end)
          throw e
        }
      }

      case 'TemplateLiteral': {
        let result = ''
        for (const part of node.parts) {
          result += part.type === 'StringLiteral' ? part.value : String(evalNode(part, env))
        }
        return result
      }

      case 'SpreadElement':
        return evalNode(node.argument, env)

      case 'LambdaAccessor':
        return makeLambdaAccessor(node.property, g)

      case 'LambdaIdentity':
        return (item: unknown) => item

      case 'LambdaExpression':
        return (item: unknown) => evalLambdaBody(node.body, item, env)

      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'UndefinedLiteral':
      case 'Identifier':
      default:
        throw new Error(`Unknown node type: ${(node as ASTNode).type}`)
    }
  } finally {
    g.exitDepth()
  }
}

function evalCallExpression(
  node: Extract<ASTNode, { type: 'CallExpression' }>,
  env: EvalEnv,
): unknown {
  const { fn, g, s } = env

  if (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') {
    const obj = evalNode(node.callee.object, env)
    if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
    const computedValue = node.callee.computed ? evalNode(node.callee.property, env) : undefined
    const methodName = node.callee.computed
      ? String(computedValue)
      : getIdentifierName(node.callee.property, 'Expected method name')

    try {
      const method = validateMethodCall(obj, methodName, g)
      const args: unknown[] = []
      for (const arg of node.args) {
        pushCallArgument(args, arg, env)
      }
      validateMethodArgs(obj, methodName, args, g)
      const result = rejectPromise(method.call(obj, ...args), 'method', methodName)
      checkResultArrayLength(result, g)
      checkResultStringLength(result, g)
      return result
    } catch (e) {
      if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
      throw e
    }
  }

  if (node.callee.type === 'Identifier') {
    try {
      const resolved = resolveCallable(node.callee.name, fn)
      const args: unknown[] = []
      for (const arg of node.args) {
        pushCallArgument(args, arg, env)
      }
      // Context functions receive the live evaluation context as their first
      // argument. It is typed Readonly<TCtx> to signal read-only intent; bonsai
      // does not copy or freeze it (see the context-aware functions docs).
      const result =
        resolved.kind === 'context' ? resolved.fn(env.ctx, ...args) : resolved.fn(...args)
      return rejectPromise(result, 'function', node.callee.name)
    } catch (e) {
      if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
      throw e
    }
  }

  throw new Error('Cannot call non-identifier')
}

function pushCallArgument(args: unknown[], node: ASTNode, env: EvalEnv): void {
  if (node.type === 'SpreadElement') {
    args.push(...expandSpreadValue(evalNode(node.argument, env), env.g.policy.maxArrayLength))
    return
  }

  args.push(evalArg(node, env))
}

function evalArg(node: ASTNode, env: EvalEnv): unknown {
  if (node.type === 'LambdaAccessor') {
    return makeLambdaAccessor(node.property, env.g)
  }
  if (node.type === 'LambdaIdentity') {
    return (item: unknown) => item
  }
  return evalNode(node, env)
}

function evalPipe(input: unknown, transformNode: ASTNode, env: EvalEnv): unknown {
  const { tr } = env

  if (transformNode.type === 'CallExpression') {
    const calleeName = getIdentifierName(transformNode.callee, 'Transform must be an identifier')
    const func = resolveTransform(calleeName, tr)
    const args: unknown[] = []
    for (const arg of transformNode.args) {
      pushCallArgument(args, arg, env)
    }
    return rejectPromise(func(input, ...args), 'transform', calleeName)
  }

  if (transformNode.type === 'Identifier') {
    return rejectPromise(
      resolveTransform(transformNode.name, tr)(input),
      'transform',
      transformNode.name,
    )
  }

  throw new Error('Invalid transform expression')
}

function evalLambdaBody(node: ASTNode, item: unknown, env: EvalEnv): unknown {
  const { g } = env
  g.enterDepth()
  g.step()

  let ownDepth = true
  try {
    switch (node.type) {
      case 'LambdaIdentity':
        return item

      case 'LambdaAccessor':
        g.checkNameAccess(node.property, 'member')
        return (item as Record<string, unknown>)?.[node.property]

      case 'MemberExpression': {
        const object = evalLambdaBody(node.object, item, env)
        const computedValue = node.computed ? evalNode(node.property, env) : undefined
        return accessMember(object, node.property, node.computed, computedValue, g)
      }

      case 'OptionalMemberExpression': {
        const object = evalLambdaBody(node.object, item, env)
        if (object == null) return undefined
        const computedValue = node.computed ? evalNode(node.property, env) : undefined
        return accessMember(object, node.property, node.computed, computedValue, g)
      }

      case 'CallExpression': {
        if (
          node.callee.type === 'MemberExpression' ||
          node.callee.type === 'OptionalMemberExpression'
        ) {
          const obj = evalLambdaBody(node.callee.object, item, env)
          if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
          const computedValue = node.callee.computed
            ? evalNode(node.callee.property, env)
            : undefined
          const methodName = node.callee.computed
            ? String(computedValue)
            : getIdentifierName(node.callee.property, 'Expected method name')
          const method = validateMethodCall(obj, methodName, g)
          const args: unknown[] = []
          for (const arg of node.args) {
            if (arg.type === 'SpreadElement') {
              args.push(...expandSpreadValue(evalNode(arg.argument, env), g.policy.maxArrayLength))
            } else {
              args.push(evalArg(arg, env))
            }
          }
          validateMethodArgs(obj, methodName, args, g)
          const result = rejectPromise(method.call(obj, ...args), 'method', methodName)
          checkResultArrayLength(result, g)
          checkResultStringLength(result, g)
          return result
        }
        // Delegate to evalNode for non-method calls (e.g. registered functions)
        ownDepth = false
        g.exitDepth()
        return evalNode(node, env)
      }

      case 'BinaryExpression': {
        const op = node.operator
        if (op === '&&') {
          const left = evalLambdaBody(node.left, item, env)
          return (left as boolean) ? evalLambdaBody(node.right, item, env) : left
        }
        if (op === '||') {
          const left = evalLambdaBody(node.left, item, env)
          return (left as boolean) ? left : evalLambdaBody(node.right, item, env)
        }
        if (op === '??') {
          const left = evalLambdaBody(node.left, item, env)
          return left ?? evalLambdaBody(node.right, item, env)
        }
        return applyBinaryOp(
          op,
          evalLambdaBody(node.left, item, env),
          evalLambdaBody(node.right, item, env),
        )
      }

      case 'UnaryExpression':
        return applyUnaryOp(node.operator, evalLambdaBody(node.operand, item, env))

      case 'ConditionalExpression':
        return (evalLambdaBody(node.test, item, env) as boolean)
          ? evalLambdaBody(node.consequent, item, env)
          : evalLambdaBody(node.alternate, item, env)

      case 'LambdaExpression':
        return evalLambdaBody(node.body, item, env)

      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'UndefinedLiteral':
      case 'Identifier':
      case 'ArrayLiteral':
      case 'ObjectLiteral':
      case 'PipeExpression':
      case 'SpreadElement':
      case 'TemplateLiteral':
      default:
        // Delegate to evalNode which manages its own depth
        ownDepth = false
        g.exitDepth()
        return evalNode(node, env)
    }
  } finally {
    if (ownDepth) g.exitDepth()
  }
}

function getObjectPropertyKey(prop: ObjectProperty, env: EvalEnv): string {
  const key = prop.computed ? String(evalNode(prop.key, env)) : getObjectLiteralKeyName(prop.key)
  env.g.checkNameAccess(key, 'object-key')
  return key
}

function makeLambdaAccessor(
  property: string,
  guard: ExecutionContext,
): (item: Record<string, unknown>) => unknown {
  return (item: Record<string, unknown>) => {
    guard.checkNameAccess(property, 'member')
    return item?.[property]
  }
}
