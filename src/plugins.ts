import type {
  TransformFn,
  FunctionFn,
  ContextFunctionFn,
  RegisteredFunction,
  TransformMetadata,
  FunctionMetadata,
  BonsaiType,
  ParameterMetadata,
} from './types.js'
import { BLOCKED_PROPERTIES } from './execution-context.js'

const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'in', 'not'])
const STATIC_TYPE_KINDS = new Set([
  'unknown',
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'literal',
  'array',
  'object',
  'union',
])
const ARRAY_TYPE_RULES = new Set([
  'preserve',
  'optional-element',
  'flatten',
  'map',
  'filter',
  'find',
  'some',
  'every',
])

function normalizeStaticType(
  value: BonsaiType,
  path: string,
  ancestors = new WeakSet(),
): BonsaiType {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`bonsai: ${path} must be a static type descriptor`)
  }
  if (ancestors.has(value)) throw new TypeError(`bonsai: ${path} must not contain cycles`)
  if (!STATIC_TYPE_KINDS.has(value.kind)) {
    throw new TypeError(`bonsai: ${path} has an unknown static type kind`)
  }
  ancestors.add(value)
  try {
    if (value.kind === 'array') {
      return Object.freeze({
        kind: 'array',
        element: normalizeStaticType(value.element, `${path}.element`, ancestors),
      })
    }
    if (value.kind === 'object') {
      if (
        value.properties === null ||
        typeof value.properties !== 'object' ||
        Array.isArray(value.properties)
      ) {
        throw new TypeError(`bonsai: ${path}.properties must be an object`)
      }
      const properties: Record<string, BonsaiType> = Object.create(null)
      for (const [name, propertyType] of Object.entries(value.properties)) {
        properties[name] = normalizeStaticType(propertyType, `${path}.${name}`, ancestors)
      }
      const additional = value.additionalProperties
      return Object.freeze({
        kind: 'object',
        properties: Object.freeze(properties),
        ...(additional === undefined || additional === false
          ? { additionalProperties: additional }
          : {
              additionalProperties: normalizeStaticType(
                additional,
                `${path}.additionalProperties`,
                ancestors,
              ),
            }),
      })
    }
    if (value.kind === 'literal') {
      const literal = value.value
      if (
        typeof literal !== 'string' &&
        typeof literal !== 'boolean' &&
        !(typeof literal === 'number' && Number.isFinite(literal))
      ) {
        throw new TypeError(`bonsai: ${path}.value must be a string, finite number, or boolean`)
      }
      return Object.freeze({ kind: 'literal', value: literal })
    }
    if (value.kind === 'union') {
      if (!Array.isArray(value.members) || value.members.length === 0) {
        throw new TypeError(`bonsai: ${path}.members must be a non-empty array`)
      }
      return Object.freeze({
        kind: 'union',
        members: Object.freeze(
          value.members.map((member, index) =>
            normalizeStaticType(member, `${path}.members[${String(index)}]`, ancestors),
          ),
        ),
      })
    }
    return Object.freeze({ kind: value.kind })
  } finally {
    ancestors.delete(value)
  }
}

function normalizeParameters(
  parameters: readonly ParameterMetadata[] | undefined,
  path: string,
): readonly ParameterMetadata[] | undefined {
  if (parameters === undefined) return undefined
  if (!Array.isArray(parameters)) throw new TypeError(`bonsai: ${path} must be an array`)
  const names = new Set<string>()
  let optionalSeen = false
  return Object.freeze(
    parameters.map((parameter, index) => {
      if (parameter === null || typeof parameter !== 'object' || Array.isArray(parameter)) {
        throw new TypeError(`bonsai: ${path}[${String(index)}] must be an object`)
      }
      if (!BINDING_NAME.test(parameter.name) || KEYWORDS.has(parameter.name)) {
        throw new TypeError(`bonsai: ${path}[${String(index)}].name must be an identifier`)
      }
      if (names.has(parameter.name)) {
        throw new TypeError(`bonsai: ${path} contains duplicate parameter "${parameter.name}"`)
      }
      names.add(parameter.name)
      if (parameter.rest === true && index !== parameters.length - 1) {
        throw new TypeError(`bonsai: only the final parameter may be rest`)
      }
      if (optionalSeen && parameter.optional !== true && parameter.rest !== true) {
        throw new TypeError(`bonsai: required parameters cannot follow optional parameters`)
      }
      optionalSeen ||= parameter.optional === true || parameter.rest === true
      if (parameter.description !== undefined && typeof parameter.description !== 'string') {
        throw new TypeError(`bonsai: parameter description must be a string`)
      }
      return Object.freeze({
        name: parameter.name,
        type: normalizeStaticType(parameter.type, `${path}[${String(index)}].type`),
        ...(parameter.optional === true ? { optional: true } : {}),
        ...(parameter.rest === true ? { rest: true } : {}),
        ...(parameter.description === undefined ? {} : { description: parameter.description }),
      })
    }),
  )
}

