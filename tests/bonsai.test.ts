import { describe, it, expect } from 'vitest'
import { bonsai, evaluateExpression, BonsaiTypeError, BonsaiReferenceError, formatBonsaiError } from '../src/index.js'
import { all } from '../src/stdlib/index.js'
import { strings } from '../src/stdlib/strings.js'
import { arrays } from '../src/stdlib/arrays.js'

describe('bonsai()', () => {
  it('should create an instance', () => {
    const expr = bonsai()
    expect(expr).toBeDefined()
    expect(typeof expr.evaluate).toBe('function')
    expect(typeof expr.evaluateSync).toBe('function')
    expect(typeof expr.compile).toBe('function')
    expect(typeof expr.validate).toBe('function')
    expect(typeof expr.use).toBe('function')
    expect(typeof expr.addTransform).toBe('function')
    expect(typeof expr.addFunction).toBe('function')
  })

  it('should evaluate a simple expression synchronously', () => {
    const expr = bonsai()
    const result = expr.evaluateSync('1 + 2')
    expect(result).toBe(3)
  })

  it('should evaluate with context', () => {
    const expr = bonsai()
    const result = expr.evaluateSync('user.age >= 18', {
      user: { age: 25 },
    })
    expect(result).toBe(true)
  })

  it('should evaluate async', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('1 + 2')
    expect(result).toBe(3)
  })

  it('should compile and reuse expressions', () => {
    const expr = bonsai()
    const compiled = expr.compile('user.age >= 18')
    expect(compiled.evaluateSync({ user: { age: 25 } })).toBe(true)
    expect(compiled.evaluateSync({ user: { age: 15 } })).toBe(false)
  })

  it('should register and use transforms', () => {
    const expr = bonsai()
    expr.addTransform('double', (val: unknown) => (val as number) * 2)
    expect(expr.evaluateSync('price |> double', { price: 25 })).toBe(50)
  })

  it('should register and use functions', () => {
    const expr = bonsai()
    expr.addFunction('greet', (name: unknown) => `Hello, ${name}!`)
    expect(expr.evaluateSync('greet("Dan")')).toBe('Hello, Dan!')
  })

  it("allows access to context from inside functions when specified", () => {
    const expr = bonsai()
    function functionWithContext (this: { context: { name: string} } ) {
      return `Hello, ${this.context.name}!`
    }
    expr.addFunction("greet", functionWithContext, { allowContextAccess: true });
    expect(expr.evaluateSync("greet()", { name: "Dan" })).toBe("Hello, Dan!")
  })

  it("denies access to context from inside functions when specified", () => {
    const expr = bonsai()
    function functionWithContext (this: { context: { name: string} } ) {
      return `Hello, ${this?.context?.name}!`
    }
    expr.addFunction("greet", functionWithContext, { allowContextAccess: false });
    expect(expr.evaluateSync("greet()", { name: "Dan" })).toBe("Hello, undefined!")
  })

  it("denies access to context from inside functions by default", () => {
    const expr = bonsai()
    function functionWithContext (this: { context: {name:string} }) {
      return `Hello, ${this?.context?.name}!`
    }
    expr.addFunction("greet", functionWithContext)
    expect(expr.evaluateSync("greet()", { name: "Dan" })).toBe("Hello, undefined!")
  })

  it('should apply plugins via use()', () => {
    const expr = bonsai()
    expr.use((e) => {
      e.addTransform('triple', (val: unknown) => (val as number) * 3)
    })
    expect(expr.evaluateSync('x |> triple', { x: 10 })).toBe(30)
  })

  it('should validate expressions', () => {
    const expr = bonsai()
    const valid = expr.validate('1 + 2')
    expect(valid.valid).toBe(true)
    if (!valid.valid) throw new Error('expected valid')
    expect(valid.ast).toBeDefined()

    const invalid = expr.validate('1 +')
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.length).toBeGreaterThan(0)
  })

  it('should return references from validate()', () => {
    const expr = bonsai()
    const result = expr.validate('user.name |> upper |> trim')
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error('expected valid')

    expect(result.references.identifiers).toEqual(['user'])
    expect(result.references.transforms).toEqual(['upper', 'trim'])
    expect(result.references.functions).toEqual([])
  })

  it('should extract function references from validate()', () => {
    const expr = bonsai()
    const result = expr.validate('max(a, b) + min(c, d)')
    if (!result.valid) throw new Error('expected valid')

    expect(result.references.identifiers).toEqual(['a', 'b', 'c', 'd'])
    expect(result.references.functions).toEqual(['max', 'min'])
  })

  it('should extract transform args from validate()', () => {
    const expr = bonsai()
    const result = expr.validate('items |> join(", ")')
    if (!result.valid) throw new Error('expected valid')

    expect(result.references.identifiers).toEqual(['items'])
    expect(result.references.transforms).toEqual(['join'])
  })

  it('should cache compiled expressions', () => {
    const expr = bonsai()
    const a = expr.compile('1 + 2')
    const b = expr.compile('1 + 2')
    expect(a).toBe(b) // same object reference
  })

  it('should accept safety options', () => {
    const expr = bonsai({ maxDepth: 5 })
    expect(expr).toBeDefined()
  })

  it('should block prototype access', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('obj.__proto__', { obj: {} })).toThrow('Blocked')
  })

  it('should NOT enforce deniedProperties on top-level identifiers (only on member access)', () => {
    const expr = bonsai({ deniedProperties: ['secret'] })
    // Identifiers bypass allow/deny lists — only member/method access is restricted
    expect(expr.evaluateSync('secret', { secret: 42 })).toBe(42)
    // But member access IS blocked
    expect(() => expr.evaluateSync('obj.secret', { obj: { secret: 42 } })).toThrow('denied')
  })

  it('should NOT enforce allowedProperties on top-level identifiers (only on member access)', () => {
    const expr = bonsai({ allowedProperties: ['user', 'name'] })
    expect(expr.evaluateSync('user.name', { user: { name: 'Dan' } })).toBe('Dan')
    // Identifiers bypass allow/deny lists
    expect(expr.evaluateSync('secret', { secret: 42 })).toBe(42)
    // But member access to unlisted properties IS blocked
    expect(() => expr.evaluateSync('user.age', { user: { age: 30 } })).toThrow('allowed properties')
  })

  it('should support typed generics on evaluateSync', () => {
    const expr = bonsai()
    const result = expr.evaluateSync<number>('1 + 2')
    // TypeScript sees this as number, not unknown
    expect(result + 1).toBe(4)
  })

  it('should support typed generics on compile().evaluateSync', () => {
    const expr = bonsai()
    const compiled = expr.compile('1 + 2')
    const result = compiled.evaluateSync<number>()
    expect(result + 1).toBe(4)
  })

  it('should support typed generics on evaluate', async () => {
    const expr = bonsai()
    const result = await expr.evaluate<number>('1 + 2')
    expect(result + 1).toBe(4)
  })
})

