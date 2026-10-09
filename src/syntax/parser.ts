import { BonsaiLimitError, BonsaiSyntaxError } from '../errors.js'
import {
  forEachChild,
  type BinaryOperator,
  type CallNode,
  type CallStyle,
  type HasNode,
  type LambdaNode,
  type MapEntry,
  type Node,
  type SpreadNode,
} from './ast.js'
import { BLOCKED_NAMES, tokenize, type Token } from './lexer.js'

export interface ParseLimits {
  /** Maximum source length in UTF-16 code units. */
  readonly maxSourceLength: number
  /** Maximum syntactic nesting depth. */
  readonly maxDepth: number
  /** Maximum number of syntax nodes (tokens are bounded at 4x this). */
  readonly maxNodes: number
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = Object.freeze({
  maxSourceLength: 100_000,
  maxDepth: 128,
  maxNodes: 20_000,
})

// Binding power of binary operators; higher binds tighter.
const BINARY_LEVEL: Readonly<Record<string, number>> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  in: 5,
  'not in': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
  '**': 8,
}
const EQUALITY_LEVEL = BINARY_LEVEL['==']
const RELATIONAL_LEVEL = BINARY_LEVEL['<']
/** Operators that bind tighter than "??" but read as if they did not; they need parentheses beside it. */
const NULLISH_MIXED = Object.keys(BINARY_LEVEL).filter(
  (op) => op !== '??' && op !== '&&' && op !== '||',
)