function assertBinding(
  kind: 'transform' | 'function' | 'context function',
  name: unknown,
  fn: unknown,
): asserts fn is (...args: unknown[]) => unknown {
  if (typeof name !== 'string' || !BINDING_NAME.test(name) || KEYWORDS.has(name)) {
    throw new TypeError(`bonsai: ${kind} name must be a callable expression identifier`)
  }
  if (BLOCKED_PROPERTIES.has(name)) {
    throw new TypeError(`bonsai: ${kind} name "${name}" is reserved for sandbox safety`)
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`bonsai: ${kind} "${name}" must be registered with a function`)
  }
}

function normalizeTransformMetadata(metadata: TransformMetadata | undefined): TransformMetadata {
  if (metadata === undefined) return Object.freeze({})
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('bonsai: transform metadata must be an object')
  }
  const { inputType, parameters, returnType, arrayTypeRule, description } = metadata
  if (description !== undefined && typeof description !== 'string') {
    throw new TypeError('bonsai: transform metadata description must be a string')
  }
  if (arrayTypeRule !== undefined && !ARRAY_TYPE_RULES.has(arrayTypeRule)) {
    throw new TypeError('bonsai: transform metadata arrayTypeRule is invalid')
  }
  return Object.freeze({
    ...(inputType === undefined
      ? {}
      : { inputType: normalizeStaticType(inputType, 'transform metadata inputType') }),
    ...(parameters === undefined
      ? {}
      : { parameters: normalizeParameters(parameters, 'transform metadata parameters') }),
    ...(returnType === undefined
      ? {}
      : { returnType: normalizeStaticType(returnType, 'transform metadata returnType') }),
    ...(arrayTypeRule === undefined ? {} : { arrayTypeRule }),
    ...(description === undefined ? {} : { description }),
  })
}

function normalizeFunctionMetadata(metadata: FunctionMetadata | undefined): FunctionMetadata {
  if (metadata === undefined) return Object.freeze({})
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('bonsai: function metadata must be an object')
  }
  const { parameters, returnType, description } = metadata
  if (description !== undefined && typeof description !== 'string') {
    throw new TypeError('bonsai: function metadata description must be a string')
  }
  return Object.freeze({
    ...(parameters === undefined
      ? {}
      : { parameters: normalizeParameters(parameters, 'function metadata parameters') }),
    ...(returnType === undefined
      ? {}
      : { returnType: normalizeStaticType(returnType, 'function metadata returnType') }),
    ...(description === undefined ? {} : { description }),
  })
}

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

/**
 * Declared maximum argument count per transform function (the arguments after
 * the piped value), recorded when metadata declares `parameters`. Keyed by the
 * function object so the evaluator's hot pipe path needs no extra plumbing
 * through Bindings; a name-independent key means one function registered under
 * two names with different declarations widens to the larger cap (the
 * conservative direction: never falsely reject a declared-legal call).
 */
const declaredTransformMaxArgs = new WeakMap<TransformFn, number>()

