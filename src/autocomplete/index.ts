import type {
  BonsaiInstance,
  Token,
  InferredTypeName,
  BonsaiObjectType,
  BonsaiType,
} from '../types.js'
import { tolerantTokenize, isCursorInsideString, type ErrorHandler } from './tokenizer.js'
import { classifyCursor } from './context.js'
import { generateCompletions, type Completion, type CompletionEnv } from './completions.js'
import {
  inferType,
  resolvePropertyChain,
  inferElementType,
  inferMethodReturnType,
  resolveContextChain,
  snapshotDataProperties,
  type ResolveOptions,
} from './inference.js'
import { isMethodReceiverType } from './catalog.js'
import { inferredTypeNames, toInferredTypeName } from '../static-types.js'

export type { Completion }

/** Static type metadata used to filter and continue pipe completions safely. */
export interface AutocompleteTransformSignature {
  /** Input types accepted by the transform. Omit when it accepts any type. */
  input?: readonly InferredTypeName[]
  /** Output type, when it is stable regardless of arguments. */
  output?: InferredTypeName
}

export interface AutocompleteOptions {
  context?: Record<string, unknown>
  /** Static context schema. Supplies completions without requiring live values. */
  schema?: BonsaiObjectType
  /**
   * Static transform metadata for transforms registered without
   * `defineTransform()` metadata (registry metadata is used automatically and
   * entries here override it). Completion never calls transforms, functions,
   * or property accessors to infer a type. An output type lets inference
   * continue through a pipeline such as `name |> trim |> `.
   */
  transformSignatures?: Record<string, AutocompleteTransformSignature>
  /** Called when an unexpected internal error occurs during completion.
   *  Expected errors (e.g., syntax errors, security blocks, type mismatches) are not reported.
   *  Useful for debugging missing or incorrect completions. */
  onError?: ErrorHandler
}

export interface AutocompleteInstance {
  complete: (expression: string, cursor: number) => Completion[]
  setContext: (context: Record<string, unknown>) => void
}

