import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import { parse } from '../src/parser.js'

describe('compiler - constant folding', () => {
  it('should fold constant arithmetic', () => {
    const ast = parse('2 + 3')
    const optimized = compile(ast)
    expect(optimized).toMatchObject({ type: 'NumberLiteral', value: 5 })
  })

  it('should fold nested constant arithmetic', () => {
    const ast = parse('2 + 3 * 4')
    const optimized = compile(ast)
    expect(optimized).toMatchObject({ type: 'NumberLiteral', value: 14 })
  })

  it('should fold constant string concatenation', () => {
    const ast = parse('"hello" + " " + "world"')
    const optimized = compile(ast)
    expect(optimized).toMatchObject({ type: 'StringLiteral', value: 'hello world' })
  })

  it('should fold constant boolean expressions', () => {
    const ast = parse('true && false')
    const optimized = compile(ast)
    expect(optimized).toMatchObject({ type: 'BooleanLiteral', value: false })
  })

  it('should not fold expressions with identifiers', () => {
    const ast = parse('x + 1')
    const optimized = compile(ast)
    expect(optimized.type).toBe('BinaryExpression')
  })
})

describe('compiler - dead branch elimination', () => {
  it('should eliminate false branch of always-true ternary', () => {
    const ast = parse('true ? "yes" : "no"')
    const optimized = compile(ast)
    expect(optimized).toMatchObject({ type: 'StringLiteral', value: 'yes' })
  })

  it('should eliminate true branch of always-false ternary', () => {
    const ast = parse('false ? "yes" : "no"')
    const optimized = compile(ast)
    expect(optimized).toMatchObject({ type: 'StringLiteral', value: 'no' })
  })

  it('should not eliminate when condition is dynamic', () => {
    const ast = parse('x ? "yes" : "no"')
    const optimized = compile(ast)
    expect(optimized.type).toBe('ConditionalExpression')
  })
})

describe('compiler - null/undefined constant folding', () => {
  it('folds null == null to true', () => {
    const optimized = compile(parse('null == null'))
    expect(optimized).toMatchObject({ type: 'BooleanLiteral', value: true })
  })

  it('folds null != undefined to false', () => {
    const optimized = compile(parse('null != null'))
    expect(optimized).toMatchObject({ type: 'BooleanLiteral', value: false })
  })

  it('does not fold null == undefined (different types)', () => {
    const optimized = compile(parse('null == undefined'))
    // The compiler uses strict equality, so null !== undefined — not foldable
    expect(optimized.type).toBe('BinaryExpression')
  })
})

describe('compiler - exponentiation folding', () => {
  it('folds right-associative ** correctly', () => {
    // 2 ** 3 ** 2 should be 2 ** (3 ** 2) = 2 ** 9 = 512
    const optimized = compile(parse('2 ** 3 ** 2'))
    expect(optimized).toMatchObject({ type: 'NumberLiteral', value: 512 })
  })
})

describe('compiler - passthrough', () => {
  it('should pass through non-optimizable expressions unchanged', () => {
    const ast = parse('user.name |> upper')
    const optimized = compile(ast)
    expect(optimized.type).toBe('PipeExpression')
  })

  it('returns an independent artifact without freezing the caller-owned input AST', () => {
    const ast = parse('user.name + 1')
    const optimized = compile(ast)
    expect(optimized).not.toBe(ast)
    expect(Object.isFrozen(optimized)).toBe(false)
    expect(Object.isFrozen(ast)).toBe(false)
    if (ast.type !== 'BinaryExpression') throw new Error('expected binary expression')
    expect(Object.isFrozen(ast.left)).toBe(false)

    const callAst = parse('user.name.trim()')
    const optimizedCall = compile(callAst)
    if (callAst.type !== 'CallExpression' || optimizedCall.type !== 'CallExpression') {
      throw new Error('expected call expression')
    }
    expect(optimizedCall.callee).not.toBe(callAst.callee)
    expect(Object.isFrozen(callAst.callee)).toBe(false)
  })
})

