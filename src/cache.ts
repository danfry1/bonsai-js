export class LRUCache<K, V> {
  private readonly max: number
  private readonly map = new Map<K, V>()
  // Fast path: track last accessed key to skip LRU reordering on repeated hits
  private lastKey: K | undefined
  private lastValue: V | undefined

  constructor(max: number) {
    this.max = max > 0 ? max : 0
  }

  get(key: K): V | undefined {
    // Fast path: same key as last access — no Map reordering needed
    if (key === this.lastKey) return this.lastValue

    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    // Move to end (most recent) for LRU ordering
    this.map.delete(key)
    this.map.set(key, value)
    this.lastKey = key
    this.lastValue = value
    return value
  }

  set(key: K, value: V): void {
    if (this.max === 0) return

    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.max) {
      // Evict oldest (first key)
      const oldest = this.map.keys().next().value!
      this.map.delete(oldest)
      if (this.lastKey === oldest) {
        this.lastKey = undefined
        this.lastValue = undefined
      }
    }
    this.map.set(key, value)
    this.lastKey = key
    this.lastValue = value
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
    this.lastKey = undefined
    this.lastValue = undefined
  }
}
