import type { BonsaiInstance, Token, InferredTypeName } from '../types.js'
import { ExpressionError } from '../errors.js'
import { tolerantTokenize, type ErrorHandler } from './tokenizer.js'
import { classifyCursor } from './context.js'
import { generateCompletions, type Completion, type CompletionEnv } from './completions.js'
import { inferType, resolvePropertyChain, inferElementType, inferMethodReturnType, type ResolveOptions } from './inference.js'

export type { Completion }

export interface AutocompleteOptions {
  context?: Record<string, unknown>
  /** Map of transform name → accepted input types (e.g., { upper: ['string'], filter: ['array'] }).
   *  When set, pipe-transform completions are filtered by the inferred input type.
   *  When omitted, auto-probing discovers type compatibility by calling each transform
   *  with a sample value — this runs once per type and is cached per instance.
   *  For performance-sensitive contexts (e.g., large transform registries), pass this
   *  explicitly to avoid the cold-start probe cost. */
  transformTypes?: Record<string, InferredTypeName[]>
  /** Called when an unexpected internal error occurs during completion.
   *  Expected errors (e.g., syntax errors from incomplete expressions) are not reported.
   *  Useful for debugging missing or incorrect completions. */
  onError?: ErrorHandler
}

export interface AutocompleteInstance {
  complete(expression: string, cursor: number): Completion[]
  setContext(context: Record<string, unknown>): void
}

// Valid identifier pattern for transform name validation
const VALID_IDENTIFIER = /^[a-zA-Z_$][\w$]*$/

export function createAutocomplete(
  instance: BonsaiInstance,
  options: AutocompleteOptions = {},
): AutocompleteInstance {
  let context: Record<string, unknown> = options.context ?? {}
  const probeCache = new Map<string, Set<string>>()
  const onError = options.onError

  // Cache policy at construction — it's immutable per-instance
  const rawPolicy = instance.getPolicy()
  const policy = {
    allowedProperties: rawPolicy.allowedProperties ? new Set(rawPolicy.allowedProperties) : undefined,
    deniedProperties: rawPolicy.deniedProperties ? new Set(rawPolicy.deniedProperties) : undefined,
  }
  // Resolve policy for property chain resolution (shared across calls)
  const resolvePolicy: ResolveOptions = {
    allowedProperties: policy.allowedProperties,
    deniedProperties: policy.deniedProperties,
  }

  return {
    complete(expression: string, cursor: number): Completion[] {
      // Clamp cursor to valid range
      cursor = Math.max(0, Math.min(cursor, expression.length))

      const { tokens, insideString } = tolerantTokenize(expression, cursor, onError)
      if (insideString) return []

      const cursorCtx = classifyCursor(tokens, cursor)
      if (cursorCtx.kind === 'none') return []

      const transforms = instance.listTransforms()
      const functions = instance.listFunctions()

      const env: CompletionEnv = {
        transforms, functions, policy,
      }

      if (cursorCtx.kind === 'pipe-transform') {
        const inputType = inferPipeInputType(expression, cursor, instance, context, onError)
        env.pipe = { inputType, transformTypes: options.transformTypes }
        if (inputType && !options.transformTypes) {
          const accepted = probeAcceptedTransforms(instance, inputType, probeCache, transforms, onError)
          env.transforms = transforms.filter(name => accepted.has(name))
        }
      } else if (cursorCtx.kind === 'top-level-member') {
        // Only use eval-based inference when prefix is empty (cursor right after dot)
        // When prefix is non-empty (user typing a partial name), use static resolution
        const useEval = cursorCtx.prefix === ''
        const evalResult = useEval ? tryEvalPrefix(expression, cursor, instance, context, tokens, onError) : undefined
        if (evalResult !== undefined) {
          env.member = { resolvedValue: evalResult, resolvedType: inferType(evalResult) }
        } else {
          // Fall back to static chain resolution from context
          const chain = extractChainFromTokens(cursorCtx.precedingTokens)
          if (chain.length > 0) {
            const result = resolvePropertyChain(context, chain, resolvePolicy)
            if (result.found) {
              env.member = { resolvedValue: result.value, resolvedType: inferType(result.value) }
            } else {
              // If static resolution failed but there's a method call in the chain,
              // try to infer type from the method return type map
              const inferred = inferTypeFromTokenChain(cursorCtx.precedingTokens, context, resolvePolicy)
              if (inferred) {
                env.member = { resolvedType: inferred }
              }
            }
          }
        }
      } else if (cursorCtx.kind === 'lambda-member') {
        const arrTokens = extractChainBeforeCall(tokens, cursor)
        const arrResult = resolvePropertyChain(context, arrTokens)
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
          const arrResult = resolvePropertyChain(context, arrTokens)
          if (arrResult.found && Array.isArray(arrResult.value)) {
            const elemInfo = inferElementType(arrResult.value)
            env.lambda = {
              elementProperties: elemInfo.properties,
              elementValue: elemInfo.type === 'object' ? elemInfo.value : undefined,
            }
            resolved = true
          }
        }

        // Second try: for nested lambdas, try eval-based inference
        // e.g., groups.map(.users.filter(. → evaluate groups[0].users to get the array
        if (!resolved) {
          const nestedArr = tryResolveNestedLambdaArray(tokens, cursor, context)
          if (nestedArr) {
            const elemInfo = inferElementType(nestedArr)
            env.lambda = {
              elementProperties: elemInfo.properties,
              elementValue: elemInfo.type === 'object' ? elemInfo.value : undefined,
            }
          }
        }
      } else if (cursorCtx.kind === 'identifier') {
        env.identifier = { contextKeys: Object.keys(context), contextValues: context }
      }

      return generateCompletions(cursorCtx, env)
    },

    setContext(newContext: Record<string, unknown>): void {
      context = newContext ?? {}
    },
  }
}

