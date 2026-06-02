import type {
  BonsaiOptions,
  BonsaiContext,
  BonsaiInstance,
  CompiledExpression,
  EvaluationContextArgs,
  ExpressionReferences,
  ContextFunctionFn,
  ASTNode,
} from './types.js'
import { parse } from './parser.js'
import { compile } from './compiler.js'
import { evaluate } from './evaluator.js'
import { evaluateAsync } from './evaluator-async.js'
import { SecurityPolicy, ExecutionContext } from './execution-context.js'
import { LRUCache } from './cache.js'
import { createPluginRegistry } from './plugins.js'
import { ExpressionError, formatError, offsetToPosition } from './errors.js'
import { getIdentifierName } from './eval-ops.js'

export {
  ExpressionError,
  BonsaiTypeError,
  BonsaiSecurityError,
  BonsaiReferenceError,
  formatError,
  formatBonsaiError,
} from './errors.js'
export { tokenize } from './lexer.js'
export { parse } from './parser.js'
export { compile } from './compiler.js'
export type {
  ASTNode,
  Token,
  TokenType,
  InferredTypeName,
  PolicySnapshot,
  ResolveResult,
  BonsaiPlugin,
  BonsaiInstance,
  CompiledExpression,
  ValidationResult,
  ExpressionReferences,
  BonsaiOptions,
  TransformFn,
  FunctionFn,
  ContextFunctionFn,
} from './types.js'

const DEFAULT_CACHE_SIZE = 256

/**
 * Validate options at construction so misconfiguration fails fast with a clear
 * error rather than silently producing surprising behavior (e.g. a negative
 * cacheSize quietly disabling the cache).
 */
function assertValidOptions(options: BonsaiOptions): void {
  const requireNonNegativeInt = (name: string, value: number | undefined): void => {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new RangeError(
        `bonsai: "${name}" must be a non-negative integer, received ${String(value)}`,
      )
    }
  }
  requireNonNegativeInt('cacheSize', options.cacheSize)
  requireNonNegativeInt('maxArrayLength', options.maxArrayLength)
  requireNonNegativeInt('maxStringLength', options.maxStringLength)

  if (
    options.maxDepth !== undefined &&
    (!Number.isInteger(options.maxDepth) || options.maxDepth < 1)
  ) {
    throw new RangeError(
      `bonsai: "maxDepth" must be a positive integer, received ${String(options.maxDepth)}`,
    )
  }
  if (
    options.timeout !== undefined &&
    (typeof options.timeout !== 'number' ||
      !Number.isFinite(options.timeout) ||
      options.timeout < 0)
  ) {
    throw new RangeError(
      `bonsai: "timeout" must be a non-negative, finite number of milliseconds, received ${String(options.timeout)}`,
    )
  }
  const requireStringArray = (name: string, value: readonly unknown[] | undefined): void => {
    if (value === undefined) return
    if (!Array.isArray(value)) {
      throw new TypeError(`bonsai: "${name}" must be an array of strings`)
    }
    if (!value.every((item) => typeof item === 'string')) {
      throw new TypeError(`bonsai: "${name}" must contain only strings`)
    }
  }
  requireStringArray('allowedProperties', options.allowedProperties)
  requireStringArray('deniedProperties', options.deniedProperties)
}

// Shared instance for standalone one-off evaluation
let sharedInstance: BonsaiInstance | undefined

/**
 * Evaluate a single expression with default options. Uses a shared instance internally.
 * For repeated evaluation or custom configuration, use `bonsai()` to create a dedicated instance.
 */
export function evaluateExpression<T = unknown>(
  expression: string,
  context?: Record<string, unknown>,
): T {
  sharedInstance ??= bonsai()
  return sharedInstance.evaluateSync<T>(expression, context)
}

