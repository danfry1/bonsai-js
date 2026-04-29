import type {
  BonsaiOptions,
  BonsaiInstance,
  CompiledExpression,
  ValidationResult,
  ExpressionReferences,
  TransformFn,
  FunctionFn,
  BonsaiPlugin,
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

export { ExpressionError, BonsaiTypeError, BonsaiSecurityError, BonsaiReferenceError, formatError, formatBonsaiError } from './errors.js'
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
} from './types.js'

const DEFAULT_CACHE_SIZE = 256

// Shared instance for standalone one-off evaluation
let _shared: BonsaiInstance | undefined

/**
 * Evaluate a single expression with default options. Uses a shared instance internally.
 * For repeated evaluation or custom configuration, use `bonsai()` to create a dedicated instance.
 */
export function evaluateExpression<T = unknown>(expression: string, context?: Record<string, unknown>): T {
  if (!_shared) _shared = bonsai()
  return _shared.evaluateSync<T>(expression, context)
}

/**
 * Create a new Bonsai instance with optional safety and caching configuration.
 * Register transforms and functions via `.use()`, `.addTransform()`, and `.addFunction()`.
 *
 * @example
 * ```ts
 * const expr = bonsai({ timeout: 50 })
 * expr.use(strings)
 * expr.evaluateSync('name |> trim |> upper', { name: '  hello  ' }) // "HELLO"
 * ```
 */
export function bonsai(options: BonsaiOptions = {}): BonsaiInstance {
  const registry = createPluginRegistry()
  const cache = new LRUCache<string, CompiledExpression>(options.cacheSize ?? DEFAULT_CACHE_SIZE)
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

  function compileExpr(source: string): CompiledExpression {
    const cached = cache.get(source)
    if (cached) return cached

    const optimized = getAst(source)

    const compiled: CompiledExpression = {
      ast: optimized,
      source,
      async evaluate<T = unknown>(context = {}) {
        return evaluateAsync(optimized, context, registry.transforms, registry.functions, createExecutionContext(), source) as Promise<T>
      },
      evaluateSync<T = unknown>(context = {}) {
        if (syncCtxInUse) {
          return evaluate(optimized, context, registry.transforms, registry.functions, createExecutionContext(), source) as T
        }
        syncCtxInUse = true
        try {
          syncCtx.reset()
          return evaluate(optimized, context, registry.transforms, registry.functions, syncCtx, source) as T
        } finally {
          syncCtxInUse = false
        }
      },
    }

    cache.set(source, compiled)
    return compiled
  }

  const instance: BonsaiInstance = {
    use(plugin) { plugin(instance); return instance },
    addTransform(name, fn) { registry.addTransform(name, fn); return instance },
    addFunction(name, fn, addFunctionOptions?: {allowContextAccess: boolean}) { registry.addFunction(name, fn, addFunctionOptions?.allowContextAccess ?? false); return instance },
    removeTransform(name) { return registry.removeTransform(name) },
    removeFunction(name) { return registry.removeFunction(name) },
    hasTransform(name) { return registry.getTransform(name) !== undefined },
    hasFunction(name) { return registry.getFunction(name) !== undefined },
    listTransforms() { return registry.getTransformNames() },
    listFunctions() { return registry.getFunctionNames() },
    getPolicy() {
      return {
        ...(policy.allowedProperties ? { allowedProperties: [...policy.allowedProperties] } : {}),
        ...(policy.deniedProperties ? { deniedProperties: [...policy.deniedProperties] } : {}),
      }
    },
    clearCache() { cache.clear(); astCache.clear() },
    compile(expression) { return compileExpr(expression) },
    async evaluate<T = unknown>(expression: string, context = {}) {
      const ast = getAst(expression)
      return evaluateAsync(ast, context, registry.transforms, registry.functions, createExecutionContext(), expression) as Promise<T>
    },
    evaluateSync<T = unknown>(expression: string, context = {}) {
      // Hot path: reuse pooled ExecutionContext to avoid per-call allocation
      const ast = getAst(expression)
      if (syncCtxInUse) {
        // Reentrant call (e.g., custom function calling evaluateSync) — fresh allocation
        return evaluate(ast, context, registry.transforms, registry.functions, createExecutionContext(), expression) as T
      }
      syncCtxInUse = true
      try {
        syncCtx.reset()
        return evaluate(ast, context, registry.transforms, registry.functions, syncCtx, expression) as T
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
          errors: [{
            message,
            position: { line: position.line, column: position.column },
            formatted: error instanceof ExpressionError
              ? error.message
              : formatError(message, { source: expression, start, end }),
          }],
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
        n.properties.forEach(p => { walk(p.key); walk(p.value) })
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
    }
  }

  walk(node)
  return {
    identifiers: [...identifiers],
    transforms: [...transforms],
    functions: [...functions],
  }
}
