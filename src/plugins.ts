import type { TransformFn, FunctionFn, ContextFunctionFn } from './types.js'

/**
 * Snapshot of every registered binding passed to the evaluator on each call.
 * Bundled into a single object so the evaluator signature stays compact and
 * we avoid per-call allocation (the registry caches and reuses the snapshot
 * until a registration changes).
 */
export interface Bindings {
  readonly transforms: Record<string, TransformFn>
  readonly functions: Record<string, FunctionFn>
  readonly contextFunctions: Record<string, ContextFunctionFn>
}

export interface PluginRegistry {
  addTransform(name: string, fn: TransformFn): void
  addFunction(name: string, fn: FunctionFn): void
  addContextFunction(name: string, fn: ContextFunctionFn): void
  removeTransform(name: string): boolean
  removeFunction(name: string): boolean
  getTransform(name: string): TransformFn | undefined
  getFunction(name: string): FunctionFn | undefined
  getContextFunction(name: string): ContextFunctionFn | undefined
  isContextFunction(name: string): boolean
  hasFunction(name: string): boolean
  getTransformNames(): string[]
  getFunctionNames(): string[]
  use(plugin: (registry: PluginRegistry) => void): void
  readonly transforms: Record<string, TransformFn>
  readonly functions: Record<string, FunctionFn>
  readonly contextFunctions: Record<string, ContextFunctionFn>
  /** Cached snapshot of all bindings. Rebuilt only when a registration changes. */
  readonly bindings: Bindings
}

export function createPluginRegistry(): PluginRegistry {
  const transformMap = new Map<string, TransformFn>()
  const functionMap = new Map<string, FunctionFn>()
  const contextFunctionMap = new Map<string, ContextFunctionFn>()

  // Cached snapshots, rebuilt only when registry changes
  let transformsCache: Record<string, TransformFn> = {}
  let functionsCache: Record<string, FunctionFn> = {}
  let contextFunctionsCache: Record<string, ContextFunctionFn> = {}
  let transformsDirty = false
  let functionsDirty = false
  let contextFunctionsDirty = false

  const registry: PluginRegistry = {
    addTransform(name, fn) {
      transformMap.set(name, fn)
      transformsDirty = true
    },
    addFunction(name, fn) {
      functionMap.set(name, fn)
      functionsDirty = true
      // Context and pure functions share a namespace: overwrite the other kind.
      if (contextFunctionMap.delete(name)) contextFunctionsDirty = true
    },
    addContextFunction(name, fn) {
      contextFunctionMap.set(name, fn)
      contextFunctionsDirty = true
      if (functionMap.delete(name)) functionsDirty = true
    },
    removeTransform(name) {
      const r = transformMap.delete(name)
      if (r) transformsDirty = true
      return r
    },
    removeFunction(name) {
      const pure = functionMap.delete(name)
      const ctx = contextFunctionMap.delete(name)
      if (pure) functionsDirty = true
      if (ctx) contextFunctionsDirty = true
      return pure || ctx
    },
    getTransform(name) { return transformMap.get(name) },
    getFunction(name) { return functionMap.get(name) },
    getContextFunction(name) { return contextFunctionMap.get(name) },
    isContextFunction(name) { return contextFunctionMap.has(name) },
    hasFunction(name) { return functionMap.has(name) || contextFunctionMap.has(name) },
    getTransformNames() { return [...transformMap.keys()] },
    getFunctionNames() {
      const names = new Set<string>(functionMap.keys())
      for (const name of contextFunctionMap.keys()) names.add(name)
      return [...names]
    },
    use(plugin) { plugin(registry) },
    get transforms() {
      if (transformsDirty) {
        transformsCache = Object.fromEntries(transformMap)
        transformsDirty = false
      }
      return transformsCache
    },
    get functions() {
      if (functionsDirty) {
        functionsCache = Object.fromEntries(functionMap)
        functionsDirty = false
      }
      return functionsCache
    },
    get contextFunctions() {
      if (contextFunctionsDirty) {
        contextFunctionsCache = Object.fromEntries(contextFunctionMap)
        contextFunctionsDirty = false
      }
      return contextFunctionsCache
    },
    get bindings(): Bindings {
      // Reuse the cached individual snapshots. The composite object is
      // rebuilt only when any of the three underlying caches change.
      const t = registry.transforms
      const f = registry.functions
      const cf = registry.contextFunctions
      if (
        !bindingsCache
        || bindingsCache.transforms !== t
        || bindingsCache.functions !== f
        || bindingsCache.contextFunctions !== cf
      ) {
        bindingsCache = { transforms: t, functions: f, contextFunctions: cf }
      }
      return bindingsCache
    },
  }

  let bindingsCache: Bindings | undefined

  return registry
}
