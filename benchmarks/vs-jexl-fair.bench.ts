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

// -- Jexl setup --
jexl.addTransform('upper', (val: string) => val.toUpperCase())
jexl.addTransform('sum', (arr: number[]) => arr.reduce((a, b) => a + b, 0))

// Jexl's .eval is a safe expression evaluator API, not JS eval
const jexlRun = (expression: string, ctx?: Record<string, unknown>) => jexl.eval(expression, ctx) // eslint-disable-line

// ============================================================
// Round 1: Default usage (how most people use each library)
// Bonsai auto-caches, Jexl does not
// ============================================================
describe('default usage (bonsai cached vs jexl uncached)', () => {
  bench('bonsai: evaluateSync (auto-cached)', () => {
    expr.evaluateSync('user.age >= 18 && user.verified', context)
  })
  bench('jexl: async eval (no cache)', async () => {
    await jexlRun('user.age >= 18 && user.verified', context)
  })
})

// ============================================================
// Round 2: Both pre-compiled — pure evaluation speed
// ============================================================
describe('pre-compiled: comparison + logic', () => {
  const bonsaiCompiled = expr.compile('user.age >= 18 && user.verified')
  const jexlCompiled = jexl.compile('user.age >= 18 && user.verified')

  bench('bonsai', () => {
    bonsaiCompiled.evaluateSync(context)
  })
  bench('jexl', () => {
    jexlCompiled.evalSync(context)
  })
})

describe('pre-compiled: simple literal', () => {
  const bonsaiCompiled = expr.compile('42')
  const jexlCompiled = jexl.compile('42')

  bench('bonsai', () => {
    bonsaiCompiled.evaluateSync({})
  })
  bench('jexl', () => {
    jexlCompiled.evalSync({})
  })
})

describe('pre-compiled: arithmetic', () => {
  const bonsaiCompiled = expr.compile('1 + 2 * 3')
  const jexlCompiled = jexl.compile('1 + 2 * 3')

  bench('bonsai', () => {
    bonsaiCompiled.evaluateSync({})
  })
  bench('jexl', () => {
    jexlCompiled.evalSync({})
  })
})

describe('pre-compiled: property access', () => {
  const bonsaiCompiled = expr.compile('user.name')
  const jexlCompiled = jexl.compile('user.name')

  bench('bonsai', () => {
    bonsaiCompiled.evaluateSync(context)
  })
  bench('jexl', () => {
    jexlCompiled.evalSync(context)
  })
})

describe('pre-compiled: ternary', () => {
  const bonsaiCompiled = expr.compile('user.age >= 18 ? "adult" : "minor"')
  const jexlCompiled = jexl.compile('user.age >= 18 ? "adult" : "minor"')

  bench('bonsai', () => {
    bonsaiCompiled.evaluateSync(context)
  })
  bench('jexl', () => {
    jexlCompiled.evalSync(context)
  })
})

describe('pre-compiled: transform', () => {
  const bonsaiCompiled = expr.compile('user.name |> upper')
  const jexlCompiled = jexl.compile('user.name|upper')

  bench('bonsai', () => {
    bonsaiCompiled.evaluateSync(context)
  })
  bench('jexl', () => {
    jexlCompiled.evalSync(context)
  })
})
