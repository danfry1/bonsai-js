import { describe, expect, it } from 'vitest'
import { bonsai, fn, formatType, print, t, type Node } from '../src/index.js'
import { codeOf } from './helpers.js'
import { createLanguageService } from '../src/service/index.js'

describe('blocked names are never callable', () => {
  it.each(['constructor(1)', 'x.prototype()', '__proto__(1)', 'x?.constructor()'])(
    '%s is a syntax error',
    (source) => {
      expect(codeOf(() => bonsai().parse(source))).toBe('SYNTAX')
    },
  )
})

describe('the evaluation context', () => {
  it('reports a throwing or revoked Proxy as HOST_ERROR', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(codeOf(() => bonsai().evaluateSync('1', revoked.proxy))).toBe('HOST_ERROR')
  })

  it('rejects opaque values as the context', () => {
    const env = bonsai({ variables: { size: t.number() } })
    const context = new Map([['size', 1]]) as unknown as { size: number }
    expect(codeOf(() => env.evaluateSync('size', context))).toBe('INVALID_ARGUMENT')
  })
})

describe('the clock', () => {
  it('must return a valid Date', () => {
    const numeric = bonsai({ clock: Date.now as unknown as () => Date })
    expect(codeOf(() => numeric.evaluateSync('now()'))).toBe('HOST_CONTRACT')
    // A broken clock is a host bug, not something try() hides.
    expect(codeOf(() => numeric.evaluateSync('try(now(), null)'))).toBe('HOST_CONTRACT')
    expect(codeOf(() => bonsai({ clock: () => new Date(Number.NaN) }).evaluateSync('now()'))).toBe(
      'HOST_CONTRACT',
    )
    const throwing = bonsai({
      clock: () => {
        throw new Error('down')
      },
    })
    expect(codeOf(() => throwing.evaluateSync('now()'))).toBe('HOST_ERROR')
  })
})

describe('print() validates its input', () => {
  const env = bonsai()

  it('rejects unknown options', () => {
    expect(() => print(env.parse('a'), { call: 'method' } as never)).toThrow(TypeError)
    expect(print(env.parse('a + 1'), { calls: undefined })).toBe('a + 1')
  })

  it('rejects cyclic and very deep trees with a clear error', () => {
    const cyclic = { type: 'Unary', operator: '!', start: 0, end: 1 } as Record<string, unknown>
    cyclic.operand = cyclic
    expect(() => print(cyclic as unknown as Node)).toThrow(/cycle/u)
    let deep: unknown = { type: 'Literal', value: true, start: 0, end: 1 }
    for (let i = 0; i < 50_000; i++)
      deep = { type: 'Unary', operator: '!', operand: deep, start: 0, end: 1 }
    expect(() => print(deep as Node)).toThrow(/deeper than/u)
  })
})

describe('optional spec fields accept undefined', () => {
  it('runs a host function declared with undefined optional fields', () => {
    const inc = fn({
      params: [t.number()],
      returns: t.number(),
      required: undefined,
      rest: undefined,
      description: undefined,
      cost: undefined,
      run: (x) => x + 1,
    })
    expect(bonsai({ functions: { inc } }).evaluateSync('inc(1)')).toBe(2)
  })
})

describe('checker precision with expected types', () => {
  const Role = t.enum('admin', 'member')
  const env = bonsai({
    variables: {
      order: t.object({ id: t.string(), status: t.string() }),
      users: t.list(t.object({ id: t.string(), role: Role })),
      user: t.object({ role: Role }),
      events: t.list(t.object({ type: t.string() })),
      e: Role,
      b: t.boolean(),
    },
  })

  it.each([
    ['order', t.object({ id: t.string() })],
    ['b ? order : order', t.object({ id: t.string() })],
    ['users.map(u => {id: u.id, role: u.role})', t.list(t.object({ id: t.string(), role: Role }))],
    ['{role: user.role}.role', Role],
    ['first([e])', t.optional(Role)],
    ['users.map(u => u.role == "admin" ? "full" : "read")', t.list(t.enum('full', 'read'))],
    [
      'reduce(events, (st, x) => x.type == "purchase" ? "converted" : st, "new")',
      t.enum('new', 'converted'),
    ],
    [
      'users.map(u => {access: u.role == "admin" ? "full" : "read"})',
      t.list(t.object({ access: t.enum('full', 'read') })),
    ],
  ] as const)('accepts %s against its expected type', (source, expected) => {
    expect(env.check(source, { expect: expected }).diagnostics).toEqual([])
  })

  it('keeps declared enums in literals', () => {
    expect(formatType(env.check('[e]').type ?? t.never())).toBe('("admin" | "member")[]')
    expect(env.check('{role: user.role}.role == "root"').diagnostics.map((d) => d.code)).toEqual([
      'ALWAYS_FALSE',
    ])
  })

  it('accepts allow-lists longer than 256 items against a large enum', () => {
    const values = Array.from({ length: 300 }, (_, i) => `C${i}`)
    expect(bonsai().check(JSON.stringify(values), { expect: t.list(t.enum(...values)) }).ok).toBe(
      true,
    )
  })

  it('warns when includes can never hold, like in', () => {
    const roles = bonsai({ variables: { roles: t.list(Role) } })
    expect(roles.check('roles.includes("zz")').diagnostics.map((d) => d.code)).toEqual([
      'ALWAYS_FALSE',
    ])
  })

  it('treats spreading an empty list as no arguments', () => {
    expect(env.check('max(...[])').diagnostics.map((d) => d.code)).toEqual(['NO_OVERLOAD'])
    expect(formatType(env.check('max(1, ...[])').type ?? t.never())).toBe('number')
  })
})

describe('checking a source full of typos stays fast', () => {
  it('bounds did-you-mean suggestions', () => {
    const fields = Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`field${i}x`, t.number()]),
    )
    const env = bonsai({ variables: { o: t.object(fields) } })
    const source = `[${Array.from({ length: 6000 }, (_, i) => `o.fieldx${i}`).join(', ')}]`
    const start = performance.now()
    const result = env.check(source)
    // Unbounded, this took seconds; a generous bound keeps CI stable.
    expect(performance.now() - start).toBeLessThan(3000)
    expect(result.diagnostics).toHaveLength(6000)
    // The first unknown names still get a hint.
    expect(result.diagnostics[0]?.message).toContain('did you mean')
  })
})

describe('language service', () => {
  const Role = t.enum('admin', 'member')
  const env = bonsai({
    variables: {
      order: t.object({ lines: t.list(t.object({ sku: t.string(), cat: t.string() })) }),
      roles: t.list(Role),
      users: t.list(t.object({ role: Role, name: t.string() })),
    },
  })
  const service = createLanguageService(env)
  const labels = (source: string): string[] =>
    service.complete(source, source.length).items.map((item) => item.label)

  it('types the parameters of an unfinished reduce lambda', () => {
    expect(labels('reduce(order.lines, (acc, l) => l.')).toEqual(
      expect.arrayContaining(['sku', 'cat']),
    )
    expect(labels('order.lines.reduce((acc, l) => l.')).toEqual(
      expect.arrayContaining(['sku', 'cat']),
    )
  })

  it('offers literal values for call arguments', () => {
    expect(labels('roles.includes("')).toEqual(['admin', 'member'])
    expect(labels('users.sortBy(.name, "')).toEqual(['asc', 'desc'])
  })

  it('hovers the field of an implicit member, not the item', () => {
    expect(service.hover('order.lines.map(.cat)', 17)).toMatchObject({
      start: 16,
      end: 20,
      detail: 'string',
    })
  })
})
