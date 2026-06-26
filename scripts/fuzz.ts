/**
 * Continuous fuzz harness for the Bonsai sandbox.
 *
 * The property tests in `tests/` run a fixed seed and a bounded number of cases
 * as part of the unit suite. This harness is the continuous complement: it
 * generates expressions with random seeds and high volume, weighted toward the
 * sandbox escape surface (dangerous keys, computed access, methods, spread,
 * pipes), and checks the threat-model invariants on every one.
 *
 * Invariants asserted for each generated expression:
 *   1. `parse` only ever throws `ExpressionError` (never a raw host error).
 *   2. Evaluation only throws a typed Bonsai error (no leaked host exception).
 *   3. No result escapes the sandbox (never a function or a host prototype).
 *   4. Synchronous and asynchronous evaluation agree (differential parity).
 *   5. Compiling first preserves semantics (constant folding changes nothing).
 * A separate property feeds random junk to `parse` to fuzz lexer/parser crashes.
 *
 * Usage: `bun run scripts/fuzz.ts [budgetMs]` (default 20000). On a violation it
 * prints the shrunk counterexample and seed and exits non-zero.
 */
import { performance } from 'node:perf_hooks'
import { deepStrictEqual } from 'node:assert/strict'
import fc from 'fast-check'
import { parse } from '../src/parser.js'
import { compile } from '../src/compiler.js'
import {
  ExpressionError,
  BonsaiSecurityError,
  BonsaiTypeError,
  BonsaiReferenceError,
} from '../src/errors.js'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'

const DEFAULT_BUDGET_MS = 20_000
const RUNS_PER_BATCH = 150
const MAX_SEED = 0x7fff_ffff
const DIFFERENTIAL_SEED_SALT = 0x55
const PARSER_SEED_SALT = 0xaa
const MS_PER_SECOND = 1000

const expr = bonsai()
expr.use(strings)
expr.use(arrays)
expr.use(math)

const CONTEXT = {
  num: 3,
  other: 7,
  text: 'hello',
  flag: true,
  maybe: null,
  items: [1, 2, 3],
  nums: [1, 2, 3],
  obj: { safe: 1 },
  user: { age: 30, name: 'Dan', verified: true, profile: { city: 'London', code: 42 } },
} as const

type Outcome = { ok: true; value: unknown } | { ok: false; name: string }

function capture(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, name: error instanceof Error ? error.name : 'Unknown' }
  }
}

async function captureAsync(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, name: error instanceof Error ? error.name : 'Unknown' }
  }
}

function isTypedBonsaiError(error: unknown): boolean {
  return (
    error instanceof ExpressionError ||
    error instanceof BonsaiSecurityError ||
    error instanceof BonsaiTypeError ||
    error instanceof BonsaiReferenceError
  )
}

// A pure expression with no function-returning extensions can never legitimately
// produce a function or a host prototype. Either would mean a method, transform,
// or the prototype chain leaked through the sandbox.
function isSandboxEscape(value: unknown): boolean {
  if (typeof value === 'function') return true
  return value === Object.prototype || value === Array.prototype || value === Function.prototype
}

function equalOutcome(a: Outcome, b: Outcome): boolean {
  if (a.ok && b.ok) {
    try {
      deepStrictEqual(a.value, b.value)
      return true
    } catch {
      return false
    }
  }
  if (!a.ok && !b.ok) return a.name === b.name
  return false
}

class FuzzViolation extends Error {}

function invariantsHold(source: string): boolean {
  let parsed
  try {
    parsed = parse(source)
  } catch (error) {
    if (error instanceof ExpressionError) return true // a rejected parse is fine
    throw new FuzzViolation(`parse threw ${String(error)}`)
  }

  try {
    compile(parsed)
  } catch (error) {
    if (isTypedBonsaiError(error)) return true
    throw new FuzzViolation(`compile threw ${String(error)}`)
  }

  const sync = capture(() => expr.evaluateSync(source, CONTEXT))
  if (!sync.ok) return true // a typed rejection is captured by name below via parity
  if (isSandboxEscape(sync.value)) {
    throw new FuzzViolation(`result escaped the sandbox: ${typeof sync.value}`)
  }
  return true
}

async function differentialHolds(source: string): Promise<boolean> {
  const sync = capture(() => expr.evaluateSync(source, CONTEXT))
  if (!sync.ok && !isTypedErrorOutcome(source)) {
    throw new FuzzViolation('sync evaluation threw a non-Bonsai error')
  }
  const asyncOutcome = await captureAsync(() => expr.evaluate(source, CONTEXT))
  if (!equalOutcome(sync, asyncOutcome)) {
    throw new FuzzViolation('synchronous and asynchronous evaluation diverged')
  }
  const viaCompiled = capture(() => expr.compile(source).evaluateSync(CONTEXT))
  if (!equalOutcome(sync, viaCompiled)) {
    throw new FuzzViolation('compiling first changed the result')
  }
  return true
}

// Re-run the raw throw to classify it: a thrown value that is not a typed Bonsai
// error is a leaked host exception and a real violation.
function isTypedErrorOutcome(source: string): boolean {
  try {
    expr.evaluateSync(source, CONTEXT)
    return true
  } catch (error) {
    return isTypedBonsaiError(error)
  }
}

function parseRobust(source: string): boolean {
  try {
    parse(source)
    return true
  } catch (error) {
    if (error instanceof ExpressionError) return true
    throw new FuzzViolation(`parse threw a non-ExpressionError: ${String(error)}`)
  }
}

