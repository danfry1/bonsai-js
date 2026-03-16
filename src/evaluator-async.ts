import type { ASTNode, FunctionFn, ObjectProperty, TransformFn } from './types.js'
import type { ExecutionContext } from './execution-context.js'
import { attachLocation } from './errors.js'
import { type EvalEnv } from './evaluator.js'
import {
  accessMember,
  applyBinaryOp,
  applyUnaryOp,
  expandSpreadValue,
  getIdentifierName,
  getObjectLiteralKeyName,
  resolveFunction,
  resolveTransform,
  validateMethodArgs,
  validateMethodCall,
} from './eval-ops.js'

type AsyncEvalEnv = EvalEnv

export async function evaluateAsync(
  node: ASTNode,
  context: Record<string, unknown>,
  transforms: Record<string, TransformFn>,
  functions: Record<string, FunctionFn>,
  guard: ExecutionContext,
  source?: string,
): Promise<unknown> {
  const env: AsyncEvalEnv = { ctx: context, tr: transforms, fn: functions, g: guard, s: source }
  const result = await evalNodeAsync(node, env)
  guard.checkTimeout()
  return result
}

async function evalNodeAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  const { ctx, g, s } = env
  g.enterDepth()
  g.step()

  try {
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
        g.checkNameAccess(node.name, 'identifier')
        return Object.hasOwn(ctx, node.name) ? ctx[node.name] : undefined

      case 'UnaryExpression':
        return applyUnaryOp(node.operator, await evalNodeAsync(node.operand, env))

      case 'BinaryExpression': {
        const op = node.operator
        if (op === '&&') {
          const left = await evalNodeAsync(node.left, env)
          return left ? await evalNodeAsync(node.right, env) : left
        }
        if (op === '||') {
          const left = await evalNodeAsync(node.left, env)
          return left ? left : await evalNodeAsync(node.right, env)
        }
        if (op === '??') {
          const left = await evalNodeAsync(node.left, env)
          return left != null ? left : await evalNodeAsync(node.right, env)
        }
        return applyBinaryOp(op, await evalNodeAsync(node.left, env), await evalNodeAsync(node.right, env))
      }

      case 'ConditionalExpression':
        return await evalNodeAsync(node.test, env)
          ? await evalNodeAsync(node.consequent, env)
          : await evalNodeAsync(node.alternate, env)

      case 'MemberExpression': {
        const object = await evalNodeAsync(node.object, env)
        const computedValue = node.computed ? await evalNodeAsync(node.property, env) : undefined
        try {
          return accessMember(object, node.property, node.computed, computedValue, g)
        } catch (e) {
          if (s) attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'OptionalMemberExpression': {
        const object = await evalNodeAsync(node.object, env)
        if (object == null) return undefined
        const computedValue = node.computed ? await evalNodeAsync(node.property, env) : undefined
        try {
          return accessMember(object, node.property, node.computed, computedValue, g)
        } catch (e) {
          if (s) attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'ArrayLiteral': {
        const elements: unknown[] = []
        for (const el of node.elements) {
          if (el.type === 'SpreadElement') {
            elements.push(...expandSpreadValue(await evalNodeAsync(el.argument, env), g.policy.maxArrayLength))
          } else {
            elements.push(await evalNodeAsync(el, env))
          }
        }
        g.checkArrayLength(elements.length)
        return elements
      }

      case 'ObjectLiteral': {
        const obj = Object.create(null) as Record<string, unknown>
        for (const prop of node.properties) {
          const key = await getObjectPropertyKey(prop, env)
          obj[key] = await evalNodeAsync(prop.value, env)
        }
        return obj
      }

      case 'CallExpression':
        return await evalCallExpressionAsync(node, env)

      case 'PipeExpression': {
        const input = await evalNodeAsync(node.input, env)
        try {
          return await evalPipeAsync(input, node.transform, env)
        } catch (e) {
          if (s) attachLocation(e, s, node.transform.start, node.transform.end)
          throw e
        }
      }

      case 'TemplateLiteral': {
        let result = ''
        for (const part of node.parts) {
          result += part.type === 'StringLiteral' ? part.value : String(await evalNodeAsync(part, env))
        }
        return result
      }

      case 'SpreadElement':
        return await evalNodeAsync(node.argument, env)

      case 'LambdaAccessor':
        return makeLambdaAccessor(node.property, g)

      case 'LambdaIdentity':
        return (item: unknown) => item

      case 'LambdaExpression':
        return (item: unknown) => evalLambdaBodyAsync(node.body, item, env)

      default:
        throw new Error(`Unknown node type: ${(node as ASTNode).type}`)
    }
  } finally {
    g.exitDepth()
  }
}

async function evalCallExpressionAsync(
  node: Extract<ASTNode, { type: 'CallExpression' }>,
  env: AsyncEvalEnv,
): Promise<unknown> {
  const { fn, g, s } = env

  if (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') {
    const obj = await evalNodeAsync(node.callee.object, env)
    if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
    const computedValue = node.callee.computed ? await evalNodeAsync(node.callee.property, env) : undefined
    const methodName = node.callee.computed
      ? String(computedValue)
      : getIdentifierName(node.callee.property, 'Expected method name')

    try {
      const method = validateMethodCall(obj, methodName, g)
      const args: unknown[] = []
      for (const arg of node.args) {
        await pushCallArgumentAsync(args, arg, env)
      }
      validateMethodArgs(methodName, args)

      // Higher-order array methods need async-aware iteration
      // because lambda callbacks may return Promises, which native
      // Array methods can't handle (Promises are always truthy).
      if (Array.isArray(obj) && args.length === 1 && typeof args[0] === 'function') {
        const arr = obj
        const predicate = args[0] as (item: unknown) => unknown
        const asyncResult = await evalAsyncArrayMethod(methodName, arr, predicate)
        if (asyncResult !== undefined) {
          g.checkTimeout()
          return asyncResult.value
        }
      }

      const result = await method.call(obj, ...args)
      g.checkTimeout()
      return result
    } catch (e) {
      if (s) attachLocation(e, s, node.start, node.end)
      throw e
    }
  }

  if (node.callee.type === 'Identifier') {
    try {
      const func = resolveFunction(node.callee.name, fn)
      const args: unknown[] = []
      for (const arg of node.args) {
        await pushCallArgumentAsync(args, arg, env)
      }
      const result = await func(...args)
      g.checkTimeout()
      return result
    } catch (e) {
      if (s) attachLocation(e, s, node.start, node.end)
      throw e
    }
  }

  throw new Error('Cannot call non-identifier')
}

async function pushCallArgumentAsync(args: unknown[], node: ASTNode, env: AsyncEvalEnv): Promise<void> {
  if (node.type === 'SpreadElement') {
    args.push(...expandSpreadValue(await evalNodeAsync(node.argument, env), env.g.policy.maxArrayLength))
    return
  }

  args.push(await evalArgAsync(node, env))
}

// Async-safe higher-order array method evaluation. Native JS array methods
// call predicates synchronously, but our lambdas may return Promises.
// Returns { value } if handled, undefined if the method isn't higher-order.
async function evalAsyncArrayMethod(
  methodName: string,
  arr: unknown[],
  predicate: (item: unknown) => unknown,
): Promise<{ value: unknown } | undefined> {
  switch (methodName) {
    case 'filter': {
      const results = arr.map(predicate)
      const resolved = results.some(r => r instanceof Promise) ? await Promise.all(results) : results
      return { value: arr.filter((_, i) => resolved[i]) }
    }
    case 'map': {
      const results = arr.map(predicate)
      return { value: results.some(r => r instanceof Promise) ? await Promise.all(results) : results }
    }
    case 'find': {
      const results = arr.map(predicate)
      const resolved = results.some(r => r instanceof Promise) ? await Promise.all(results) : results
      const idx = resolved.findIndex(Boolean)
      return { value: idx >= 0 ? arr[idx] : undefined }
    }
    case 'some': {
      const results = arr.map(predicate)
      const resolved = results.some(r => r instanceof Promise) ? await Promise.all(results) : results
      return { value: resolved.some(Boolean) }
    }
    case 'every': {
      const results = arr.map(predicate)
      const resolved = results.some(r => r instanceof Promise) ? await Promise.all(results) : results
      return { value: resolved.every(Boolean) }
    }
    case 'findIndex': {
      const results = arr.map(predicate)
      const resolved = results.some(r => r instanceof Promise) ? await Promise.all(results) : results
      return { value: resolved.findIndex(Boolean) }
    }
    case 'flatMap': {
      const results = arr.map(predicate)
      const resolved = results.some(r => r instanceof Promise) ? await Promise.all(results) : results
      return { value: (resolved as unknown[]).flat() }
    }
    default:
      return undefined
  }
}

async function evalArgAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  if (node.type === 'LambdaAccessor') {
    return makeLambdaAccessor(node.property, env.g)
  }
  if (node.type === 'LambdaIdentity') {
    return (item: unknown) => item
  }
  return await evalNodeAsync(node, env)
}

async function evalPipeAsync(input: unknown, transformNode: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  const { tr, g } = env

  if (transformNode.type === 'CallExpression') {
    const calleeName = getIdentifierName(transformNode.callee, 'Transform must be an identifier')
    const func = resolveTransform(calleeName, tr)
    const args: unknown[] = []
    for (const arg of transformNode.args) {
      await pushCallArgumentAsync(args, arg, env)
    }
    const result = await func(input, ...args)
    g.checkTimeout()
    return result
  }

  if (transformNode.type === 'Identifier') {
    const result = await resolveTransform(transformNode.name, tr)(input)
    g.checkTimeout()
    return result
  }

  throw new Error('Invalid transform expression')
}

async function evalLambdaBodyAsync(node: ASTNode, item: unknown, env: AsyncEvalEnv): Promise<unknown> {
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
        const object = await evalLambdaBodyAsync(node.object, item, env)
        const computedValue = node.computed ? await evalNodeAsync(node.property, env) : undefined
        return accessMember(object, node.property, node.computed, computedValue, g)
      }

      case 'OptionalMemberExpression': {
        const object = await evalLambdaBodyAsync(node.object, item, env)
        if (object == null) return undefined
        const computedValue = node.computed ? await evalNodeAsync(node.property, env) : undefined
        return accessMember(object, node.property, node.computed, computedValue, g)
      }

      case 'CallExpression': {
        if (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') {
          const obj = await evalLambdaBodyAsync(node.callee.object, item, env)
          if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
          const computedValue = node.callee.computed ? await evalNodeAsync(node.callee.property, env) : undefined
          const methodName = node.callee.computed
            ? String(computedValue)
            : getIdentifierName(node.callee.property, 'Expected method name')
          const method = validateMethodCall(obj, methodName, g)
          const args: unknown[] = []
          for (const arg of node.args) {
            if (arg.type === 'SpreadElement') {
              args.push(...expandSpreadValue(await evalNodeAsync(arg.argument, env), g.policy.maxArrayLength))
            } else {
              args.push(await evalArgAsync(arg, env))
            }
          }
          validateMethodArgs(methodName, args)

          // Async-safe higher-order array method handling (same as top-level path)
          if (Array.isArray(obj) && args.length === 1 && typeof args[0] === 'function') {
            const asyncResult = await evalAsyncArrayMethod(methodName, obj, args[0] as (item: unknown) => unknown)
            if (asyncResult !== undefined) {
              g.checkTimeout()
              return asyncResult.value
            }
          }

          return await method.call(obj, ...args)
        }
        ownDepth = false
        g.exitDepth()
        return await evalNodeAsync(node, env)
      }

      case 'BinaryExpression': {
        const op = node.operator
        if (op === '&&') {
          const left = await evalLambdaBodyAsync(node.left, item, env)
          return left ? await evalLambdaBodyAsync(node.right, item, env) : left
        }
        if (op === '||') {
          const left = await evalLambdaBodyAsync(node.left, item, env)
          return left ? left : await evalLambdaBodyAsync(node.right, item, env)
        }
        if (op === '??') {
          const left = await evalLambdaBodyAsync(node.left, item, env)
          return left != null ? left : await evalLambdaBodyAsync(node.right, item, env)
        }
        return applyBinaryOp(op, await evalLambdaBodyAsync(node.left, item, env), await evalLambdaBodyAsync(node.right, item, env))
      }

      case 'UnaryExpression':
        return applyUnaryOp(node.operator, await evalLambdaBodyAsync(node.operand, item, env))

      case 'ConditionalExpression':
        return await evalLambdaBodyAsync(node.test, item, env)
          ? await evalLambdaBodyAsync(node.consequent, item, env)
          : await evalLambdaBodyAsync(node.alternate, item, env)

      case 'LambdaExpression':
        return await evalLambdaBodyAsync(node.body, item, env)

      default:
        ownDepth = false
        g.exitDepth()
        return await evalNodeAsync(node, env)
    }
  } finally {
    if (ownDepth) g.exitDepth()
  }
}

async function getObjectPropertyKey(prop: ObjectProperty, env: AsyncEvalEnv): Promise<string> {
  const key = prop.computed ? String(await evalNodeAsync(prop.key, env)) : getObjectLiteralKeyName(prop.key)
  env.g.checkNameAccess(key, 'object-key')
  return key
}

function makeLambdaAccessor(property: string, guard: ExecutionContext): (item: Record<string, unknown>) => unknown {
  return (item: Record<string, unknown>) => {
    guard.checkNameAccess(property, 'member')
    return item?.[property]
  }
}
