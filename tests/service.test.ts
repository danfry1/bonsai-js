import { describe, expect, it } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

const env = bonsai({
  variables: {
    user: t.object({ name: t.string(), age: t.number(), tags: t.list(t.string()) }),
    orders: t.list(
      t.object({ id: t.string(), total: t.number(), lines: t.list(t.object({ sku: t.string() })) }),
    ),
  },
  functions: {
    lookup: fn({
      params: [t.string()],
      returns: t.string(),
      description: 'Looks things up.',
      run: (s) => s,
    }),
  },
})
const service = createLanguageService(env)

const labels = (source: string, offset = source.length): string[] =>
  service.complete(source, offset).items.map((item) => item.label)

describe('completions', () => {
  it('completes variables, functions, and keywords', () => {
    expect(labels('us')).toEqual(['user'])
    expect(labels('look')).toContain('lookup')
    expect(labels('')).toEqual(expect.arrayContaining(['user', 'orders', 'map', 'true', 'let']))
  })

  it('completes properties and applicable methods after a dot', () => {
    const items = service.complete('user.', 5).items
    expect(items.slice(0, 3).map((i) => i.label)).toEqual(['age', 'name', 'tags'])
    expect(labels('user.name.')).toEqual(
      expect.arrayContaining(['length', 'toUpperCase', 'startsWith', 'lookup']),
    )
    expect(labels('user.name.')).not.toContain('filter')
    expect(labels('user.tags.')).toEqual(
      expect.arrayContaining(['filter', 'map', 'join', 'length']),
    )
  })

  it('knows the item type inside lambdas', () => {
    expect(labels('orders.filter(.')).toEqual(expect.arrayContaining(['id', 'total', 'lines']))
    expect(labels('orders.map(o => o.')).toEqual(expect.arrayContaining(['id', 'total']))
    expect(labels('orders.filter(o => o.lines.some(.')).toContain('sku')
  })

  it('knows let bindings and lambda parameters', () => {
    expect(labels('let big = orders.filter(.total > 1); bi')).toEqual(['big'])
    expect(labels('orders.map(order => ord')).toContain('order')
  })

  it('replaces the partially typed name', () => {
    const result = service.complete('user.na + 1', 7)
    expect(result).toMatchObject({ from: 5, to: 7 })
    expect(result.items[0]?.label).toBe('name')
  })

  it('offers nothing inside strings and comments', () => {
    expect(labels('"user.')).toEqual([])
    expect(labels('// user.')).toEqual([])
  })

  it('works inside templates', () => {
    expect(labels('`${user.')).toContain('name')
  })

  it('never throws on arbitrary partial input', () => {
    const inputs = [
      '(',
      '[',
      '{',
      '{a:',
      'user.(',
      '..',
      '`${',
      'let',
      'let x',
      'let x =',
      'a ?',
      'a ? b',
      'x =>',
      '...',
      ')',
      '"',
      "'",
      '/*',
      'orders.map(.',
      'has(',
      'try(1,',
    ]
    for (const input of inputs) {
      for (let i = 0; i <= input.length; i++) {
        expect(() => service.complete(input, i)).not.toThrow()
        expect(() => service.hover(input, i)).not.toThrow()
      }
    }
  })
})

describe('hover and diagnostics', () => {
  it('shows expression types and function signatures', () => {
    expect(service.hover('orders.map(.total)', 2)?.detail).toContain('id: string')
    expect(service.hover('lookup("a")', 2)).toMatchObject({
      detail: 'lookup(string): string',
      documentation: 'Looks things up.',
    })
  })

  it('reports diagnostics without throwing', () => {
    expect(service.diagnostics('user.agee').map((d) => d.code)).toEqual(['UNKNOWN_PROPERTY'])
    expect(service.diagnostics('1 +').map((d) => d.code)).toEqual(['SYNTAX'])
  })
})
