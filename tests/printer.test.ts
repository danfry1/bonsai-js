import { describe, expect, it } from 'vitest'
import { bonsai, print, type Node } from '../src/index.js'

const env = bonsai()
const roundTrip = (source: string): string => print(env.parse(source))

describe('print', () => {
  it.each([
    ['1 + 2 * 3', '1 + 2 * 3'],
    ['(1 + 2) * 3', '(1 + 2) * 3'],
    ['1 - (2 - 3)', '1 - (2 - 3)'],
    ['(1 - 2) - 3', '1 - 2 - 3'],
    ['2 ** 3 ** 2', '2 ** 3 ** 2'],
    ['(2 ** 3) ** 2', '(2 ** 3) ** 2'],
    ['(-2) ** 2', '(-2) ** 2'],
    ['-(2 ** 2)', '-(2 ** 2)'],
    ['- -x', '- -x'],
    ['(a ?? b) || c', '(a ?? b) || c'],
    ['a ?? (b && c)', 'a ?? (b && c)'],
    ['(a < b) == c', 'a < b == c'],
    ['a == (b == c)', 'a == (b == c)'],
    ['a && b && c && d', 'a && b && c && d'],
    ['a ? b : c ? d : e', 'a ? b : c ? d : e'],
    ['(a ? b : c) ? d : e', '(a ? b : c) ? d : e'],
    ['(let x = 1; x) + 1', '(let x = 1; x) + 1'],
    ['let x = 1; let y = 2; x + y', 'let x = 1; let y = 2; x + y'],
    ['x not in [1, 2]', 'x not in [1, 2]'],
    ['!(a && b)', '!(a && b)'],
    ['a?.b?.[c]?.d()', 'a?.b?.[c]?.d()'],
    [
      'users.filter(.age >= 18 && !.suspended).map(.name)',
      'users.filter(.age >= 18 && !.suspended).map(.name)',
    ],
    ['rows.map(.[0])', 'rows.map(.[0])'],
    ['xs.filter(10 < .)', 'xs.filter(10 < .)'],
    ['orders.reduce((sum, o) => sum + o.total, 0)', 'orders.reduce((sum, o) => sum + o.total, 0)'],
    ['items.map(x => x * 2)', 'items.map(x => x * 2)'],
    ['{ a: 1, "b-c": 2, [k]: 3, ...o, name }', '{ a: 1, "b-c": 2, [k]: 3, ...o, name }'],
    ['{ null: 1, in: 2 }', '{ null: 1, in: 2 }'],
    ['[1, ...xs, 2]', '[1, ...xs, 2]'],
    ['max(...xs)', 'max(...xs)'],
    ['has(user.email) && try(a / b, 0) > 1', 'has(user.email) && try(a / b, 0) > 1'],
    ['obj.in + obj.null', 'obj.in + obj.null'],
    ['"a\\"b\\\\c\\n\\t"', '"a\\"b\\\\c\\n\\t"'],
    ['`total: ${a + 1}!`', '`total: ${a + 1}!`'],
    ['`a\\`b\\${c}`', '`a\\`b\\${c}`'],
    ['// comments are dropped\n1 /* here too */ + 2', '1 + 2'],
    ['1_000 + 0xff', '1000 + 255'],
  ])('%s', (source, expected) => {
    expect(roundTrip(source)).toBe(expected)
    // Printing is idempotent and keeps the meaning.
    expect(roundTrip(expected)).toBe(expected)
  })

  it('normalizes call style on request', () => {
    const tree = env.parse('trim(name).toUpperCase().startsWith("A")')
    expect(print(tree, { calls: 'method' })).toBe('name.trim().toUpperCase().startsWith("A")')
    expect(print(tree, { calls: 'function' })).toBe('startsWith(toUpperCase(trim(name)), "A")')
    expect(print(tree)).toBe('trim(name).toUpperCase().startsWith("A")')
  })

  it('prints compiled trees, where implicit lambdas are explicit nodes', () => {
    const program = env.compile('groups.map(.users.filter(.active).length)')
    expect(print(program.ast)).toBe('groups.map(.users.filter(.active).length)')
  })

  it('prints trees built by hand, as a visual editor would', () => {
    const at = { start: 0, end: 0 }
    const tree: Node = {
      type: 'Binary',
      operator: '&&',
      left: {
        type: 'Binary',
        operator: '>=',
        left: {
          type: 'Member',
          object: { type: 'Variable', name: 'user', ...at },
          name: 'age',
          optional: false,
          ...at,
        },
        right: { type: 'Literal', value: 18, ...at },
        ...at,
      },
      right: {
        type: 'Call',
        name: 'includes',
        style: 'method',
        optional: false,
        nameStart: 0,
        nameEnd: 0,
        args: [
          {
            type: 'Member',
            object: { type: 'Variable', name: 'user', ...at },
            name: 'first-name',
            optional: false,
            ...at,
          },
          { type: 'Literal', value: -1, ...at },
        ],
        ...at,
      },
      ...at,
    }
    const printed = print(tree)
    expect(printed).toBe('user.age >= 18 && user["first-name"].includes(-1)')
    expect(env.evaluateSync(printed, { user: { age: 20, 'first-name': [-1] } })).toBe(true)
  })

  it('escapes control characters with escapes the lexer reads', () => {
    const printed = print({ type: 'Literal', value: 'a\u0000b\bc', start: 0, end: 0 })
    expect(env.evaluateSync(printed)).toBe('a\u0000b\bc')
  })

  it('rejects numbers that have no source form', () => {
    expect(() => print({ type: 'Literal', value: Number.NaN, start: 0, end: 0 })).toThrow(
      expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/non-finite/u) }),
    )
  })
})