export function createAutocomplete(
  instance: BonsaiInstance,
  options: AutocompleteOptions = {},
): AutocompleteInstance {
  let context: Record<string, unknown> = options.context ?? {}
  const schemaContext = sampleContextFromSchema(options.schema)
  const onError = options.onError

  // Cache policy at construction — it's immutable per-instance
  const rawPolicy = instance.getPolicy()
  const policy = {
    allowedProperties: rawPolicy.allowedProperties
      ? new Set(rawPolicy.allowedProperties)
      : undefined,
    deniedProperties: rawPolicy.deniedProperties ? new Set(rawPolicy.deniedProperties) : undefined,
  }
  // Resolve policy for property chain resolution (shared across calls)
  const resolvePolicy: ResolveOptions = {
    allowedProperties: policy.allowedProperties,
    deniedProperties: policy.deniedProperties,
  }

  return {
    complete(expression: string, cursor: number): Completion[] {
      try {
        return completeInner(expression, cursor)
      } catch (err: unknown) {
        onError?.(err, 'complete')
        return []
      }
    },

    setContext(newContext: Record<string, unknown>): void {
      context = newContext ?? {}
    },
  }

  function completeInner(expression: string, cursor: number): Completion[] {
    // Clamp cursor to valid range
    cursor = Math.max(0, Math.min(cursor, expression.length))

    // Fast path: check if cursor is inside a string before expensive tokenization
    if (isCursorInsideString(expression, cursor)) return []

    const { tokens } = tolerantTokenize(expression, cursor, onError)
    const dataContext = Object.assign(
      Object.create(null) as Record<string, unknown>,
      schemaContext,
      snapshotDataProperties(context),
    )

    const cursorCtx = classifyCursor(tokens, cursor)
    if (cursorCtx.kind === 'none') return []

    // Defer listTransforms/listFunctions to branches that need them (avoids allocation on every call)
    const env: CompletionEnv = {
      transforms: [],
      functions: [],
      policy,
    }

    if (cursorCtx.kind === 'pipe-transform') {
      const transforms = instance.listTransforms()
      env.transforms = transforms
      // Registry metadata (BonsaiType) is widened to runtime kinds for
      // filtering; explicit `transformSignatures` override per name.
      const registrySignatures: Record<string, AutocompleteTransformSignature> = {}
      for (const name of transforms) {
        const metadata = instance.getTransformMetadata(name)
        if (metadata === undefined) continue
        const input =
          metadata.inputType === undefined ? undefined : inferredTypeNames(metadata.inputType)
        const output =
          metadata.returnType === undefined ? undefined : toInferredTypeName(metadata.returnType)
        registrySignatures[name] = {
          // An input type that widens to no concrete kind (unknown) accepts anything.
          ...(input !== undefined && input.length > 0 ? { input } : {}),
          ...(output === undefined ? {} : { output }),
        }
      }
      const signatures = { ...registrySignatures, ...options.transformSignatures }
      const inputType = inferPipeInputType(tokens, cursor, dataContext, resolvePolicy, signatures)
      const transformTypes: Record<string, InferredTypeName[]> = {}
      for (const [name, signature] of Object.entries(signatures)) {
        if (signature.input !== undefined) transformTypes[name] = [...signature.input]
      }
      env.pipe = { inputType, transformTypes }
    } else if (cursorCtx.kind === 'top-level-member') {
      // Resolve simple data chains first, then use the method return-type catalog.
      const chain = extractChainFromTokens(cursorCtx.precedingTokens)
      if (chain.length > 0) {
        const result = resolveContextChain(dataContext, chain, resolvePolicy)
        if (result.found) {
          env.member = { resolvedValue: result.value, resolvedType: inferType(result.value) }
        } else {
          const inferred = inferStaticExpressionType(
            cursorCtx.precedingTokens,
            dataContext,
            resolvePolicy,
          )
          if (inferred) env.member = { resolvedType: inferred }
        }
      } else {
        const inferred = inferStaticExpressionType(
          cursorCtx.precedingTokens,
          dataContext,
          resolvePolicy,
        )
        if (inferred) env.member = { resolvedType: inferred }
      }
    } else if (cursorCtx.kind === 'lambda-member') {
      const arrTokens = extractChainBeforeCall(tokens, cursor)
      const arrResult = resolveContextChain(dataContext, arrTokens, resolvePolicy)
      if (arrResult.found && Array.isArray(arrResult.value)) {
        const elemInfo = inferElementType(arrResult.value)
        if (elemInfo.type === 'object') {
          const resolved = resolvePropertyChain(elemInfo.value, cursorCtx.chain, resolvePolicy)
          if (resolved.found) {
            env.member = { resolvedValue: resolved.value, resolvedType: inferType(resolved.value) }
          }
        } else if (elemInfo.type !== 'unknown') {
          env.member = { resolvedType: inferType(elemInfo.value) }
        }
      }
    } else if (cursorCtx.kind === 'lambda-start') {
      const arrTokens = extractChainBeforeCall(tokens, cursor)
      let resolved = false

      // First try: static chain resolution from context
      if (arrTokens.length > 0) {
        const arrResult = resolveContextChain(dataContext, arrTokens, resolvePolicy)
        if (arrResult.found && Array.isArray(arrResult.value)) {
          const elemInfo = inferElementType(arrResult.value)
          env.lambda = {
            elementProperties: elemInfo.properties,
            elementValue: elemInfo.type === 'object' ? elemInfo.value : undefined,
          }
          resolved = true
        }
      }

      // Second try: statically walk representative own data properties for nested lambdas.
      if (!resolved) {
        const nestedArr = tryResolveNestedLambdaArray(tokens, cursor, dataContext, resolvePolicy)
        if (nestedArr) {
          const elemInfo = inferElementType(nestedArr)
          env.lambda = {
            elementProperties: elemInfo.properties,
            elementValue: elemInfo.type === 'object' ? elemInfo.value : undefined,
          }
        }
      }
    } else if (cursorCtx.kind === 'identifier') {
      env.functions = instance.listFunctions()
      env.functionMetadata = Object.fromEntries(
        env.functions.flatMap((name) => {
          const metadata = instance.getFunctionMetadata(name)
          return metadata ? [[name, metadata]] : []
        }),
      )
      env.identifier = { contextKeys: Object.keys(dataContext), contextValues: dataContext }
    }

    return generateCompletions(cursorCtx, env)
  }
}

function sampleContextFromSchema(schema: BonsaiObjectType | undefined): Record<string, unknown> {
  if (schema?.kind !== 'object') return Object.create(null) as Record<string, unknown>
  return sampleForType(schema, new WeakSet()) as Record<string, unknown>
}