const ATOMS = [
  '0',
  '1',
  '7',
  '"x"',
  '"hello"',
  'true',
  'null',
  'undefined',
  'num',
  'text',
  'flag',
  'maybe',
  'items',
  'nums',
  'items[0]',
  'user',
  'user.age',
  'user.profile',
  'user?.profile?.code',
] as const

const BINARY_OPERATORS = ['+', '-', '*', '/', '%', '==', '!=', '<', '>=', '&&', '||', '??'] as const
const UNARY_OPERATORS = ['!', '-', '+'] as const
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'] as const
const NAV_BASES = ['user', 'user.profile', 'items', 'text', 'num', 'obj'] as const
const METHOD_FORMS = [
  'text.toUpperCase()',
  'text.trim()',
  'text.slice(1)',
  'text.split("")',
  'nums.join("-")',
  'nums.toSorted()',
  'nums.map(. * 2)',
  'nums.filter(. > 2)',
  'nums.find(. >= 3)',
  'nums.some(. > 4)',
  'text |> upper',
  'nums |> sum',
] as const

// Recursive expression grammar weighted toward the escape surface: dangerous-key
// access (static, computed, and chained), object literals with computed keys,
// methods, spread, and pipes, on top of the operator/ternary core.
const { expr: expressionArbitrary } = fc.letrec<{ expr: string }>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 4, depthSize: 'medium' },
    { weight: 5, arbitrary: fc.constantFrom(...ATOMS) },
    { weight: 3, arbitrary: fc.constantFrom(...METHOD_FORMS) },
    {
      weight: 3,
      arbitrary: fc
        .tuple(fc.constantFrom(...NAV_BASES), fc.constantFrom(...DANGEROUS_KEYS))
        .map(([base, key]) => `${base}.${key}`),
    },
    {
      weight: 3,
      arbitrary: fc
        .tuple(fc.constantFrom(...NAV_BASES), fc.constantFrom(...DANGEROUS_KEYS))
        .map(([base, key]) => `${base}[${JSON.stringify(key)}]`),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(...DANGEROUS_KEYS).map((key) => `{ [${JSON.stringify(key)}]: 1 }`),
    },
    {
      weight: 2,
      arbitrary: fc.constantFrom(...NAV_BASES).map((base) => `${base}.constructor.constructor`),
    },
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
        .tuple(tie('expr'), tie('expr'), tie('expr'))
        .map(([test, consequent, alternate]) => `(${test} ? ${consequent} : ${alternate})`),
    },
    {
      weight: 2,
      arbitrary: fc
        .array(tie('expr'), { minLength: 1, maxLength: 4 })
        .map((parts) => `[${[...parts, '...items'].join(', ')}]`),
    },
    {
      weight: 2,
      arbitrary: tie('expr').map((base) => `(${base})[num]`),
    },
  ),
}))

// Junk targeted at the lexer/parser: random text plus structured fragments of
// operators, brackets, and keywords that are more likely to reach deep parser
// states than uniform random strings.
const junkArbitrary = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary', maxLength: 64 }),
  fc
    .array(
      fc.constantFrom(
        '(',
        ')',
        '.',
        '?.',
        '[',
        ']',
        '+',
        '|>',
        '?',
        ':',
        '__proto__',
        'map',
        '"',
        '`',
        '${',
        '}',
        ',',
        '...',
        ' ',
      ),
      { maxLength: 48 },
    )
    .map((parts) => parts.join('')),
)

function reportAndExit(label: string, details: fc.RunDetails<[string]>): never {
  process.stdout.write(`✗ fuzz violation in ${label}\n`)
  const counterexample = details.counterexample
  if (counterexample) {
    process.stdout.write(`  counterexample: ${JSON.stringify(counterexample[0])}\n`)
  }
  process.stdout.write(`  seed: ${details.seed}  path: ${details.counterexamplePath ?? ''}\n`)
  const detail = details as unknown as { errorInstance?: unknown }
  const message = detail.errorInstance instanceof Error ? detail.errorInstance.message : 'unknown'
  process.stdout.write(`  error: ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const budgetMs = Number(process.argv[2] ?? process.env.FUZZ_MS ?? DEFAULT_BUDGET_MS)
  const started = performance.now()
  let totalCases = 0
  let batches = 0

  while (performance.now() - started < budgetMs) {
    const seed = Math.floor(Math.random() * MAX_SEED)

    const escape = fc.check(fc.property(expressionArbitrary, invariantsHold), {
      numRuns: RUNS_PER_BATCH,
      seed,
    })
    if (escape.failed) reportAndExit('sandbox invariants', escape)

    const differential = await fc.check(fc.asyncProperty(expressionArbitrary, differentialHolds), {
      numRuns: RUNS_PER_BATCH,
      seed: seed ^ DIFFERENTIAL_SEED_SALT,
    })
    if (differential.failed) reportAndExit('sync/async/compile parity', differential)

    const parser = fc.check(fc.property(junkArbitrary, parseRobust), {
      numRuns: RUNS_PER_BATCH,
      seed: seed ^ PARSER_SEED_SALT,
    })
    if (parser.failed) reportAndExit('parser robustness', parser)

    totalCases += escape.numRuns + differential.numRuns + parser.numRuns
    batches += 1
  }

  const seconds = Math.round((performance.now() - started) / MS_PER_SECOND)
  process.stdout.write(
    `✓ fuzz: ${totalCases} cases across ${batches} batches in ${seconds}s, no violations\n`,
  )
}

await main()
