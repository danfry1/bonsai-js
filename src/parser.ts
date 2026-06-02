import type {
  ASTNode,
  BinaryExpressionOperator,
  ObjectProperty,
  OperatorValue,
  Token,
} from './types.js'
import { tokenize } from './lexer.js'
import { ExpressionError } from './errors.js'

// Precedence levels (binding power) for Pratt parsing
const PIPE_PRECEDENCE = 5

const PRECEDENCE: Readonly<Record<OperatorValue | '??', number | undefined>> = {
  '||': 10,
  '&&': 20,
  '??': 25,
  '==': 30,
  '!=': 30,
  '<': 40,
  '>': 40,
  '<=': 40,
  '>=': 40,
  in: 40,
  '+': 50,
  '-': 50,
  '*': 60,
  '/': 60,
  '%': 60,
  '**': 70,
  // Unary-only operators have no binary precedence
  '!': undefined,
  not: undefined,
}

const MAX_PARSE_DEPTH = 32

// Upper bound on recursive-descent grammar nesting (parentheses, unary chains,
// bracket indexing, etc.). This is a safety backstop that fails closed with a
// typed ExpressionError before the native call stack can overflow. It is far
// above any realistic expression and well above the evaluator's default
// maxDepth (100), so legitimate input is unaffected; parenthesis nesting that
// produces no AST node is bounded here rather than by the evaluator.
const MAX_GRAMMAR_DEPTH = 1000

