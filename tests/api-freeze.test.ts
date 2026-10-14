import { describe, expect, it } from 'vitest'
import { bonsai, mapChildren, print, type CallNode, type Node } from '../src/index.js'

describe('API freeze', () => {
  it('names a residual tree ast, as Program and CheckResult do', () => {
    const program = bonsai().compile('user.age > limit && user.plan == "pro"')
    const result = program.partial({ limit: 5 }, { unknown: ['user'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    expect(print(result.ast)).toBe(result.source)
    expect('residual' in result).toBe(false)
  })

  it('keeps residual offsets in the original expression, 0 for filled-in values', () => {
    const source = 'limit + 1 > 0 && user.age / user.zero > limit'
    const result = bonsai()
      .compile(source)
      .partial({ limit: 5 }, { unknown: ['user'] })
    if (result.status !== 'residual') throw new Error('expected a residual')
    const root = result.ast
    if (root.type !== 'Binary' || root.left.type !== 'Binary')
      throw new Error('expected a comparison')
    expect(source.slice(root.left.start, root.left.end)).toBe('user.age / user.zero')
    expect(root.right).toMatchObject({ type: 'Literal', value: 5, start: 0, end: 0 })
    let error: unknown
    try {
      result.evaluateSync({ user: { age: 1, zero: 0 } })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'DIVISION_BY_ZERO', source, span: { start: 17, end: 37 } })
  })

  it('prints and maps a hand-built call without name spans', () => {
    const at = { start: 0, end: 0 }
    const call: CallNode = {
      type: 'Call',
      name: 'round',
      style: 'function',
      optional: false,
      args: [{ type: 'Variable', name: 'x', ...at }],
      ...at,
    }
    expect(print(call)).toBe('round(x)')
    const renamed = mapChildren(call, (child: Node) =>
      child.type === 'Variable' ? { ...child, name: 'y' } : child,
    )
    expect(print(renamed)).toBe('round(y)')
  })

  it('still records name spans on parsed calls', () => {
    const source = 'xs.round(2)'
    const tree = bonsai().parse(source)
    if (tree.type !== 'Call') throw new Error('expected a call')
    expect(source.slice(tree.nameStart, tree.nameEnd)).toBe('round')
  })
})
