import { describe, expect, it } from 'vitest'
import { BonsaiSecurityError, ExpressionError } from '../src/errors.js'
import { tokenize } from '../src/lexer.js'
import { parse } from '../src/parser.js'
import type { ASTNode, Token } from '../src/types.js'

function withoutEof(source: string): Token[] {
  return tokenize(source).slice(0, -1)
}

function errorFrom(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to throw')
}

describe('lexer exact token contract', () => {
  it.each([
    ['0', 'Number', '0'],
    ['9', 'Number', '9'],
    ['0x0', 'Number', '0x0'],
    ['0Xf_F', 'Number', '0Xf_F'],
    ['0xa_A', 'Number', '0xa_A'],
    ['0b0_1', 'Number', '0b0_1'],
    ['0B1_0', 'Number', '0B1_0'],
    ['0o0_7', 'Number', '0o0_7'],
    ['0O7_0', 'Number', '0O7_0'],
    ['9.8e-2', 'Number', '9.8e-2'],
    ['1E+9', 'Number', '1E+9'],
    ['_', 'Identifier', '_'],
    ['$', 'Identifier', '$'],
    ['a0_Z$', 'Identifier', 'a0_Z$'],
    ['Z9', 'Identifier', 'Z9'],
    ['in', 'Operator', 'in'],
    ['not', 'Operator', 'not'],
  ])('emits one exact token for %s', (source, type, value) => {
    expect(tokenize(source)).toEqual([
      { type, value, start: 0, end: source.length },
      { type: 'EOF', value: '', start: source.length, end: source.length },
    ])
  })

  it.each([
    ['...', 'Spread', '...'],
    ['.', 'Punctuation', '.'],
    ['|>', 'Pipe', '|>'],
    ['||', 'Operator', '||'],
    ['&&', 'Operator', '&&'],
    ['==', 'Operator', '=='],
    ['!=', 'Operator', '!='],
    ['!', 'Operator', '!'],
    ['<=', 'Operator', '<='],
    ['<', 'Operator', '<'],
    ['>=', 'Operator', '>='],
    ['>', 'Operator', '>'],
    ['**', 'Operator', '**'],
    ['?.', 'OptionalChain', '?.'],
    ['??', 'NullishCoalescing', '??'],
    ['?', 'Punctuation', '?'],
    ['+', 'Operator', '+'],
    ['-', 'Operator', '-'],
    ['*', 'Operator', '*'],
    ['/', 'Operator', '/'],
    ['%', 'Operator', '%'],
    ['(', 'Punctuation', '('],
    [')', 'Punctuation', ')'],
    ['[', 'Punctuation', '['],
    [']', 'Punctuation', ']'],
    ['{', 'Punctuation', '{'],
    ['}', 'Punctuation', '}'],
    [',', 'Punctuation', ','],
    [':', 'Punctuation', ':'],
  ])('pins the type, value, and width of %s', (source, type, value) => {
    expect(withoutEof(source)).toEqual([{ type, value, start: 0, end: source.length }])
  })

  it('decodes every supported string escape in one exact token', () => {
    const source = '"\\n\\t\\r\\\\\\0\\x41\\u0042\\u{43}\\q"'
    expect(tokenize(source)).toEqual([
      {
        type: 'String',
        value: '\n\t\r\\\0ABCq',
        start: 0,
        end: source.length,
      },
      { type: 'EOF', value: '', start: source.length, end: source.length },
    ])
  })

  it('skips every supported whitespace code point without shifting token spans', () => {
    expect(tokenize(' \t\n\rvalue')).toEqual([
      { type: 'Identifier', value: 'value', start: 4, end: 9 },
      { type: 'EOF', value: '', start: 9, end: 9 },
    ])
  })

  it('preserves nested interpolation strings and templates verbatim', () => {
    const source = '`outer:${{"}": `inner:${value}`}.x}:end`'
    expect(tokenize(source)).toEqual([
      { type: 'TemplateLiteral', value: source, start: 0, end: source.length },
      { type: 'EOF', value: '', start: source.length, end: source.length },
    ])
  })

  it.each([
    ['0x', 'Invalid hexadecimal literal', 0, 2],
    ['0b', 'Invalid binary literal', 0, 2],
    ['0o', 'Invalid octal literal', 0, 2],
    ['1e+', 'Invalid number: exponent has no digits', 0, 3],
    ['0x_FF', 'Invalid hexadecimal literal', 0, 2],
    ['0b_1', 'Invalid binary literal', 0, 2],
    ['0o_7', 'Invalid octal literal', 0, 2],
  ])('reports the exact malformed-number span for %s', (source, message, start, end) => {
    const error = errorFrom(() => tokenize(source))
    expect(error).toBeInstanceOf(ExpressionError)
    expect(error).toMatchObject({
      source,
      rawMessage: expect.stringContaining(message),
      start,
      end,
    })
  })

  it('enforces source and token limits at their exact inclusive boundaries', () => {
    expect(tokenize('x', { maxSourceLength: 1, maxTokens: 1 })).toHaveLength(2)
    expect(errorFrom(() => tokenize('xx', { maxSourceLength: 1 }))).toMatchObject({
      name: 'BonsaiSecurityError',
      code: 'MAX_SOURCE_LENGTH',
    })
    expect(errorFrom(() => tokenize('x y', { maxTokens: 1 }))).toMatchObject({
      name: 'BonsaiSecurityError',
      code: 'MAX_TOKENS',
    })
  })
})