export function parse(source: string, _depth = 0): ASTNode {
  if (_depth > MAX_PARSE_DEPTH) {
    throw new ExpressionError('Maximum template nesting depth exceeded', {
      source,
      start: 0,
      end: source.length,
    })
  }
  const tokens = tokenize(source)
  let pos = 0
  let grammarDepth = 0

  function current(): Token {
    return tokens[pos]
  }

  function advance(): Token {
    return tokens[pos++]
  }

  function expect(type: string, value?: string): Token {
    const tok = current()
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new ExpressionError(
        `Expected ${value !== undefined ? `"${value}"` : type} but got ${tok.value !== '' ? `"${tok.value}"` : tok.type}`,
        { source, start: tok.start, end: tok.end },
      )
    }
    return advance()
  }

  function enterNesting(): void {
    if (++grammarDepth > MAX_GRAMMAR_DEPTH) {
      grammarDepth--
      const tok = current()
      throw new ExpressionError('Maximum expression nesting depth exceeded', {
        source,
        start: tok.start,
        end: tok.end,
      })
    }
  }

  // Pratt parser entry. Wrapped so that grammar recursion depth is bounded:
  // pathologically nested input fails closed with a typed ExpressionError
  // rather than overflowing the native call stack.
  function parseExpression(minPrec = 0): ASTNode {
    enterNesting()
    try {
      return parseExpressionInner(minPrec)
    } finally {
      grammarDepth--
    }
  }

  function parseExpressionInner(minPrec = 0): ASTNode {
    let left = parseUnary()

    // Ternary — lowest precedence, handled before binary ops
    if (current().type === 'Punctuation' && current().value === '?' && minPrec === 0) {
      advance() // skip '?'
      const consequent = parseExpression(0)
      expect('Punctuation', ':')
      const alternate = parseExpression(0)
      left = {
        type: 'ConditionalExpression',
        test: left,
        consequent,
        alternate,
        start: left.start,
        end: alternate.end,
      }
      return left
    }

    // Pipe expressions — very low precedence
    while (current().type === 'Pipe' && minPrec <= PIPE_PRECEDENCE) {
      advance() // skip '|>'
      const transform = parsePipeTransform()
      left = {
        type: 'PipeExpression',
        input: left,
        transform,
        start: left.start,
        end: transform.end,
      }
    }

    // Binary operators via Pratt parsing
    while (true) {
      const tok = current()
      let prec: number | undefined

      if (tok.type === 'Operator') {
        prec = PRECEDENCE[tok.value]
        // Handle 'not in' as a combined operator
        if (tok.value === 'not') {
          const nextTok = tokens[pos + 1]
          if (nextTok !== undefined && nextTok.type === 'Operator' && nextTok.value === 'in') {
            prec = PRECEDENCE.in
          }
        }
      } else if (tok.type === 'NullishCoalescing') {
        prec = PRECEDENCE['??']
      }

      if (prec === undefined || prec < minPrec) break

      const op = advance()
      let opValue: BinaryExpressionOperator
      if (op.type === 'NullishCoalescing') {
        opValue = '??'
      } else if (op.value === 'not') {
        advance() // skip 'in'
        opValue = 'not in'
      } else {
        opValue = op.value as Exclude<BinaryExpressionOperator, '??' | 'not in'>
      }

      // Right-associative for **
      const nextMinPrec = opValue === '**' ? prec : prec + 1
      const right = parseExpression(nextMinPrec)

      left = {
        type: 'BinaryExpression',
        operator: opValue,
        left,
        right,
        start: left.start,
        end: right.end,
      }
    }

    // Ternary after binary (for cases like `a > 5 ? b : c`)
    if (current().type === 'Punctuation' && current().value === '?' && minPrec === 0) {
      advance() // skip '?'
      const consequent = parseExpression(0)
      expect('Punctuation', ':')
      const alternate = parseExpression(0)
      left = {
        type: 'ConditionalExpression',
        test: left,
        consequent,
        alternate,
        start: left.start,
        end: alternate.end,
      }
    }

    // Pipe after binary/ternary
    while (current().type === 'Pipe' && minPrec <= PIPE_PRECEDENCE) {
      advance()
      const transform = parsePipeTransform()
      left = {
        type: 'PipeExpression',
        input: left,
        transform,
        start: left.start,
        end: transform.end,
      }
    }

    return left
  }

  function parsePipeTransform(): ASTNode {
    let node = parsePrimary()

    // Allow transform to be a call expression: `upper` or `default("N/A")`
    if (current().type === 'Punctuation' && current().value === '(') {
      advance() // skip '('
      const args: ASTNode[] = []
      while (!(current().type === 'Punctuation' && current().value === ')')) {
        if (args.length > 0) expect('Punctuation', ',')
        if (current().type === 'Punctuation' && current().value === ')') break
        args.push(parseExpression(0))
      }
      const end = expect('Punctuation', ')').end
      node = {
        type: 'CallExpression',
        callee: node,
        args,
        start: node.start,
        end,
      }
    }

    return node
  }

  function parseUnary(): ASTNode {
    enterNesting()
    try {
      return parseUnaryInner()
    } finally {
      grammarDepth--
    }
  }

  function parseUnaryInner(): ASTNode {
    const tok = current()

    if (tok.type === 'Operator' && (tok.value === '!' || tok.value === '-' || tok.value === '+')) {
      advance()
      const operand = parseUnary()
      return {
        type: 'UnaryExpression',
        operator: tok.value,
        operand,
        start: tok.start,
        end: operand.end,
      }
    }

    return parsePostfix()
  }

  function parsePostfix(): ASTNode {
    let node = parsePrimary()

    while (true) {
      const tok = current()

      // Dot notation: obj.prop
      if (tok.type === 'Punctuation' && tok.value === '.') {
        advance()
        const prop = expect('Identifier')
        node = {
          type: 'MemberExpression',
          object: node,
          property: { type: 'Identifier', name: prop.value, start: prop.start, end: prop.end },
          computed: false,
          start: node.start,
          end: prop.end,
        }
        continue
      }

      // Bracket notation: obj[expr]
      if (tok.type === 'Punctuation' && tok.value === '[') {
        advance()
        const property = parseExpression(0)
        const end = expect('Punctuation', ']').end
        node = {
          type: 'MemberExpression',
          object: node,
          property,
          computed: true,
          start: node.start,
          end,
        }
        continue
      }

      // Optional chaining: obj?.prop or obj?.[expr]
      if (tok.type === 'OptionalChain') {
        advance()
        // obj?.[expr] — computed optional
        if (current().type === 'Punctuation' && current().value === '[') {
          advance()
          const property = parseExpression(0)
          const end = expect('Punctuation', ']').end
          node = {
            type: 'OptionalMemberExpression',
            object: node,
            property,
            computed: true,
            start: node.start,
            end,
          }
          continue
        }
        // obj?.prop — regular optional
        const prop = expect('Identifier')
        node = {
          type: 'OptionalMemberExpression',
          object: node,
          property: { type: 'Identifier', name: prop.value, start: prop.start, end: prop.end },
          computed: false,
          start: node.start,
          end: prop.end,
        }
        continue
      }

      // Function call: fn(args)
      if (tok.type === 'Punctuation' && tok.value === '(') {
        advance()
        const args: ASTNode[] = []
        while (!(current().type === 'Punctuation' && current().value === ')')) {
          if (args.length > 0) expect('Punctuation', ',')
          if (current().type === 'Punctuation' && current().value === ')') break
          args.push(parseExpression(0))
        }
        const end = expect('Punctuation', ')').end
        node = {
          type: 'CallExpression',
          callee: node,
          args,
          start: node.start,
          end,
        }
        continue
      }

      break
    }

    return node
  }

  function parsePrimary(): ASTNode {
    const tok = current()

    // Number
    if (tok.type === 'Number') {
      advance()
      const raw = tok.value.replace(/_/gu, '')
      return { type: 'NumberLiteral', value: Number(raw), start: tok.start, end: tok.end }
    }

    // String
    if (tok.type === 'String') {
      advance()
      return { type: 'StringLiteral', value: tok.value, start: tok.start, end: tok.end }
    }

    // Boolean
    if (tok.type === 'Boolean') {
      advance()
      return { type: 'BooleanLiteral', value: tok.value === 'true', start: tok.start, end: tok.end }
    }

    // Null
    if (tok.type === 'Null') {
      advance()
      return { type: 'NullLiteral', value: null, start: tok.start, end: tok.end }
    }

    // Undefined
    if (tok.type === 'Undefined') {
      advance()
      return { type: 'UndefinedLiteral', value: undefined, start: tok.start, end: tok.end }
    }

    // Template literal
    if (tok.type === 'TemplateLiteral') {
      return parseTemplateLiteral()
    }

    // Identifier
    if (tok.type === 'Identifier') {
      advance()
      return { type: 'Identifier', name: tok.value, start: tok.start, end: tok.end }
    }

    // Parenthesized expression
    if (tok.type === 'Punctuation' && tok.value === '(') {
      advance()
      const expr = parseExpression(0)
      expect('Punctuation', ')')
      return expr
    }

    // Array literal
    if (tok.type === 'Punctuation' && tok.value === '[') {
      return parseArrayLiteral()
    }

    // Object literal
    if (tok.type === 'Punctuation' && tok.value === '{') {
      return parseObjectLiteral()
    }

    // Lambda: .property or .property >= value (compound predicate)
    if (tok.type === 'Punctuation' && tok.value === '.') {
      return parseLambdaExpression()
    }

    // Spread element
    if (tok.type === 'Spread') {
      advance()
      const argument = parseExpression(0)
      return { type: 'SpreadElement', argument, start: tok.start, end: argument.end }
    }

    throw new ExpressionError(
      `Unexpected ${tok.type === 'EOF' ? 'end of expression' : `token "${tok.value}"`}`,
      { source, start: tok.start, end: tok.end },
    )
  }

  function parseLambdaExpression(): ASTNode {
    // We're at the `.` token
    const start = current().start
    advance() // skip the `.`

    // Bare `.` as identity lambda (e.g., `. > 2`, `. == "x"`)
    // Must be followed by an operator to form a compound predicate.
    let node: ASTNode
    if (current().type !== 'Identifier') {
      if (current().type !== 'Operator' && current().type !== 'NullishCoalescing') {
        throw new ExpressionError(`Expected property name or operator after "."`, {
          source,
          start,
          end: start + 1,
        })
      }
      node = { type: 'LambdaIdentity', start, end: start + 1 }
    } else {
      const prop = expect('Identifier')
      node = {
        type: 'LambdaAccessor',
        property: prop.value,
        start,
        end: prop.end,
      }
    }

    // Continue with postfix operations (member access, optional chaining, calls)
    while (true) {
      const tok = current()
      if (tok.type === 'Punctuation' && tok.value === '.') {
        advance()
        const nextProp = expect('Identifier')
        node = {
          type: 'MemberExpression',
          object: node,
          property: {
            type: 'Identifier',
            name: nextProp.value,
            start: nextProp.start,
            end: nextProp.end,
          },
          computed: false,
          start: node.start,
          end: nextProp.end,
        }
        continue
      }
      if (tok.type === 'OptionalChain') {
        advance()
        const nextProp = expect('Identifier')
        node = {
          type: 'OptionalMemberExpression',
          object: node,
          property: {
            type: 'Identifier',
            name: nextProp.value,
            start: nextProp.start,
            end: nextProp.end,
          },
          computed: false,
          start: node.start,
          end: nextProp.end,
        }
        continue
      }
      if (tok.type === 'Punctuation' && tok.value === '[') {
        advance()
        const property = parseExpression(0)
        const end = expect('Punctuation', ']').end
        node = {
          type: 'MemberExpression',
          object: node,
          property,
          computed: true,
          start: node.start,
          end,
        }
        continue
      }
      if (tok.type === 'Punctuation' && tok.value === '(') {
        advance()
        const args: ASTNode[] = []
        while (!(current().type === 'Punctuation' && current().value === ')')) {
          if (args.length > 0) expect('Punctuation', ',')
          if (current().type === 'Punctuation' && current().value === ')') break
          args.push(parseExpression(0))
        }
        const end = expect('Punctuation', ')').end
        node = {
          type: 'CallExpression',
          callee: node,
          args,
          start: node.start,
          end,
        }
        continue
      }
      break
    }

    // Check for binary operator to form compound predicate
    const tok = current()
    let prec: number | undefined
    if (tok.type === 'Operator') {
      prec = PRECEDENCE[tok.value]
      if (tok.value === 'not') {
        const nextTok = tokens[pos + 1]
        if (nextTok !== undefined && nextTok.type === 'Operator' && nextTok.value === 'in') {
          prec = PRECEDENCE.in
        }
      }
    } else if (tok.type === 'NullishCoalescing') {
      prec = PRECEDENCE['??']
    }

    // If followed by an operator, this is a compound lambda like `.age >= 18`
    if (prec !== undefined) {
      let left: ASTNode = node
      while (true) {
        const opTok = current()
        let opPrec: number | undefined
        if (opTok.type === 'Operator') {
          opPrec = PRECEDENCE[opTok.value]
          if (opTok.value === 'not') {
            const nextTok = tokens[pos + 1]
            if (nextTok !== undefined && nextTok.type === 'Operator' && nextTok.value === 'in') {
              opPrec = PRECEDENCE.in
            }
          }
        } else if (opTok.type === 'NullishCoalescing') {
          opPrec = PRECEDENCE['??']
        }
        if (opPrec === undefined) break

        const op = advance()
        let opValue: BinaryExpressionOperator
        if (op.type === 'NullishCoalescing') {
          opValue = '??'
        } else if (op.value === 'not') {
          advance() // skip 'in'
          opValue = 'not in'
        } else {
          opValue = op.value as Exclude<BinaryExpressionOperator, '??' | 'not in'>
        }

        const nextMinPrec = opValue === '**' ? opPrec : opPrec + 1
        const right = parseExpression(nextMinPrec)

        left = {
          type: 'BinaryExpression',
          operator: opValue,
          left,
          right,
          start: left.start,
          end: right.end,
        }
      }
      node = left
    }

    // Check for ternary — compound lambda with conditional
    if (current().type === 'Punctuation' && current().value === '?') {
      advance() // skip '?'
      const consequent = parseExpression(0)
      expect('Punctuation', ':')
      const alternate = parseExpression(0)
      const body: ASTNode = {
        type: 'ConditionalExpression',
        test: node,
        consequent,
        alternate,
        start,
        end: alternate.end,
      }
      return {
        type: 'LambdaExpression',
        body,
        start,
        end: alternate.end,
      }
    }

    // If node is just a LambdaAccessor or LambdaIdentity, keep it as-is
    if (node.type === 'LambdaAccessor' || node.type === 'LambdaIdentity') {
      return node
    }

    // It has member access / calls / binary ops — wrap in LambdaExpression
    return {
      type: 'LambdaExpression',
      body: node,
      start,
      end: node.end,
    }
  }

  function parseArrayLiteral(): ASTNode {
    const start = expect('Punctuation', '[').start
    const elements: ASTNode[] = []

    while (!(current().type === 'Punctuation' && current().value === ']')) {
      if (elements.length > 0) expect('Punctuation', ',')
      if (current().type === 'Punctuation' && current().value === ']') break
      elements.push(parseExpression(0))
    }

    const end = expect('Punctuation', ']').end
    return { type: 'ArrayLiteral', elements, start, end }
  }

  function parseObjectLiteral(): ASTNode {
    const start = expect('Punctuation', '{').start
    const properties: ObjectProperty[] = []

    while (!(current().type === 'Punctuation' && current().value === '}')) {
      if (properties.length > 0) expect('Punctuation', ',')
      if (current().type === 'Punctuation' && current().value === '}') break

      let key: ASTNode
      let computed = false

      // Computed property: [expr]
      if (current().type === 'Punctuation' && current().value === '[') {
        advance()
        key = parseExpression(0)
        expect('Punctuation', ']')
        computed = true
      } else {
        // Identifier or string key
        const tok = current()
        if (tok.type === 'Identifier') {
          advance()
          key = { type: 'Identifier', name: tok.value, start: tok.start, end: tok.end }

          // Shorthand: { name } → { name: name }
          const next = current()
          if (next.type === 'Punctuation' && (next.value === ',' || next.value === '}')) {
            const value: ASTNode = {
              type: 'Identifier',
              name: tok.value,
              start: tok.start,
              end: tok.end,
            }
            properties.push({
              type: 'ObjectProperty',
              key,
              value,
              computed: false,
              start: key.start,
              end: value.end,
            })
            continue
          }
        } else if (tok.type === 'String') {
          advance()
          key = { type: 'StringLiteral', value: tok.value, start: tok.start, end: tok.end }
        } else {
          throw new ExpressionError(`Expected property name but got "${tok.value}"`, {
            source,
            start: tok.start,
            end: tok.end,
          })
        }
      }

      expect('Punctuation', ':')
      const value = parseExpression(0)

      properties.push({
        type: 'ObjectProperty',
        key,
        value,
        computed,
        start: key.start,
        end: value.end,
      })
    }

    const end = expect('Punctuation', '}').end
    return { type: 'ObjectLiteral', properties, start, end }
  }

  function parseTemplateLiteral(): ASTNode {
    const tok = advance() // consume TemplateLiteral token
    const raw = tok.value.slice(1, -1) // remove backticks
    const parts: ASTNode[] = []
    let i = 0
    let textStart = 0

    while (i < raw.length) {
      if (raw[i] === '$' && i + 1 < raw.length && raw[i + 1] === '{') {
        // Add text before interpolation
        if (i > textStart) {
          const text = raw.slice(textStart, i)
          parts.push({ type: 'StringLiteral', value: text, start: tok.start, end: tok.end })
        }
        // Find matching }. Skip over string literals and nested template
        // literals so that braces or quotes inside them (e.g. `${ "x}" }` or a
        // nested `` `${ `a}b` }` ``) do not throw off the brace count.
        i += 2
        let depth = 1
        const exprStart = i
        while (i < raw.length && depth > 0) {
          const c = raw[i]
          if (c === '"' || c === "'" || c === '`') {
            i++ // opening quote / backtick
            while (i < raw.length && raw[i] !== c) {
              if (raw[i] === '\\') i++ // skip the escaped character
              i++
            }
            i++ // closing quote / backtick
            continue
          }
          if (c === '{') depth++
          else if (c === '}') depth--
          if (depth > 0) i++
        }
        const exprSource = raw.slice(exprStart, i)
        i++ // skip closing }
        textStart = i
        // Parse the interpolated expression
        const exprAst = parse(exprSource, _depth + 1)
        parts.push(exprAst)
      } else {
        i++
      }
    }

    // Remaining text
    if (textStart < raw.length) {
      const text = raw.slice(textStart)
      parts.push({ type: 'StringLiteral', value: text, start: tok.start, end: tok.end })
    }

    return { type: 'TemplateLiteral', parts, start: tok.start, end: tok.end }
  }

  const result = parseExpression(0)

  if (current().type !== 'EOF') {
    const tok = current()
    throw new ExpressionError(`Unexpected token "${tok.value}"`, {
      source,
      start: tok.start,
      end: tok.end,
    })
  }

  return result
}
