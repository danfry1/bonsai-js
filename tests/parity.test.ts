import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'

// A broad corpus exercised through BOTH evaluateSync and evaluate. The two
// evaluators are separate tree-walks that must stay in lockstep; this guards
// against silent divergence in results across operators, member access,
// optional chaining, spread, templates, methods, lambdas, pipes, and HOF.
const cases: Array<[string, Record<string, unknown>]> = [
  ['1 + 2 * 3', {}],
  ['2 ** 3 ** 2', {}],
  ['-5 % 3', {}],
  ['a && b', { a: true, b: false }],
  ['a || b', { a: 0, b: 'x' }],
  ['a ?? b', { a: null, b: 5 }],
  ['x > 5 ? "hi" : "lo"', { x: 7 }],
  ['"a" in tags', { tags: ['a', 'b'] }],
  ['3 not in [1, 2]', {}],
  ['user.profile?.name', { user: {} }],
  ['user?.a?.b?.c', { user: { a: { b: { c: 9 } } } }],
  ['items[1]', { items: [10, 20, 30] }],
  ['[...xs, 4]', { xs: [1, 2, 3] }],
  ['{ a: 1, b: x }', { x: 2 }],
  ['`hi ${name}!`', { name: 'dan' }],
  ['nums.map(. * 2)', { nums: [1, 2, 3] }],
  ['nums.filter(. > 1)', { nums: [1, 2, 3] }],
  ['nums.find(. > 1)', { nums: [1, 2, 3] }],
  ['nums.findIndex(. > 1)', { nums: [1, 2, 3] }],
  ['nums.some(. > 2)', { nums: [1, 2, 3] }],
  ['nums.every(. > 0)', { nums: [1, 2, 3] }],
  ['data.flatMap(.vals)', { data: [{ vals: [1] }, { vals: [2, 3] }] }],
  ['"a,b,c".split(",")', {}],
  ['"Hello".toUpperCase()', {}],
  ['name |> upper', { name: 'dan' }],
  ['nums |> sum', { nums: [1, 2, 3] }],
  [
    'users |> filter(.active) |> map(.name)',
    {
      users: [
        { name: 'A', active: true },
        { name: 'B', active: false },
      ],
    },
  ],
]

describe('sync/async evaluation parity', () => {
  for (const [expr, ctx] of cases) {
    it(`produces identical results for: ${expr}`, async () => {
      const instance = bonsai().use(strings).use(arrays).use(math)
      const sync = instance.evaluateSync(expr, ctx)
      const asyncResult = await instance.evaluate(expr, ctx)
      expect(asyncResult).toEqual(sync)
    })
  }
})
