import type { Token } from '../types.js'

interface CursorContextBase {
  prefix: string
}

export type CursorContext =
  | CursorContextBase & { kind: 'top-level-member'; precedingTokens: Token[] }
  | CursorContextBase & { kind: 'lambda-start'; depth: number }
  | CursorContextBase & { kind: 'lambda-member'; chain: string[]; depth: number }
  | CursorContextBase & { kind: 'pipe-transform' }
  | CursorContextBase & { kind: 'identifier' }
  | { kind: 'none' }

/** Extract prefix from any non-none CursorContext. */
export function getPrefix(ctx: CursorContext): string {
  return ctx.kind !== 'none' ? ctx.prefix : ''
}

const OPERATOR_TYPES = new Set(['Operator', 'NullishCoalescing'])

function tokenKey(t: Token): string {
  return t.type === 'Punctuation' ? `${t.type}:${t.value}` : t.type
}

const LAMBDA_TRIGGERS = new Set([
  'Punctuation:(', 'Punctuation:,',
  'Punctuation:?', 'Punctuation::',
])

const VALUE_PRODUCERS = new Set([
  'Identifier', 'Number', 'String', 'Boolean',
  'Punctuation:)', 'Punctuation:]',
])

export function classifyCursor(tokens: Token[], cursor: number): CursorContext {
  const before = tokens.filter(t => t.start < cursor)
  if (before.length === 0) return { kind: 'identifier', prefix: '' }

  const last = before[before.length - 1]
  const secondLast = before.length >= 2 ? before[before.length - 2] : null

  // Is last token a partial identifier at cursor?
  const lastIsPartial = last.type === 'Identifier' && last.end >= cursor

  // Pipe context
  if (last.type === 'Pipe') return { kind: 'pipe-transform', prefix: '' }
  if (lastIsPartial && secondLast?.type === 'Pipe') {
    return { kind: 'pipe-transform', prefix: last.value }
  }

  // Build lambda scope state
  const state = buildLambdaState(before)

  // Check for dot
  const dotToken = lastIsPartial ? secondLast : last
  const prefix = lastIsPartial ? last.value : ''

  if (dotToken && isDot(dotToken)) {
    const beforeDotIdx = before.indexOf(dotToken)
    const prevToken = beforeDotIdx > 0 ? before[beforeDotIdx - 1] : null

    if (state.depth > 0) {
      // Inside a call scope
      const prevKey = prevToken ? tokenKey(prevToken) : ''
      if (!prevToken || LAMBDA_TRIGGERS.has(prevKey) || OPERATOR_TYPES.has(prevToken.type)) {
        return { kind: 'lambda-start', prefix, depth: state.depth }
      }
      if (state.lambdaActive[state.depth] && prevToken && VALUE_PRODUCERS.has(tokenKey(prevToken))) {
        return { kind: 'lambda-member', prefix, chain: [...state.currentChain], depth: state.depth }
      }
    }

    // Top-level member access
    return { kind: 'top-level-member', prefix, precedingTokens: before.slice(0, before.indexOf(dotToken)) }
  }

  // Identifier context
  if (OPERATOR_TYPES.has(last.type) ||
      (last.type === 'Punctuation' && '(,'.includes(last.value))) {
    return { kind: 'identifier', prefix: '' }
  }

  if (lastIsPartial) {
    if (!secondLast || OPERATOR_TYPES.has(secondLast.type) ||
        (secondLast.type === 'Punctuation' && '(,'.includes(secondLast.value))) {
      // Check if inside lambda scope — if so and secondLast is lambda trigger, it's lambda start
      if (state.depth > 0 && secondLast && (LAMBDA_TRIGGERS.has(tokenKey(secondLast)) || OPERATOR_TYPES.has(secondLast.type))) {
        return { kind: 'lambda-start', prefix: last.value, depth: state.depth }
      }
      return { kind: 'identifier', prefix: last.value }
    }
  }

  return { kind: 'none' }
}

function isDot(t: Token): boolean {
  return (t.type === 'Punctuation' && t.value === '.') || t.type === 'OptionalChain'
}

interface LambdaState {
  depth: number
  lambdaActive: Record<number, boolean>
  currentChain: string[]
}

function buildLambdaState(tokens: Token[]): LambdaState {
  let depth = 0
  const lambdaActive: Record<number, boolean> = {}
  const currentChain: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]

    if (t.type === 'Punctuation' && t.value === '(') {
      depth++
      lambdaActive[depth] = false
    } else if (t.type === 'Punctuation' && t.value === ')') {
      delete lambdaActive[depth]
      depth = Math.max(0, depth - 1)
    } else if (depth > 0 && isDot(t)) {
      const prev = i > 0 ? tokens[i - 1] : null
      const prevKey = prev ? tokenKey(prev) : ''
      if (!prev || LAMBDA_TRIGGERS.has(prevKey) || OPERATOR_TYPES.has(prev?.type ?? '')) {
        lambdaActive[depth] = true
        currentChain.length = 0
      } else if (lambdaActive[depth] && prev && VALUE_PRODUCERS.has(tokenKey(prev))) {
        // Only push identifiers onto the chain — not ) or ] which are value-producers
        // but not property names (e.g., .name.trim(). — the ) should not be in the chain)
        if (prev.type === 'Identifier') {
          currentChain.push(prev.value)
        }
      }
    }
  }

  return { depth, lambdaActive, currentChain }
}