function sampleForType(type: BonsaiType, ancestors: WeakSet<object>): unknown {
  if (ancestors.has(type)) return undefined
  ancestors.add(type)
  try {
    switch (type.kind) {
      case 'string':
        return ''
      case 'number':
        return 0
      case 'boolean':
        return false
      case 'null':
        return null
      case 'undefined':
      case 'unknown':
        return undefined
      case 'literal':
        return type.value
      case 'array':
        return [sampleForType(type.element, ancestors)]
      case 'object': {
        const value: Record<string, unknown> = Object.create(null)
        for (const [name, property] of Object.entries(type.properties)) {
          value[name] = sampleForType(property, ancestors)
        }
        return value
      }
      case 'union': {
        const representative = type.members.find(
          (member) => member.kind !== 'null' && member.kind !== 'undefined',
        )
        return representative === undefined ? undefined : sampleForType(representative, ancestors)
      }
    }
  } finally {
    ancestors.delete(type)
  }
  throw new TypeError('Unknown static type')
}

/**
 * Infer the type by walking the token chain and using the return type map.
 * Handles: user.name.trim(). → string (because trim returns string)
 */
function inferTypeFromTokenChain(
  tokens: Token[],
  context: Record<string, unknown>,
  resolveOpts?: ResolveOptions,
): InferredTypeName | undefined {
  // Walk the chain: resolve context properties, then use return type map for method calls
  let currentType: InferredTypeName | undefined

  // First resolve as much as we can from context
  const chain: string[] = []
  let i = 0
  for (; i < tokens.length; i++) {
    if (tokens[i].type === 'Identifier') {
      chain.push(tokens[i].value)
    } else if (
      (tokens[i].type === 'Punctuation' && tokens[i].value === '.') ||
      tokens[i].type === 'OptionalChain'
    ) {
      continue
    } else if (
      tokens[i].type === 'Punctuation' &&
      tokens[i].value === '[' &&
      i + 2 < tokens.length &&
      tokens[i + 2].type === 'Punctuation' &&
      tokens[i + 2].value === ']' &&
      (tokens[i + 1].type === 'Number' || tokens[i + 1].type === 'String')
    ) {
      // `[0]` / `["key"]` index segment on a context chain (not after a method call).
      if (currentType !== undefined) return undefined
      chain.push(tokens[i + 1].value)
      i += 2
    } else if (tokens[i].type === 'Punctuation' && tokens[i].value === '(') {
      // Method call — use the last identifier as method name
      const methodName = chain.pop()
      if (methodName === undefined || methodName === '') break

      // Resolve what we have so far to get the receiver type
      if (currentType === undefined && chain.length > 0) {
        const result = resolveContextChain(context, chain, resolveOpts)
        currentType = result.found ? inferType(result.value) : undefined
      } else if (currentType !== undefined && chain.length > 0) {
        // Property access on a method return type — can't resolve statically
        // (e.g., trim().foo.bar( — foo/bar are not context properties)
        currentType = undefined
      }
      // Always clear chain after consuming it for a method call
      chain.length = 0

      if (currentType && isMethodReceiverType(currentType)) {
        const returned = inferMethodReturnType(currentType, methodName)
        currentType = returned === 'unknown' ? undefined : returned
      } else {
        currentType = undefined
      }

      // Skip past the closing paren
      let depth = 1
      i++
      while (i < tokens.length && depth > 0) {
        if (tokens[i].type === 'Punctuation' && tokens[i].value === '(') depth++
        if (tokens[i].type === 'Punctuation' && tokens[i].value === ')') depth--
        i++
      }
      i-- // will be incremented by for loop
      continue
    } else {
      break
    }
  }

  // If we have a resolved type but there are unresolved identifiers remaining
  // (e.g., user.name.trim().nonExistent), we can't resolve further statically
  if (currentType !== undefined && chain.length > 0) {
    return undefined
  }

  // Resolve remaining chain from context if we haven't resolved type yet
  if (currentType === undefined && chain.length > 0) {
    const result = resolveContextChain(context, chain, resolveOpts)
    currentType = result.found ? inferType(result.value) : undefined
  }

  return currentType
}

/** Infer a useful type without evaluating the expression. */
function inferStaticExpressionType(
  tokens: Token[],
  context: Record<string, unknown>,
  resolveOpts?: ResolveOptions,
): InferredTypeName | undefined {
  const relevant = tokens.filter(
    (token) =>
      !((token.type === 'Punctuation' && token.value === '.') || token.type === 'OptionalChain'),
  )
  if (relevant.length === 0) return undefined
  const first = relevant[0]
  if (first.type === 'String' || first.type === 'TemplateLiteral') return 'string'
  if (first.type === 'Number') return 'number'
  if (first.type === 'Boolean') return 'boolean'
  if (first.type === 'Null') return 'null'
  if (first.type === 'Undefined') return 'undefined'
  if (first.type === 'Punctuation' && first.value === '[') return 'array'
  if (first.type === 'Punctuation' && first.value === '{') return 'object'
  return inferTypeFromTokenChain(tokens, context, resolveOpts)
}

