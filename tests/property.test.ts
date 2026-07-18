import { describe, expect } from 'vitest'
import { deepStrictEqual } from 'node:assert/strict'
import { it, fc } from '@fast-check/vitest'
import { compile } from '../src/compiler.js'
import { ExpressionError } from '../src/errors.js'
import { evaluate } from '../src/evaluator.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { bonsai } from '../src/index.js'
import { arrays, strings, math } from '../src/stdlib/index.js'

// Fixed seeds keep CI runs deterministic and reproducible. On failure fast-check
// shrinks the generated source to a minimal counterexample and prints the seed
// plus a repro path, so a regression points straight at the smallest breaking
// expression instead of whatever large form the generator happened to emit.
const SEED_EXPRESSION = 0xc0ffee
const SEED_HOF = 0x5eed01
const SEED_SHAPE = 0x5ea9e0
const SEED_FUZZ = 0xbad5eed

type Outcome = { ok: true; value: unknown } | { ok: false; name: string; message: string }

const CONTEXT = {
  num: 3,
  other: 7,
  text: 'hello',
  flag: true,
  maybe: null,
  items: [1, 2, 3],
  user: {
    age: 30,
    name: 'Dan',
    verified: true,
    profile: { city: 'London', code: 42 },
  },
} as const

const ATOMS = [
  '0',
  '1',
  '2',
  '7',
  '"x"',
  '"hello"',
  'true',
  'false',
  'null',
  'undefined',
  'num',
  'other',
  'text',
  'flag',
  'maybe',
  'items[0]',
  'items[1]',
  'user.age',
  'user.name',
  'user.verified',
  'user.profile.city',
  'user?.profile?.code',
] as const

const BINARY_OPERATORS = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '&&',
  '||',
  '??',
] as const

const UNARY_OPERATORS = ['!', '-', '+'] as const
const MEMBERSHIP_OPERATORS = ['in', 'not in'] as const
const MEMBERSHIP_RIGHT = ['items', '"hello"', '["x", "hello"]'] as const

function captureOutcome(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    return { ok: false, name: err.name, message: err.message }
  }
}

async function captureAsyncOutcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    return { ok: false, name: err.name, message: err.message }
  }
}

// Recursive expression grammar. fc.letrec ties the `expr` rule to itself and the
// `maxDepth` constraint bounds nesting; at the depth limit oneof falls back to
// the terminating `atom` branch. Weights mirror the original generator's roll
// buckets so the distribution of forms stays comparable.
const { expr: expressionArbitrary } = fc.letrec<{ expr: string }>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3, depthSize: 'medium' },
    { weight: 4, arbitrary: fc.constantFrom(...ATOMS) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom(...UNARY_OPERATORS), tie('expr'))
        .map(([operator, operand]) => `(${operator}${operand})`),
    },
    {
      weight: 6,
      arbitrary: fc
        .tuple(tie('expr'), fc.constantFrom(...BINARY_OPERATORS), tie('expr'))
        .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(
          tie('expr'),
          fc.constantFrom(...MEMBERSHIP_OPERATORS),
          fc.constantFrom(...MEMBERSHIP_RIGHT),
        )
        .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(tie('expr'), tie('expr'), tie('expr'))
        .map(
          ([condition, consequent, alternative]) =>
            `(${condition} ? ${consequent} : ${alternative})`,
        ),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.array(tie('expr'), { minLength: 1, maxLength: 4 }), fc.boolean())
        .map(([parts, spread]) => `[${[...parts, ...(spread ? ['...items'] : [])].join(', ')}]`),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(tie('expr'), tie('expr')).map(([a, b]) => `{ a: ${a}, b: ${b} }`),
    },
    {
      weight: 1,
      arbitrary: tie('expr').map((inner) => `\`value:\${${inner}}\``),
    },
  ),
}))

