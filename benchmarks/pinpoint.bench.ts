import { describe, bench } from 'vitest'
import { parse } from '../src/parser.js'
import { compile } from '../src/compiler.js'
import { evaluate } from '../src/evaluator.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'

const ctx = { user: { name: 'Dan', age: 30, verified: true } }
const tr = {}
const fn = {}
const policy = new SecurityPolicy()

describe('pinpoint: literal 42', () => {
  const ast = compile(parse('42'))

  bench('new ExecutionContext + evaluate', () => {
    evaluate(ast, {}, tr, fn, new ExecutionContext(policy))
  })

  bench('direct switch', () => {
    const node = ast as { type: string; value: number }
    switch (node.type) {
      case 'NumberLiteral':
        return node.value
    }
  })
})

describe('pinpoint: user.age >= 18 && user.verified', () => {
  const ast = compile(parse('user.age >= 18 && user.verified'))

  bench('new ExecutionContext each time', () => {
    evaluate(ast, ctx, tr, fn, new ExecutionContext(policy))
  })
})
