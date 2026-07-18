import type { ASTNode, Identifier, ObjectProperty } from './types.js'
import type { Bindings } from './plugins.js'
import type { ExecutionContext } from './execution-context.js'
import { attachLocation } from './errors.js'
import type { EvalEnv } from './evaluator.js'
import {
  accessMember,
  accessMemberByName,
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

type AsyncEvalEnv = EvalEnv

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
  if (!guard.needsAccounting) return evalNodeAsync(node, env)
  guard.beginRun()
  try {
    const result = await evalNodeAsync(node, env)
    guard.checkTimeout()
    return result
  } finally {
    guard.endRun()
  }
}

async function evalNodeAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
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

  return evalCompoundAsync(node, env)
}

async function evalCompoundAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  const { g, s } = env
  g.enterDepth()
  g.step()

  try {
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
        return applyBinaryOp(
          op,
          await evalNodeAsync(node.left, env),
          await evalNodeAsync(node.right, env),
        )
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
          result +=
            part.type === 'StringLiteral' ? part.value : String(await evalNodeAsync(part, env))
        }
        return result
      }

      case 'SpreadElement':
        return await evalNodeAsync(node.argument, env)

      case 'LambdaAccessor':
        return makeLambdaAccessor(node.property, g)

      case 'LambdaIdentity':
        return (item: unknown) => {
          g.step()
          return item
        }

      case 'LambdaExpression':
        return (item: unknown) => {
          g.step()
          return evalLambdaBodyAsync(node.body, item, env)
        }

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

async function evalCallExpressionAsync(
  node: Extract<ASTNode, { type: 'CallExpression' }>,
  env: AsyncEvalEnv,
): Promise<unknown> {
  const { fn, g, s } = env

  if (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') {
    const obj = await evalNodeAsync(node.callee.object, env)
    if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
    const computedValue = node.callee.computed
      ? await evalNodeAsync(node.callee.property, env)
      : undefined
    const methodName = node.callee.computed
      ? String(computedValue)
      : getIdentifierName(node.callee.property, 'Expected method name')

    try {
      const method = validateMethodCall(obj, methodName, g)
      const args: unknown[] = []
      for (const arg of node.args) {
        await pushCallArgumentAsync(args, arg, env)
      }
      validateMethodArgs(obj, methodName, args, g)

      // Standard higher-order array methods need async-aware iteration because
      // lambda callbacks may return Promises, which native Array methods can't
      // handle (a Promise is always truthy). An overridden method is left to run
      // natively below, matching the sync path. Arguments after the thisArg
      // (index 1) are ignored, as the native methods do.
      if (
        Array.isArray(obj) &&
        args.length >= 1 &&
        typeof args[0] === 'function' &&
        canReimplementAsync(method, methodName)
      ) {
        const asyncResult = await evalAsyncArrayMethod(
          methodName,
          obj,
          args[0] as ArrayCallback,
          args[1],
        )
        if (asyncResult !== undefined) {
          g.checkTimeout()
          checkResultArrayLength(asyncResult.value, g)
          return asyncResult.value
        }
      }

      const result = await method.call(obj, ...args)
      g.checkTimeout()
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
        await pushCallArgumentAsync(args, arg, env)
      }
      // Context functions receive the live evaluation context as their first
      // argument (typed Readonly<TCtx> for intent; not copied or frozen).
      const result =
        resolved.kind === 'context'
          ? await resolved.fn(env.ctx, ...args)
          : await resolved.fn(...args)
      g.checkTimeout()
      return result
    } catch (e) {
      if (s !== undefined && s !== '') attachLocation(e, s, node.start, node.end)
      throw e
    }
  }

  throw new Error('Cannot call non-identifier')
}

async function pushCallArgumentAsync(
  args: unknown[],
  node: ASTNode,
  env: AsyncEvalEnv,
): Promise<void> {
  if (node.type === 'SpreadElement') {
    args.push(
      ...expandSpreadValue(
        await evalNodeAsync(node.argument, env),
        env.g.policy.maxArrayLength,
        env.g,
      ),
    )
    return
  }

  args.push(await evalArgAsync(node, env))
}

type ArrayCallback = (item: unknown, index: number, array: unknown[]) => unknown

