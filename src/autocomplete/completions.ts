import { METHODS_BY_TYPE, BLOCKED_NAMES, KEYWORDS, getMethodReturnType } from './catalog.js'
import { getPrefix, type CursorContext } from './context.js'
import { inferType } from './inference.js'

// ── Completion type ────────────────────────────────────────────

type CompletionInsert =
  | { insertText?: undefined; cursorOffset?: undefined }
  | { insertText: string; cursorOffset?: number }

interface CompletionBase {
  label: string
  kind: 'variable' | 'property' | 'method' | 'transform' | 'function' | 'keyword'
  detail?: string
  /** Lower values sort first. Can become negative after fuzzy-match boosting. */
  sortPriority: number
}

export type Completion = CompletionBase & CompletionInsert

// ── CompletionEnv ──────────────────────────────────────────────

/** Info for member-access contexts (top-level-member, lambda-member). */
export interface MemberInfo {
  resolvedValue?: unknown
  resolvedType?: string
}

/** Info for lambda-start context. */
export interface LambdaInfo {
  elementProperties?: string[]
  elementValue?: Record<string, unknown>
}

/** Info for identifier context. */
export interface IdentifierInfo {
  contextKeys: string[]
  contextValues: Record<string, unknown>
}

/** Info for pipe-transform context. */
export interface PipeInfo {
  inputType?: string
  transformTypes?: Record<string, string[]>
}

export interface CompletionEnv {
  transforms: string[]
  functions: string[]
  policy: { allowedProperties?: ReadonlySet<string>; deniedProperties?: ReadonlySet<string> }
  member?: MemberInfo
  lambda?: LambdaInfo
  identifier?: IdentifierInfo
  pipe?: PipeInfo
}

// Higher-order methods that take a lambda predicate
const LAMBDA_METHODS = new Set(['filter', 'map', 'find', 'findIndex', 'some', 'every', 'flatMap'])
const PREVIEW_MAX_LENGTH = 20

export function generateCompletions(ctx: CursorContext, env: CompletionEnv): Completion[] {
  const results: Completion[] = []

  switch (ctx.kind) {
    case 'top-level-member':
    case 'lambda-member':
      addPropertyCompletions(results, env)
      addMethodCompletions(results, env)
      break
    case 'lambda-start':
      addLambdaPropertyCompletions(results, env)
      break
    case 'pipe-transform':
      for (const name of env.transforms) {
        if (env.pipe?.inputType && env.pipe.transformTypes) {
          const accepts = env.pipe.transformTypes[name]
          if (Array.isArray(accepts) && !accepts.includes(env.pipe.inputType)) continue
        }
        results.push({ label: name, kind: 'transform', sortPriority: 0 })
      }
      break
    case 'identifier':
      addIdentifierCompletions(results, env)
      break
    case 'none':
      break
  }

  return filterAndRank(results, getPrefix(ctx))
}

