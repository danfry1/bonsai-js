import { describe, expect, it, vi } from 'vitest'
import { bonsai, t } from '../src/index.js'
import type * as Regex from '../src/runtime/regex.js'
import { createLanguageService } from '../src/service/index.js'

// Counts pattern compilations, so check-time regex work can be measured without timing.
const compiles = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/runtime/regex.js', async (importOriginal) => {
  const original = await importOriginal<typeof Regex>()
  return {
    ...original,
    compileRegex: (...args: Parameters<typeof original.compileRegex>) => {
      compiles.count++
      return original.compileRegex(...args)
    },
  }
})

/** A wide map whose keys are listed through a counted trap. */
function wideMap(size: number): { value: Record<string, number>; listings: () => number } {
  let listings = 0
  const target = Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i]))
  const value = new Proxy(target, {
    ownKeys(inner) {
      listings++
      return Reflect.ownKeys(inner)
    },
  })
  return { value, listings: () => listings }
}

describe('rendering an explanation is bounded by the trace', () => {
  const refs = 400
  const source = `[${Array.from({ length: refs }, () => 'w').join(', ')}].length > 0`

  it('lists a recurring map once per rendering, however many nodes show it', () => {
    const w = wideMap(5000)
    const explanation = bonsai().explainSync(source, { w: w.value })
    expect(explanation.ok).toBe(true)
    const before = w.listings()
    const text = String(explanation)
    expect(w.listings() - before).toBe(1)
    // Every node still shows the map's preview.
    expect(text.split('"k0":0').length - 1).toBeGreaterThanOrEqual(refs)
    const json = JSON.stringify(explanation)
    expect(w.listings() - before).toBe(2)
    expect(json.length).toBeLessThan(2_000_000)
  })

  it('serializes reasons() under one budget, cycles included', () => {
    const w = wideMap(5000)
    const loop: Record<string, unknown> = { n: 1 }
    loop.self = loop
    const explanation = bonsai().explainSync(`${source} && loop.self.n > 0`, {
      w: w.value,
      loop,
    })
    const before = w.listings()
    const json = JSON.stringify(explanation.reasons())
    expect(w.listings() - before).toBeLessThanOrEqual(1)
    expect(json.length).toBeLessThan(2_000_000)
    const parsed = JSON.parse(json) as { text: string }[]
    const texts = explanation.reasons().map((reason) => reason.text)
    expect(parsed.map((reason) => reason.text)).toEqual(texts)
    expect(texts).toContain('loop.self.n > 0')
  })

  it('writes a trace on its own in its JSON form, without changing its keys', () => {
    const explanation = bonsai().explainSync('a + 1 > b', { a: 1, b: 0 })
    const fromTrace: unknown = JSON.parse(JSON.stringify(explanation.trace))
    const fromExplanation = (JSON.parse(JSON.stringify(explanation)) as { trace: unknown }).trace
    expect(fromTrace).toEqual(fromExplanation)
    expect(Object.keys(explanation.trace)).not.toContain('toJSON')
    expect({ ...explanation.trace }).not.toHaveProperty('toJSON')
  })
})

describe('literal patterns go through the pattern cache', () => {
  it('compiles a pattern repeated in one source once', () => {
    const one = '"a".matches("(qq|zz){3}x8")'
    compiles.count = 0
    const result = bonsai().check(`[${Array.from({ length: 50 }, () => one).join(', ')}]`)
    expect(result.ok).toBe(true)
    expect(compiles.count).toBe(1)
  })

  it('parses a repeated bad pattern once and reports every use', () => {
    const one = '"a".matches("(^){9}y8")'
    compiles.count = 0
    const result = bonsai().check(`[${Array.from({ length: 50 }, () => one).join(', ')}]`)
    expect(result.diagnostics).toHaveLength(50)
    expect(compiles.count).toBe(1)
  })
})

describe('completion keeps nested endings', () => {
  const rec = t.object({ a: t.number(), name: t.string() })
  const service = createLanguageService(
    bonsai({ variables: { o1: rec, b: t.boolean(), xs: t.list(rec), n: t.number() } }),
  )
  const labels = (source: string): string[] =>
    service.complete(source, source.length).items.map((item) => item.label)

  it.each(['try({[(try(o1.', '{[`${b ? [o1.', 'b ? {[{[b ? o1.na', '{[try(let v = (o1?.'])(
    'completes %s',
    (source) => {
      expect(labels(source)).toContain('name')
    },
  )

  it('completes a single open call at the end of a long source', () => {
    const pad = `[${Array.from({ length: 16_000 }, () => '9e299').join(',')}].length > 0 && `
    expect(labels(`${pad}try(o1.`)).toEqual(expect.arrayContaining(['a', 'name']))
  })
})

describe('explanation snapshots of host keys', () => {
  it('keeps a key named __proto__ as a key', () => {
    const user = JSON.parse('{"__proto__": {"admin": true}, "name": "a"}') as object
    const json = JSON.stringify(bonsai().explainSync('user', { user }))
    expect(json).toContain('"__proto__":{"admin":true}')
  })
})