// Async-safe evaluation of a standard higher-order array method. Native array
// methods call the callback synchronously, but bonsai lambdas may return
// Promises, so this reimplements the method while matching native semantics
// exactly, so a given expression behaves and charges identically in sync
// (which runs the native method) and async. Specifically:
//   - the callback receives (item, index, array) as native methods do;
//   - map/filter/flatMap/some/every skip sparse holes (they never invoke the
//     callback for an empty slot), while find/findIndex visit holes as
//     `undefined`, matching each method's native hole handling;
//   - map preserves length and holes in its result;
//   - some/every/find/findIndex short-circuit at the first decisive element;
//   - callbacks are awaited sequentially so depth stays balanced per element
//     (a concurrent fan-out would enter depth for every element before any
//     exits, scaling maxDepth with array length instead of nesting).
//
// This is used for the unmodified prototype method (the caller checks it is not
// an own override or a globally replaced method); those are run natively, as in
// sync. Array subclasses ARE handled here — deferring them to the native method
// would hand it Promise-returning lambdas it cannot await — with the result
// constructed via Symbol.species so the subclass type is preserved. Step
// accounting is not charged here — a bonsai-lambda callback charges via its own
// closure (as in sync), and an opaque host callback is uncounted in both.
// Returns { value } when handled, undefined for a method it does not implement.
async function evalAsyncArrayMethod(
  methodName: string,
  arr: unknown[],
  callback: ArrayCallback,
  thisArg: unknown,
): Promise<{ value: unknown } | undefined> {
  const len = arr.length
  switch (methodName) {
    case 'filter': {
      const out = arraySpeciesCreate(arr, 0)
      const define = needsDefineProperty(out)
      let k = 0
      for (let i = 0; i < len; i++) {
        if (!(i in arr)) continue
        const item = arr[i]
        if (isTruthy(await callback.call(thisArg, item, i, arr)))
          defineElement(out, k++, item, define)
      }
      return { value: out }
    }
    case 'map': {
      const out = arraySpeciesCreate(arr, len) // preserves length; holes stay holes
      const define = needsDefineProperty(out)
      for (let i = 0; i < len; i++) {
        if (!(i in arr)) continue
        defineElement(out, i, await callback.call(thisArg, arr[i], i, arr), define)
      }
      return { value: out }
    }
    case 'flatMap': {
      const out = arraySpeciesCreate(arr, 0)
      const define = needsDefineProperty(out)
      let k = 0
      for (let i = 0; i < len; i++) {
        if (!(i in arr)) continue
        // Flatten each result (depth 1, skipping holes) immediately, before the
        // next callback runs, matching native flatMap: a later callback that
        // mutates an array returned earlier must not affect what was flattened.
        const result = await callback.call(thisArg, arr[i], i, arr)
        if (Array.isArray(result)) {
          // Snapshot the length: native flattening reads it once, so a later
          // read that appends to `result` does not extend what was flattened.
          const resultLength = result.length
          for (let j = 0; j < resultLength; j++) {
            if (j in result) defineElement(out, k++, result[j], define)
          }
        } else {
          defineElement(out, k++, result, define)
        }
      }
      return { value: out }
    }
    case 'find': {
      for (let i = 0; i < len; i++) {
        // Capture before the callback: native find returns the value passed to
        // the predicate, even if the callback mutates the slot.
        const item = arr[i]
        if (isTruthy(await callback.call(thisArg, item, i, arr))) return { value: item }
      }
      return { value: undefined }
    }
    case 'findIndex': {
      for (let i = 0; i < len; i++) {
        if (isTruthy(await callback.call(thisArg, arr[i], i, arr))) return { value: i }
      }
      return { value: -1 }
    }
    case 'some': {
      for (let i = 0; i < len; i++) {
        if (!(i in arr)) continue
        if (isTruthy(await callback.call(thisArg, arr[i], i, arr))) return { value: true }
      }
      return { value: false }
    }
    case 'every': {
      for (let i = 0; i < len; i++) {
        if (!(i in arr)) continue
        if (!isTruthy(await callback.call(thisArg, arr[i], i, arr))) return { value: false }
      }
      return { value: true }
    }
    default:
      return undefined
  }
}

// Captured at module load: a later global replacement of, say,
// Array.prototype.map is then treated as non-standard and deferred to natively,
// keeping sync and async in agreement.
const ORIGINAL_ARRAY_METHODS: Readonly<Record<string, unknown>> = {
  filter: Array.prototype.filter,
  map: Array.prototype.map,
  flatMap: Array.prototype.flatMap,
  find: Array.prototype.find,
  findIndex: Array.prototype.findIndex,
  some: Array.prototype.some,
  every: Array.prototype.every,
}

// Whether the async evaluator may substitute its await-capable reimplementation
// for this call: only when `method` is the original, unmodified Array.prototype
// implementation. An own override or a globally replaced prototype method is run
// natively instead (as sync does), so both agree. Array subclasses that inherit
// the standard method are reimplemented here (with Symbol.species) rather than
// deferred, since the native method cannot await a Promise-returning lambda.
function canReimplementAsync(method: unknown, methodName: string): boolean {
  return method === ORIGINAL_ARRAY_METHODS[methodName]
}

