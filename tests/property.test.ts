import { describe, expect, it } from 'vitest'
import { deepStrictEqual } from 'node:assert/strict'
import { compile } from '../src/compiler.js'
import { ExpressionError } from '../src/errors.js'
import { evaluate } from '../src/evaluator.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { bonsai } from '../src/index.js'

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