/**
 * Create a new Bonsai instance with optional safety and caching configuration.
 * Register transforms and functions via `.use()`, `.addTransform()`, `.addFunction()`,
 * and `.addContextFunction()`.
 *
 * Pass a context type argument to get end-to-end type safety on the evaluation
 * context: `bonsai<MyContext>()` will type-check `evaluate(expr, ctx)` calls,
 * require a context argument when `MyContext` has required fields, and
 * propagate `MyContext` into context-aware function signatures.
 *
 * @example
 * ```ts
 * const expr = bonsai({ timeout: 50 })
 * expr.use(strings)
 * expr.evaluateSync('name |> trim |> upper', { name: '  hello  ' }) // "HELLO"
 *
 * type AppCtx = { userId: string; perms: string[] }
 * const app = bonsai<AppCtx>()
 * app.addContextFunction('hasPermission', (ctx, action) =>
 *   ctx.perms.includes(String(action)))
 * app.evaluateSync('hasPermission("write")', { userId: 'u_1', perms: ['write'] })
 * ```
 */
export function bonsai<TCtx extends BonsaiContext = Record<string, unknown>>(
  options: BonsaiOptions = {},
): BonsaiInstance<TCtx> {
  assertValidOptions(options)
  const registry = createPluginRegistry()
  const cache = new LRUCache<string, CompiledExpression<TCtx>>(
    options.cacheSize ?? DEFAULT_CACHE_SIZE,
  )
  const astCache = new LRUCache<string, ASTNode>(options.cacheSize ?? DEFAULT_CACHE_SIZE)

  const policy = new SecurityPolicy(options)

  // Pooled ExecutionContext for evaluateSync — avoids per-call allocation
  const syncCtx = new ExecutionContext(policy)
  let syncCtxInUse = false

  function createExecutionContext(): ExecutionContext {
    return new ExecutionContext(policy)
  }

  function getAst(source: string): ASTNode {
    let ast = astCache.get(source)
    if (ast) return ast
    ast = compile(parse(source))
    astCache.set(source, ast)
    return ast
  }

  function compileExpr(source: string): CompiledExpression<TCtx> {
    const cached = cache.get(source)
    if (cached) return cached

    const optimized = getAst(source)

    const compiled: CompiledExpression<TCtx> = {
      ast: optimized,
      source,
      async evaluate<T = unknown>(...args: EvaluationContextArgs<TCtx>) {
        const ctx = (args[0] ?? {}) as Record<string, unknown>
        return evaluateAsync(
          optimized,
          ctx,
          registry.bindings,
          createExecutionContext(),
          source,
        ) as Promise<T>
      },
      evaluateSync<T = unknown>(...args: EvaluationContextArgs<TCtx>) {
        const ctx = (args[0] ?? {}) as Record<string, unknown>
        if (syncCtxInUse) {
          return evaluate(optimized, ctx, registry.bindings, createExecutionContext(), source) as T
        }
        syncCtxInUse = true
        try {
          syncCtx.reset()
          return evaluate(optimized, ctx, registry.bindings, syncCtx, source) as T
        } finally {
          syncCtxInUse = false
        }
      },
    }

    cache.set(source, compiled)
    return compiled
  }

  const instance: BonsaiInstance<TCtx> = {
    use(plugin) {
      plugin(instance)
      return instance
    },
    addTransform(name, fn) {
      registry.addTransform(name, fn)
      return instance
    },
    addFunction(name, fn) {
      registry.addFunction(name, fn)
      return instance
    },
    addContextFunction(name, fn) {
      // Cast: internal registry stores context functions as ContextFunctionFn
      // (default generic), public API exposes them typed against TCtx. The
      // runtime treats the ctx arg as opaque, so the cast is sound.
      registry.addContextFunction(name, fn as unknown as ContextFunctionFn)
      return instance
    },
    removeTransform(name) {
      return registry.removeTransform(name)
    },
    removeFunction(name) {
      return registry.removeFunction(name)
    },
    hasTransform(name) {
      return registry.getTransform(name) !== undefined
    },
    hasFunction(name) {
      return registry.hasFunction(name)
    },
    isContextFunction(name) {
      return registry.isContextFunction(name)
    },
    listTransforms() {
      return registry.getTransformNames()
    },
    listFunctions() {
      return registry.getFunctionNames()
    },
    getPolicy() {
      return {
        ...(policy.allowedProperties ? { allowedProperties: [...policy.allowedProperties] } : {}),
        ...(policy.deniedProperties ? { deniedProperties: [...policy.deniedProperties] } : {}),
      }
    },
    clearCache() {
      cache.clear()
      astCache.clear()
    },
    compile(expression) {
      return compileExpr(expression)
    },
    async evaluate<T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>) {
      const ast = getAst(expression)
      const ctx = (args[0] ?? {}) as Record<string, unknown>
      return evaluateAsync(
        ast,
        ctx,
        registry.bindings,
        createExecutionContext(),
        expression,
      ) as Promise<T>
    },
    evaluateSync<T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>) {
      // Hot path: reuse pooled ExecutionContext to avoid per-call allocation
      const ast = getAst(expression)
      const ctx = (args[0] ?? {}) as Record<string, unknown>
      if (syncCtxInUse) {
        // Reentrant call (e.g. custom function calling evaluateSync). Allocate fresh.
        return evaluate(ast, ctx, registry.bindings, createExecutionContext(), expression) as T
      }
      syncCtxInUse = true
      try {
        syncCtx.reset()
        return evaluate(ast, ctx, registry.bindings, syncCtx, expression) as T
      } finally {
        syncCtxInUse = false
      }
    },
    validate(expression) {
      try {
        const ast = parse(expression)
        return { valid: true, errors: [], ast, references: extractReferences(ast) }
      } catch (error: unknown) {
        let message: string
        if (error instanceof ExpressionError) {
          message = error.rawMessage
        } else if (error instanceof Error) {
          message = error.message
        } else {
          message = String(error)
        }
        const { start, end } = error instanceof ExpressionError ? error : { start: 0, end: 1 }
        const position = offsetToPosition(expression, start)
        return {
          valid: false,
          errors: [
            {
              message,
              position: { line: position.line, column: position.column },
              formatted:
                error instanceof ExpressionError
                  ? error.message
                  : formatError(message, { source: expression, start, end }),
            },
          ],
        }
      }
    },
  }

  return instance
}