// The array in which a species-aware method (map/filter/flatMap) builds its
// result, mirroring the ECMAScript ArraySpeciesCreate abstract operation so the
// result type — and its error behavior — matches what the native method would
// produce for the same receiver. Reads `@@species` from the receiver's
// constructor (which may be an object or a function); an absent/null species
// falls back to a plain Array, and a species that is not a constructor throws a
// TypeError exactly as the native method does. `new Array` is same-realm, so an
// intrinsic Array constructor short-circuits to a plain Array.
function arraySpeciesCreate(receiver: unknown[], length: number): unknown[] {
  let ctor: unknown = (receiver as { constructor?: unknown }).constructor
  if (ctor === Array) return new Array<unknown>(length)
  if (ctor !== null && (typeof ctor === 'object' || typeof ctor === 'function')) {
    ctor = (ctor as Record<PropertyKey, unknown>)[Symbol.species]
    if (ctor === null) ctor = undefined
  }
  if (ctor === undefined) return new Array<unknown>(length)
  if (typeof ctor !== 'function') {
    throw new TypeError('Array species is not a constructor')
  }
  return Reflect.construct(ctor as new (n: number) => unknown, [length]) as unknown[]
}

// A species result that is not an ordinary Array (a subclass, typed array, or a
// host constructor's instance) needs CreateDataPropertyOrThrow semantics rather
// than plain assignment: it defines an own data property, overriding any index
// setter and throwing when the target refuses the write (e.g. an out-of-bounds
// typed-array index), matching the native methods. Ordinary arrays take the
// faster assignment path, for which the two are equivalent.
function needsDefineProperty(result: unknown[]): boolean {
  return Object.getPrototypeOf(result) !== Array.prototype
}

function defineElement(out: unknown[], index: number, value: unknown, define: boolean): void {
  if (define) {
    Object.defineProperty(out, index, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  } else {
    out[index] = value
  }
}

async function evalArgAsync(node: ASTNode, env: AsyncEvalEnv): Promise<unknown> {
  if (node.type === 'LambdaAccessor') {
    return makeLambdaAccessor(node.property, env.g)
  }
  if (node.type === 'LambdaIdentity') {
    return (item: unknown) => {
      env.g.step()
      return item
    }
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
  switch (node.type) {
    case 'LambdaIdentity':
      return item
    case 'LambdaAccessor':
      g.checkNameAccess(node.property, 'member')
      return (item as Record<string, unknown>)?.[node.property]
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'UndefinedLiteral':
    case 'Identifier':
      return evalNodeAsync(node, env)
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
        if (
          node.callee.type === 'MemberExpression' ||
          node.callee.type === 'OptionalMemberExpression'
        ) {
          const obj = await evalLambdaBodyAsync(node.callee.object, item, env)
          if (node.callee.type === 'OptionalMemberExpression' && obj == null) return undefined
          const computedValue = node.callee.computed
            ? await evalNodeAsync(node.callee.property, env)
            : undefined
          const methodName = node.callee.computed
            ? String(computedValue)
            : getIdentifierName(node.callee.property, 'Expected method name')
          const method = validateMethodCall(obj, methodName, g)
          const args: unknown[] = []
          for (const arg of node.args) {
            if (arg.type === 'SpreadElement') {
              args.push(
                ...expandSpreadValue(
                  await evalNodeAsync(arg.argument, env),
                  g.policy.maxArrayLength,
                  g,
                ),
              )
            } else {
              args.push(await evalArgAsync(arg, env))
            }
          }
          validateMethodArgs(obj, methodName, args, g)

          // Async-safe higher-order array method handling (same as top-level path)
          if (
            Array.isArray(obj) &&
            args.length >= 1 &&
            typeof args[0] === 'function' &&
            canReimplementAsync(method, methodName)
          ) {
            const asyncResult = await evalAsyncArrayMethod(
              methodName,
              obj,
              args[0] as ArrayCallback,
              args[1],
            )
            if (asyncResult !== undefined) {
              g.checkTimeout()
              checkResultArrayLength(asyncResult.value, g)
              return asyncResult.value
            }
          }

          const result = await method.call(obj, ...args)
          g.checkTimeout()
          checkResultArrayLength(result, g)
          checkResultStringLength(result, g)
          return result
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
        return applyBinaryOp(
          op,
          await evalLambdaBodyAsync(node.left, item, env),
          await evalLambdaBodyAsync(node.right, item, env),
        )
      }

      case 'UnaryExpression':
        return applyUnaryOp(node.operator, await evalLambdaBodyAsync(node.operand, item, env))

      case 'ConditionalExpression':
        return isTruthy(await evalLambdaBodyAsync(node.test, item, env))
          ? await evalLambdaBodyAsync(node.consequent, item, env)
          : await evalLambdaBodyAsync(node.alternate, item, env)

      case 'LambdaExpression':
        return await evalLambdaBodyAsync(node.body, item, env)

      case 'ArrayLiteral':
      case 'ObjectLiteral':
      case 'PipeExpression':
      case 'TemplateLiteral':
      case 'SpreadElement':
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
    ? String(await evalNodeAsync(prop.key, env))
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

function makeLambdaAccessor(
  property: string,
  guard: ExecutionContext,
): (item: Record<string, unknown>) => unknown {
  return (item: Record<string, unknown>) => {
    guard.step()
    guard.checkNameAccess(property, 'member')
    return item?.[property]
  }
}
