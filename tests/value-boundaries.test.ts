import { describe, expect, it } from 'vitest'
import { bonsai, BonsaiSecurityError, BonsaiTypeError } from '../src/index.js'

describe('produced-value limits', () => {
  it('checks function, context-function, and transform results in sync mode', () => {
    const expr = bonsai<{ suffix: string }>({ maxArrayLength: 2, maxStringLength: 3 })
    expr.addFunction('largeArray', () => [1, 2, 3])
    expr.addContextFunction('largeString', (ctx) => `x${ctx.suffix}`)
    expr.addTransform('duplicate', (value) => `${String(value)}${String(value)}`)

    expect(() => expr.evaluateSync('largeArray()', { suffix: 'yyy' })).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('largeString()', { suffix: 'yyy' })).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('"ab" |> duplicate', { suffix: '' })).toThrow(
      BonsaiSecurityError,
    )
  })

  it('checks function and transform results in async mode', async () => {
    const expr = bonsai({ maxArrayLength: 2, maxStringLength: 3 })
    expr.addFunction('largeArray', () => Promise.resolve([1, 2, 3]))
    expr.addTransform('largeString', () => Promise.resolve('four'))

    await expect(expr.evaluate('largeArray()')).rejects.toBeInstanceOf(BonsaiSecurityError)
    await expect(expr.evaluate('1 |> largeString')).rejects.toBeInstanceOf(BonsaiSecurityError)
  })

  it('checks concatenation and template construction', () => {
    const expr = bonsai({ maxArrayLength: 2, maxStringLength: 3 })

    expect(() => expr.evaluateSync('left + right', { left: 'ab', right: 'cd' })).toThrow(
      BonsaiSecurityError,
    )
    expect(() => expr.evaluateSync('`ab${suffix}`', { suffix: 'cd' })).toThrow(BonsaiSecurityError)
  })

  it('never rejects context data that is only passed through', async () => {
    // Limits bound what an expression *produces*. A large context array or
    // string read back unchanged (or through member access / indexing) is the
    // host's own data and is not a violation.
    const expr = bonsai({ maxArrayLength: 2, maxStringLength: 3 })
    const context = { value: [1, 2, 3], user: { bio: 'long text' }, rows: [[1, 2, 3]] }

    expect(expr.evaluateSync('value', context)).toEqual([1, 2, 3])
    expect(expr.evaluateSync('user.bio', context)).toBe('long text')
    expect(expr.evaluateSync('rows[0]', context)).toEqual([1, 2, 3])
    expect(expr.evaluateSync('value.length', context)).toBe(3)
    await expect(expr.evaluate('user.bio', context)).resolves.toBe('long text')
    // Producing a new oversized value from it is still rejected.
    expect(() => expr.evaluateSync('[...value]', context)).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('value.map(. * 2)', context)).toThrow(BonsaiSecurityError)
  })

  it('allows produced values exactly at their configured limits', () => {
    const expr = bonsai({ maxArrayLength: 3, maxStringLength: 4 })
    expr.addFunction('array', () => [1, 2, 3])
    expr.addTransform('text', () => 'four')

    expect(expr.evaluateSync('array()')).toEqual([1, 2, 3])
    expect(expr.evaluateSync('0 |> text')).toBe('four')
  })
})

describe('synchronous thenable boundary', () => {
  it('rejects Promise-compatible objects, not only native Promises', () => {
    const expr = bonsai()
    expr.addFunction('thenable', () => ({ then: () => undefined }))

    expect(() => expr.evaluateSync('thenable()')).toThrow(BonsaiTypeError)
    expect(() => expr.evaluateSync('thenable()')).toThrow(/synchronous function result/u)
  })

  it('blocks dangerous names at registration rather than leaving callable exceptions', () => {
    const expr = bonsai()
    expect(() => expr.addFunction('constructor', () => 1)).toThrow(TypeError)
    expect(() => expr.addTransform('__proto__', (value) => value)).toThrow(TypeError)
  })
})

describe('object and call structural limits', () => {
  it('enforces object-literal property counts in sync and async modes', async () => {
    const expr = bonsai({ maxObjectProperties: 2 })

    expect(() => expr.evaluateSync('{ a: 1, b: 2, c: 3 }')).toThrow(BonsaiSecurityError)
    await expect(expr.evaluate('{ a: 1, b: 2, c: 3 }')).rejects.toMatchObject({
      code: 'MAX_OBJECT_PROPERTIES',
    })
    expect(expr.evaluateSync('{ a: 1, b: 2 }')).toEqual({ a: 1, b: 2 })
  })

  it('enforces call-argument counts before and after spread expansion', async () => {
    const expr = bonsai({ maxCallArguments: 2 })
    expr.addFunction('count', (...args) => args.length)
    expr.addTransform('withArgs', (_value, ...args) => args.length)

    expect(() => expr.evaluateSync('count(1, 2, 3)')).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('count(...items)', { items: [1, 2, 3] })).toThrow(
      BonsaiSecurityError,
    )
    expect(() => expr.evaluateSync('0 |> withArgs(1, 2, 3)')).toThrow(BonsaiSecurityError)
    await expect(expr.evaluate('count(...items)', { items: [1, 2, 3] })).rejects.toMatchObject({
      code: 'MAX_CALL_ARGUMENTS',
    })
    expect(expr.evaluateSync('count(1, 2)')).toBe(2)
  })
})

describe('parse-time structural limits', () => {
  it('rejects source text before tokenization when it is too long', () => {
    const expr = bonsai({ maxSourceLength: 2 })
    expect(() => expr.evaluateSync('123')).toThrow(BonsaiSecurityError)
    expect(() => expr.evaluateSync('123')).toThrow(/source length/u)
  })

  it('rejects excessive token and AST counts with stable codes', () => {
    expect(() => bonsai({ maxTokens: 2 }).evaluateSync('1 + 2')).toThrow(
      expect.objectContaining({ code: 'MAX_TOKENS' }),
    )
    expect(() =>
      bonsai({ maxAstNodes: 2 }).evaluateSync('left + right', { left: 1, right: 2 }),
    ).toThrow(expect.objectContaining({ code: 'MAX_AST_NODES' }))
  })

  it('permits expressions exactly at each structural boundary', () => {
    expect(bonsai({ maxSourceLength: 1, maxTokens: 1, maxAstNodes: 1 }).evaluateSync('1')).toBe(1)
  })
})