function extractReferences(node: ASTNode): ExpressionReferences {
  const identifiers = new Set<string>()
  const transforms = new Set<string>()
  const functions = new Set<string>()

  function walk(n: ASTNode): void {
    switch (n.type) {
      case 'Identifier':
        identifiers.add(n.name)
        break
      case 'PipeExpression':
        walk(n.input)
        if (n.transform.type === 'Identifier') {
          transforms.add(n.transform.name)
        } else if (n.transform.type === 'CallExpression') {
          if (n.transform.callee.type === 'Identifier') {
            transforms.add(getIdentifierName(n.transform.callee))
          }
          n.transform.args.forEach(walk)
        }
        break
      case 'CallExpression':
        if (n.callee.type === 'Identifier') {
          functions.add(n.callee.name)
        } else {
          walk(n.callee)
        }
        n.args.forEach(walk)
        break
      case 'BinaryExpression':
        walk(n.left)
        walk(n.right)
        break
      case 'UnaryExpression':
        walk(n.operand)
        break
      case 'ConditionalExpression':
        walk(n.test)
        walk(n.consequent)
        walk(n.alternate)
        break
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        walk(n.object)
        if (n.computed) walk(n.property)
        break
      case 'ArrayLiteral':
        n.elements.forEach(walk)
        break
      case 'ObjectLiteral':
        n.properties.forEach((p) => {
          walk(p.key)
          walk(p.value)
        })
        break
      case 'TemplateLiteral':
        n.parts.forEach(walk)
        break
      case 'SpreadElement':
        walk(n.argument)
        break
      case 'LambdaExpression':
        walk(n.body)
        break
      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'UndefinedLiteral':
      case 'LambdaAccessor':
      case 'LambdaIdentity':
        break
    }
  }

  walk(node)
  return {
    identifiers: [...identifiers],
    transforms: [...transforms],
    functions: [...functions],
  }
}