describe('introspection', () => {
  it('hasTransform returns true for registered transforms', () => {
    const expr = bonsai()
    expr.addTransform('double', (val: unknown) => (val as number) * 2)
    expect(expr.hasTransform('double')).toBe(true)
    expect(expr.hasTransform('triple')).toBe(false)
  })

  it('hasFunction returns true for registered functions', () => {
    const expr = bonsai()
    expr.addFunction('greet', () => 'hi')
    expect(expr.hasFunction('greet')).toBe(true)
    expect(expr.hasFunction('farewell')).toBe(false)
  })

  it('listTransforms returns all registered transform names', () => {
    const expr = bonsai()
    expr.addTransform('a', (v: unknown) => v)
    expr.addTransform('b', (v: unknown) => v)
    expect(expr.listTransforms()).toEqual(['a', 'b'])
  })

  it('listFunctions returns all registered function names', () => {
    const expr = bonsai()
    expr.addFunction('x', () => 1)
    expr.addFunction('y', () => 2)
    expect(expr.listFunctions()).toEqual(['x', 'y'])
  })
})

describe('removeTransform / removeFunction', () => {
  it('removeTransform removes a registered transform', () => {
    const expr = bonsai()
    expr.addTransform('double', (val: unknown) => (val as number) * 2)
    expect(expr.hasTransform('double')).toBe(true)
    expect(expr.removeTransform('double')).toBe(true)
    expect(expr.hasTransform('double')).toBe(false)
  })

  it('removeTransform returns false for non-existent transform', () => {
    const expr = bonsai()
    expect(expr.removeTransform('nope')).toBe(false)
  })

  it('removeFunction removes a registered function', () => {
    const expr = bonsai()
    expr.addFunction('greet', () => 'hi')
    expect(expr.removeFunction('greet')).toBe(true)
    expect(expr.hasFunction('greet')).toBe(false)
  })

  it('removed transform is no longer usable', () => {
    const expr = bonsai()
    expr.addTransform('double', (val: unknown) => (val as number) * 2)
    expr.removeTransform('double')
    expect(() => expr.evaluateSync('x |> double', { x: 5 })).toThrow('Unknown transform')
  })
})

