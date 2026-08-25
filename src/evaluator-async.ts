import type { ASTNode, Identifier, ObjectProperty } from './types.js'
import type { Bindings } from './plugins.js'
import type { ExecutionContext } from './execution-context.js'
import { attachLocation } from './errors.js'
import type { EvalEnv } from './evaluator.js'
import { createBonsaiLambda } from './lambda.js'
import { coerceToString } from './coerce.js'
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

type AsyncEvalEnv = EvalEnv
type CallExpressionNode = Extract<ASTNode, { type: 'CallExpression' }>
type MemberCalleeNode = Extract<ASTNode, { type: 'MemberExpression' | 'OptionalMemberExpression' }>
type MemberCallExpressionNode = CallExpressionNode & { callee: MemberCalleeNode }

// This is the async mirror of src/evaluator.ts. The two walks are kept separate
// to preserve the synchronous fast path (see ARCHITECTURE.md). Any change to
// evaluation semantics or a security guard here must also be made in the
// synchronous evaluator and both lambda-body walks; tests/parity.test.ts and
// tests/property.test.ts assert the two evaluators stay aligned.

export async function evaluateAsync(
  node: ASTNode,
  context: Record<string, unknown>,
  bindings: Bindings,
  guard: ExecutionContext,
  source?: string,
): Promise<unknown> {
  const env: AsyncEvalEnv = {
    ctx: context,
    tr: bindings.transforms,
    fn: bindings.functions,
    g: guard,
    s: source,
  }
  // Result limits apply where values are produced, not to the final value, so
  // context data passed through unchanged is never rejected (mirrors evaluator.ts).
  // Stryker disable next-line ConditionalExpression: forcing inert run accounting on only changes performance
  if (!guard.needsAccounting) return guard.waitFor(evalNodeAsync(node, env))
  guard.beginRun()
  try {
    const result = await guard.waitFor(evalNodeAsync(node, env))
    guard.checkTimeout()
    return result
  } finally {
    guard.endRun()
  }
}

async function evalNodeAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  // Fast path for leaf nodes — no depth tracking or step counting needed
  if (
    node.type === 'NumberLiteral' ||
    node.type === 'StringLiteral' ||
    node.type === 'BooleanLiteral'
  ) {
    return node.value
  }
  if (node.type === 'NullLiteral') return null
  if (node.type === 'UndefinedLiteral') return undefined
  if (node.type === 'Identifier') {
    env.g.checkNameAccess(node.name, 'identifier')
    return readOwnProperty(env.ctx, node.name)
  }

  return evalCompoundAsync(node, env)
}

async function evalCompoundAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  const { g, s } = env
  g.enterDepth()
  g.step()

  try {
    // Leaf-only/internal nodes are rejected by the default branch.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check
    switch (node.type) {
      case 'UnaryExpression':
        return applyUnaryOp(node.operator, await evalNodeAsync(node.operand, env))

      case 'BinaryExpression': {
        const op = node.operator
        if (op === '&&') {
          const left = await evalNodeAsync(node.left, env)
          return isTruthy(left) ? await evalNodeAsync(node.right, env) : left
        }
        if (op === '||') {
          const left = await evalNodeAsync(node.left, env)
          return isTruthy(left) ? left : await evalNodeAsync(node.right, env)
        }
        if (op === '??') {
          const left = await evalNodeAsync(node.left, env)
          return left ?? (await evalNodeAsync(node.right, env))
        }
        const result = applyBinaryOp(
          op,
          await evalNodeAsync(node.left, env),
          await evalNodeAsync(node.right, env),
          g,
        )
        checkResultLimits(result, g)
        return result
      }

      case 'ConditionalExpression':
        return isTruthy(await evalNodeAsync(node.test, env))
          ? await evalNodeAsync(node.consequent, env)
          : await evalNodeAsync(node.alternate, env)

      case 'MemberExpression': {
        const object = await evalNodeAsync(node.object, env)
        try {
          return node.computed
            ? accessMember(object, node.property, true, await evalNodeAsync(node.property, env), g)
            : accessMemberByName(object, (node.property as Identifier).name, g)
        } catch (e) {
          if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
          throw e
        }
      }

      case 'OptionalMemberExpression': {
        const object = await evalNodeAsync(node.object, env)
        if (object == null) return undefined
        try {
          return node.computed
            ? accessMember(object, node.property, true, await evalNodeAsync(node.property, env), g)
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
              ...expandSpreadValue(
                await evalNodeAsync(el.argument, env),
                g.policy.maxArrayLength,
                g,
              ),
            )
          } else {
            elements.push(await evalNodeAsync(el, env))
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
          if (s !== undefined && s !== '')
            attachLocation(e, s, node.transform.start, node.transform.end)
          throw e
        }
      }

      case 'TemplateLiteral': {
        let result = ''
        for (const part of node.parts) {
          g.step()
          // A static string and the same string passed through coerceToString are identical.
          // Stryker disable next-line StringLiteral
          result +=
            part.type === 'StringLiteral'
              ? part.value
              : coerceToString(await evalNodeAsync(part, env), 'template interpolation')
          g.checkStringLength(result.length)
        }
        return result
      }

      case 'SpreadElement':
        return await evalNodeAsync(node.argument, env)

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
          return evalLambdaBodyAsync(node.body, item, env)
        })

      default:
        throw new Error(`Unknown node type: ${(node as ASTNode).type}`)
    }
  } finally {
    g.exitDepth()
  }
}