/** Parses an expression into a syntax tree. Throws BonsaiSyntaxError or BonsaiLimitError. */
export function parse(source: string, limits: ParseLimits = DEFAULT_PARSE_LIMITS): Node {
  let tokens = tokenize(source, {
    maxSourceLength: limits.maxSourceLength,
    maxTokens: limits.maxNodes * 4,
  })
  let tokenBudget = limits.maxNodes * 4 - tokens.length
  let pos = 0
  let depth = 0
  let nodeCount = 0
  const parenthesized = new WeakSet<Node>()
  const scopes: string[][] = []

  const peek = (offset = 0): Token => tokens[Math.min(pos + offset, tokens.length - 1)]
  const next = (): Token => tokens[pos++]
  const isPunct = (value: string, offset = 0): boolean => {
    const token = peek(offset)
    return token.kind === 'punct' && token.value === value
  }
  const isKeyword = (value: string, offset = 0): boolean => {
    const token = peek(offset)
    return token.kind === 'keyword' && token.value === value
  }
  const fail = (message: string, start: number, end: number): never => {
    // Spans always lie within the source.
    const to = Math.min(end, source.length)
    throw new BonsaiSyntaxError(message, { source, span: { start: Math.min(start, to), end: to } })
  }
  /** Where to point for `token`: the end of input points at the last token before it. */
  const spanOf = (token: Token): readonly [number, number] => {
    if (token.kind === 'eof') {
      const last = tokens[tokens.length - 2]
      return last === undefined ? [token.start, token.end] : [last.start, last.end]
    }
    return [token.start, Math.max(token.end, token.start + 1)]
  }
  const failAt = (message: string, token: Token): never => fail(message, ...spanOf(token))
  const unexpected = (token: Token = peek()): never =>
    failAt(
      token.kind === 'eof'
        ? 'Unexpected end of expression'
        : `Unexpected ${describe(token)}${hintFor(token, tokens[tokens.indexOf(token) - 1])}`,
      token,
    )
  const expectPunct = (value: string): Token => {
    if (!isPunct(value)) {
      const token = peek()
      failAt(
        token.kind === 'eof'
          ? `Expected "${value}" but the expression ended`
          : `Expected "${value}" but found ${describe(token)}`,
        token,
      )
    }
    return next()
  }

  // Tree depth of every node built so far. Everything downstream (checker,
  // compiler, evaluation) recurses over the tree, so its depth is what must be
  // bounded, not just the parser's own recursion.
  const depths = new WeakMap<object, number>()

  function node<T extends Node | SpreadNode | MapEntry>(value: T): T {
    if (++nodeCount > limits.maxNodes) {
      throw new BonsaiLimitError(
        'TOO_MANY_NODES',
        `Expression has more than ${limits.maxNodes} nodes`,
        {
          source,
          span: { start: value.start, end: value.end },
        },
      )
    }
    let nodeDepth = 0
    const measure = (child: object): void => {
      nodeDepth = Math.max(nodeDepth, depths.get(child) ?? 1)
    }
    if (value.type === 'Spread') measure(value.argument)
    else if (value.type === 'Entry') {
      measure(value.value)
      if (typeof value.key !== 'string') measure(value.key)
    } else {
      forEachChild(value, measure)
      if (value.type === 'List') for (const item of value.items) measure(item)
      if (value.type === 'Map') for (const entry of value.entries) measure(entry)
      if (value.type === 'Call') for (const arg of value.args) measure(arg)
    }
    nodeDepth += 1
    if (nodeDepth > limits.maxDepth) {
      throw new BonsaiLimitError('TOO_DEEP', `Expression nests deeper than ${limits.maxDepth}`, {
        source,
        span: { start: value.start, end: value.end },
      })
    }
    depths.set(value, nodeDepth)
    return value
  }

  /** Builds a balanced tree for a run of one associative logical operator. */
  function balance(operator: '&&' | '||' | '??', operands: readonly Node[]): Node {
    if (operands.length === 1) return operands[0]
    const middle = Math.ceil(operands.length / 2)
    const left = balance(operator, operands.slice(0, middle))
    const right = balance(operator, operands.slice(middle))
    return node({ type: 'Binary', operator, left, right, start: left.start, end: right.end })
  }

  function enter(token: Token): void {
    if (++depth > limits.maxDepth) {
      throw new BonsaiLimitError('TOO_DEEP', `Expression nests deeper than ${limits.maxDepth}`, {
        source,
        span: { start: token.start, end: Math.max(token.end, token.start + 1) },
      })
    }
  }

  function isLocal(name: string): boolean {
    for (const scope of scopes) if (scope.includes(name)) return true
    return false
  }

  function bindLocal(name: string, token: Token): void {
    if (isLocal(name)) fail(`"${name}" is already bound in this scope`, token.start, token.end)
    if (BLOCKED_NAMES.has(name)) fail(`"${name}" cannot be used as a name`, token.start, token.end)
  }

  // expression := let | conditional
  function parseExpression(): Node {
    enter(peek())
    try {
      if (isKeyword('let')) return parseLet()
      return parseConditional()
    } finally {
      depth--
    }
  }

  function parseLet(): Node {
    const letToken = next()
    const nameToken = next()
    if (nameToken.kind !== 'name') failAt('Expected a name after "let"', nameToken)
    bindLocal(nameToken.value, nameToken)
    expectPunct('=')
    const value = parseExpression()
    expectPunct(';')
    scopes.push([nameToken.value])
    try {
      const body = parseExpression()
      return node({
        type: 'Let',
        name: nameToken.value,
        value,
        body,
        start: letToken.start,
        end: body.end,
      })
    } finally {
      scopes.pop()
    }
  }

  function parseConditional(): Node {
    const test = parseBinary(1)
    if (!isPunct('?')) return test
    next()
    const then = parseExpression()
    expectPunct(':')
    const otherwise = parseExpression()
    return node({
      type: 'Conditional',
      test,
      then,
      otherwise,
      start: test.start,
      end: otherwise.end,
    })
  }

  function binaryOperatorAt(token: Token): BinaryOperator | undefined {
    if (token.kind === 'keyword') {
      if (token.value === 'in') return 'in'
      if (token.value === 'not') return 'not in'
      return undefined
    }
    if (token.kind !== 'punct') return undefined
    return token.value in BINARY_LEVEL ? (token.value as BinaryOperator) : undefined
  }

  function isBare(candidate: Node, operators: readonly string[]): boolean {
    return (
      candidate.type === 'Binary' &&
      operators.includes(candidate.operator) &&
      !parenthesized.has(candidate)
    )
  }

  function parseBinary(minLevel: number): Node {
    let left = parseUnary()
    // A run of the same logical operator (a && b && c ...) is collected and
    // balanced: same result and left-to-right short-circuit order, but log depth.
    let chain: Node[] | undefined
    let chainOperator: '&&' | '||' | '??' | undefined
    const flush = (): void => {
      if (chain !== undefined && chainOperator !== undefined) left = balance(chainOperator, chain)
      chain = undefined
      chainOperator = undefined
    }
    for (;;) {
      const token = peek()
      const operator = binaryOperatorAt(token)
      if (operator === undefined) break
      const level = BINARY_LEVEL[operator]
      if (level < minLevel) break
      if (operator !== chainOperator) flush()
      next()
      if (operator === 'not in') {
        if (!isKeyword('in'))
          fail('Expected "in" after "not" (use ! for negation)', token.start, token.end)
        next()
      }
      if (operator === '**' && left.type === 'Unary' && !parenthesized.has(left)) {
        fail(
          'Parenthesize the left side of "**": write (-x) ** y or -(x ** y)',
          left.start,
          token.end,
        )
      }
      const right = parseBinary(operator === '**' ? level : level + 1)
      if (
        (operator === '??' && (isBare(left, ['&&', '||']) || isBare(right, ['&&', '||']))) ||
        ((operator === '&&' || operator === '||') &&
          (isBare(left, ['??']) || isBare(right, ['??'])))
      ) {
        fail('Parenthesize "??" when mixing it with "&&" or "||"', left.start, right.end)
      }
      // `score ?? 0 > 10` means score ?? (0 > 10), which reads as (score ?? 0) > 10.
      if (operator === '??') {
        const mixed = [left, right].find((side) => isBare(side, NULLISH_MIXED))
        if (mixed !== undefined) {
          const op = (mixed as { operator: string }).operator
          fail(
            `Parenthesize "${op}" next to "??": write (a ?? b) ${op} c or a ?? (b ${op} c)`,
            left.start,
            right.end,
          )
        }
      }
      if (operator === '&&' || operator === '||' || operator === '??') {
        if (chain === undefined) {
          chain = [left]
          chainOperator = operator
        }
        chain.push(right)
        continue
      }
      if (level === EQUALITY_LEVEL || level === RELATIONAL_LEVEL) {
        const sameLevel =
          level === EQUALITY_LEVEL ? ['==', '!='] : ['<', '<=', '>', '>=', 'in', 'not in']
        if (isBare(left, sameLevel)) {
          fail(
            `Comparisons do not chain; write (a ${(left as { operator: string }).operator} b) && (b ${operator} c) or add parentheses`,
            left.start,
            right.end,
          )
        }
      }
      left = node({ type: 'Binary', operator, left, right, start: left.start, end: right.end })
    }
    flush()
    return left
  }

  function parseUnary(): Node {
    const token = peek()
    if (token.kind === 'punct' && (token.value === '!' || token.value === '-')) {
      enter(token)
      try {
        next()
        const operand = parseUnary()
        return node({
          type: 'Unary',
          operator: token.value,
          operand,
          start: token.start,
          end: operand.end,
        })
      } finally {
        depth--
      }
    }
    return parsePostfix(parsePrimary())
  }

  function parsePostfix(start: Node): Node {
    let current = start
    for (;;) {
      const token = peek()
      if (token.kind !== 'punct') break
      if (token.value === '.' || token.value === '?.') {
        const optional = token.value === '?.'
        next()
        if (optional && isPunct('[')) {
          current = parseIndex(current, true)
          continue
        }
        const nameToken = next()
        if (nameToken.kind !== 'name' && nameToken.kind !== 'keyword') {
          failAt(`Expected a property or method name after "${token.value}"`, nameToken)
        }
        current = memberOrMethod(current, nameToken, optional)
        continue
      }
      if (token.value === '[') {
        current = parseIndex(current, false)
        continue
      }
      if (token.value === '(') {
        fail(
          'Only named functions can be called, e.g. round(x) or x.round()',
          token.start,
          token.end,
        )
      }
      if (token.value === '|>') {
        fail(
          'The pipe operator is reserved; use method syntax instead, e.g. price.round(2)',
          token.start,
          token.end,
        )
      }
      break
    }
    return current
  }

  function memberOrMethod(object: Node, nameToken: Token, optional: boolean): Node {
    const name = nameToken.value
    if (isPunct('(')) {
      const call = parseArguments()
      return makeCall(nameToken, [object, ...call.args], 'method', optional, object.start, call.end)
    }
    if (BLOCKED_NAMES.has(name))
      fail(`Property "${name}" is not accessible`, nameToken.start, nameToken.end)
    return node({
      type: 'Member',
      object,
      name,
      optional,
      start: object.start,
      end: nameToken.end,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
    })
  }

  function parseIndex(object: Node, optional: boolean): Node {
    next() // [
    const index = parseExpression()
    const close = expectPunct(']')
    return node({ type: 'Index', object, index, optional, start: object.start, end: close.end })
  }

  function makeCall(
    nameToken: Token,
    args: (Node | SpreadNode)[],
    style: CallStyle,
    optional: boolean,
    start: number,
    end: number,
  ): CallNode {
    if (style !== 'function' && (nameToken.value === 'has' || nameToken.value === 'try')) {
      fail(`${nameToken.value}(...) cannot be called as a method`, nameToken.start, nameToken.end)
    }
    if (BLOCKED_NAMES.has(nameToken.value))
      fail(`"${nameToken.value}" cannot be called`, nameToken.start, nameToken.end)
    return node({
      type: 'Call',
      name: nameToken.value,
      args,
      style,
      optional,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      start,
      end,
    })
  }

  function parseArguments(): { args: (Node | SpreadNode)[]; end: number } {
    const open = expectPunct('(')
    enter(open)
    try {
      const args: (Node | SpreadNode)[] = []
      while (!isPunct(')')) {
        if (isPunct('...')) {
          const spread = next()
          const argument = parseExpression()
          args.push(node({ type: 'Spread', argument, start: spread.start, end: argument.end }))
        } else {
          args.push(parseArgument())
        }
        if (!isPunct(',')) break
        next()
      }
      const close = expectPunct(')')
      return { args, end: close.end }
    } finally {
      depth--
    }
  }

  function parseArgument(): Node {
    return arrowAhead() ? parseArrow() : parseExpression()
  }

  function arrowAhead(): boolean {
    const token = peek()
    if (token.kind === 'name') return isPunct('=>', 1)
    if (!isPunct('(')) return false
    let offset = 1
    if (isPunct(')', offset)) return isPunct('=>', offset + 1)
    for (;;) {
      if (peek(offset).kind !== 'name') return false
      offset++
      if (isPunct(')', offset)) return isPunct('=>', offset + 1)
      if (!isPunct(',', offset)) return false
      offset++
    }
  }

  function parseArrow(): Node {
    const first = peek()
    const params: string[] = []
    const paramTokens: Token[] = []
    if (first.kind === 'name') {
      paramTokens.push(next())
    } else {
      next() // (
      while (!isPunct(')')) {
        paramTokens.push(next())
        if (isPunct(',')) next()
      }
      next() // )
    }
    const arrow = expectPunct('=>')
    for (const token of paramTokens) {
      bindLocal(token.value, token)
      if (params.includes(token.value))
        fail(`Duplicate parameter "${token.value}"`, token.start, token.end)
      params.push(token.value)
    }
    if (params.length > 2)
      fail('A lambda takes at most two parameters (item, index)', first.start, arrow.end)
    scopes.push(params)
    try {
      const body = parseExpression()
      return node<LambdaNode>({
        type: 'Lambda',
        params,
        implicit: false,
        body,
        start: first.start,
        end: body.end,
      })
    } finally {
      scopes.pop()
    }
  }

  function parsePrimary(): Node {
    const token = peek()
    switch (token.kind) {
      case 'number':
        next()
        return node({
          type: 'Literal',
          value: token.number as number,
          start: token.start,
          end: token.end,
        })
      case 'string':
        next()
        return node({ type: 'Literal', value: token.value, start: token.start, end: token.end })
      case 'template':
        next()
        return parseTemplate(token)
      case 'keyword':
        if (token.value === 'true' || token.value === 'false') {
          next()
          return node({
            type: 'Literal',
            value: token.value === 'true',
            start: token.start,
            end: token.end,
          })
        }
        if (token.value === 'null') {
          next()
          return node({ type: 'Literal', value: null, start: token.start, end: token.end })
        }
        if (token.value === 'let') {
          fail('Parenthesize a "let" expression used as an operand', token.start, token.end)
        }
        return unexpected()
      case 'name':
        return parseName()
      case 'punct':
        switch (token.value) {
          case '(': {
            if (arrowAhead()) {
              fail(
                'A lambda can only be passed directly as a function argument',
                token.start,
                token.end,
              )
            }
            next()
            const inner = parseExpression()
            expectPunct(')')
            parenthesized.add(inner)
            return inner
          }
          case '[':
            return parseList()
          case '{':
            return parseMap()
          case '.':
            return parseImplicit()
          default:
            return unexpected()
        }
      case 'eof':
      default:
        return unexpected()
    }
  }

  function parseName(): Node {
    const token = next()
    const name = token.value
    if (isPunct('=>')) {
      fail('A lambda can only be passed directly as a function argument', token.start, peek().end)
    }
    if (isPunct('(')) {
      if (name === 'has') return parseHas(token)
      if (name === 'try') return parseTry(token)
      const call = parseArguments()
      return makeCall(token, call.args, 'function', false, token.start, call.end)
    }
    if (BLOCKED_NAMES.has(name)) fail(`"${name}" is not accessible`, token.start, token.end)
    if (isLocal(name)) return node({ type: 'Local', name, start: token.start, end: token.end })
    return node({ type: 'Variable', name, start: token.start, end: token.end })
  }

  function parseHas(token: Token): Node {
    const open = expectPunct('(')
    const target = parseExpression()
    const close = expectPunct(')')
    if (target.type !== 'Member' && target.type !== 'Index') {
      fail(
        'has(...) takes a property path such as has(user.email) or has(prefs["theme"])',
        open.start,
        close.end,
      )
    }
    return node<HasNode>({
      type: 'Has',
      target: target as HasNode['target'],
      start: token.start,
      end: close.end,
    })
  }

  function parseTry(token: Token): Node {
    const open = expectPunct('(')
    enter(open)
    try {
      const body = parseExpression()
      expectPunct(',')
      const fallback = parseExpression()
      if (isPunct(',')) next()
      const close = expectPunct(')')
      return node({ type: 'Try', body, fallback, start: token.start, end: close.end })
    } finally {
      depth--
    }
  }

  // `.` is the implicit lambda parameter. Which lambda it belongs to depends on
  // function signatures, so binding happens after parsing (see check/bind.ts).
  function parseImplicit(): Node {
    const dot = next()
    const it: Node = node({ type: 'It', start: dot.start, end: dot.end })
    // `.name` (adjacent) reads a property of the item; `. > 1` is the item itself.
    const following = peek()
    if (
      (following.kind === 'name' || following.kind === 'keyword') &&
      following.start === dot.end
    ) {
      next()
      return memberOrMethod(it, following, false)
    }
    return it
  }

  function parseList(): Node {
    const open = next()
    const items: (Node | SpreadNode)[] = []
    while (!isPunct(']')) {
      if (isPunct('...')) {
        const spread = next()
        const argument = parseExpression()
        items.push(node({ type: 'Spread', argument, start: spread.start, end: argument.end }))
      } else {
        items.push(parseExpression())
      }
      if (!isPunct(',')) break
      next()
    }
    const close = expectPunct(']')
    return node({ type: 'List', items, start: open.start, end: close.end })
  }

  function parseMap(): Node {
    const open = next()
    const entries: (MapEntry | SpreadNode)[] = []
    const seen = new Set<string>()
    while (!isPunct('}')) {
      const token = peek()
      if (isPunct('...')) {
        next()
        const argument = parseExpression()
        entries.push(node({ type: 'Spread', argument, start: token.start, end: argument.end }))
      } else if (isPunct('[')) {
        next()
        const key = parseExpression()
        expectPunct(']')
        expectPunct(':')
        const value = parseExpression()
        entries.push(node({ type: 'Entry', key, value, start: token.start, end: value.end }))
      } else {
        let key: string
        if (token.kind === 'name' || token.kind === 'keyword' || token.kind === 'string')
          key = token.value
        else if (token.kind === 'number') key = String(token.number)
        else return unexpected()
        next()
        if (BLOCKED_NAMES.has(key)) fail(`"${key}" cannot be used as a key`, token.start, token.end)
        if (seen.has(key)) fail(`Duplicate key "${key}"`, token.start, token.end)
        seen.add(key)
        if (isPunct(':')) {
          next()
          const value = parseExpression()
          entries.push(node({ type: 'Entry', key, value, start: token.start, end: value.end }))
        } else if (token.kind === 'name') {
          // shorthand `{ name }`
          const value: Node = isLocal(key)
            ? node({ type: 'Local', name: key, start: token.start, end: token.end })
            : node({ type: 'Variable', name: key, start: token.start, end: token.end })
          entries.push(node({ type: 'Entry', key, value, start: token.start, end: token.end }))
        } else {
          expectPunct(':')
        }
      }
      if (!isPunct(',')) break
      next()
    }
    const close = expectPunct('}')
    return node({ type: 'Map', entries, start: open.start, end: close.end })
  }

  function parseTemplate(token: Token): Node {
    const parts: (string | Node)[] = []
    for (const part of token.template ?? []) {
      if (part.kind === 'text') {
        parts.push(part.value)
        continue
      }
      const inner = tokenize(source.slice(part.start, part.end), {
        maxSourceLength: limits.maxSourceLength,
        maxTokens: Math.max(tokenBudget, 1),
      }).map((t) => ({
        ...t,
        start: t.start + part.start,
        end: t.end + part.start,
        ...(t.template === undefined
          ? {}
          : {
              template: t.template.map((templatePart) =>
                templatePart.kind === 'expr'
                  ? {
                      ...templatePart,
                      start: templatePart.start + part.start,
                      end: templatePart.end + part.start,
                    }
                  : templatePart,
              ),
            }),
      }))
      tokenBudget -= inner.length
      if (inner.length === 1) fail('Empty template interpolation', part.start - 2, part.end + 1)
      const savedTokens = tokens
      const savedPos = pos
      tokens = inner
      pos = 0
      try {
        parts.push(parseExpression())
        if (peek().kind !== 'eof') unexpected()
      } finally {
        tokens = savedTokens
        pos = savedPos
      }
    }
    return node({ type: 'Template', parts, start: token.start, end: token.end })
  }

  const root = parseExpression()
  if (peek().kind !== 'eof') unexpected()
  return root
}