function recordDeclaredTransformArity(fn: TransformFn, metadata: TransformMetadata): void {
  const parameters = metadata.parameters
  if (parameters === undefined) return
  const max = parameters.at(-1)?.rest === true ? Infinity : parameters.length
  const previous = declaredTransformMaxArgs.get(fn)
  declaredTransformMaxArgs.set(fn, previous === undefined ? max : Math.max(previous, max))
}

/**
 * The declared argument cap for a transform, or undefined when its metadata
 * declares no parameters (undeclared transforms accept anything, as before).
 * A surplus argument is a silent wrong answer waiting to happen — the piped
 * value is unaffected by the extras — so the evaluator rejects it loudly.
 */
export function transformMaxArgs(fn: TransformFn): number | undefined {
  return declaredTransformMaxArgs.get(fn)
}

export interface PluginRegistry {
  addTransform: (name: string, fn: TransformFn, metadata?: TransformMetadata) => void
  replaceTransform: (name: string, fn: TransformFn, metadata?: TransformMetadata) => void
  addFunction: (name: string, fn: FunctionFn, metadata?: FunctionMetadata) => void
  replaceFunction: (name: string, fn: FunctionFn, metadata?: FunctionMetadata) => void
  addContextFunction: (name: string, fn: ContextFunctionFn, metadata?: FunctionMetadata) => void
  replaceContextFunction: (name: string, fn: ContextFunctionFn, metadata?: FunctionMetadata) => void
  removeTransform: (name: string) => boolean
  removeFunction: (name: string) => boolean
  getTransform: (name: string) => TransformFn | undefined
  getTransformMetadata: (name: string) => TransformMetadata | undefined
  getFunction: (name: string) => RegisteredFunction | undefined
  getFunctionMetadata: (name: string) => FunctionMetadata | undefined
  isContextFunction: (name: string) => boolean
  hasFunction: (name: string) => boolean
  getTransformNames: () => string[]
  getFunctionNames: () => string[]
  use: (plugin: (registry: PluginRegistry) => void) => void
  seal: () => void
  isSealed: () => boolean
  readonly revision: number
  readonly transforms: Record<string, TransformFn>
  readonly functions: Record<string, RegisteredFunction>
  /** Cached snapshot of all bindings. Rebuilt only when a registration changes. */
  readonly bindings: Bindings
}