async function evalCallExpressionAsync(
  node: CallExpressionNode,
  env: AsyncEvalEnv,
): Promise<unknown> {
  const { fn, g, s } = env
  g.checkCallArguments(node.args.length)

  if (isMemberCall(node)) {
    try {
      return await evalMethodCallAsync(node, env, (object) => evalNodeAsync(object, env))
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
        await pushCallArgumentAsync(args, arg, env)
      }
      // Context functions receive the live evaluation context as their first
      // argument (typed Readonly<TCtx> for intent; not copied or frozen).
      const result =
        resolved.kind === 'context'
          ? await resolved.fn(env.ctx, ...args)
          : await resolved.fn(...args)
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

function isMemberCall(node: CallExpressionNode): node is MemberCallExpressionNode {
  return node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression'
}

/**
 * One async method-call path shared by top-level and lambda-body evaluation.
 * Only evaluation of the receiver differs: a lambda receiver may start from
 * the current item, while computed properties and arguments use the ordinary
 * expression environment in both cases.
 */
async function evalMethodCallAsync(
  node: MemberCallExpressionNode,
  env: AsyncEvalEnv,
  evaluateObject: (node: ASTNode) => Promise<unknown>,
): Promise<unknown> {
  const { g } = env
  const { callee } = node
  g.checkCallArguments(node.args.length)
  const obj = await evaluateObject(callee.object)
  if (callee.type === 'OptionalMemberExpression' && obj == null) return undefined
  const computedValue = callee.computed ? await evalNodeAsync(callee.property, env) : undefined
  const methodName = callee.computed
    ? coerceToString(computedValue, 'computed method name')
    : (callee.property as Identifier).name
  const receiver = Array.isArray(obj) ? arrayMethodReceiver(obj, methodName, g) : obj
  const method = validateMethodCall(receiver, methodName, g)
  const args: unknown[] = []
  for (const arg of node.args) {
    await pushCallArgumentAsync(args, arg, env)
  }
  validateMethodArgs(receiver, methodName, args, g)
  if (g.needsAccounting) chargeNativeMethod(receiver, methodName, g)

  // Native array callbacks cannot await Bonsai lambdas: handle the audited
  // higher-order catalog sequentially so order and short-circuiting match sync.
  if (Array.isArray(receiver)) {
    const asyncResult = await evalAsyncArrayMethod(
      methodName,
      receiver,
      args[0] as (item: unknown) => unknown,
    )
    if (asyncResult !== undefined) {
      g.checkTimeout()
      checkResultLimits(asyncResult.value, g)
      return asyncResult.value
    }
  }

  const result = await method.call(receiver, ...args)
  g.checkTimeout()
  checkResultLimits(result, g)
  return result
}

async function pushCallArgumentAsync(
  args: unknown[],
  node: ASTNode,
  env: AsyncEvalEnv,
): Promise<void> {
  if (node.type === 'SpreadElement') {
    const expanded = expandSpreadValue(
      await evalNodeAsync(node.argument, env),
      env.g.policy.maxArrayLength,
      env.g,
    )
    env.g.checkCallArguments(args.length + expanded.length)
    // Append by index: `push(...expanded)` hits the engine's argument-count
    // limit (~125k on V8) when a host raises maxCallArguments past it.
    for (const element of expanded) args.push(element)
    return
  }

  args.push(await evalArgAsync(node, env))
  env.g.checkCallArguments(args.length)
}

// Async-safe higher-order array method evaluation. Native JS array methods
// call predicates synchronously, but our lambdas may return Promises.
// Returns { value } if handled, undefined if the method isn't higher-order.
//
// Predicates are awaited sequentially (one element fully resolves before the
// next begins) so that this path matches the synchronous evaluator exactly:
//   - depth accounting stays balanced per element (a concurrent fan-out would
//     enter depth for every element before any exits, so maxDepth would scale
//     with array length instead of nesting);
//   - some/every/find/findIndex short-circuit at the first decisive element,
//     so side effects and evaluation counts match native (and sync) semantics.
//
// Step accounting is NOT charged here: the sync evaluator runs the native
// method and cannot charge per element, so a step per element here would make
// the same expression consume a different budget in async than in sync. A
// bonsai-lambda predicate still charges via its own closure (as it does in
// sync); an opaque host-function predicate is uncounted in both.
async function evalAsyncArrayMethod(
  methodName: string,
  arr: unknown[],
  predicate: (item: unknown) => unknown,
): Promise<{ value: unknown } | undefined> {
  switch (methodName) {
    case 'filter': {
      const out: unknown[] = []
      for (let index = 0; index < arr.length; index++) {
        if (!Object.hasOwn(arr, index)) continue
        const item = arr[index]
        if (isTruthy(await predicate(item))) out.push(item)
      }
      return { value: out }
    }
    case 'map': {
      const out: unknown[] = new Array<unknown>(arr.length)
      for (let index = 0; index < arr.length; index++) {
        if (!Object.hasOwn(arr, index)) continue
        out[index] = await predicate(arr[index])
      }
      return { value: out }
    }
    case 'flatMap': {
      const out: unknown[] = []
      for (let index = 0; index < arr.length; index++) {
        if (!Object.hasOwn(arr, index)) continue
        const value = await predicate(arr[index])
        if (Array.isArray(value)) {
          // Append by index, not `push(...expanded)`: spreading into a call
          // hits the engine's argument-count limit (~125k on V8) with a raw
          // RangeError before the caller's checkResultLimits can produce the
          // typed MAX_ARRAY_LENGTH error that the sync walk raises.
          const expanded = expandSpreadValue(value)
          for (const element of expanded) out.push(element)
        } else {
          out.push(value)
        }
      }
      return { value: out }
    }
    case 'find': {
      for (let index = 0; index < arr.length; index++) {
        // Array.prototype.find visits sparse holes as undefined. Keep the
        // index loop (rather than for...of) so no mutable iterator is consulted.
        const item = Object.hasOwn(arr, index) ? arr[index] : undefined
        if (isTruthy(await predicate(item))) return { value: item }
      }
      // Stryker disable next-line ObjectLiteral: an empty wrapper has the same `.value`
      return { value: undefined }
    }
    case 'findIndex': {
      for (let i = 0; i < arr.length; i++) {
        if (isTruthy(await predicate(arr[i]))) return { value: i }
      }
      return { value: -1 }
    }
    case 'some': {
      for (let index = 0; index < arr.length; index++) {
        if (!Object.hasOwn(arr, index)) continue
        if (isTruthy(await predicate(arr[index]))) return { value: true }
      }
      return { value: false }
    }
    case 'every': {
      for (let index = 0; index < arr.length; index++) {
        if (!Object.hasOwn(arr, index)) continue
        if (!isTruthy(await predicate(arr[index]))) return { value: false }
      }
      return { value: true }
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
    return createBonsaiLambda((item: unknown) => {
      env.g.step()
      return item
    })
  }
  return evalNodeAsync(node, env)
}

async function evalPipeAsync(
  input: unknown,
  transformNode: ASTNode,
  env: AsyncEvalEnv,
): Promise<unknown> {
  const { tr, g } = env

  if (transformNode.type === 'CallExpression') {
    g.checkCallArguments(transformNode.args.length)
    const calleeName = getIdentifierName(transformNode.callee, 'Transform must be an identifier')
    const func = resolveTransform(calleeName, tr)
    const args: unknown[] = []
    for (const arg of transformNode.args) {
      await pushCallArgumentAsync(args, arg, env)
    }
    const result = await func(input, ...args)
    g.checkTimeout()
    checkResultLimits(result, g)
    return result
  }

  if (transformNode.type === 'Identifier') {
    const result = await resolveTransform(transformNode.name, tr)(input)
    g.checkTimeout()
    checkResultLimits(result, g)
    return result
  }

  throw new Error('Invalid transform expression')
}

async function evalLambdaBodyAsync(
  node: ASTNode,
  item: unknown,
  env: AsyncEvalEnv,
): Promise<unknown> {
  const { g } = env

  // Leaf fast path — mirrors evalNodeAsync and the sync evalLambdaBody: item-
  // independent leaves and the single accessor need no depth tracking or step
  // counting. Keeps depth accounting identical to the main walk and the sync
  // lambda walk (parity).
  if (node.type === 'LambdaIdentity') return item
  if (node.type === 'LambdaAccessor') {
    return item == null ? undefined : accessMemberByName(item, node.property, g)
  }
  if (
    node.type === 'NumberLiteral' ||
    node.type === 'StringLiteral' ||
    node.type === 'BooleanLiteral' ||
    node.type === 'NullLiteral' ||
    node.type === 'UndefinedLiteral' ||
    node.type === 'Identifier'
  ) {
    return evalNodeAsync(node, env)
  }

  g.enterDepth()
  g.step()

  let ownDepth = true
  try {
    // Item-independent compound nodes deliberately delegate through default.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check
    switch (node.type) {
      case 'MemberExpression': {
        const object = await evalLambdaBodyAsync(node.object, item, env)
        return node.computed
          ? accessMember(object, node.property, true, await evalNodeAsync(node.property, env), g)
          : accessMemberByName(object, (node.property as Identifier).name, g)
      }

      case 'OptionalMemberExpression': {
        const object = await evalLambdaBodyAsync(node.object, item, env)
        if (object == null) return undefined
        return node.computed
          ? accessMember(object, node.property, true, await evalNodeAsync(node.property, env), g)
          : accessMemberByName(object, (node.property as Identifier).name, g)
      }

      case 'CallExpression': {
        if (isMemberCall(node)) {
          return await evalMethodCallAsync(node, env, (object) =>
            evalLambdaBodyAsync(object, item, env),
          )
        }
        ownDepth = false
        g.exitDepth()
        return await evalNodeAsync(node, env)
      }

      case 'BinaryExpression': {
        const op = node.operator
        if (op === '&&') {
          const left = await evalLambdaBodyAsync(node.left, item, env)
          return isTruthy(left) ? await evalLambdaBodyAsync(node.right, item, env) : left
        }
        if (op === '||') {
          const left = await evalLambdaBodyAsync(node.left, item, env)
          return isTruthy(left) ? left : await evalLambdaBodyAsync(node.right, item, env)
        }
        if (op === '??') {
          const left = await evalLambdaBodyAsync(node.left, item, env)
          return left ?? (await evalLambdaBodyAsync(node.right, item, env))
        }
        const result = applyBinaryOp(
          op,
          await evalLambdaBodyAsync(node.left, item, env),
          await evalLambdaBodyAsync(node.right, item, env),
          g,
        )
        checkResultLimits(result, g)
        return result
      }

      case 'UnaryExpression':
        return applyUnaryOp(node.operator, await evalLambdaBodyAsync(node.operand, item, env))

      case 'ConditionalExpression':
        return isTruthy(await evalLambdaBodyAsync(node.test, item, env))
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
  const key = prop.computed
    ? coerceToString(await evalNodeAsync(prop.key, env), 'computed object key')
    : getObjectLiteralKeyName(prop.key)
  env.g.checkNameAccess(key, 'object-key')
  return key
}

// Reproduces JavaScript truthiness exactly for values of static type
// `unknown`/`any`, so the short-circuit and conditional operators keep their
// original coercion semantics while satisfying strict-boolean-expressions.
function isTruthy(value: unknown): boolean {
  return Boolean(value)
}

function makeLambdaAccessor(property: string, guard: ExecutionContext): (item: unknown) => unknown {
  // The property name is static, so the access policy is checked once when the
  // lambda is created rather than once per element (mirrors evaluator.ts).
  // Every non-identifier/non-object-key access kind follows the same policy branch.
  // Stryker disable next-line StringLiteral
  guard.checkNameAccess(property, 'member')
  return createBonsaiLambda((item: unknown) => {
    guard.step()
    return readOwnProperty(item, property)
  })
}
