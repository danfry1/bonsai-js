import { describe, bench } from 'vitest'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'
import jexl from 'jexl'

const context = { user: { name: 'Dan', age: 30, verified: true }, items: [1, 2, 3, 4, 5] }

const expr = bonsai()
expr.use(strings)
expr.use(arrays)
expr.use(math)

jexl.addTransform('upper', (val: string) => val.toUpperCase())
jexl.addTransform('sum', (arr: number[]) => arr.reduce((a, b) => a + b, 0))

// jexl.eval is a safe expression evaluator API, not JS eval
const jexlRun = (expression: string, ctx?: Record<string, unknown>) => jexl.eval(expression, ctx) // eslint-disable-line

// Pre-compiled only
const exComp = expr.compile('user.age >= 18 && user.verified')
const jxComp = jexl.compile('user.age >= 18 && user.verified')

describe('pre-compiled: comparison + logic', () => {
  bench('bonsai', () => {
    exComp.evaluateSync(context)
  })
  bench('jexl', () => {
    jxComp.evalSync(context)
  })
})

const exLit = expr.compile('42')
const jxLit = jexl.compile('42')

describe('pre-compiled: literal', () => {
  bench('bonsai', () => {
    exLit.evaluateSync({})
  })
  bench('jexl', () => {
    jxLit.evalSync({})
  })
})

const exProp = expr.compile('user.name')
const jxProp = jexl.compile('user.name')

describe('pre-compiled: property access', () => {
  bench('bonsai', () => {
    exProp.evaluateSync(context)
  })
  bench('jexl', () => {
    jxProp.evalSync(context)
  })
})

describe('default usage: comparison', () => {
  bench('bonsai', () => {
    expr.evaluateSync('user.age >= 18 && user.verified', context)
  })
  bench('jexl', async () => {
    await jexlRun('user.age >= 18 && user.verified', context)
  })
})
