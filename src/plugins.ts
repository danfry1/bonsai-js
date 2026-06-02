import type { TransformFn, FunctionFn, ContextFunctionFn, RegisteredFunction } from './types.js'

/**
 * Snapshot of every registered binding passed to the evaluator on each call.
 * Bundled into a single object so the evaluator signature stays compact and
 * we avoid per-call allocation (the registry caches and reuses the snapshot
 * until a registration changes).
 */
export interface Bindings {
  readonly transforms: Record<string, TransformFn>
  readonly functions: Record<string, RegisteredFunction>
}

export interface PluginRegistry {
  addTransform(name: string, fn: TransformFn): void
  addFunction(name: string, fn: FunctionFn): void
  addContextFunction(name: string, fn: ContextFunctionFn): void
  removeTransform(name: string): boolean
  removeFunction(name: string): boolean
  getTransform(name: string): TransformFn | undefined
  getFunction(name: string): RegisteredFunction | undefined
  isContextFunction(name: string): boolean
  hasFunction(name: string): boolean
  getTransformNames(): string[]
  getFunctionNames(): string[]
  use(plugin: (registry: PluginRegistry) => void): void
  readonly transforms: Record<string, TransformFn>
  readonly functions: Record<string, RegisteredFunction>
  /** Cached snapshot of all bindings. Rebuilt only when a registration changes. */
  readonly bindings: Bindings
}

export function createPluginRegistry(): PluginRegistry {
  const transformMap = new Map<string, TransformFn>()
  // Pure and context functions share one namespace keyed by name; the tagged
  // value records which kind was registered. Re-registering a name with either
  // method structurally replaces the prior entry (last registration wins),
  // so there is no cross-map invariant to keep in sync.
  const functionMap = new Map<string, RegisteredFunction>()

  // Cached snapshots, rebuilt only when the registry changes
  let transformsCache: Record<string, TransformFn> = {}
  let functionsCache: Record<string, RegisteredFunction> = {}
  let transformsDirty = false
  let functionsDirty = false
  let bindingsCache: Bindings | undefined

  const registry: PluginRegistry = {
    addTransform(name, fn) {
      transformMap.set(name, fn)
      transformsDirty = true
    },
    addFunction(name, fn) {
      functionMap.set(name, { kind: 'pure', fn })
      functionsDirty = true
    },
    addContextFunction(name, fn) {
      functionMap.set(name, { kind: 'context', fn })
      functionsDirty = true
    },
    removeTransform(name) {
      const r = transformMap.delete(name)
      if (r) transformsDirty = true
      return r
    },
    removeFunction(name) {
      const r = functionMap.delete(name)
      if (r) functionsDirty = true
      return r
    },
    getTransform(name) {
      return transformMap.get(name)
    },
    getFunction(name) {
      return functionMap.get(name)
    },
    isContextFunction(name) {
      return functionMap.get(name)?.kind === 'context'
    },
    hasFunction(name) {
      return functionMap.has(name)
    },
    getTransformNames() {
      return [...transformMap.keys()]
    },
    getFunctionNames() {
      return [...functionMap.keys()]
    },
    use(plugin) {
      plugin(registry)
    },
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
    get bindings(): Bindings {
      // Reuse the cached individual snapshots. The composite object is
      // rebuilt only when either underlying cache changes.
      const t = registry.transforms
      const f = registry.functions
      if (!bindingsCache || bindingsCache.transforms !== t || bindingsCache.functions !== f) {
        bindingsCache = { transforms: t, functions: f }
      }
      return bindingsCache
    },
  }

  return registry
}
