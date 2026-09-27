// Same workloads in Bonsai and CEL (@marcbachmann/cel-js), each compiled once
// and evaluated repeatedly. CEL integers are BigInt, so its contexts use
// BigInt (or doubles where the expression uses decimals) to stay idiomatic.
import { parse as celParse } from '@marcbachmann/cel-js'
import { bench, describe } from 'vitest'
import { bonsai } from '../src/index.js'

const env = bonsai()
const items = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  price: i % 50,
  qty: (i % 7) + 1,
  active: i % 3 !== 0,
}))
const celItems = items.map((item) => ({ ...item, id: BigInt(item.id), price: BigInt(item.price), qty: BigInt(item.qty) }))

const cases = [
  {
    name: 'rule: three comparisons',
    bonsai: 'user.age >= 18 && user.country == "GB" && user.plan == "pro"',
    cel: 'user.age >= 18 && user.country == "GB" && user.plan == "pro"',
    context: { user: { age: 25, country: 'GB', plan: 'pro' } },
    celContext: { user: { age: 25n, country: 'GB', plan: 'pro' } },
  },
  {
    name: 'arithmetic',
    bonsai: 'a.x * b.y + c.z * 2',
    cel: 'a.x * b.y + c.z * 2.0',
    context: { a: { x: 2.5 }, b: { y: 3.5 }, c: { z: 4.5 } },
    celContext: { a: { x: 2.5 }, b: { y: 3.5 }, c: { z: 4.5 } },
  },
  {
    name: 'membership',
    bonsai: '"vip" in user.tags',
    cel: '"vip" in user.tags',
    context: { user: { tags: ['a', 'b', 'vip'] } },
    celContext: { user: { tags: ['a', 'b', 'vip'] } },
  },
  {
    name: 'filter + map over 1000 items',
    bonsai: 'items.filter(.active).map(.price * .qty)',
    cel: 'items.filter(i, i.active).map(i, i.price * i.qty)',
    context: { items },
    celContext: { items: celItems },
  },
]

for (const c of cases) {
  describe(c.name, () => {
    const program = env.compile(c.bonsai)
    const celProgram = celParse(c.cel)
    bench('bonsai', () => {
      program.evaluateSync(c.context)
    })
    bench('cel-js', () => {
      celProgram(c.celContext)
    })
  })
}
