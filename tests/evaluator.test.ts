import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/evaluator.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { bonsai, BonsaiTypeError } from '../src/index.js'

function run(expr: string, context: Record<string, unknown> = {}) {
  const ast = parse(expr)
  const ec = new ExecutionContext(new SecurityPolicy())
  return evaluate(ast, context, { transforms: {}, functions: {} }, ec)
}

describe('evaluator - literals', () => {
  it('should evaluate numbers', () => {
    expect(run('42')).toBe(42)
  })

  it('should evaluate strings', () => {
    expect(run('"hello"')).toBe('hello')
  })

  it('should evaluate booleans', () => {
    expect(run('true')).toBe(true)
    expect(run('false')).toBe(false)
  })

  it('should evaluate null', () => {
    expect(run('null')).toBe(null)
  })

  it('should evaluate undefined', () => {
    expect(run('undefined')).toBe(undefined)
  })
})

describe('evaluator - arithmetic', () => {
  it('should evaluate addition', () => {
    expect(run('1 + 2')).toBe(3)
  })

  it('should evaluate subtraction', () => {
    expect(run('5 - 3')).toBe(2)
  })

  it('should evaluate multiplication', () => {
    expect(run('3 * 4')).toBe(12)
  })

  it('should evaluate division', () => {
    expect(run('10 / 3')).toBeCloseTo(3.333)
  })

  it('should evaluate modulo', () => {
    expect(run('10 % 3')).toBe(1)
  })

  it('should evaluate exponentiation', () => {
    expect(run('2 ** 3')).toBe(8)
  })

  it('should respect precedence', () => {
    expect(run('2 + 3 * 4')).toBe(14)
  })

  it('should respect parentheses', () => {
    expect(run('(2 + 3) * 4')).toBe(20)
  })

  it('should handle string concatenation', () => {
    expect(run('"hello" + " " + "world"')).toBe('hello world')
  })
})

describe('evaluator - comparison (strict)', () => {
  it('should evaluate ==', () => {
    expect(run('1 == 1')).toBe(true)
    expect(run('1 == 2')).toBe(false)
    expect(run('"1" == 1')).toBe(false) // strict!
  })

  it('should evaluate !=', () => {
    expect(run('1 != 2')).toBe(true)
    expect(run('"1" != 1')).toBe(true) // strict!
  })

  it('should evaluate < > <= >=', () => {
    expect(run('1 < 2')).toBe(true)
    expect(run('2 > 1')).toBe(true)
    expect(run('2 <= 2')).toBe(true)
    expect(run('3 >= 2')).toBe(true)
  })
})

describe('evaluator - logical', () => {
  it('should evaluate &&', () => {
    expect(run('true && true')).toBe(true)
    expect(run('true && false')).toBe(false)
  })

  it('should evaluate ||', () => {
    expect(run('false || true')).toBe(true)
    expect(run('false || false')).toBe(false)
  })

  it('should evaluate !', () => {
    expect(run('!true')).toBe(false)
    expect(run('!false')).toBe(true)
  })

  it('should short-circuit &&', () => {
    expect(run('false && boom', {})).toBe(false)
  })

  it('should short-circuit ||', () => {
    expect(run('true || boom', {})).toBe(true)
  })
})

describe('evaluator - ternary', () => {
  it('should evaluate ternary true branch', () => {
    expect(run('true ? "yes" : "no"')).toBe('yes')
  })

  it('should evaluate ternary false branch', () => {
    expect(run('false ? "yes" : "no"')).toBe('no')
  })
})

describe('evaluator - nullish coalescing', () => {
  it('should return left side if not null/undefined', () => {
    expect(run('0 ?? "default"')).toBe(0)
    expect(run('"" ?? "default"')).toBe('')
    expect(run('false ?? "default"')).toBe(false)
  })

  it('should return right side if null', () => {
    expect(run('null ?? "default"')).toBe('default')
  })

  it('should return right side if undefined', () => {
    expect(run('undefined ?? "default"')).toBe('default')
  })
})

