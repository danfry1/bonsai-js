import { tokenize } from '../lexer.js'
import { ExpressionError } from '../errors.js'
import type { Token, PunctuationValue, OperatorValue } from '../types.js'

/** Token type that excludes EOF — all tokens returned by tolerantTokenize. */
export type NonEofToken = Exclude<Token, { type: 'EOF' }>

export interface TolerantTokenResult {
  tokens: NonEofToken[]
  partial: boolean
  insideString: boolean
}

/** Known phases where errors can occur during completion. */
export type CompletionPhase =
  | 'tokenize'
  | 'tryEvalPrefix'
  | 'inferPipeInputType'
  | `probeTransform:${string}`
  | 'complete'

export type ErrorHandler = (error: unknown, phase: CompletionPhase) => void

export function tolerantTokenize(
  expression: string,
  cursor: number,
  onError?: ErrorHandler,
): TolerantTokenResult {
  if (expression.length === 0) {
    return { tokens: [], partial: false, insideString: false }
  }

  const insideString = isCursorInsideString(expression, cursor)

  try {
    const tokens = tokenize(expression).filter((t): t is NonEofToken => t.type !== 'EOF')
    return { tokens, partial: false, insideString }
  } catch (err: unknown) {
    if (!(err instanceof ExpressionError || err instanceof SyntaxError)) {
      onError?.(err, 'tokenize')
    }
    const tokens = regexScan(expression, cursor)
    return { tokens, partial: true, insideString }
  }
}

export function isCursorInsideString(expression: string, cursor: number): boolean {
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let templateDepth = 0
  const braceStack: number[] = [] // per-depth brace counter for nested interpolations
  let escaped = false

  for (let i = 0; i < expression.length && i < cursor; i++) {
    const ch = expression[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
      escaped = true
      continue
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === "'") inSingle = true
      else if (ch === '"') inDouble = true
      else if (ch === '`') { inTemplate = true; templateDepth = 0; braceStack.length = 0 }
    } else if (inSingle && ch === "'") {
      inSingle = false
    } else if (inDouble && ch === '"') {
      inDouble = false
    } else if (inTemplate) {
      if (ch === '`' && templateDepth === 0) {
        inTemplate = false
      } else if (ch === '$' && i + 1 < expression.length && expression[i + 1] === '{') {
        templateDepth++
        braceStack.push(0)
        i++
      } else if (templateDepth > 0 && ch === '{') {
        braceStack[braceStack.length - 1]++
      } else if (templateDepth > 0 && ch === '}') {
        if (braceStack.length > 0 && braceStack[braceStack.length - 1] > 0) {
          braceStack[braceStack.length - 1]--
        } else {
          braceStack.pop()
          templateDepth--
        }
      }
    }
  }

  return inSingle || inDouble || (inTemplate && templateDepth === 0)
}

const TOKEN_RE = /\?\.|\.\.\.|\|>|\?\?|&&|\|\||[!=<>]=?|[+\-*/%]|\*\*|[.(){}[\],?:]|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\$]|\\.|\$(?!\{))*`?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|[a-zA-Z_$][\w$]*/g

function regexScan(expression: string, cursor: number): NonEofToken[] {
  const tokens: NonEofToken[] = []
  const text = expression.slice(0, cursor)

  for (const match of text.matchAll(TOKEN_RE)) {
    const value = match[0]
    const start = match.index
    const end = start + value.length
    const token = classifyToken(value, start, end)
    if (token) tokens.push(token)
  }

  return tokens
}

function classifyToken(value: string, start: number, end: number): NonEofToken | null {
  if (value === '|>') return { type: 'Pipe', value, start, end }
  if (value === '?.') return { type: 'OptionalChain', value, start, end }
  if (value === '??') return { type: 'NullishCoalescing', value, start, end }
  if (value === '...') return { type: 'Spread', value, start, end }
  if (value === 'true' || value === 'false') return { type: 'Boolean', value, start, end }
  if (value === 'null') return { type: 'Null', value, start, end }
  if (value === 'undefined') return { type: 'Undefined', value, start, end }
  if (/^[a-zA-Z_$]/.test(value)) return { type: 'Identifier', value, start, end }
  if (/^\d/.test(value)) return { type: 'Number', value, start, end }
  if (value.startsWith('"') || value.startsWith("'")) return { type: 'String', value, start, end }
  if (value.startsWith('`')) return { type: 'TemplateLiteral', value, start, end }
  if (value.length === 1 && '(){}[],:?.'.includes(value)) return { type: 'Punctuation', value: value as PunctuationValue, start, end }
  if ('+-*/%!=<>&|'.includes(value[0]) || value === '**') return { type: 'Operator', value: value as OperatorValue, start, end }
  return null
}
