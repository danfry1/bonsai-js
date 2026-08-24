import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/evaluator.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { bonsai, BonsaiTypeError, BonsaiSecurityError, BonsaiReferenceError } from '../src/index.js'

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
    expect(() => run('[...value]', { value: 42 })).toThrow('an array')
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

  it('spread rejects arbitrary iterables without running them', () => {
    const expr = bonsai({ maxArrayLength: 5 })
    let calls = 0
    function* gen() {
      calls++
      let i = 0
      while (true) yield i++
    }
    expect(() => expr.evaluateSync('[...items]', { items: gen() })).toThrow('an array')
    expect(calls).toBe(0)
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

// The blocks below pin behaviour that mutation testing showed was untested in
// evaluator.ts: where source locations get attached to errors, the non-callable
// and invalid-transform guards, lambda accessor null safety, and the optional
// member short-circuit's interaction with the property access policy.

function evaluateWith(
  expr: string,
  context: Record<string, unknown>,
  source: string | undefined,
): unknown {
  const ec = new ExecutionContext(new SecurityPolicy())
  return evaluate(parse(expr), context, { transforms: {}, functions: {} }, ec, source)
}

describe('evaluator - error location attachment', () => {
  // Each throwing site attaches a source location only when a non-empty source
  // string is present. This pins every `if (s !== undefined && s !== '')` guard
  // in the catch blocks across three source values:
  //   - the expression itself  -> location must be attached
  //   - undefined (no source)   -> the original error must propagate untouched
  //   - '' (empty source)       -> no attachment (the `s !== ''` half of the guard)
  // Asserting the error *class* survives the no-source case matters because a
  // mutant that always attaches calls attachLocation with an undefined source,
  // which throws a TypeError instead of the original error.
  const errorOf = (fn: () => unknown): unknown => {
    try {
      fn()
    } catch (e) {
      return e
    }
    throw new Error('expected the expression to throw')
  }
  const isBonsaiError = (e: unknown): boolean =>
    e instanceof BonsaiTypeError ||
    e instanceof BonsaiSecurityError ||
    e instanceof BonsaiReferenceError
  const locationOf = (e: unknown): unknown => (e as { location?: unknown }).location

  const sites: [label: string, expr: string, ctx: Record<string, unknown>][] = [
    ['member access', 'o.__proto__', { o: {} }],
    ['optional member access', 'o?.__proto__', { o: {} }],
    ['pipe transform', '5 |> nope', {}],
    ['method call', 'items.nope()', { items: [] }],
    ['function call', 'nope()', {}],
  ]

  it.each(sites)('attaches a location for %s when source is provided', (_label, expr, ctx) => {
    expect(locationOf(errorOf(() => evaluateWith(expr, ctx, expr)))).toMatchObject({
      start: expect.any(Number),
      end: expect.any(Number),
    })
  })

  it.each(sites)(
    'propagates the original error with no location for %s when source is absent',
    (_label, expr, ctx) => {
      const err = errorOf(() => evaluateWith(expr, ctx, undefined))
      expect(isBonsaiError(err)).toBe(true)
      expect(locationOf(err)).toBeUndefined()
    },
  )

  it.each(sites)(
    'does not attach a location for %s when the source is the empty string',
    (_label, expr, ctx) => {
      expect(locationOf(errorOf(() => evaluateWith(expr, ctx, '')))).toBeUndefined()
    },
  )
})

describe('evaluator - non-callable and invalid-transform guards', () => {
  it('throws "Cannot call non-identifier" when the callee is neither a name nor a member', () => {
    expect(() => run('(1 + 2)()')).toThrow('Cannot call non-identifier')
  })

  it('throws "Invalid transform expression" when a pipe target is not a call or identifier', () => {
    expect(() => run('5 |> 42')).toThrow('Invalid transform expression')
  })
})

describe('evaluator - member access reads the evaluated object', () => {
  // Pins that member access actually evaluates the object and returns the
  // accessed value (mutants that drop the object eval or the return yield
  // undefined instead).
  it('returns the named property of a context object', () => {
    expect(run('o.x', { o: { x: 5 } })).toBe(5)
  })

  it('reads a nested member inside a lambda body', () => {
    expect(run('[{ x: { y: 5 } }].map(.x.y)')).toEqual([5])
  })
})

describe('evaluator - lambda accessor null safety', () => {
  it('a direct .field accessor over a null item yields undefined, not a throw', () => {
    expect(run('[null].map(.x)')).toEqual([undefined])
  })

  it('a .field accessor inside a compound lambda body is null-safe', () => {
    // Exercises the lambda-body accessor path (distinct from the direct-arg one).
    expect(run('[null].map(.x ?? "d")')).toEqual(['d'])
  })

  it('a method call on an optional member of a null value short-circuits to undefined', () => {
    expect(run('[{ x: null }].map(.x?.toString())')).toEqual([undefined])
  })

  it('a method call on an optional member of a NON-null value still runs the method', () => {
    // Distinguishes the `callee is optional && obj == null` short-circuit guard
    // from mutants that always (or never correctly) short-circuit.
    expect(run('[{ x: "hi" }].map(.x?.toString())')).toEqual(['hi'])
  })

  it('a method call on a NON-optional null member throws rather than short-circuiting', () => {
    // `.x.toString()` (no ?.) over a null x must not be treated as optional.
    expect(() => run('[{ x: null }].map(.x.toString())')).toThrow()
  })

  it('a method call on a non-null member inside a lambda evaluates normally', () => {
    expect(run('[{ x: 5 }].map(.x.toString())')).toEqual(['5'])
  })

  it('evaluates || inside a lambda body with left-truthy short-circuit', () => {
    expect(run('[0, 5].map(. || 9)')).toEqual([9, 5])
  })
})

describe('evaluator - optional member short-circuit respects the access policy', () => {
  // `o?.b` where o is null must NOT consult the property guard for b, because b
  // is never read. The null short-circuit is what skips checkNameAccess; a mutant
  // that drops it would run accessMember(null, 'b') and the allow-list (which
  // omits b) would wrongly reject instead of yielding undefined.
  it('a null optional-member access does not run the property check', () => {
    const ec = new ExecutionContext(new SecurityPolicy({ allowedProperties: ['a'] }))
    const result = evaluate(parse('a?.b'), { a: null }, { transforms: {}, functions: {} }, ec)
    expect(result).toBeUndefined()
  })

  it('a null optional-member inside a lambda body also skips the property check', () => {
    // .a is null, so .a?.b short-circuits; the guard for b must not run, even
    // though b is not on the allow-list (map and a are, so the lambda can run).
    const ec = new ExecutionContext(new SecurityPolicy({ allowedProperties: ['a', 'map'] }))
    const result = evaluate(
      parse('[{ a: null }].map(.a?.b)'),
      {},
      { transforms: {}, functions: {} },
      ec,
    )
    expect(result).toEqual([undefined])
  })
})

describe('evaluator - async-in-sync guard names the kind', () => {
  // A transform that returns a promise during a synchronous evaluation must be
  // rejected with a message that names it a "transform" result. Pins the kind
  // label passed to rejectPromise (a mutant blanking it drops the word).
  const promiseTransform = { transforms: { later: () => Promise.resolve(1) }, functions: {} }

  it('rejects a promise-returning bare transform as a synchronous transform result', () => {
    const ec = new ExecutionContext(new SecurityPolicy())
    expect(() => evaluate(parse('5 |> later'), {}, promiseTransform, ec)).toThrow(
      'synchronous transform result',
    )
  })

  it('rejects a promise-returning transform call as a synchronous transform result', () => {
    // The call form (`later(...)`) takes a distinct code path from the bare form.
    const ec = new ExecutionContext(new SecurityPolicy())
    expect(() => evaluate(parse('5 |> later(1)'), {}, promiseTransform, ec)).toThrow(
      'synchronous transform result',
    )
  })
})

describe('evaluator - depth is released after each compound node', () => {
  // Many sibling compound nodes evaluate fine because each releases its depth on
  // exit. A mutant that drops the `finally { g.exitDepth() }` would leak depth
  // across siblings and trip MAX_DEPTH well before the real limit. 150 sibling
  // additions stay far under the default maxDepth of 100 per branch, but would
  // accumulate to ~151 if depth were never released.
  it('evaluates many sibling compound expressions without tripping the depth guard', () => {
    const expr = `[${Array.from({ length: 150 }, () => '1 + 1').join(', ')}]`
    const result = run(expr) as number[]
    expect(result).toHaveLength(150)
    expect(result.every((v) => v === 2)).toBe(true)
  })
})