describe('validate pretty-print', () => {
  it('includes formatted error with caret pointer', () => {
    const expr = bonsai()
    const result = expr.validate('1 + * 2')
    expect(result.valid).toBe(false)
    expect(result.errors[0].formatted).toBeDefined()
    expect(result.errors[0].formatted).toContain('^')
    expect(result.errors[0].formatted).toContain('1 + * 2')
  })

  it('includes column position from parse error', () => {
    const expr = bonsai()
    const result = expr.validate('foo +')
    expect(result.valid).toBe(false)
    expect(result.errors[0].position.column).toBeGreaterThan(0)
  })

  it('reports real line and column for multiline parse errors', () => {
    const expr = bonsai()
    const result = expr.validate('total +\nsubtotal + ]')
    expect(result.valid).toBe(false)
    expect(result.errors[0].position).toEqual({ line: 2, column: 12 })
    expect(result.errors[0].formatted).toContain('2 | subtotal + ]')
  })
})

describe('all plugin', () => {
  it('should load all stdlib plugins at once', () => {
    const expr = bonsai()
    expr.use(all)

    // strings
    expect(expr.evaluateSync('"hello" |> upper')).toBe('HELLO')
    // arrays
    expect(expr.evaluateSync('items |> count', { items: [1, 2, 3] })).toBe(3)
    // math
    expect(expr.evaluateSync('x |> round', { x: 3.7 })).toBe(4)
    // types
    expect(expr.evaluateSync('x |> isString', { x: 'hi' })).toBe(true)
    // dates
    expect(expr.evaluateSync('ts |> formatDate("YYYY")', { ts: 0 })).toBe('1970')
  })
})

describe('method chaining', () => {
  it('use() returns this for chaining', () => {
    const expr = bonsai()
      .use(strings)
      .use(arrays)
    expect(expr.evaluateSync('"hello" |> upper')).toBe('HELLO')
    expect(expr.evaluateSync('items |> count', { items: [1, 2] })).toBe(2)
  })

  it('addTransform returns this for chaining', () => {
    const expr = bonsai()
      .addTransform('double', (v: unknown) => (v as number) * 2)
      .addTransform('inc', (v: unknown) => (v as number) + 1)
    expect(expr.evaluateSync('x |> double |> inc', { x: 5 })).toBe(11)
  })

  it('addFunction returns this for chaining', () => {
    const expr = bonsai()
      .addFunction('add', (a: unknown, b: unknown) => (a as number) + (b as number))
    expect(expr.evaluateSync('add(1, 2)')).toBe(3)
  })

  it('full chain from factory to evaluation', () => {
    const result = bonsai()
      .use(strings)
      .addTransform('exclaim', (v: unknown) => `${v}!`)
      .evaluateSync('"hello" |> upper |> exclaim')
    expect(result).toBe('HELLO!')
  })
})