// ObjectProperty is represented separately from ASTNode, but counts as one
// structural node in the public maxAstNodes budget. This independent oracle
// makes the exact boundary executable for every AST edge.
function countAstNodes(node: ASTNode): number {
  switch (node.type) {
    case 'BinaryExpression':
      return 1 + countAstNodes(node.left) + countAstNodes(node.right)
    case 'UnaryExpression':
      return 1 + countAstNodes(node.operand)
    case 'ConditionalExpression':
      return (
        1 +
        countAstNodes(node.test) +
        countAstNodes(node.consequent) +
        countAstNodes(node.alternate)
      )
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return 1 + countAstNodes(node.object) + countAstNodes(node.property)
    case 'ArrayLiteral':
      return 1 + node.elements.reduce((count, element) => count + countAstNodes(element), 0)
    case 'ObjectLiteral':
      return (
        1 +
        node.properties.reduce(
          (count, property) =>
            count + 1 + countAstNodes(property.key) + countAstNodes(property.value),
          0,
        )
      )
    case 'CallExpression':
      return (
        1 +
        countAstNodes(node.callee) +
        node.args.reduce((count, argument) => count + countAstNodes(argument), 0)
      )
    case 'PipeExpression':
      return 1 + countAstNodes(node.input) + countAstNodes(node.transform)
    case 'TemplateLiteral':
      return 1 + node.parts.reduce((count, part) => count + countAstNodes(part), 0)
    case 'SpreadElement':
      return 1 + countAstNodes(node.argument)
    case 'LambdaExpression':
      return 1 + countAstNodes(node.body)
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'UndefinedLiteral':
    case 'Identifier':
    case 'LambdaAccessor':
    case 'LambdaIdentity':
      return 1
    default:
      throw new Error('unhandled AST node')
  }
}

describe('parser exact AST budget contract', () => {
  it.each([
    ['leaf', 'value'],
    ['unary', '!value'],
    ['binary', 'left + right'],
    ['conditional', 'test ? yes : no'],
    ['named member', 'value.name'],
    ['optional computed member', 'value?.[key]'],
    ['array and spread', '[1, ...items]'],
    ['object properties', '{ plain: 1, [key]: 2 }'],
    ['call and spread argument', 'fn(1, ...args)'],
    ['pipe and transform call', 'value |> transform(1)'],
    ['template parts', '`before:${value}:after`'],
    ['lambda body', 'items.map(.value > 0)'],
    ['lambda optional computed member', 'items.map(.child?.[key])'],
  ])('counts every structural edge for %s', (_label, expression) => {
    const count = countAstNodes(parse(expression))
    expect(() => parse(expression, { maxAstNodes: count })).not.toThrow()

    const error = errorFrom(() => parse(expression, { maxAstNodes: count - 1 }))
    expect(error).toBeInstanceOf(BonsaiSecurityError)
    expect(error).toMatchObject({ code: 'MAX_AST_NODES' })
  })
})