function addPropertyCompletions(results: Completion[], env: CompletionEnv): void {
  const value = env.member?.resolvedValue
  if (value == null || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  for (const key of keys) {
    if (isBlocked(key, env.policy)) continue
    const propValue = obj[key]
    const valueType = inferType(propValue)
    results.push({
      label: key,
      kind: 'property',
      detail: valueType,
      sortPriority: 0,
    })
  }
}

function addMethodCompletions(results: Completion[], env: CompletionEnv): void {
  const type = env.member?.resolvedType
  if (!type) return
  const methods = METHODS_BY_TYPE[type as keyof typeof METHODS_BY_TYPE]
  if (!methods) return
  for (const method of methods) {
    // Check BLOCKED_NAMES and deniedProperties, but NOT allowedProperties.
    // allowedProperties is a property-access allowlist — methods are allowlisted
    // by METHODS_BY_TYPE (mirrors isAllowedReceiver). deniedProperties explicitly
    // blocks names, which applies to methods too for evaluator consistency.
    if (BLOCKED_NAMES.has(method)) continue
    if (env.policy.deniedProperties && env.policy.deniedProperties.has(method)) continue
    const returnType = getMethodReturnType(type, method)
    const detail = returnType ? `${type} → ${returnType}` : type
    const isLambda = LAMBDA_METHODS.has(method)
    const insert = isLambda ? `${method}(.)` : `${method}()`
    results.push({
      label: method,
      kind: 'method',
      detail,
      insertText: insert,
      cursorOffset: isLambda ? insert.length - 2 : insert.length - 1,
      sortPriority: 1,
    })
  }
}

function addLambdaPropertyCompletions(results: Completion[], env: CompletionEnv): void {
  if (!env.lambda?.elementProperties) return
  for (const prop of env.lambda.elementProperties) {
    if (isBlocked(prop, env.policy)) continue
    const valueType = env.lambda.elementValue ? inferType(env.lambda.elementValue[prop]) : undefined
    results.push({
      label: prop,
      kind: 'property',
      detail: valueType,
      sortPriority: 0,
    })
  }
}

function addIdentifierCompletions(results: Completion[], env: CompletionEnv): void {
  // Note: allowedProperties/deniedProperties are NOT checked for context variable names.
  // This matches the evaluator's behavior — ExecutionContext.checkNameAccess skips
  // allow/deny checks for kind === 'identifier'. Root identifiers are never blocked.
  if (env.identifier) {
    for (const key of env.identifier.contextKeys) {
      const value = env.identifier.contextValues[key]
      const valueType = inferType(value)
      let detail: string = valueType
      // Show a brief preview for simple values
      if (valueType === 'string' && typeof value === 'string') {
        detail = value.length > PREVIEW_MAX_LENGTH
          ? `"${value.slice(0, PREVIEW_MAX_LENGTH)}…"`
          : `"${value}"`
      } else if (valueType === 'number') {
        detail = String(value)
      } else if (valueType === 'boolean') {
        detail = String(value)
      } else if (valueType === 'array' && Array.isArray(value)) {
        detail = `array(${value.length})`
      }
      results.push({ label: key, kind: 'variable', detail, sortPriority: 0 })
    }
  }
  for (const name of env.functions) {
    const insert = `${name}()`
    results.push({ label: name, kind: 'function', insertText: insert, cursorOffset: insert.length - 1, sortPriority: 1 })
  }
  for (const kw of KEYWORDS) {
    results.push({ label: kw, kind: 'keyword', sortPriority: 2 })
  }
}

function isBlocked(name: string, policy: CompletionEnv['policy']): boolean {
  if (BLOCKED_NAMES.has(name)) return true
  if (policy.allowedProperties && !policy.allowedProperties.has(name)) return true
  if (policy.deniedProperties && policy.deniedProperties.has(name)) return true
  return false
}

const EXACT_MATCH_BOOST = 20
const PREFIX_MATCH_BOOST = 15
const FUZZY_MATCH_BOOST = 5

// Fuzzy scoring constants
const SCORE_EXACT = 1000
const SCORE_PREFIX_BASE = 500
const SCORE_PREFIX_PER_CHAR = 10
const SCORE_CONTAINS_BASE = 200
const SCORE_CONTAINS_PER_CHAR = 5
const SCORE_CHAR_MATCH = 10
const SCORE_CONSECUTIVE_BONUS = 15
const SCORE_BOUNDARY_BONUS = 10

/**
 * Fuzzy match score. Returns 0 for no match, higher = better match.
 * Rewards: consecutive matches, matches at word boundaries (camelCase), matches at start.
 */
function fuzzyScore(label: string, query: string): number {
  const labelLower = label.toLowerCase()
  const queryLower = query.toLowerCase()

  if (label === query) return SCORE_EXACT
  if (labelLower.startsWith(queryLower)) return SCORE_PREFIX_BASE + (query.length * SCORE_PREFIX_PER_CHAR)
  if (labelLower.includes(queryLower)) return SCORE_CONTAINS_BASE + (query.length * SCORE_CONTAINS_PER_CHAR)

  // Fuzzy: every character in query must appear in label in order
  let qi = 0
  let score = 0
  let prevMatchIdx = -2
  for (let li = 0; li < label.length && qi < queryLower.length; li++) {
    if (labelLower[li] === queryLower[qi]) {
      qi++
      score += SCORE_CHAR_MATCH
      if (li === prevMatchIdx + 1) score += SCORE_CONSECUTIVE_BONUS
      if (li === 0 || label[li] === label[li].toUpperCase() && label[li] !== label[li].toLowerCase()) score += SCORE_BOUNDARY_BONUS
      prevMatchIdx = li
    }
  }

  if (qi < queryLower.length) return 0
  return score
}

function filterAndRank(results: Completion[], prefix: string): Completion[] {
  if (!prefix) return results.sort(comparator)

  const scored: Array<{ completion: Completion; score: number }> = []

  for (const c of results) {
    const score = fuzzyScore(c.label, prefix)
    if (score === 0) continue

    let boost = 0
    if (score >= SCORE_EXACT) boost = EXACT_MATCH_BOOST
    else if (score >= SCORE_PREFIX_BASE) boost = PREFIX_MATCH_BOOST
    else if (score >= SCORE_CONTAINS_BASE) boost = FUZZY_MATCH_BOOST

    scored.push({
      completion: { ...c, sortPriority: c.sortPriority - boost },
      score,
    })
  }

  // Sort by fuzzy score descending, then by base priority, then by label length, then alphabetically
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.completion.sortPriority !== b.completion.sortPriority) return a.completion.sortPriority - b.completion.sortPriority
    if (a.completion.label.length !== b.completion.label.length) return a.completion.label.length - b.completion.label.length
    if (a.completion.label < b.completion.label) return -1
    if (a.completion.label > b.completion.label) return 1
    return 0
  })

  return scored.map(s => s.completion)
}

function comparator(a: Completion, b: Completion): number {
  if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority
  if (a.label.length !== b.label.length) return a.label.length - b.label.length
  if (a.label < b.label) return -1
  if (a.label > b.label) return 1
  return 0
}