describe('clearCache', () => {
  it('clears the cache without affecting functionality', () => {
    const expr = bonsai()
    expr.evaluateSync('1 + 2')
    expr.clearCache()
    // should still work after clearing
    expect(expr.evaluateSync('1 + 2')).toBe(3)
  })

  it('compiled expressions from before clearCache still reference the same compiled object', () => {
    const expr = bonsai()
    const a = expr.compile('1 + 2')
    expr.clearCache()
    const b = expr.compile('1 + 2')
    // After clearing, a new compile creates a new object
    expect(a).not.toBe(b)
    // But both still work
    expect(a.evaluateSync()).toBe(3)
    expect(b.evaluateSync()).toBe(3)
  })
})

describe('evaluateExpression standalone', () => {
  it('evaluates simple expressions without creating an instance', () => {
    expect(evaluateExpression('1 + 2')).toBe(3)
  })

  it('evaluates with context', () => {
    expect(evaluateExpression('x * 2', { x: 21 })).toBe(42)
  })

  it('supports typed generic', () => {
    const result = evaluateExpression<number>('1 + 2')
    expect(result + 1).toBe(4)
  })
})

describe('error source locations', () => {
  it('attaches location to BonsaiTypeError from pipe transform', () => {
    const expr = bonsai()
    expr.use(strings)
    try {
      expr.evaluateSync('x |> upper', { x: 42 })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BonsaiTypeError)
      const err = e as BonsaiTypeError
      expect(err.location).toBeDefined()
      expect(err.formatted).toContain('x |> upper')
      expect(err.location!.source).toBe('x |> upper')
      expect(err.location!.start).toBe(5)
      expect(err.location!.end).toBe(10)
      expect(formatBonsaiError(err)).toContain('line 1, column 6')
    }
  })

  it('attaches location to BonsaiReferenceError from unknown transform', () => {
    const expr = bonsai()
    try {
      expr.evaluateSync('x |> nope', { x: 1 })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BonsaiReferenceError)
      const err = e as BonsaiReferenceError
      expect(err.location).toBeDefined()
      expect(err.formatted).toContain('x |> nope')
      expect(err.location!.source).toBe('x |> nope')
    }
  })

  it('attaches location to errors from function calls', () => {
    const expr = bonsai()
    try {
      expr.evaluateSync('nope(1, 2)')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BonsaiReferenceError)
      const err = e as BonsaiReferenceError
      expect(err.location).toBeDefined()
      expect(err.formatted).toContain('nope(1, 2)')
      expect(err.location!.source).toBe('nope(1, 2)')
    }
  })

  it('attaches location to errors in chained pipes', () => {
    const expr = bonsai()
    expr.use(strings)
    expr.use(arrays)
    try {
      // count expects array, upper returns string
      expr.evaluateSync('"hello" |> upper |> count')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BonsaiTypeError)
      const err = e as BonsaiTypeError
      expect(err.location).toBeDefined()
      expect(err.formatted).toContain('"hello" |> upper |> count')
      // location should point to "count", not "upper"
      expect(err.location!.start).toBe(20)
      expect(err.location!.end).toBe(25)
    }
  })

  it('attaches location to async evaluation errors', async () => {
    const expr = bonsai()
    expr.use(strings)
    try {
      await expr.evaluate('x |> upper', { x: 42 })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BonsaiTypeError)
      const err = e as BonsaiTypeError
      expect(err.location).toBeDefined()
      expect(err.formatted).toContain('x |> upper')
      expect(err.location!.source).toBe('x |> upper')
    }
  })
})