export function createPluginRegistry(): PluginRegistry {
  const transformMap = new Map<string, TransformFn>()
  const transformMetadataMap = new Map<string, TransformMetadata>()
  // Pure and context functions share one namespace keyed by name; the tagged
  // value records which kind was registered.
  const functionMap = new Map<string, RegisteredFunction>()
  const functionMetadataMap = new Map<string, FunctionMetadata>()

  // Cached snapshots, rebuilt only when the registry changes
  let transformsCache: Record<string, TransformFn> = Object.freeze({})
  let functionsCache: Record<string, RegisteredFunction> = Object.freeze({})
  let transformsDirty = false
  let functionsDirty = false
  let bindingsCache: Bindings | undefined
  let revision = 0
  let sealed = false

  const assertMutable = (): void => {
    if (sealed) throw new TypeError('bonsai: extension registry is sealed')
  }

  const assertNew = (kind: 'transform' | 'function', name: string, exists: boolean): void => {
    if (exists) {
      const replacement = kind === 'transform' ? 'replaceTransform' : 'replaceFunction'
      throw new TypeError(
        `bonsai: ${kind} "${name}" is already registered; use ${replacement}() for an intentional override`,
      )
    }
  }

  const assertExisting = (kind: 'transform' | 'function', name: string, exists: boolean): void => {
    if (!exists) throw new TypeError(`bonsai: cannot replace unknown ${kind} "${name}"`)
  }

  const putTransform = (
    name: string,
    fn: TransformFn,
    metadata: TransformMetadata | undefined,
  ): void => {
    assertBinding('transform', name, fn)
    const normalizedMetadata = normalizeTransformMetadata(metadata)
    transformMap.set(name, fn)
    transformMetadataMap.set(name, normalizedMetadata)
    recordDeclaredTransformArity(fn, normalizedMetadata)
    transformsDirty = true
    revision++
  }

  const putFunction = (
    kind: 'pure' | 'context',
    name: string,
    fn: FunctionFn | ContextFunctionFn,
    metadata: FunctionMetadata | undefined,
  ): void => {
    assertBinding(kind === 'pure' ? 'function' : 'context function', name, fn)
    const normalizedMetadata = normalizeFunctionMetadata(metadata)
    const entry: RegisteredFunction = kind === 'pure' ? { kind, fn } : { kind, fn }
    functionMap.set(name, entry)
    functionMetadataMap.set(name, normalizedMetadata)
    functionsDirty = true
    revision++
  }

  const registry: PluginRegistry = {
    addTransform(name, fn, metadata) {
      assertMutable()
      assertNew('transform', name, transformMap.has(name))
      putTransform(name, fn, metadata)
    },
    replaceTransform(name, fn, metadata) {
      assertMutable()
      assertExisting('transform', name, transformMap.has(name))
      putTransform(name, fn, metadata)
    },
    addFunction(name, fn, metadata) {
      assertMutable()
      assertNew('function', name, functionMap.has(name))
      putFunction('pure', name, fn, metadata)
    },
    replaceFunction(name, fn, metadata) {
      assertMutable()
      assertExisting('function', name, functionMap.has(name))
      putFunction('pure', name, fn, metadata)
    },
    addContextFunction(name, fn, metadata) {
      assertMutable()
      assertNew('function', name, functionMap.has(name))
      putFunction('context', name, fn, metadata)
    },
    replaceContextFunction(name, fn, metadata) {
      assertMutable()
      assertExisting('function', name, functionMap.has(name))
      putFunction('context', name, fn, metadata)
    },
    removeTransform(name) {
      assertMutable()
      const r = transformMap.delete(name)
      transformMetadataMap.delete(name)
      if (r) {
        transformsDirty = true
        revision++
      }
      return r
    },
    removeFunction(name) {
      assertMutable()
      const r = functionMap.delete(name)
      functionMetadataMap.delete(name)
      if (r) {
        functionsDirty = true
        revision++
      }
      return r
    },
    getTransform(name) {
      return transformMap.get(name)
    },
    getTransformMetadata(name) {
      return transformMetadataMap.get(name)
    },
    getFunction(name) {
      return functionMap.get(name)
    },
    getFunctionMetadata(name) {
      return functionMetadataMap.get(name)
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
      assertMutable()
      if (typeof plugin !== 'function') {
        throw new TypeError('bonsai: plugin must be a function')
      }
      const savedTransforms = new Map(transformMap)
      const savedTransformMetadata = new Map(transformMetadataMap)
      const savedFunctions = new Map(functionMap)
      const savedFunctionMetadata = new Map(functionMetadataMap)
      const savedRevision = revision
      try {
        plugin(registry)
      } catch (error: unknown) {
        transformMap.clear()
        transformMetadataMap.clear()
        functionMap.clear()
        functionMetadataMap.clear()
        for (const [name, value] of savedTransforms) transformMap.set(name, value)
        for (const [name, value] of savedTransformMetadata) {
          transformMetadataMap.set(name, value)
        }
        for (const [name, value] of savedFunctions) functionMap.set(name, value)
        for (const [name, value] of savedFunctionMetadata) functionMetadataMap.set(name, value)
        transformsDirty = true
        functionsDirty = true
        bindingsCache = undefined
        revision = savedRevision
        throw error
      }
    },
    seal() {
      sealed = true
      // Materialize and freeze the final evaluator snapshot immediately.
      void registry.bindings
    },
    isSealed() {
      return sealed
    },
    get revision() {
      return revision
    },
    get transforms() {
      if (transformsDirty) {
        transformsCache = Object.freeze(Object.fromEntries(transformMap))
        transformsDirty = false
      }
      return transformsCache
    },
    get functions() {
      if (functionsDirty) {
        functionsCache = Object.freeze(Object.fromEntries(functionMap))
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
        bindingsCache = Object.freeze({ transforms: t, functions: f })
      }
      return bindingsCache
    },
  }

  return registry
}
