import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'

describe('BonsaiOptions validation', () => {
  it('rejects a negative or non-integer cacheSize (previously silently disabled the cache)', () => {
    expect(() => bonsai({ cacheSize: -1 })).toThrow(RangeError)
    expect(() => bonsai({ cacheSize: 1.5 })).toThrow(RangeError)
    expect(() => bonsai({ cacheSize: Number.NaN })).toThrow(RangeError)
  })

  it('rejects a non-positive or non-integer maxDepth', () => {
    expect(() => bonsai({ maxDepth: 0 })).toThrow(RangeError)
    expect(() => bonsai({ maxDepth: -5 })).toThrow(RangeError)
    expect(() => bonsai({ maxDepth: 2.5 })).toThrow(RangeError)
  })

  it('rejects a negative or non-integer maxArrayLength / maxStringLength', () => {
    expect(() => bonsai({ maxArrayLength: -1 })).toThrow(RangeError)
    expect(() => bonsai({ maxArrayLength: 10.5 })).toThrow(RangeError)
    expect(() => bonsai({ maxStringLength: -1 })).toThrow(RangeError)
    expect(() => bonsai({ maxStringLength: 10.5 })).toThrow(RangeError)
  })

  it('rejects a negative, NaN, or non-finite timeout', () => {
    expect(() => bonsai({ timeout: -1 })).toThrow(RangeError)
    expect(() => bonsai({ timeout: Number.NaN })).toThrow(RangeError)
    expect(() => bonsai({ timeout: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })

  it('rejects non-array allow/deny lists', () => {
    expect(() => bonsai({ allowedProperties: 'name' as unknown as string[] })).toThrow(TypeError)
    expect(() => bonsai({ deniedProperties: 'secret' as unknown as string[] })).toThrow(TypeError)
  })

  it('rejects allow/deny lists containing non-string elements', () => {
    expect(() => bonsai({ allowedProperties: ['name', 42] as unknown as string[] })).toThrow(TypeError)
    expect(() => bonsai({ deniedProperties: [null] as unknown as string[] })).toThrow(TypeError)
    expect(() => bonsai({ allowedProperties: [undefined] as unknown as string[] })).toThrow(TypeError)
  })

  it('accepts valid and boundary option values', () => {
    expect(() => bonsai()).not.toThrow()
    expect(() => bonsai({})).not.toThrow()
    expect(() => bonsai({ cacheSize: 0 })).not.toThrow() // 0 = caching disabled
    expect(() => bonsai({ maxDepth: 1 })).not.toThrow()
    expect(() => bonsai({ maxArrayLength: 0 })).not.toThrow()
    expect(() => bonsai({ maxStringLength: 0 })).not.toThrow()
    expect(() => bonsai({ timeout: 0 })).not.toThrow() // 0 = timeout disabled
    expect(() => bonsai({ allowedProperties: ['name'], deniedProperties: [] })).not.toThrow()
  })

  it('a disabled cache (cacheSize 0) still evaluates correctly', () => {
    const expr = bonsai({ cacheSize: 0 })
    expect(expr.evaluateSync('1 + 2')).toBe(3)
    expect(expr.evaluateSync('1 + 2')).toBe(3)
  })
})
