import { describe, it, expect } from 'vitest'
import { parse } from '../src/parser.js'

describe('parser - member access', () => {
  it('should parse dot notation', () => {
    const ast = parse('user.name')
    expect(ast).toMatchObject({
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'user' },
      property: { type: 'Identifier', name: 'name' },
      computed: false,
    })
  })

  it('should parse nested dot notation', () => {
    const ast = parse('user.address.city')
    expect(ast).toMatchObject({
      type: 'MemberExpression',
      object: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'user' },
        property: { type: 'Identifier', name: 'address' },
      },
      property: { type: 'Identifier', name: 'city' },
    })
  })

  it('should parse bracket notation', () => {
    const ast = parse('obj["key"]')
    expect(ast).toMatchObject({
      type: 'MemberExpression',
      computed: true,
    })
  })

  it('should parse array indexing', () => {
    const ast = parse('items[0]')
    expect(ast).toMatchObject({
      type: 'MemberExpression',
      computed: true,
      property: { type: 'NumberLiteral', value: 0 },
    })
  })

  it('should parse optional chaining', () => {
    const ast = parse('user?.address?.city')
    expect(ast).toMatchObject({
      type: 'OptionalMemberExpression',
      object: {
        type: 'OptionalMemberExpression',
      },
    })
  })
})

describe('parser - arrays', () => {
  it('should parse array literal', () => {
    const ast = parse('[1, 2, 3]')
    expect(ast).toMatchObject({
      type: 'ArrayLiteral',
      elements: [
        { type: 'NumberLiteral', value: 1 },
        { type: 'NumberLiteral', value: 2 },
        { type: 'NumberLiteral', value: 3 },
      ],
    })
  })

  it('should parse spread in arrays', () => {
    const ast = parse('[...a, ...b]')
    expect(ast).toMatchObject({
      type: 'ArrayLiteral',
      elements: [
        { type: 'SpreadElement', argument: { type: 'Identifier', name: 'a' } },
        { type: 'SpreadElement', argument: { type: 'Identifier', name: 'b' } },
      ],
    })
  })

  it('should parse empty array', () => {
    const ast = parse('[]')
    expect(ast).toMatchObject({ type: 'ArrayLiteral', elements: [] })
  })
})

describe('parser - objects', () => {
  it('should parse object literal', () => {
    const ast = parse('{ name: "Dan", age: 30 }')
    expect(ast).toMatchObject({
      type: 'ObjectLiteral',
      properties: [
        {
          key: { type: 'Identifier', name: 'name' },
          value: { type: 'StringLiteral', value: 'Dan' },
        },
        { key: { type: 'Identifier', name: 'age' }, value: { type: 'NumberLiteral', value: 30 } },
      ],
    })
  })

  it('should parse computed property keys', () => {
    const ast = parse('{ [key]: "value" }')
    expect(ast).toMatchObject({
      type: 'ObjectLiteral',
      properties: [{ computed: true, key: { type: 'Identifier', name: 'key' } }],
    })
  })
})

describe('parser - function calls', () => {
  it('should parse function call with no args', () => {
    const ast = parse('isAdult()')
    expect(ast).toMatchObject({
      type: 'CallExpression',
      callee: { type: 'Identifier', name: 'isAdult' },
      args: [],
    })
  })

  it('should parse function call with args', () => {
    const ast = parse('max(a, b)')
    expect(ast).toMatchObject({
      type: 'CallExpression',
      callee: { type: 'Identifier', name: 'max' },
      args: [
        { type: 'Identifier', name: 'a' },
        { type: 'Identifier', name: 'b' },
      ],
    })
  })
})

describe('parser - pipe expressions', () => {
  it('should parse simple pipe', () => {
    const ast = parse('name |> upper')
    expect(ast).toMatchObject({
      type: 'PipeExpression',
      input: { type: 'Identifier', name: 'name' },
      transform: { type: 'Identifier', name: 'upper' },
    })
  })

  it('should parse chained pipes', () => {
    const ast = parse('name |> trim |> upper')
    expect(ast).toMatchObject({
      type: 'PipeExpression',
      input: {
        type: 'PipeExpression',
        input: { type: 'Identifier', name: 'name' },
        transform: { type: 'Identifier', name: 'trim' },
      },
      transform: { type: 'Identifier', name: 'upper' },
    })
  })

  it('should parse pipe with transform args', () => {
    const ast = parse('value |> default("N/A")')
    expect(ast).toMatchObject({
      type: 'PipeExpression',
      transform: {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: 'default' },
      },
    })
  })

  it('should parse lambda accessor in transform', () => {
    const ast = parse('users |> filter(.active)')
    expect(ast).toMatchObject({
      type: 'PipeExpression',
      transform: {
        type: 'CallExpression',
        args: [{ type: 'LambdaAccessor', property: 'active' }],
      },
    })
  })
})

describe('parser - template literals', () => {
  it('should parse simple template literal', () => {
    const ast = parse('`Hello ${name}`')
    expect(ast).toMatchObject({ type: 'TemplateLiteral' })
  })
})

describe('parser - error messages', () => {
  it('should give helpful error on unexpected token', () => {
    expect(() => parse('1 +')).toThrow()
  })

  it('should give helpful error on unclosed parenthesis', () => {
    expect(() => parse('(1 + 2')).toThrow()
  })
})
