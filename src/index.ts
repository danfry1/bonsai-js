import type {
  BonsaiOptions,
  BonsaiContext,
  BonsaiInstance,
  CompiledExpression,
  EvaluationContextArgs,
  EvaluationOptions,
  ExpressionReferences,
  ContextFunctionFn,
  ASTNode,
  ValidationResult,
} from './types.js'
import { parse } from './parser.js'
import { compile, frozenAstView } from './compiler.js'
import { evaluate, evaluatePooled, type EvalEnv } from './evaluator.js'
import { evaluateAsync } from './evaluator-async.js'
import { SecurityPolicy, ExecutionContext, NO_EVALUATION_OPTIONS } from './execution-context.js'
import { LRUCache } from './cache.js'
import { createPluginRegistry, type Bindings } from './plugins.js'
import { ExpressionError, formatError, offsetToPosition } from './errors.js'
import { getIdentifierName } from './eval-ops.js'

export {
  ExpressionError,
  BonsaiTypeError,
  BonsaiSecurityError,
  BonsaiReferenceError,
  isBonsaiError,
  isBonsaiRuntimeError,
  formatError,
  formatBonsaiError,
} from './errors.js'
export type {
  BonsaiError,
  BonsaiRuntimeError,
  BonsaiSecurityCode,
  ErrorLocation,
} from './errors.js'
export { tokenize } from './lexer.js'
export { parse } from './parser.js'
export { compile } from './compiler.js'
/** Static type builders for extension metadata; the same `t` is re-exported by `bonsai-js/checker`. */
export { t } from './static-types.js'
export type {
  ASTNode,
  Token,
  TokenType,
  InferredTypeName,
  BonsaiType,
  BonsaiObjectType,
  ParameterMetadata,
  PolicySnapshot,
  ResolveResult,
  BonsaiPlugin,
  PluginRegistrar,
  BonsaiInstance,
  CompiledExpression,
  ValidationResult,
  ValidationError,
  ExpressionReferences,
  BonsaiOptions,
  SyntaxLimits,
  EvaluationOptions,
  TransformMetadata,
  ArrayTransformTypeRule,
  TransformDefinition,
  FunctionMetadata,
  FunctionDefinition,
  ContextFunctionDefinition,
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
  requireNonNegativeInt('maxSourceLength', options.maxSourceLength)
  requireNonNegativeInt('maxTokens', options.maxTokens)
  requireNonNegativeInt('maxAstNodes', options.maxAstNodes)
  requireNonNegativeInt('maxArrayLength', options.maxArrayLength)
  requireNonNegativeInt('maxStringLength', options.maxStringLength)
  requireNonNegativeInt('maxObjectProperties', options.maxObjectProperties)
  requireNonNegativeInt('maxCallArguments', options.maxCallArguments)
  requireNonNegativeInt('maxSteps', options.maxSteps)

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
  const publicAstCache = new WeakMap<ASTNode, ASTNode>()

  const policy = new SecurityPolicy(options)

  // Pooled ExecutionContext and EvalEnv for evaluateSync — avoids per-call
  // allocation on the hot path. Both are reused only on the non-reentrant path,
  // guarded by syncCtxInUse; a reentrant call (a registered function calling
  // back into evaluateSync) takes the fresh-allocation branch instead.
  const syncCtx = new ExecutionContext(policy)
  const EMPTY_CTX: Record<string, unknown> = Object.freeze({})
  const syncEnv: EvalEnv = {
    ctx: EMPTY_CTX,
    tr: registry.bindings.transforms,
    fn: registry.bindings.functions,
    g: syncCtx,
    s: undefined,
  }
  let syncCtxInUse = false

  function createExecutionContext(
    evaluationOptions: EvaluationOptions = NO_EVALUATION_OPTIONS,
  ): ExecutionContext {
    return new ExecutionContext(policy, undefined, evaluationOptions)
  }

  // Hot synchronous path: populate and reuse the pooled env rather than
  // allocating one per call. Caller guarantees syncCtxInUse is false.
  function runSyncPooled<T>(
    ast: ASTNode,
    ctx: Record<string, unknown>,
    source: string,
    evaluationOptions: EvaluationOptions = NO_EVALUATION_OPTIONS,
    bindings: Bindings = registry.bindings,
  ): T {
    syncCtxInUse = true
    try {
      syncCtx.reset(evaluationOptions)
      syncEnv.ctx = ctx
      syncEnv.tr = bindings.transforms
      syncEnv.fn = bindings.functions
      syncEnv.s = source
      return evaluatePooled(ast, syncEnv) as T
    } finally {
      // Drop references to the caller's context so it is not retained between
      // calls; the guard (syncEnv.g) is constant and stays put.
      syncEnv.ctx = EMPTY_CTX
      syncEnv.s = undefined
      syncCtxInUse = false
    }
  }

  function getAst(source: string): ASTNode {
    let ast = astCache.get(source)
    if (ast) return ast
    ast = compile(parse(source, policy), policy)
    astCache.set(source, ast)
    return ast
  }

  function compileExpr(source: string): CompiledExpression<TCtx> {
    const cacheKey = `${String(registry.revision)}\0${source}`
    const cached = cache.get(cacheKey)
    if (cached) return cached

    const optimized = getAst(source)
    let publicAst = publicAstCache.get(optimized)
    if (publicAst === undefined) {
      publicAst = frozenAstView(optimized, policy)
      publicAstCache.set(optimized, publicAst)
    }
    // Compilation binds to one immutable registry snapshot. Later mutable
    // registrations affect one-shot evaluation and future compilations only.
    const compiledBindings = registry.bindings

    const compiled: CompiledExpression<TCtx> = {
      ast: publicAst,
      source,
      async evaluate<T = unknown>(...args: EvaluationContextArgs<TCtx>) {
        const ctx = (args[0] ?? {}) as Record<string, unknown>
        const evaluationOptions = args[1] ?? NO_EVALUATION_OPTIONS
        return evaluateAsync(
          optimized,
          ctx,
          compiledBindings,
          createExecutionContext(evaluationOptions),
          source,
        ) as Promise<T>
      },
      evaluateSync<T = unknown>(...args: EvaluationContextArgs<TCtx>) {
        const ctx = (args[0] ?? {}) as Record<string, unknown>
        const evaluationOptions = args[1] ?? NO_EVALUATION_OPTIONS
        if (syncCtxInUse) {
          return evaluate(
            optimized,
            ctx,
            compiledBindings,
            createExecutionContext(evaluationOptions),
            source,
          ) as T
        }
        return runSyncPooled<T>(optimized, ctx, source, evaluationOptions, compiledBindings)
      },
    }

    cache.set(cacheKey, compiled)
    return compiled
  }

  function validateExpression(expression: string): ValidationResult {
    try {
      const ast = parse(expression, policy)
      return { valid: true as const, errors: [] as [], ast, references: extractReferences(ast) }
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
        valid: false as const,
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
  }

  const instance: BonsaiInstance<TCtx> = {
    use(plugin) {
      // The instance is a `PluginRegistrar<TCtx>` (BonsaiInstance extends it), so
      // the plugin receives exactly the registration surface it asked for. No cast.
      registry.use(() => {
        plugin(instance)
      })
      return instance
    },
    addTransform(name, fn, metadata) {
      registry.addTransform(name, fn, metadata)
      return instance
    },
    replaceTransform(name, fn, metadata) {
      registry.replaceTransform(name, fn, metadata)
      return instance
    },
    defineTransform(definition) {
      registry.addTransform(definition.name, definition.evaluate, definition)
      return instance
    },
    addFunction(name, fn, metadata) {
      registry.addFunction(name, fn, metadata)
      return instance
    },
    replaceFunction(name, fn, metadata) {
      registry.replaceFunction(name, fn, metadata)
      return instance
    },
    defineFunction(definition) {
      registry.addFunction(definition.name, definition.evaluate, definition)
      return instance
    },
    addContextFunction(name, fn, metadata) {
      // Cast: internal registry stores context functions as ContextFunctionFn
      // (default generic), public API exposes them typed against TCtx. The
      // runtime treats the ctx arg as opaque, so the cast is sound.
      registry.addContextFunction(name, fn as unknown as ContextFunctionFn, metadata)
      return instance
    },
    replaceContextFunction(name, fn, metadata) {
      registry.replaceContextFunction(name, fn as unknown as ContextFunctionFn, metadata)
      return instance
    },
    defineContextFunction(definition) {
      registry.addContextFunction(
        definition.name,
        definition.evaluate as unknown as ContextFunctionFn,
        definition,
      )
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
    getTransformMetadata(name) {
      return registry.getTransformMetadata(name)
    },
    getFunctionMetadata(name) {
      return registry.getFunctionMetadata(name)
    },
    listFunctions() {
      return registry.getFunctionNames()
    },
    getPolicy() {
      return {
        maxSourceLength: policy.maxSourceLength,
        maxTokens: policy.maxTokens,
        maxAstNodes: policy.maxAstNodes,
        maxObjectProperties: policy.maxObjectProperties,
        maxCallArguments: policy.maxCallArguments,
        maxDepth: policy.maxDepth,
        maxArrayLength: policy.maxArrayLength,
        maxStringLength: policy.maxStringLength,
        maxSteps: policy.maxSteps,
        timeout: policy.timeout,
        ...(policy.allowedProperties ? { allowedProperties: [...policy.allowedProperties] } : {}),
        ...(policy.deniedProperties ? { deniedProperties: [...policy.deniedProperties] } : {}),
      }
    },
    clearCache() {
      cache.clear()
      astCache.clear()
    },
    seal() {
      registry.seal()
      return instance
    },
    isSealed() {
      return registry.isSealed()
    },
    compile(expression) {
      return compileExpr(expression)
    },
    async evaluate<T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>) {
      const ast = getAst(expression)
      const ctx = (args[0] ?? {}) as Record<string, unknown>
      const evaluationOptions = args[1] ?? NO_EVALUATION_OPTIONS
      return evaluateAsync(
        ast,
        ctx,
        registry.bindings,
        createExecutionContext(evaluationOptions),
        expression,
      ) as Promise<T>
    },
    evaluateSync<T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>) {
      // Hot path: reuse pooled ExecutionContext to avoid per-call allocation
      const ast = getAst(expression)
      const ctx = (args[0] ?? {}) as Record<string, unknown>
      const evaluationOptions = args[1] ?? NO_EVALUATION_OPTIONS
      if (syncCtxInUse) {
        // Reentrant call (e.g. custom function calling evaluateSync). Allocate fresh.
        return evaluate(
          ast,
          ctx,
          registry.bindings,
          createExecutionContext(evaluationOptions),
          expression,
        ) as T
      }
      return runSyncPooled<T>(ast, ctx, expression, evaluationOptions)
    },
    validate(expression) {
      return validateExpression(expression)
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
          // Static object-literal keys name output fields; only a computed key
          // can reference context data.
          if (p.computed) walk(p.key)
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