// These tests pin the compiler's exact output, not just that "something folds".
// They were added to kill mutation-testing survivors in compiler.ts: unary
// folding (including the folded value and when folding must NOT happen), folding
// that recurses through every active node type, and the truthiness table that
// drives dead-branch elimination.
describe('compiler - unary folding', () => {
  it('folds !true to the boolean false (value, not just type)', () => {
    expect(compile(parse('!true'))).toMatchObject({ type: 'BooleanLiteral', value: false })
  })

  it('folds !false to the boolean true', () => {
    expect(compile(parse('!false'))).toMatchObject({ type: 'BooleanLiteral', value: true })
  })

  it('folds -5 to the number -5 (sign preserved)', () => {
    expect(compile(parse('-5'))).toMatchObject({ type: 'NumberLiteral', value: -5 })
  })

  it('folds -3.5 to -3.5', () => {
    expect(compile(parse('-3.5'))).toMatchObject({ type: 'NumberLiteral', value: -3.5 })
  })

  it('does NOT fold ! applied to a non-boolean constant', () => {
    // typeof val === 'boolean' must gate the ! fold; !5 stays a UnaryExpression.
    expect(compile(parse('!5')).type).toBe('UnaryExpression')
  })

  it('does NOT fold - applied to a non-number constant', () => {
    expect(compile(parse('-"x"')).type).toBe('UnaryExpression')
  })

  it('does NOT fold a unary operator over a non-constant operand', () => {
    expect(compile(parse('!flag')).type).toBe('UnaryExpression')
    expect(compile(parse('-count')).type).toBe('UnaryExpression')
  })
})

describe('compiler - folding recurses through every active node type', () => {
  it('folds inside array literal elements', () => {
    const optimized = compile(parse('[1 + 1, 2 * 3]')) as unknown as {
      elements: { type: string; value: unknown }[]
    }
    expect(optimized.elements[0]).toMatchObject({ type: 'NumberLiteral', value: 2 })
    expect(optimized.elements[1]).toMatchObject({ type: 'NumberLiteral', value: 6 })
  })

  it('folds object values and computed keys', () => {
    const optimized = compile(parse('{ total: 1 + 2, [3 + 4]: 5 + 6 }')) as unknown as {
      properties: {
        key: { type: string; value: unknown }
        value: { type: string; value: unknown }
      }[]
    }
    expect(optimized.properties[0].value).toMatchObject({ type: 'NumberLiteral', value: 3 })
    expect(optimized.properties[1].key).toMatchObject({ type: 'NumberLiteral', value: 7 })
    expect(optimized.properties[1].value).toMatchObject({ type: 'NumberLiteral', value: 11 })
  })

  it('folds inside template interpolations and spread arguments', () => {
    const template = compile(parse('`total ${1 + 2}`')) as unknown as {
      parts: { type: string; value: unknown }[]
    }
    expect(template.parts[1]).toMatchObject({ type: 'NumberLiteral', value: 3 })

    const spread = compile(parse('[...[1 + 2]]')) as unknown as {
      elements: { argument: { elements: { type: string; value: unknown }[] } }[]
    }
    expect(spread.elements[0].argument.elements[0]).toMatchObject({
      type: 'NumberLiteral',
      value: 3,
    })
  })

  it('folds inside call arguments', () => {
    const optimized = compile(parse('foo(1 + 1)')) as unknown as {
      args: { type: string; value: unknown }[]
    }
    expect(optimized.args[0]).toMatchObject({ type: 'NumberLiteral', value: 2 })
  })

  it('folds inside a computed member index', () => {
    const optimized = compile(parse('arr[1 + 1]')) as unknown as {
      property: { type: string; value: unknown }
    }
    expect(optimized.property).toMatchObject({ type: 'NumberLiteral', value: 2 })
  })

  it('folds the input of a pipe expression', () => {
    const optimized = compile(parse('(1 + 1) |> upper')) as unknown as {
      input: { type: string; value: unknown }
    }
    expect(optimized.input).toMatchObject({ type: 'NumberLiteral', value: 2 })
  })

  it('folds inside a lambda body', () => {
    const optimized = compile(parse('.x + (1 + 1)')) as unknown as {
      body: { right: { type: string; value: unknown } }
    }
    expect(optimized.body.right).toMatchObject({ type: 'NumberLiteral', value: 2 })
  })
})

