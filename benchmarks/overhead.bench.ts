import { describe, bench } from 'vitest'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'
import { parse } from '../src/parser.js'
import { compile } from '../src/compiler.js'
import { evaluate } from '../src/evaluator.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'

const expr = bonsai()
expr.use(strings)
expr.use(arrays)
expr.use(math)

const context = { user: { name: 'Dan', age: 30, verified: true } }

describe('overhead: literal 42', () => {
  const compiled = expr.compile('42')
  const ast = compile(parse('42'))
  const policy = new SecurityPolicy()
  const transforms = {}
  const functions = {}

  bench('via evaluateSync (full path)', () => {
    compiled.evaluateSync({})
  })
  bench('raw evaluate (no cache lookup)', () => {
    evaluate(ast, {}, { transforms, functions, contextFunctions: {} }, new ExecutionContext(policy))
  })
  bench('baseline: just return 42', () => {
    const node = ast as { value: number }
    node.value
  })
})

describe('overhead: property access user.name', () => {
  const compiled = expr.compile('user.name')
  const ast = compile(parse('user.name'))
  const policy = new SecurityPolicy()

  bench('via evaluateSync (full path)', () => {
    compiled.evaluateSync(context)
  })
  bench('raw evaluate (no cache lookup)', () => {
    evaluate(ast, context, { transforms: {}, functions: {}, contextFunctions: {} }, new ExecutionContext(policy))
  })
})

describe('overhead: comparison user.age >= 18 && user.verified', () => {
  const compiled = expr.compile('user.age >= 18 && user.verified')
  const ast = compile(parse('user.age >= 18 && user.verified'))
  const policy = new SecurityPolicy()

  bench('via evaluateSync (full path)', () => {
    compiled.evaluateSync(context)
  })
  bench('raw evaluate (no cache lookup)', () => {
    evaluate(ast, context, { transforms: {}, functions: {}, contextFunctions: {} }, new ExecutionContext(policy))
  })
})