// ── Nested lambda resolution ───────────────────────────────────

/**
 * For nested lambdas like `groups.map(.users.filter(.`, resolve the inner array
 * by walking the call stack: find the outermost array from context, get its element,
 * then follow the lambda property chain to find the nested array.
 */
function tryResolveNestedLambdaArray(
  tokens: Token[],
  cursor: number,
  context: Record<string, unknown>,
  resolveOpts?: ResolveOptions,
): unknown[] | undefined {
  const before = tokens.filter((t) => t.start < cursor)

  // Collect lambda chains at each depth level
  // For `groups.map(.users.filter(.`:
  //   depth 1 (after map(): lambda chain = ['users']
  //   depth 2 (after filter(): lambda chain = [] (we're at the start)
  const lambdaChainsByDepth = new Map<number, string[]>()
  let depth = 0
  let currentChain: string[] = []
  let inLambda = false

  for (let i = 0; i < before.length; i++) {
    const t = before[i]
    if (t.type === 'Punctuation' && t.value === '(') {
      if (inLambda && currentChain.length > 0) {
        // The last identifier before ( is a method name, not a property — remove it
        const chain = [...currentChain]
        chain.pop() // remove the method name (e.g., 'filter' from ['users', 'filter'])
        if (chain.length > 0) {
          lambdaChainsByDepth.set(depth, chain)
        }
      }
      depth++
      inLambda = false
      currentChain = []
    } else if (t.type === 'Punctuation' && t.value === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth > 0 && t.type === 'Punctuation' && t.value === '.') {
      const prev = i > 0 ? before[i - 1] : null
      if (prev && prev.type === 'Punctuation' && (prev.value === '(' || prev.value === ',')) {
        inLambda = true
        currentChain = []
      }
    } else if (inLambda && t.type === 'Identifier') {
      currentChain.push(t.value)
    }
  }

  // Save current chain for the current depth
  if (inLambda && currentChain.length > 0) {
    lambdaChainsByDepth.set(depth, [...currentChain])
  }

  // Find the outermost method-call ( — must be preceded by `identifier` with a `.`/`?.`/`|>` before it
  // This skips leading function calls like fn(arg) or grouping parens like (expr)
  let outerParenIdx = -1
  for (let i = 0; i < before.length; i++) {
    if (before[i].type === 'Punctuation' && before[i].value === '(' && i >= 2) {
      const prev = before[i - 1]
      const prevPrev = before[i - 2]
      if (
        prev.type === 'Identifier' &&
        ((prevPrev.type === 'Punctuation' && prevPrev.value === '.') ||
          prevPrev.type === 'OptionalChain' ||
          prevPrev.type === 'Pipe')
      ) {
        outerParenIdx = i
        break
      }
    }
  }

  if (outerParenIdx <= 0) return undefined

  // Extract the context array chain before the outermost call.
  const chain = extractChainBeforeOuterCall(before, outerParenIdx)
  if (chain.length === 0) return undefined

  // Resolve the outermost array from context
  const outerResult = resolveContextChain(context, chain, resolveOpts)
  if (!outerResult.found || !Array.isArray(outerResult.value)) return undefined
  let currentValue: unknown = outerResult.value

  // Walk through each depth's lambda chain to resolve nested arrays
  for (let d = 1; d <= depth; d++) {
    const elemInfo = inferElementType(currentValue as unknown[])
    if (elemInfo.type !== 'object') return undefined

    const lambdaChain = lambdaChainsByDepth.get(d)
    if (!lambdaChain || lambdaChain.length === 0) {
      // No lambda chain at this depth — we're at the start of the lambda
      // The current array is what we want
      return currentValue as unknown[]
    }

    // Follow the lambda chain on the element
    const nestedResult = resolvePropertyChain(elemInfo.value, lambdaChain, resolveOpts)
    if (!nestedResult.found || !Array.isArray(nestedResult.value)) return undefined
    currentValue = nestedResult.value
  }

  return Array.isArray(currentValue) ? (currentValue as unknown[]) : undefined
}

