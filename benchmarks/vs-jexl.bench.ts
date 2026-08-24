import { describe, bench } from 'vitest'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'
import jexl from 'jexl'

const context = {
  user: { name: 'Dan', age: 30, verified: true },
  items: [1, 2, 3, 4, 5],
}

// -- Bonsai setup --
const expr = bonsai()
expr.use(strings)
expr.use(arrays)
expr.use(math)

// -- Jexl setup (add equivalent transforms) --
jexl.addTransform('upper', (val: string) => val.toUpperCase())
jexl.addTransform('sum', (arr: number[]) => arr.reduce((a, b) => a + b, 0))

// Helper to run jexl (its API is called .eval but it's a safe expression evaluator, not JS eval)
const jexlEvaluate = (expression: string, ctx?: Record<string, unknown>) =>
  jexl.eval(expression, ctx) // eslint-disable-line

describe('simple literal: 42', () => {
  bench('bonsai', async () => {
    await expr.evaluate('42')
  })
  bench('jexl', async () => {
    await jexlEvaluate('42')
  })
})

describe('arithmetic: 1 + 2 * 3', () => {
  bench('bonsai', async () => {
    await expr.evaluate('1 + 2 * 3')
  })
  bench('jexl', async () => {
    await jexlEvaluate('1 + 2 * 3')
  })
})

describe('property access: user.name', () => {
  bench('bonsai', async () => {
    await expr.evaluate('user.name', context)
  })
  bench('jexl', async () => {
    await jexlEvaluate('user.name', context)
  })
})

describe('comparison + logic: user.age >= 18 && user.verified', () => {
  bench('bonsai', async () => {
    await expr.evaluate('user.age >= 18 && user.verified', context)
  })
  bench('jexl', async () => {
    await jexlEvaluate('user.age >= 18 && user.verified', context)
  })
})

describe('ternary: age >= 18 ? "adult" : "minor"', () => {
  bench('bonsai', async () => {
    await expr.evaluate('user.age >= 18 ? "adult" : "minor"', context)
  })
  bench('jexl', async () => {
    await jexlEvaluate('user.age >= 18 ? "adult" : "minor"', context)
  })
})

describe('transform pipeline: user.name |> upper', () => {
  bench('bonsai', async () => {
    await expr.evaluate('user.name |> upper', context)
  })
  bench('jexl', async () => {
    await jexlEvaluate('user.name|upper', context)
  })
})

describe('array transform: items |> sum', () => {
  bench('bonsai', async () => {
    await expr.evaluate('items |> sum', context)
  })
  bench('jexl', async () => {
    await jexlEvaluate('items|sum', context)
  })
})