// ── Evaluation-based type inference ────────────────────────────

/**
 * Try to evaluate the expression up to the cursor to get the actual runtime type.
 * This handles method chains like `user.name.trim().` where static resolution can't
 * know that trim() returns a string.
 */
function tryEvalPrefix(
  expression: string,
  cursor: number,
  instance: BonsaiInstance,
  context: Record<string, unknown>,
  tokens: Token[],
  onError?: ErrorHandler,
): unknown | undefined {
  // Find the expression prefix before the final dot
  const before = tokens.filter(t => t.end <= cursor)
  if (before.length === 0) return undefined

  // Walk backward to find where the expression starts (skip the trailing dot)
  let endIdx = before.length - 1
  if (before[endIdx].type === 'Punctuation' && before[endIdx].value === '.' || before[endIdx].type === 'OptionalChain') {
    endIdx--
  }
  if (endIdx < 0) return undefined

  // Extract the expression text up to (but not including) the final dot
  const exprEnd = before[endIdx].end
  const exprText = expression.slice(0, exprEnd)
  if (!exprText.trim()) return undefined

  try {
    return instance.evaluateSync(exprText, context)
  } catch (err: unknown) {
    if (!(err instanceof ExpressionError)) {
      onError?.(err, 'tryEvalPrefix')
    }
    return undefined
  }
}

/**
 * Infer the type by walking the token chain and using the RETURN_TYPES map.
 * Handles: user.name.trim(). → string (because trim returns string)
 */