/** A fix-it for the mistakes people carry over from JavaScript, SQL, or spreadsheets. */
function hintFor(token: Token, previous: Token | undefined): string {
  const adjacent = previous !== undefined && previous.end === token.start
  if (token.kind === 'punct') {
    if (token.value === '=' && adjacent && (previous.value === '==' || previous.value === '!=')) {
      return `; write ${previous.value} (it is already strict, there is no ${previous.value}=)`
    }
    if (token.value === '=') return '; use == to compare (expressions cannot assign)'
    if (token.value === '/') return '; patterns are strings, e.g. matches(text, "^a.*z$")'
  }
  if (token.kind === 'keyword' && token.value === 'not')
    return '; use ! to negate (not is only used in "not in")'
  if (token.kind === 'name') {
    if (token.value === 'and') return '; use &&'
    if (token.value === 'or') return '; use ||'
    if (previous?.kind === 'name' && previous.value === 'new') {
      return '; there is no "new": use timestamp("2026-01-31") or now()'
    }
  }
  return ''
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'number':
      return `number ${token.value}`
    case 'string':
      return 'string'
    case 'template':
      return 'template'
    case 'name':
      return `name "${token.value}"`
    case 'keyword':
      return `"${token.value}"`
    case 'punct':
      return `"${token.value}"`
    case 'eof':
    default:
      return 'end of expression'
  }
}