describe('evaluator - in operator', () => {
  it('should check string contains', () => {
    expect(run('"ell" in "hello"')).toBe(true)
    expect(run('"xyz" in "hello"')).toBe(false)
  })

  it('should check array membership', () => {
    expect(run('2 in [1, 2, 3]')).toBe(true)
    expect(run('5 in [1, 2, 3]')).toBe(false)
  })
})

describe('evaluator - context', () => {
  it('should resolve identifiers from context', () => {
    expect(run('name', { name: 'Dan' })).toBe('Dan')
  })

  it('should resolve nested properties', () => {
    expect(run('user.name', { user: { name: 'Dan' } })).toBe('Dan')
  })

  it('should resolve deeply nested properties', () => {
    expect(
      run('user.address.city', {
        user: { address: { city: 'London' } },
      }),
    ).toBe('London')
  })

  it('should resolve bracket notation', () => {
    expect(run('obj["key"]', { obj: { key: 'value' } })).toBe('value')
  })

  it('should resolve array index', () => {
    expect(run('items[0]', { items: ['a', 'b'] })).toBe('a')
  })
})

describe('evaluator - optional chaining', () => {
  it('should return undefined for null in chain', () => {
    expect(run('user?.address?.city', { user: null })).toBeUndefined()
  })

  it('should return undefined for missing in chain', () => {
    expect(run('user?.address?.city', { user: {} })).toBeUndefined()
  })

  it('should resolve when all present', () => {
    expect(run('user?.name', { user: { name: 'Dan' } })).toBe('Dan')
  })
})

describe('evaluator - arrays and objects', () => {
  it('should evaluate array literals', () => {
    expect(run('[1, 2, 3]')).toEqual([1, 2, 3])
  })

  it('should evaluate object literals', () => {
    expect(run('{ name: "Dan", age: 30 }')).toEqual({ name: 'Dan', age: 30 })
  })

  it('should evaluate spread in arrays', () => {
    expect(run('[...a, ...b]', { a: [1, 2], b: [3, 4] })).toEqual([1, 2, 3, 4])
  })

  it('throws a typed error for non-iterable array spread', () => {
    expect(() => run('[...value]', { value: 42 })).toThrow(BonsaiTypeError)
    expect(() => run('[...value]', { value: 42 })).toThrow('iterable value')
  })

  it('blocks unsafe object literal keys', () => {
    expect(() => run('{ "__proto__": 1 }')).toThrow('Blocked')
    expect(() => run('{ ["constructor"]: 1 }')).toThrow('Blocked')
  })

  it('spread respects maxArrayLength before full materialization', () => {
    const expr = bonsai({ maxArrayLength: 10 })
    const bigArray = Array.from({ length: 100 }, (_, i) => i)
    expect(() => expr.evaluateSync('[...items]', { items: bigArray })).toThrow('maximum')
  })

  it('spread limits iterable materialization', () => {
    const expr = bonsai({ maxArrayLength: 5 })
    function* gen() {
      let i = 0
      while (true) yield i++
    }
    expect(() => expr.evaluateSync('[...items]', { items: gen() })).toThrow('maximum')
  })
})

describe('number format evaluation', () => {
  it('evaluates hex numbers', () => {
    expect(run('0xFF')).toBe(255)
    expect(run('0x1A')).toBe(26)
  })

  it('evaluates binary numbers', () => {
    expect(run('0b1010')).toBe(10)
  })

  it('evaluates octal numbers', () => {
    expect(run('0o77')).toBe(63)
  })

  it('evaluates scientific notation', () => {
    expect(run('1e5')).toBe(100000)
    expect(run('1.5e-3')).toBe(0.0015)
  })

  it('evaluates numeric separators', () => {
    expect(run('1_000_000')).toBe(1000000)
  })
})