describe('property-based evaluator invariants', () => {
  const expr = bonsai()

  it.prop([expressionArbitrary], { seed: SEED_EXPRESSION, numRuns: 250 })(
    'keeps parse, compile, sync, and async evaluation aligned across generated expressions',
    async (source) => {
      const parsed = parse(source)
      deepStrictEqual(parse(source), parsed)

      const optimized = compile(parsed)
      const compiled = expr.compile(source)
      const direct = captureOutcome(() =>
        evaluate(
          parsed,
          { ...CONTEXT },
          { transforms: {}, functions: {} },
          new ExecutionContext(new SecurityPolicy()),
        ),
      )
      const optimizedDirect = captureOutcome(() =>
        evaluate(
          optimized,
          { ...CONTEXT },
          { transforms: {}, functions: {} },
          new ExecutionContext(new SecurityPolicy()),
        ),
      )
      const syncResult = captureOutcome(() => expr.evaluateSync(source, { ...CONTEXT }))
      const compiledResult = captureOutcome(() => compiled.evaluateSync({ ...CONTEXT }))
      const asyncResult = await captureAsyncOutcome(() => expr.evaluate(source, { ...CONTEXT }))

      expect(optimizedDirect).toEqual(direct)
      expect(syncResult).toEqual(direct)
      expect(compiledResult).toEqual(direct)
      expect(asyncResult).toEqual(direct)
    },
  )
})

// Higher-order coverage: the base property test never registers transforms or
// generates pipes/methods/lambdas, so the async-array-method path is unguarded
// by the parity invariant. These generators exercise transforms, stdlib
// functions, pipe chains, method chains, and lambdas through both evaluators.
const HOF_CONTEXT = {
  items: [1, 2, 3, 4],
  nums: [3, 1, 2],
  users: [
    { age: 30, name: 'Dan', active: true },
    { age: 15, name: 'Eve', active: false },
    { age: 40, name: 'Sam', active: true },
  ],
  text: 'hello world',
} as const

const NUM_LAMBDAS = ['. > 1', '. * 2', '. + 1', '. % 2 == 0'] as const
const USER_LAMBDAS = ['.age', '.name', '.active', '.age > 18', '.age >= 18 && .active'] as const
const ARRAY_REDUCERS = [
  'count',
  'first',
  'last',
  'reverse',
  'unique',
  'sort',
  'sum',
  'avg',
] as const
const NUM_TRANSFORMS = ['round', 'floor', 'ceil', 'abs'] as const
const HOF_METHODS = ['map', 'filter', 'find', 'some', 'every', 'flatMap'] as const

// Numeric pipe pipeline: items |> map/filter(...) |> reducer? |> numTransform?
const numericPipeArbitrary = fc
  .tuple(
    fc.array(fc.tuple(fc.constantFrom('map', 'filter'), fc.constantFrom(...NUM_LAMBDAS)), {
      minLength: 1,
      maxLength: 2,
    }),
    fc.option(fc.constantFrom(...ARRAY_REDUCERS), { nil: undefined }),
    fc.option(fc.constantFrom(...NUM_TRANSFORMS), { nil: undefined }),
  )
  .map(([ops, reducer, transform]) => {
    let source = 'items'
    for (const [method, lambda] of ops) source += ` |> ${method}(${lambda})`
    if (reducer) source += ` |> ${reducer}`
    if (transform) source += ` |> ${transform}`
    return source
  })

// User pipe pipeline: users |> filter(...)? |> map(...)? |> count?
const userPipeArbitrary = fc
  .tuple(
    fc.option(fc.constantFrom(...USER_LAMBDAS), { nil: undefined }),
    fc.option(fc.constantFrom(...USER_LAMBDAS), { nil: undefined }),
    fc.boolean(),
  )
  .map(([filterLambda, mapLambda, count]) => {
    let source = 'users'
    if (filterLambda) source += ` |> filter(${filterLambda})`
    if (mapLambda) source += ` |> map(${mapLambda})`
    if (count) source += ' |> count'
    return source
  })

// Method chaining: base.method(lambda).method(lambda)
const methodChainArbitrary = fc.constantFrom('items', 'nums', 'users').chain((base) => {
  const lambdas = base === 'users' ? USER_LAMBDAS : NUM_LAMBDAS
  return fc
    .array(fc.tuple(fc.constantFrom(...HOF_METHODS), fc.constantFrom(...lambdas)), {
      minLength: 1,
      maxLength: 2,
    })
    .map((ops) => {
      let source: string = base
      for (const [method, lambda] of ops) source += `.${method}(${lambda})`
      return source
    })
})

const hofArbitrary = fc.oneof(
  { weight: 4, arbitrary: numericPipeArbitrary },
  { weight: 3, arbitrary: userPipeArbitrary },
  { weight: 3, arbitrary: methodChainArbitrary },
)