function inferPipeInputType(
  tokens: Token[],
  cursor: number,
  context: Record<string, unknown>,
  resolveOpts: ResolveOptions,
  signatures?: Record<string, AutocompleteTransformSignature>,
): InferredTypeName | undefined {
  const before = tokens.filter((token) => token.start < cursor)
  const pipeIndexes = before.flatMap((token, index) => (token.type === 'Pipe' ? [index] : []))
  if (pipeIndexes.length === 0) return undefined

  let currentType = inferStaticExpressionType(before.slice(0, pipeIndexes[0]), context, resolveOpts)
  if (currentType === 'null' || currentType === 'undefined') return undefined

  for (let i = 0; i < pipeIndexes.length - 1; i++) {
    const stage = before.slice(pipeIndexes[i] + 1, pipeIndexes[i + 1])
    const name = stage.find((token) => token.type === 'Identifier')?.value
    if (name === undefined || name === '') return undefined
    const output = signatures?.[name]?.output
    if (output === undefined) return undefined
    currentType = output
  }
  return currentType
}

// ── Token chain extraction ─────────────────────────────────────

/** Extract trailing identifier.dot chain from a token array (walking backward). */
/**
 * Walk backwards over a `a.b[0]["c"]?.d` chain and return its segments
 * (`['a', 'b', '0', 'c', 'd']`). Numeric and string-literal index segments are
 * folded in so `items[0].` resolves to the element rather than the array.
 */
function extractChainFromTokens(tokens: Token[]): string[] {
  const chain: string[] = []
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.type === 'Identifier') {
      chain.unshift(t.value)
    } else if ((t.type === 'Punctuation' && t.value === '.') || t.type === 'OptionalChain') {
      continue
    } else if (t.type === 'Punctuation' && t.value === ']' && i >= 2) {
      const key = tokens[i - 1]
      const open = tokens[i - 2]
      if (!(open.type === 'Punctuation' && open.value === '[')) break
      // String token values are already unquoted by the tokenizer.
      if (key.type === 'Number' || key.type === 'String') chain.unshift(key.value)
      else break
      i -= 2
    } else {
      break
    }
  }
  return chain
}

/** Extract the identifier chain before the outermost call's open paren. */
function extractChainBeforeOuterCall(before: Token[], outerParenIdx: number): string[] {
  const chain: string[] = []
  let walkIdx = outerParenIdx - 1

  // Skip the method name
  if (walkIdx >= 0 && before[walkIdx].type === 'Identifier') walkIdx--

  // Skip the separator (dot, optional chain, or pipe)
  if (walkIdx >= 0) {
    const sep = before[walkIdx]
    if (
      (sep.type === 'Punctuation' && sep.value === '.') ||
      sep.type === 'OptionalChain' ||
      sep.type === 'Pipe'
    ) {
      walkIdx--
    }
  }

  // Skip past closing paren and its matching open paren (call-chain receiver)
  if (walkIdx >= 0 && before[walkIdx].type === 'Punctuation' && before[walkIdx].value === ')') {
    let parenDepth = 1
    walkIdx--
    while (walkIdx >= 0 && parenDepth > 0) {
      if (before[walkIdx].type === 'Punctuation' && before[walkIdx].value === ')') parenDepth++
      if (before[walkIdx].type === 'Punctuation' && before[walkIdx].value === '(') parenDepth--
      walkIdx--
    }
  }

  // Collect the identifier.identifier chain (reuses extractChainFromTokens logic)
  for (let i = walkIdx; i >= 0; i--) {
    if (before[i].type === 'Identifier') {
      chain.unshift(before[i].value)
    } else if (
      (before[i].type === 'Punctuation' && before[i].value === '.') ||
      before[i].type === 'OptionalChain'
    ) {
      continue
    } else {
      break
    }
  }

  return chain
}

function extractChainBeforeCall(tokens: Token[], cursor: number): string[] {
  const before = tokens.filter((t) => t.start < cursor)
  let parenIdx = -1
  let depth = 0
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].type === 'Punctuation' && before[i].value === ')') depth++
    if (before[i].type === 'Punctuation' && before[i].value === '(') {
      if (depth === 0) {
        parenIdx = i
        break
      }
      depth--
    }
  }

  if (parenIdx <= 0) return []

  const methodToken = before[parenIdx - 1]
  if (methodToken === undefined || methodToken.type !== 'Identifier') return []

  const preMethodIdx = parenIdx - 2
  if (preMethodIdx < 0) return []
  const preMethodToken = before[preMethodIdx]

  if (
    (preMethodToken.type === 'Punctuation' && preMethodToken.value === '.') ||
    preMethodToken.type === 'OptionalChain' ||
    preMethodToken.type === 'Pipe'
  ) {
    return extractChainFromTokens(before.slice(0, preMethodIdx))
  }

  return []
}
