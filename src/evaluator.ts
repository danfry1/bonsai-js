import type {
  ASTNode,
  Identifier,
  ObjectProperty,
  RegisteredFunction,
  TransformFn,
} from './types.js'
import type { Bindings } from './plugins.js'
import type { ExecutionContext } from './execution-context.js'
import { attachLocation, BonsaiTypeError } from './errors.js'
import {
  accessMember,
  accessMemberByName,
  readOwnProperty,
  arrayMethodReceiver,
  applyBinaryOp,
  applyUnaryOp,
  chargeNativeMethod,
  checkResultLimits,
  expandSpreadValue,
  getIdentifierName,
  getObjectLiteralKeyName,
  resolveCallable,
  resolveTransform,
  validateMethodArgs,
  validateMethodCall,
} from './eval-ops.js'
import { isPromiseLike } from './promise-like.js'
import { createBonsaiLambda } from './lambda.js'
import { coerceToString } from './coerce.js'

function rejectPromise(
  value: unknown,
  kind: 'function' | 'method' | 'transform',
  name: string,
): unknown {
  if (isPromiseLike(value)) {
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
  const env: EvalEnv = {
    ctx: context,
    tr: bindings.transforms,
    fn: bindings.functions,
    g: guard,
    s: source,
  }
  // No limits: run-tracking, per-element accounting, and the final deadline
  // check are all inert, so skip them entirely and keep the unaccounted hot path.
  // Result limits are enforced where values are *produced* (literals, spread,
  // operators, method/function/transform results), never on the final value
  // itself, so context data passed through unchanged is never rejected.
  if (!guard.needsAccounting) return evalNode(node, env)
  guard.beginRun()
  try {
    const result = evalNode(node, env)
    guard.checkTimeout()
    return result
  } finally {
    guard.endRun()
  }
}

/**
 * Pooled-env entry point for the hot synchronous path. The caller owns `env`
 * and is responsible for preventing reentrant reuse (see the `syncEnv` pooling
 * in index.ts, gated by the same flag that pools the ExecutionContext). This
 * lets repeated evaluateSync calls avoid allocating an EvalEnv per call.
 */
export function evaluatePooled(node: ASTNode, env: EvalEnv): unknown {
  if (!env.g.needsAccounting) return evalNode(node, env)
  env.g.beginRun()
  try {
    const result = evalNode(node, env)
    env.g.checkTimeout()
    return result
  } finally {
    env.g.endRun()
  }
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
      return readOwnProperty(env.ctx, node.name)
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
        const result = applyBinaryOp(op, evalNode(node.left, env), evalNode(node.right, env), g)
        checkResultLimits(result, g)
        return result
      }

      case 'ConditionalExpression':
        return (evalNode(node.test, env) as boolean)
          ? evalNode(node.consequent, env)
          : evalNode(node.alternate, env)

      case 'MemberExpression': {
        const object = evalNode(node.object, env)
        try {
          return node.computed
            ? accessMember(object, node.property, true, evalNode(node.property, env), g)
            : accessMemberByName(object, (node.property as Identifier).name, g)
        } catch (e) {
          if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'OptionalMemberExpression': {
        const object = evalNode(node.object, env)
        if (object == null) return undefined
        try {
          return node.computed
            ? accessMember(object, node.property, true, evalNode(node.property, env), g)
            : accessMemberByName(object, (node.property as Identifier).name, g)
        } catch (e) {
          if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'ArrayLiteral': {
        const elements: unknown[] = []
        for (const el of node.elements) {
          g.step()
          if (el.type === 'SpreadElement') {
            elements.push(
              ...expandSpreadValue(evalNode(el.argument, env), g.policy.maxArrayLength, g),
            )
          } else {
            elements.push(evalNode(el, env))
          }
        }
        g.checkArrayLength(elements.length)
        return elements
      }

      case 'ObjectLiteral': {
        g.checkObjectProperties(node.properties.length)
        const obj = Object.create(null) as Record<string, unknown>
        for (const prop of node.properties) {
          g.step()
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
          g.step()
          result +=
            part.type === 'StringLiteral'
              ? part.value
              : coerceToString(evalNode(part, env), 'template interpolation')
          g.checkStringLength(result.length)
        }
        return result
      }

      case 'SpreadElement':
        return evalNode(node.argument, env)

      case 'LambdaAccessor':
        return makeLambdaAccessor(node.property, g)

      case 'LambdaIdentity':
        return createBonsaiLambda((item: unknown) => {
          g.step()
          return item
        })

      case 'LambdaExpression':
        return createBonsaiLambda((item: unknown) => {
          g.step()
          return evalLambdaBody(node.body, item, env)
        })

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
  g.checkCallArguments(node.args.length)

  if (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') {
    const obj = evalNode(node.callee.object, env)
    if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
    const computedValue = node.callee.computed ? evalNode(node.callee.property, env) : undefined
    const methodName = node.callee.computed
      ? coerceToString(computedValue, 'computed method name')
      : getIdentifierName(node.callee.property, 'Expected method name')

    try {
      const receiver = Array.isArray(obj) ? arrayMethodReceiver(obj, methodName, g) : obj
      const method = validateMethodCall(receiver, methodName, g)
      const args: unknown[] = []
      for (const arg of node.args) {
        pushCallArgument(args, arg, env)
      }
      validateMethodArgs(receiver, methodName, args, g)
      if (g.needsAccounting) chargeNativeMethod(receiver, methodName, g)

      // A native method cannot be interrupted mid-call. Linear audited methods
      // are pre-charged from receiver length above; Bonsai lambdas additionally
      // charge their actual callback invocations. The deadline is checked again
      // after the intrinsic returns.
      const result = rejectPromise(method.call(receiver, ...args), 'method', methodName)
      g.checkTimeout()
      checkResultLimits(result, g)
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
      // rejectPromise runs before checkTimeout so a sync function that mistakenly
      // returns a Promise reports that misuse rather than being masked by an
      // already-elapsed deadline (matches the method and transform paths).
      const result = rejectPromise(
        resolved.kind === 'context' ? resolved.fn(env.ctx, ...args) : resolved.fn(...args),
        'function',
        node.callee.name,
      )
      g.checkTimeout()
      checkResultLimits(result, g)
      return result
    } catch (e) {
      if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
      throw e
    }
  }

  throw new Error('Cannot call non-identifier')
}

function pushCallArgument(args: unknown[], node: ASTNode, env: EvalEnv): void {
  if (node.type === 'SpreadElement') {
    const expanded = expandSpreadValue(
      evalNode(node.argument, env),
      env.g.policy.maxArrayLength,
      env.g,
    )
    env.g.checkCallArguments(args.length + expanded.length)
    args.push(...expanded)
    return
  }

  args.push(evalArg(node, env))
  env.g.checkCallArguments(args.length)
}

function evalArg(node: ASTNode, env: EvalEnv): unknown {
  if (node.type === 'LambdaAccessor') {
    return makeLambdaAccessor(node.property, env.g)
  }
  if (node.type === 'LambdaIdentity') {
    return createBonsaiLambda((item: unknown) => {
      env.g.step()
      return item
    })
  }
  return evalNode(node, env)
}

function evalPipe(input: unknown, transformNode: ASTNode, env: EvalEnv): unknown {
  const { tr, g } = env

  if (transformNode.type === 'CallExpression') {
    g.checkCallArguments(transformNode.args.length)
    const calleeName = getIdentifierName(transformNode.callee, 'Transform must be an identifier')
    const func = resolveTransform(calleeName, tr)
    const args: unknown[] = []
    for (const arg of transformNode.args) {
      pushCallArgument(args, arg, env)
    }
    const result = rejectPromise(func(input, ...args), 'transform', calleeName)
    g.checkTimeout()
    checkResultLimits(result, g)
    return result
  }

  if (transformNode.type === 'Identifier') {
    const result = rejectPromise(
      resolveTransform(transformNode.name, tr)(input),
      'transform',
      transformNode.name,
    )
    g.checkTimeout()
    checkResultLimits(result, g)
    return result
  }

  throw new Error('Invalid transform expression')
}

function evalLambdaBody(node: ASTNode, item: unknown, env: EvalEnv): unknown {
  const { g } = env

  // Leaf fast path — mirrors evalNode: item-independent leaves and the single
  // accessor need no depth tracking or step counting. Skips enterDepth/step/
  // exitDepth on the hottest per-element nodes (e.g. the `2` in `.x * 2`).
  switch (node.type) {
    case 'LambdaIdentity':
      return item
    case 'LambdaAccessor':
      return item == null ? undefined : accessMemberByName(item, node.property, g)
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'UndefinedLiteral':
    case 'Identifier':
      return evalNode(node, env)
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'CallExpression':
    case 'BinaryExpression':
    case 'UnaryExpression':
    case 'ConditionalExpression':
    case 'LambdaExpression':
    case 'ArrayLiteral':
    case 'ObjectLiteral':
    case 'PipeExpression':
    case 'SpreadElement':
    case 'TemplateLiteral':
      break
  }

  g.enterDepth()
  g.step()

  let ownDepth = true
  try {
    switch (node.type) {
      case 'MemberExpression': {
        const object = evalLambdaBody(node.object, item, env)
        return node.computed
          ? accessMember(object, node.property, true, evalNode(node.property, env), g)
          : accessMemberByName(object, (node.property as Identifier).name, g)
      }

      case 'OptionalMemberExpression': {
        const object = evalLambdaBody(node.object, item, env)
        if (object == null) return undefined
        return node.computed
          ? accessMember(object, node.property, true, evalNode(node.property, env), g)
          : accessMemberByName(object, (node.property as Identifier).name, g)
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
            ? coerceToString(computedValue, 'computed method name')
            : getIdentifierName(node.callee.property, 'Expected method name')
          const receiver = Array.isArray(obj) ? arrayMethodReceiver(obj, methodName, g) : obj
          const method = validateMethodCall(receiver, methodName, g)
          const args: unknown[] = []
          g.checkCallArguments(node.args.length)
          for (const arg of node.args) {
            if (arg.type === 'SpreadElement') {
              const expanded = expandSpreadValue(
                evalNode(arg.argument, env),
                g.policy.maxArrayLength,
                g,
              )
              g.checkCallArguments(args.length + expanded.length)
              args.push(...expanded)
            } else {
              args.push(evalArg(arg, env))
              g.checkCallArguments(args.length)
            }
          }
          validateMethodArgs(receiver, methodName, args, g)
          if (g.needsAccounting) chargeNativeMethod(receiver, methodName, g)

          const result = rejectPromise(method.call(receiver, ...args), 'method', methodName)
          g.checkTimeout()
          checkResultLimits(result, g)
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
        const result = applyBinaryOp(
          op,
          evalLambdaBody(node.left, item, env),
          evalLambdaBody(node.right, item, env),
          g,
        )
        checkResultLimits(result, g)
        return result
      }

      case 'UnaryExpression':
        return applyUnaryOp(node.operator, evalLambdaBody(node.operand, item, env))

      case 'ConditionalExpression':
        return (evalLambdaBody(node.test, item, env) as boolean)
          ? evalLambdaBody(node.consequent, item, env)
          : evalLambdaBody(node.alternate, item, env)

      case 'LambdaExpression':
        return evalLambdaBody(node.body, item, env)

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
  const key = prop.computed
    ? coerceToString(evalNode(prop.key, env), 'computed object key')
    : getObjectLiteralKeyName(prop.key)
  env.g.checkNameAccess(key, 'object-key')
  return key
}

function makeLambdaAccessor(property: string, guard: ExecutionContext): (item: unknown) => unknown {
  // The property name is static, so the access policy is checked once when the
  // lambda is created rather than once per element.
  guard.checkNameAccess(property, 'member')
  return createBonsaiLambda((item: unknown) => {
    guard.step()
    return readOwnProperty(item, property)
  })
}
