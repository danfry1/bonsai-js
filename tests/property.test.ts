import { describe, expect, it } from 'vitest'
import { deepStrictEqual } from 'node:assert/strict'
import { compile } from '../src/compiler.js'
import { ExpressionError } from '../src/errors.js'
import { evaluate } from '../src/evaluator.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { bonsai } from '../src/index.js'
import { arrays, strings, math } from '../src/stdlib/index.js'

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string }

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)]
}

function int(rand: () => number, max: number): number {
  return Math.floor(rand() * max)
}

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

function makeArray(rand: () => number, depth: number): string {
  const count = 1 + int(rand, 3)
  const parts = Array.from({ length: count }, () => generateExpression(rand, depth - 1))
  if (rand() < 0.35) {
    parts.push('...items')
  }
  return `[${parts.join(', ')}]`
}

function makeObject(rand: () => number, depth: number): string {
  return `{ a: ${generateExpression(rand, depth - 1)}, b: ${generateExpression(rand, depth - 1)} }`
}

function makeTemplate(rand: () => number, depth: number): string {
  return `\`value:${'${'}${generateExpression(rand, depth - 1)}${'}'}\``
}

function generateExpression(rand: () => number, depth: number): string {
  if (depth <= 0) {
    return pick(rand, ATOMS)
  }

  const roll = rand()
  if (roll < 0.2) return pick(rand, ATOMS)
  if (roll < 0.32) return `(${pick(rand, ['!', '-', '+'] as const)}${generateExpression(rand, depth - 1)})`
  if (roll < 0.62) {
    const left = generateExpression(rand, depth - 1)
    const operator = pick(rand, BINARY_OPERATORS)
    const right = generateExpression(rand, depth - 1)
    return `(${left} ${operator} ${right})`
  }
  if (roll < 0.72) {
    const left = generateExpression(rand, depth - 1)
    const operator = pick(rand, ['in', 'not in'] as const)
    const right = pick(rand, MEMBERSHIP_RIGHT)
    return `(${left} ${operator} ${right})`
  }
  if (roll < 0.82) {
    return `(${generateExpression(rand, depth - 1)} ? ${generateExpression(rand, depth - 1)} : ${generateExpression(rand, depth - 1)})`
  }
  if (roll < 0.9) return makeArray(rand, depth)
  if (roll < 0.97) return makeObject(rand, depth)
  return makeTemplate(rand, depth)
}

function randomJunk(rand: () => number): string {
  const chars = '()[]{}?:.,|&!=<>+-*/%\'"`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$ \t\n'
  const length = int(rand, 64)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += chars[int(rand, chars.length)]
  }
  return out
}

describe('property-based evaluator invariants', () => {
  it('keeps parse, compile, sync, and async evaluation aligned across generated expressions', async () => {
    const expr = bonsai()
    const rand = mulberry32(0xC0FFEE)

    for (let i = 0; i < 250; i++) {
      const source = generateExpression(rand, 3)
      const parsed = parse(source)
      deepStrictEqual(parse(source), parsed)

      const optimized = compile(parsed)
      const compiled = expr.compile(source)
      const direct = captureOutcome(() => evaluate(parsed, { ...CONTEXT }, { transforms: {}, functions: {} }, new ExecutionContext(new SecurityPolicy())))
      const optimizedDirect = captureOutcome(() => evaluate(optimized, { ...CONTEXT }, { transforms: {}, functions: {} }, new ExecutionContext(new SecurityPolicy())))
      const syncResult = captureOutcome(() => expr.evaluateSync(source, { ...CONTEXT }))
      const compiledResult = captureOutcome(() => compiled.evaluateSync({ ...CONTEXT }))
      const asyncResult = await captureAsyncOutcome(() => expr.evaluate(source, { ...CONTEXT }))

      expect(optimizedDirect).toEqual(direct)
      expect(syncResult).toEqual(direct)
      expect(compiledResult).toEqual(direct)
      expect(asyncResult).toEqual(direct)
    }
  })
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
const ARRAY_REDUCERS = ['count', 'first', 'last', 'reverse', 'unique', 'sort', 'sum', 'avg'] as const
const NUM_TRANSFORMS = ['round', 'floor', 'ceil', 'abs'] as const
const HOF_METHODS = ['map', 'filter', 'find', 'some', 'every', 'flatMap'] as const

function generateHof(rand: () => number): string {
  const style = rand()

  // Numeric pipe pipeline: items |> map/filter(...) |> reducer |> numTransform
  if (style < 0.4) {
    let e = 'items'
    const ops = 1 + int(rand, 2)
    for (let i = 0; i < ops; i++) {
      e += ` |> ${pick(rand, ['map', 'filter'] as const)}(${pick(rand, NUM_LAMBDAS)})`
    }
    if (rand() < 0.7) e += ` |> ${pick(rand, ARRAY_REDUCERS)}`
    if (rand() < 0.4) e += ` |> ${pick(rand, NUM_TRANSFORMS)}`
    return e
  }

  // User pipe pipeline
  if (style < 0.7) {
    let e = 'users'
    if (rand() < 0.85) e += ` |> filter(${pick(rand, USER_LAMBDAS)})`
    if (rand() < 0.85) e += ` |> map(${pick(rand, USER_LAMBDAS)})`
    if (rand() < 0.4) e += ' |> count'
    return e
  }

  // Method chaining: base.method(lambda).method(lambda)
  const base = pick(rand, ['items', 'nums', 'users'] as const)
  const lambdas = base === 'users' ? USER_LAMBDAS : NUM_LAMBDAS
  let e: string = base
  const ops = 1 + int(rand, 2)
  for (let i = 0; i < ops; i++) {
    e += `.${pick(rand, HOF_METHODS)}(${pick(rand, lambdas)})`
  }
  return e
}

describe('property-based higher-order parity', () => {
  it('keeps sync, async, and compiled aligned across generated transforms, methods, and lambdas', async () => {
    const expr = bonsai().use(arrays).use(strings).use(math)
    const rand = mulberry32(0x5EED01)

    for (let i = 0; i < 400; i++) {
      const source = generateHof(rand)
      const syncResult = captureOutcome(() => expr.evaluateSync(source, { ...HOF_CONTEXT }))
      const asyncResult = await captureAsyncOutcome(() => expr.evaluate(source, { ...HOF_CONTEXT }))
      const compiled = expr.compile(source)
      const compiledSync = captureOutcome(() => compiled.evaluateSync({ ...HOF_CONTEXT }))
      const compiledAsync = await captureAsyncOutcome(() => compiled.evaluate({ ...HOF_CONTEXT }))

      expect(asyncResult, source).toEqual(syncResult)
      expect(compiledSync, source).toEqual(syncResult)
      expect(compiledAsync, source).toEqual(syncResult)
    }
  })
})

describe('parser fuzzing', () => {
  it('throws only ExpressionError for malformed random sources', () => {
    const rand = mulberry32(0xBAD5EED)

    for (let i = 0; i < 750; i++) {
      const source = randomJunk(rand)
      try {
        parse(source)
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError)
      }
    }
  })
})