describe('compiler - constant-folding operator table', () => {
  it.each([
    ['7 - 2', 5],
    ['3 * 4', 12],
    ['10 / 4', 2.5],
    ['10 % 3', 1],
    ['2 ** 5', 32],
  ])('folds arithmetic %s to %d', (src, val) => {
    expect(compile(parse(src))).toMatchObject({ type: 'NumberLiteral', value: val })
  })

  it.each([
    ['3 < 5', true],
    ['5 < 3', false],
    ['5 > 3', true],
    ['3 >= 3', true],
    ['4 <= 3', false],
    ['5 >= 3', true], // unequal-true: pins >= against the next switch arm
    ['3 >= 5', false], // false case for >=, kills its `return true` mutant
    ['2 == 2', true],
    ['2 == 3', false],
    ['2 != 3', true],
    ['2 != 2', false],
  ])('folds comparison %s to %s', (src, val) => {
    expect(compile(parse(src))).toMatchObject({ type: 'BooleanLiteral', value: val })
  })

  // Equality-boundary cases: each pins one relational operator against its
  // neighbour (e.g. `<` vs `<=`). Without the equal-operand case, a `<`->`<=`
  // mutant agrees on every non-equal pair and survives.
  it.each([
    ['5 < 5', false], // distinguishes < from <=
    ['5 <= 5', true], // distinguishes <= from <
    ['5 > 5', false], // distinguishes > from >=
    ['5 >= 5', true], // distinguishes >= from >
  ])('folds equal-operand comparison %s to %s', (src, val) => {
    expect(compile(parse(src))).toMatchObject({ type: 'BooleanLiteral', value: val })
  })

  it.each([
    ['true && true', true],
    ['true && false', false],
    ['false || true', true],
    ['false || false', false],
  ])('folds boolean %s to %s', (src, val) => {
    expect(compile(parse(src))).toMatchObject({ type: 'BooleanLiteral', value: val })
  })
})

describe('compiler - cross-type equality folding', () => {
  // `==` / `!=` fold across mismatched constant types via the trailing equality
  // arms of evalConstant (after the number/string/boolean blocks). These pin the
  // exact boolean so a `return true` / `return false` mutant on those arms dies.
  it.each([
    ['2 == null', false],
    ['2 != null', true],
    ['null == null', true],
    ['null != null', false],
    // Two booleans compared with == / != skip the &&/|| arms and fall to the
    // trailing equality check; pins the `if (op === '||')` guard so a mutant
    // that weakens it to `if (true)` (folding `true || false`) is caught.
    ['true == false', false],
    ['true != false', true],
    ['true == true', true],
  ])('folds %s to %s', (src, val) => {
    expect(compile(parse(src))).toMatchObject({ type: 'BooleanLiteral', value: val })
  })
})

describe('compiler - type-guarded folds do not fire on mismatched operands', () => {
  // evalConstant only folds when BOTH operands match the expected type. A mutant
  // that weakens a `typeof left === 'number' && typeof right === 'number'` guard
  // (e.g. to `||`, or drops one side) would fold these; asserting they stay a
  // BinaryExpression kills those guard mutants.
  it.each(['1 + "x"', '"x" + 1', '1 && true', 'true && 1', '1 || true'])(
    'does not fold mismatched-type expression %s',
    (src) => {
      expect(compile(parse(src)).type).toBe('BinaryExpression')
    },
  )
})

describe('compiler - bare literals pass through unchanged', () => {
  // The literal/identity switch arm returns the node as-is. Deleting that return
  // makes compile() yield undefined; these assert the node survives intact.
  it.each([
    ['5', 'NumberLiteral', 5],
    ['"s"', 'StringLiteral', 's'],
    ['true', 'BooleanLiteral', true],
    ['null', 'NullLiteral', null],
  ])('passes through literal %s', (src, type, value) => {
    expect(compile(parse(src))).toMatchObject({ type, value })
  })

  it.each([
    ['x', 'Identifier'],
    ['{ a: 1 }', 'ObjectLiteral'],
  ])('passes through non-foldable %s as %s', (src, type) => {
    expect(compile(parse(src)).type).toBe(type)
  })
})

describe('compiler - dead-branch elimination truthiness table', () => {
  it.each([
    ['null ? "a" : "b"', 'b'],
    ['0 ? "a" : "b"', 'b'],
    ['"" ? "a" : "b"', 'b'],
    ['false ? "a" : "b"', 'b'],
    ['1 ? "a" : "b"', 'a'],
    ['"x" ? "a" : "b"', 'a'],
    ['true ? "a" : "b"', 'a'],
  ])('%s collapses to "%s"', (src, expected) => {
    expect(compile(parse(src))).toMatchObject({ type: 'StringLiteral', value: expected })
  })
})