describe('unary + operator', () => {
  it('coerces string to number', () => {
    expect(run('+"42"', {})).toBe(42)
  })

  it('is identity for numbers', () => {
    expect(run('+42', {})).toBe(42)
  })

  it('coerces boolean to number', () => {
    expect(run('+true', {})).toBe(1)
  })
})

describe('not in operator', () => {
  it('checks array non-membership', () => {
    expect(run('4 not in arr', { arr: [1, 2, 3] })).toBe(true)
    expect(run('2 not in arr', { arr: [1, 2, 3] })).toBe(false)
  })

  it('checks string non-containment', () => {
    expect(run('"xyz" not in str', { str: 'hello world' })).toBe(true)
    expect(run('"hello" not in str', { str: 'hello world' })).toBe(false)
  })
})

describe('shorthand object properties', () => {
  it('evaluates { name } with context', () => {
    expect(run('{ name }', { name: 'Dan' })).toEqual({ name: 'Dan' })
  })

  it('evaluates { name, age }', () => {
    expect(run('{ name, age }', { name: 'Dan', age: 30 })).toEqual({ name: 'Dan', age: 30 })
  })

  it('mixes shorthand and full properties', () => {
    expect(run('{ name, status: "active" }', { name: 'Dan' })).toEqual({
      name: 'Dan',
      status: 'active',
    })
  })
})

describe('spread in function args', () => {
  it('spreads array into function args', () => {
    const expr = bonsai()
    expr.addFunction(
      'sum3',
      (a: unknown, b: unknown, c: unknown) => (a as number) + (b as number) + (c as number),
    )
    expect(expr.evaluateSync('sum3(...args)', { args: [1, 2, 3] })).toBe(6)
  })

  it('mixes spread and regular args', () => {
    const expr = bonsai()
    expr.addFunction(
      'sum3',
      (a: unknown, b: unknown, c: unknown) => (a as number) + (b as number) + (c as number),
    )
    expect(expr.evaluateSync('sum3(1, ...rest)', { rest: [2, 3] })).toBe(6)
  })

  it('throws a typed error for non-iterable function spreads', () => {
    const expr = bonsai()
    expr.addFunction('identity', (...args: unknown[]) => args)
    expect(() => expr.evaluateSync('identity(...value)', { value: 42 })).toThrow(BonsaiTypeError)
  })
})

describe('Object.prototype isolation', () => {
  it('does not resolve Object.prototype methods as transforms', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('x |> toString', { x: 42 })).toThrow('Unknown transform')
  })

  it('does not resolve Object.prototype methods as functions', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('toString(42)')).toThrow('Unknown function')
  })

  it('does not resolve hasOwnProperty as a transform', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('x |> hasOwnProperty', { x: 'test' })).toThrow(
      'Unknown transform',
    )
  })

  it('does not resolve valueOf as a function', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('valueOf()')).toThrow('Unknown function')
  })
})

describe('in operator type checking', () => {
  it('throws for object right-hand side', () => {
    expect(() => run('"a" in obj', { obj: { a: 1 } })).toThrow(BonsaiTypeError)
  })

  it('throws with helpful message', () => {
    expect(() => run('"a" in obj', { obj: { a: 1 } })).toThrow('a string or array')
  })

  it('not in also throws for object right-hand side', () => {
    expect(() => run('"a" not in obj', { obj: { a: 1 } })).toThrow(BonsaiTypeError)
  })

  it('throws for number right-hand side', () => {
    expect(() => run('1 in x', { x: 42 })).toThrow(BonsaiTypeError)
  })

  it('works with arrays', () => {
    expect(run('2 in items', { items: [1, 2, 3] })).toBe(true)
    expect(run('5 in items', { items: [1, 2, 3] })).toBe(false)
  })

  it('works with strings', () => {
    expect(run('"ell" in word', { word: 'hello' })).toBe(true)
  })
})
