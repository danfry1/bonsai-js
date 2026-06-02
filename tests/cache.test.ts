import { describe, it, expect } from 'vitest'
import { LRUCache } from '../src/cache.js'

describe('LRUCache', () => {
  it('should store and retrieve values', () => {
    const cache = new LRUCache<string, number>(10)
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
  })

  it('should return undefined for missing keys', () => {
    const cache = new LRUCache<string, number>(10)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('should evict least recently used when full', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3) // should evict 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('should update recency on get', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // 'a' is now most recent
    cache.set('c', 3) // should evict 'b'
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })

  it('should report correct size', () => {
    const cache = new LRUCache<string, number>(10)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.size).toBe(2)
  })

  it('should clear all entries', () => {
    const cache = new LRUCache<string, number>(10)
    cache.set('a', 1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })

  it('treats non-positive cache sizes as disabled', () => {
    const cache = new LRUCache<string, number>(0)
    cache.set('a', 1)
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })

  it('handles undefined values correctly with has-based check', () => {
    const cache = new LRUCache<string, number | undefined>(10)
    cache.set('key', undefined)
    expect(cache.get('key')).toBeUndefined()
    expect(cache.size).toBe(1)
  })

  it('get() refreshes recency for LRU eviction', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.get('a') // refresh 'a'
    cache.set('d', 4) // evicts 'b' (now oldest)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })
})

describe('AST cache eviction in bonsai', () => {
  it('continues to work after AST cache eviction', async () => {
    const { bonsai } = await import('../src/index.js')
    const expr = bonsai({ cacheSize: 2 })
    // Fill the cache with 2 entries
    expect(expr.evaluateSync('1 + 1')).toBe(2)
    expect(expr.evaluateSync('2 + 2')).toBe(4)
    // Third expression triggers eviction
    expect(expr.evaluateSync('3 + 3')).toBe(6)
    // Previous expressions still evaluate correctly (re-parsed)
    expect(expr.evaluateSync('1 + 1')).toBe(2)
  })
})