describe('property-based higher-order parity', () => {
  const expr = bonsai().use(arrays).use(strings).use(math)

  it.prop([hofArbitrary], { seed: SEED_HOF, numRuns: 400 })(
    'keeps sync, async, and compiled aligned across generated transforms, methods, and lambdas',
    async (source) => {
      const syncResult = captureOutcome(() => expr.evaluateSync(source, { ...HOF_CONTEXT }))
      const asyncResult = await captureAsyncOutcome(() => expr.evaluate(source, { ...HOF_CONTEXT }))
      const compiled = expr.compile(source)
      const compiledSync = captureOutcome(() => compiled.evaluateSync({ ...HOF_CONTEXT }))
      const compiledAsync = await captureAsyncOutcome(() => compiled.evaluate({ ...HOF_CONTEXT }))

      expect(asyncResult, source).toEqual(syncResult)
      expect(compiledSync, source).toEqual(syncResult)
      expect(compiledAsync, source).toEqual(syncResult)
    },
  )
})

// Structure-aware equality: `toEqual` treats a hole and an `undefined` element
// as equal and ignores the constructor, so it cannot see the sparse-hole or
// Symbol.species differences that async higher-order parity must preserve. This
// compares length, exact present-index sets, element values, and constructor.
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    if (a.constructor !== b.constructor) return false // Symbol.species
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((k, i) => k === bk[i] && structurallyEqual(a[k as never], b[k as never]))
  }
  return Object.is(a, b)
}

// The async evaluator hand-reimplements higher-order methods, so parity depends
// on the receiver's shape (dense vs sparse vs subclass), not just the method.
// This fuzzes that dimension — which the generator above (dense arrays only)
// does not — and compares with structural equality so hole/species drift fails.
const HOLE = Symbol('hole')
const shapedArrayArbitrary = fc
  .array(fc.oneof(fc.integer({ min: -5, max: 5 }), fc.constant(HOLE)), { maxLength: 8 })
  .chain((cells) =>
    fc.constantFrom('dense', 'sparse', 'subclass').map((kind) => {
      const base = kind === 'sparse' ? cells : cells.filter((c) => c !== HOLE)
      const arr = kind === 'subclass' ? class Bag extends Array {}.of() : []
      base.forEach((c, i) => {
        if (c !== HOLE) arr[i] = c // a HOLE index is left unset -> a real hole
      })
      return arr as number[]
    }),
  )

const SHAPE_METHODS = [
  'map(. * 2)',
  'filter(. % 2 == 0)',
  'find(. > 0)',
  'findIndex(. > 0)',
  'some(. > 0)',
  'every(. > 0)',
  'flatMap(. * 2)',
] as const

describe('property-based higher-order parity across array shapes', () => {
  const expr = bonsai()

  it.prop([shapedArrayArbitrary, fc.constantFrom(...SHAPE_METHODS)], {
    seed: SEED_SHAPE,
    numRuns: 400,
  })(
    'sync and async agree structurally for dense, sparse, and subclass receivers',
    async (items, call) => {
      const source = `items.${call}`
      // These lambdas do not mutate, so a shared context is safe.
      const sync = captureOutcome(() => expr.evaluateSync(source, { items }))
      const asyncResult = await captureAsyncOutcome(() => expr.evaluate(source, { items }))

      expect(asyncResult.ok, source).toBe(sync.ok)
      if (sync.ok && asyncResult.ok) {
        expect(structurallyEqual(asyncResult.value, sync.value), source).toBe(true)
      } else if (!sync.ok && !asyncResult.ok) {
        expect(asyncResult.name, source).toBe(sync.name)
      }
    },
  )
})

const JUNK_CHARS =
  '()[]{}?:.,|&!=<>+-*/%\'"`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$ \t\n'.split(
    '',
  )

// Random junk drawn from the language's own character set: ill-formed but
// plausibly tokenizable. The invariant is that the parser fails cleanly with an
// ExpressionError and never leaks a raw runtime error.
const junkArbitrary = fc
  .array(fc.constantFrom(...JUNK_CHARS), { maxLength: 64 })
  .map((chars) => chars.join(''))

describe('parser fuzzing', () => {
  it.prop([junkArbitrary], { seed: SEED_FUZZ, numRuns: 750 })(
    'throws only ExpressionError for malformed random sources',
    (source) => {
      try {
        parse(source)
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError)
      }
    },
  )
})