function inferTypeFromTokenChain(
  tokens: Token[],
  context: Record<string, unknown>,
  resolveOpts?: ResolveOptions,
): string | undefined {
  // Walk the chain: resolve context properties, then use return type map for method calls
  let currentType: string | undefined

  // First resolve as much as we can from context
  const chain: string[] = []
  let i = 0
  for (; i < tokens.length; i++) {
    if (tokens[i].type === 'Identifier') {
      chain.push(tokens[i].value)
    } else if ((tokens[i].type === 'Punctuation' && tokens[i].value === '.') || tokens[i].type === 'OptionalChain') {
      continue
    } else if (tokens[i].type === 'Punctuation' && tokens[i].value === '(') {
      // Method call — use the last identifier as method name
      const methodName = chain.pop()
      if (!methodName) break

      // Resolve what we have so far to get the receiver type
      if (currentType === undefined && chain.length > 0) {
        const result = resolvePropertyChain(context, chain, resolveOpts)
        currentType = result.found ? inferType(result.value) : undefined
        chain.length = 0
      }

      if (currentType && methodName) {
        currentType = inferMethodReturnType(currentType, methodName)
        if (currentType === 'unknown') currentType = undefined
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

  // Resolve remaining chain from context if we haven't resolved type yet
  if (currentType === undefined && chain.length > 0) {
    const result = resolvePropertyChain(context, chain, resolveOpts)
    currentType = result.found ? inferType(result.value) : undefined
  }

  return currentType
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
): unknown[] | undefined {
  const before = tokens.filter(t => t.start < cursor)

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
      if (prev && (prev.type === 'Punctuation' && (prev.value === '(' || prev.value === ','))) {
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

  // Find the outermost array from context
  // Walk backward from the outermost ( to find the context chain
  let outerParenIdx = -1
  for (let i = 0; i < before.length; i++) {
    if (before[i].type === 'Punctuation' && before[i].value === '(') {
      outerParenIdx = i
      break
    }
  }

  if (outerParenIdx <= 0) return undefined

  // Extract the context array chain before the outermost call.
  const chain = extractChainBeforeOuterCall(before, outerParenIdx)
  if (chain.length === 0) return undefined

  // Resolve the outermost array from context
  const outerResult = resolvePropertyChain(context, chain)
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
    const nestedResult = resolvePropertyChain(elemInfo.value, lambdaChain)
    if (!nestedResult.found || !Array.isArray(nestedResult.value)) return undefined
    currentValue = nestedResult.value
  }

  return Array.isArray(currentValue) ? currentValue as unknown[] : undefined
}

// ── Transform probing ──────────────────────────────────────────

const PROBE_CACHE_MAX = 32

const TYPE_SAMPLES: Partial<Record<InferredTypeName, unknown>> = {
  string: 'sample',
  number: 42,
  boolean: true,
  array: [0],
  object: {},
}

function probeAcceptedTransforms(
  instance: BonsaiInstance,
  inputType: string,
  cache: Map<string, Set<string>>,
  currentTransforms: string[],
  onError?: ErrorHandler,
): Set<string> {
  // Key includes the current transform set to auto-invalidate when transforms change
  const cacheKey = `${inputType}:${[...currentTransforms].sort().join(',')}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const sample = TYPE_SAMPLES[inputType as InferredTypeName]
  if (sample === undefined) return new Set(currentTransforms)

  const accepted = new Set<string>()
  for (const name of currentTransforms) {
    // Validate transform name is a safe identifier before interpolating
    if (!VALID_IDENTIFIER.test(name)) continue
    try {
      instance.evaluateSync(`x |> ${name}`, { x: sample })
      accepted.add(name)
    } catch (err: unknown) {
      if (!(err instanceof ExpressionError)) {
        onError?.(err, `probeTransform:${name}`)
      }
    }
  }

  // Evict oldest entry if cache exceeds max size
  if (cache.size >= PROBE_CACHE_MAX) {
    const first = cache.keys().next()
    if (!first.done) cache.delete(first.value)
  }
  cache.set(cacheKey, accepted)
  return accepted
}

function inferPipeInputType(
  expression: string,
  cursor: number,
  instance: BonsaiInstance,
  context: Record<string, unknown>,
  onError?: ErrorHandler,
): string | undefined {
  const before = expression.slice(0, cursor)
  const pipeMatch = before.match(/^(.*)\|>\s*\w*\s*$/s)
  if (!pipeMatch) return undefined

  const exprBefore = pipeMatch[1].trim()
  if (!exprBefore) return undefined

  try {
    const result = instance.evaluateSync(exprBefore, context)
    if (result === null || result === undefined) return undefined
    return inferType(result)
  } catch (err: unknown) {
    if (!(err instanceof ExpressionError)) {
      onError?.(err, 'inferPipeInputType')
    }
    return undefined
  }
}

// ── Token chain extraction ─────────────────────────────────────

/** Extract trailing identifier.dot chain from a token array (walking backward). */
function extractChainFromTokens(tokens: Token[]): string[] {
  const chain: string[] = []
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.type === 'Identifier') {
      chain.unshift(t.value)
    } else if ((t.type === 'Punctuation' && t.value === '.') || t.type === 'OptionalChain') {
      continue
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
    if ((sep.type === 'Punctuation' && sep.value === '.') || sep.type === 'OptionalChain' || sep.type === 'Pipe') {
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
    } else if ((before[i].type === 'Punctuation' && before[i].value === '.') || before[i].type === 'OptionalChain') {
      continue
    } else {
      break
    }
  }

  return chain
}

function extractChainBeforeCall(tokens: Token[], cursor: number): string[] {
  const before = tokens.filter(t => t.start < cursor)
  let parenIdx = -1
  let depth = 0
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].type === 'Punctuation' && before[i].value === ')') depth++
    if (before[i].type === 'Punctuation' && before[i].value === '(') {
      if (depth === 0) { parenIdx = i; break }
      depth--
    }
  }

  if (parenIdx <= 0) return []

  const methodToken = before[parenIdx - 1]
  if (!methodToken || methodToken.type !== 'Identifier') return []

  const preMethodIdx = parenIdx - 2
  if (preMethodIdx < 0) return []
  const preMethodToken = before[preMethodIdx]

  if ((preMethodToken.type === 'Punctuation' && preMethodToken.value === '.') ||
      preMethodToken.type === 'OptionalChain' ||
      preMethodToken.type === 'Pipe') {
    return extractChainFromTokens(before.slice(0, preMethodIdx))
  }

  return []
}
