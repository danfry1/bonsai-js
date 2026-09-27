/**
 * Continuous fuzz harness for the Bonsai language.
 *
 * The property tests in `tests/` run a fixed seed and a bounded number of cases
 * as part of the unit suite. This harness is the continuous complement: it
 * generates expressions from a small grammar of the language (literals,
 * variables, member and index access, operators, ternaries, lists, maps,
 * templates, `let`, `try`, `has`, and built-in method calls with implicit `.`
 * lambdas) over random JSON-ish contexts, with random seeds and high volume.
 *
 * Properties asserted for each generated expression:
 *   (a) Only Bonsai errors escape: every thrown error is a `BonsaiError`, from
 *       parsing, checking, evaluation, and the language service.
 *   (b) `evaluateSync`, `await evaluate`, and `compile().evaluateSync` agree:
 *       the same value, or an error with the same code.
 *   (c) Soundness probe: when an environment whose declared variable types
 *       match the context accepts the expression (`check(source).ok`),
 *       evaluation never fails with TYPE_ERROR, NO_OVERLOAD, or NULL_RECEIVER,
 *       and the value conforms to the inferred type (and to an `expect` type
 *       the expression was accepted against). Contexts may carry keys their
 *       declared objects do not list, as database rows do. Findings are
 *       collected, de-duplicated, and printed with the shortest source seen
 *       for each.
 * A separate property feeds random junk to the parser, checker, and language
 * service to fuzz for crashes.
 *
 * Usage: `bun run scripts/fuzz.ts [budgetMs]` (default 20000, or FUZZ_MS). On
 * a violation it prints the counterexample and seed and exits non-zero.
 */
import { performance } from 'node:perf_hooks'
import { deepStrictEqual } from 'node:assert/strict'
import fc from 'fast-check'
import { analyze } from '../src/check/checker.js'
import { internalsOf } from '../src/environment.js'
import { describeMismatch, type ValidationBudget } from '../src/functions/define.js'
import {
  print,
  type Diagnostic,
  type Node,
  bonsai,
  fn,
  isBonsaiError,
  t,
  type Type,
} from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'
import { parse } from '../src/syntax/parser.js'

const DEFAULT_BUDGET_MS = 20_000
const RUNS_PER_BATCH = 150
const MAX_SEED = 0x7fff_ffff
const DIFFERENTIAL_SEED_SALT = 0x55
const JUNK_SEED_SALT = 0xaa
const MS_PER_SECOND = 1000
const MAX_SMALL_INT = 100
const MAX_LIST_LENGTH = 8
const MAX_DOUBLE = 1e6
const FIXED_CLOCK = new Date('2026-01-01T00:00:00.000Z')
const MIN_DATE = new Date('1990-01-01T00:00:00.000Z')
const MAX_DATE = new Date('2040-01-01T00:00:00.000Z')
const SOUNDNESS_CODES = new Set(['TYPE_ERROR', 'NO_OVERLOAD', 'NULL_RECEIVER'])

// === Types of generated variables ===

type Desc =
  | { readonly kind: 'number' | 'string' | 'boolean' | 'timestamp' | 'enum' }
  | { readonly kind: 'optional'; readonly inner: Desc }
  | { readonly kind: 'list'; readonly element: Desc }
  | { readonly kind: 'object'; readonly fields: readonly (readonly [string, Desc])[] }

const FIELD_NAMES = ['id', 'name', 'active', 'price', 'qty', 'tags', 'inner'] as const
const PLAN = t.enum('free', 'pro')

const { desc: descArbitrary } = fc.letrec<{ desc: Desc }>((tie) => ({
  desc: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    {
      weight: 6,
      arbitrary: fc.constantFrom<Desc>(
        { kind: 'number' },
        { kind: 'string' },
        { kind: 'boolean' },
        { kind: 'timestamp' },
        { kind: 'enum' },
      ),
    },
    { weight: 2, arbitrary: tie('desc').map((inner): Desc => ({ kind: 'optional', inner })) },
    { weight: 2, arbitrary: tie('desc').map((element): Desc => ({ kind: 'list', element })) },
    {
      weight: 3,
      arbitrary: fc
        .uniqueArray(fc.tuple(fc.constantFrom(...FIELD_NAMES), tie('desc')), {
          minLength: 1,
          maxLength: 3,
          selector: ([name]) => name,
        })
        .map((fields): Desc => ({ kind: 'object', fields })),
    },
  ),
}))

function unreachable(value: never): never {
  throw new Error(`Unexpected type descriptor ${JSON.stringify(value)}`)
}

function toType(desc: Desc): Type {
  switch (desc.kind) {
    case 'number':
      return t.number()
    case 'string':
      return t.string()
    case 'boolean':
      return t.boolean()
    case 'timestamp':
      return t.timestamp()
    case 'enum':
      return PLAN
    case 'optional':
      return t.optional(toType(desc.inner))
    case 'list':
      return t.list(toType(desc.element))
    case 'object':
      return t.object(Object.fromEntries(desc.fields.map(([name, field]) => [name, toType(field)])))
    default:
      return unreachable(desc)
  }
}

const numberValue = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -MAX_SMALL_INT, max: MAX_SMALL_INT }) },
  { weight: 1, arbitrary: fc.double({ min: -MAX_DOUBLE, max: MAX_DOUBLE, noNaN: true }) },
)
const stringValue = fc.oneof(
  fc.constantFrom('', 'a', 'vip', 'GB', 'hello world', '__proto__', '-'),
  fc.string({ maxLength: 6 }),
)

function valueFor(desc: Desc): fc.Arbitrary<unknown> {
  switch (desc.kind) {
    case 'number':
      return numberValue
    case 'string':
      return stringValue
    case 'boolean':
      return fc.boolean()
    case 'timestamp':
      return fc.date({ min: MIN_DATE, max: MAX_DATE, noInvalidDate: true })
    case 'enum':
      return fc.constantFrom('free', 'pro')
    case 'optional':
      return fc.option(valueFor(desc.inner), { nil: null })
    case 'list':
      // Longer than reduce's re-check limit, so an accumulator can outgrow it.
      return fc.array(valueFor(desc.element), { maxLength: MAX_LIST_LENGTH })
    case 'object':
      // Declared objects are open: records carry keys their type does not list.
      return fc
        .tuple(
          fc.record(
            Object.fromEntries(desc.fields.map(([name, field]) => [name, valueFor(field)])),
          ),
          fc.option(fc.jsonValue({ maxDepth: 2 }), { nil: undefined }),
        )
        .map(([record, extra]) => (extra === undefined ? record : { ...record, extra }))
    default:
      return unreachable(desc)
  }
}

// Every readable path of a variable: the variable, its fields, and list items.
function pathsOf(desc: Desc, base: string, out: string[], depth = 0): void {
  out.push(base)
  if (depth > 2) return
  const target = desc.kind === 'optional' ? desc.inner : desc
  const dot = desc.kind === 'optional' ? '?.' : '.'
  if (target.kind === 'object') {
    for (const [name, field] of target.fields)
      pathsOf(field, `${base}${dot}${name}`, out, depth + 1)
  } else if (target.kind === 'list') {
    pathsOf(target.element, `${base}[0]`, out, depth + 1)
  }
}

// Fixed variables give every case a useful baseline; `v0`/`v1` add random shapes.
const FIXED_VARIABLES: readonly (readonly [string, Desc])[] = [
  ['n', { kind: 'number' }],
  ['s', { kind: 'string' }],
  ['flag', { kind: 'boolean' }],
  ['maybe', { kind: 'optional', inner: { kind: 'number' } }],
  ['xs', { kind: 'list', element: { kind: 'number' } }],
  ['when', { kind: 'timestamp' }],
  ['plan', { kind: 'enum' }],
  ['oplan', { kind: 'optional', inner: { kind: 'enum' } }],
  ['ps', { kind: 'list', element: { kind: 'enum' } }],
  [
    'items',
    {
      kind: 'list',
      element: {
        kind: 'object',
        fields: [
          ['id', { kind: 'number' }],
          ['name', { kind: 'string' }],
          ['active', { kind: 'boolean' }],
          ['price', { kind: 'number' }],
          ['tags', { kind: 'list', element: { kind: 'string' } }],
          ['tag', { kind: 'optional', inner: { kind: 'string' } }],
        ],
      },
    },
  ],
]

interface Scenario {
  readonly variables: readonly (readonly [string, Desc])[]
  readonly context: Record<string, unknown>
  /** Whether the context values match the declared types. */
  readonly typed: boolean
  readonly source: string
  /** A result type to check the expression against, for the `expect` probe. */
  readonly expect: Type
}

/** Honest host functions: each returns what it declares. */
const FUNCTIONS = {
  pick: fn({ params: [], returns: PLAN, run: () => 'pro' as const }),
  nums: fn({ params: [], returns: t.list(t.number()), run: () => [1, 2] }),
  half: fn({ params: [t.number()], returns: t.number(), run: (n: number) => n / 2 }),
  needA: fn({ params: [t.object({ a: t.number() })], returns: t.number(), run: (m) => m.a }),
  tags: fn({
    params: [t.record(t.string())],
    returns: t.number(),
    run: (m) => Object.keys(m).length,
  }),
  plans: fn({ params: [t.list(PLAN)], returns: t.number(), run: (l) => l.length }),
  onePlan: fn({ params: [PLAN], returns: t.number(), run: () => 1 }),
  optA: fn({
    params: [t.object({ id: t.number(), extra: t.optional(t.number()) })],
    returns: t.number(),
    run: (m) => (m.extra ?? 0) + 1,
  }),
}

const EXPECTS: readonly Type[] = [
  t.number(),
  t.string(),
  t.boolean(),
  PLAN,
  t.list(t.number()),
  t.list(PLAN),
  t.object({ id: t.number() }),
  t.record(t.number()),
  t.optional(t.string()),
  t.object({ id: t.number(), extra: t.optional(t.number()) }),
  t.list(t.optional(PLAN)),
  t.optional(PLAN),
]

// === Expression grammar ===

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
  'in',
  'not in',
] as const
const LITERALS = [
  '0',
  '1',
  '2',
  '-1',
  '2.5',
  '"a"',
  '"vip"',
  '""',
  '"free"',
  '"pro"',
  '"gold"',
  'true',
  'false',
  'null',
] as const
const NO_ARG_METHODS = [
  'length',
  'sum()',
  'avg()',
  'min()',
  'max()',
  'first()',
  'last()',
  'sort()',
  'reverse()',
  'unique()',
  'isEmpty()',
  'toUpperCase()',
  'trim()',
  'round()',
  'abs()',
  'toString()',
  'keys()',
  'type()',
  'flat()',
] as const
const ARG_METHODS = [
  'join("-")',
  'slice(1)',
  'at(-1)',
  'includes("a")',
  'includes(1)',
  'startsWith("a")',
  'split("")',
  'toFixed(1)',
  'clamp(0, 10)',
  'sort("desc")',
  'padStart(3, "0")',
] as const
const LAMBDA_METHODS = [
  'map',
  'filter',
  'some',
  'every',
  'find',
  'count',
  'sortBy',
  'flatMap',
] as const
const ITEM_ATOMS = [
  '.',
  '.id',
  '.name',
  '.active',
  '.price',
  '.tags',
  '.tag',
  '.extra',
  '[.]',
  '1',
  '"a"',
] as const
// Some accumulators never converge (`[acc, x]`, `{ v: acc }`): after reduce's
// re-check limit their type is `any` by design, so their results are gradual
// (checked at run time) rather than findings.
const REDUCERS = [
  'acc + x',
  'acc ?? x',
  '[acc, x]',
  'x',
  'acc',
  '{ a: acc, b: x }',
  'acc + 1 > 0 ? x : acc',
  'acc.toString() + x',
  '{ v: acc }',
  '[acc]',
  'flag ? x : acc',
  '{ ...acc, id: 1 }',
] as const
const SPREADS = [
  ['[...', ']'],
  ['{ id: 1, ...', ' }'],
  ['max(1, ...', ')'],
  ['max(...', ')'],
  ['half(...', ')'],
  ['join(...', ')'],
] as const
const HOST_CALLS = [
  ['half(', ')'],
  ['needA({ a: ', ' })'],
  ['tags(', ')'],
  ['plans([', '])'],
  ['plans(', ')'],
  ['onePlan(', ')'],
  ['optA(', ')'],
  ['reduce(items, (acc, x) => flag ? x : acc, ', ')'],
  ['values(', ')'],
] as const
const ITEM_OPERATORS = ['+', '*', '>', '>=', '==', '!=', '&&', '??'] as const
const LET_NAMES = ['q', 'r'] as const

// Implicit-lambda bodies: `.` and `.field` combined with operators.
const itemExpression = fc.oneof(
  fc.constantFrom(...ITEM_ATOMS),
  fc
    .tuple(
      fc.constantFrom(...ITEM_ATOMS),
      fc.constantFrom(...ITEM_OPERATORS),
      fc.constantFrom(...ITEM_ATOMS),
    )
    .map(([left, operator, right]) => `${left} ${operator} ${right}`),
  fc.constantFrom('.tags.length', '.name.length', '.tags.some(. == "vip")', '.price * 2 > 10'),
)

function expressionFor(paths: readonly string[]): fc.Arbitrary<string> {
  const atoms = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...LITERALS) },
    { weight: 5, arbitrary: fc.constantFrom(...paths) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        'now()',
        'days(1)',
        'hours(n)',
        'when - now()',
        'now() - when > days(30)',
        'pick()',
        'nums()',
        '{}',
        '{ id: 0 }',
        'items[0]',
      ),
    },
  )
  const { expr } = fc.letrec<{ expr: string }>((tie) => ({
    expr: fc.oneof(
      { maxDepth: 4, depthSize: 'medium' },
      { weight: 8, arbitrary: atoms },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.constantFrom('!', '-'), tie('expr'))
          .map(([operator, operand]) => `${operator}(${operand})`),
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
        arbitrary: fc.array(tie('expr'), { maxLength: 3 }).map((parts) => `[${parts.join(', ')}]`),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(tie('expr'), tie('expr'))
          .map(([first, second]) => `{ id: ${first}, name: ${second} }`),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(tie('expr'), tie('expr'))
          .map(([first, second]) => `\`v=\${${first}}/\${${second}}\``),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom(...LET_NAMES), tie('expr'), tie('expr'))
          .map(
            ([name, value, body]) =>
              `(let ${name} = ${value}; ${name} == null ? ${body} : ${name})`,
          ),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(tie('expr'), tie('expr'))
          .map(([body, fallback]) => `try(${body}, ${fallback})`),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom(...paths).map((path) => `has(${path.replaceAll('?.', '.')})`),
      },
      {
        weight: 1,
        arbitrary: fc.tuple(tie('expr'), tie('expr')).map(([object, key]) => `(${object})[${key}]`),
      },
      {
        weight: 3,
        arbitrary: fc
          .tuple(tie('expr'), fc.constantFrom(...NO_ARG_METHODS, ...ARG_METHODS), fc.boolean())
          .map(([receiver, method, optional]) => `(${receiver})${optional ? '?.' : '.'}${method}`),
      },
      {
        weight: 3,
        arbitrary: fc
          .tuple(tie('expr'), fc.constantFrom(...LAMBDA_METHODS), itemExpression)
          .map(([receiver, method, body]) => `(${receiver}).${method}(${body})`),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(tie('expr'), fc.constantFrom(...REDUCERS), tie('expr'))
          .map(([list, body, initial]) => `reduce(${list}, (acc, x) => ${body}, ${initial})`),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom(...SPREADS), tie('expr'))
          .map(([[open, close], inner]) => `${open}(${inner})${close}`),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom(...HOST_CALLS), tie('expr'))
          .map(([[open, close], arg]) => `${open}${arg}${close}`),
      },
    ),
  }))
  return expr
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .tuple(fc.array(descArbitrary, { maxLength: 2 }), fc.boolean())
  .chain(([extra, typed]) => {
    const variables = [
      ...FIXED_VARIABLES,
      ...extra.map((desc, index): readonly [string, Desc] => [`v${String(index)}`, desc]),
    ]
    const paths: string[] = []
    for (const [name, desc] of variables) pathsOf(desc, name, paths)
    // An untyped scenario reads arbitrary JSON; only property (c) needs the
    // values to match the declared types.
    const context = typed
      ? fc.record(Object.fromEntries(variables.map(([name, desc]) => [name, valueFor(desc)])))
      : fc.dictionary(
          fc.constantFrom(...variables.map(([name]) => name)),
          fc.jsonValue({ maxDepth: 3 }),
        )
    return fc
      .tuple(context, expressionFor(paths), fc.constantFrom(...EXPECTS))
      .map(([ctx, source, expect]) => ({ variables, context: ctx, typed, source, expect }))
  })

// === Properties ===

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; span?: { start: number; end: number } }

class FuzzViolation extends Error {}

function classify(error: unknown, label: string): Outcome {
  if (!isBonsaiError(error)) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new FuzzViolation(`${label} threw a non-Bonsai error: ${detail}`)
  }
  return { ok: false, code: error.code, message: error.message, span: error.span }
}

function capture(label: string, run: () => unknown): Outcome {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return classify(error, label)
  }
}

async function captureAsync(label: string, run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return classify(error, label)
  }
}

function describeOutcome(outcome: Outcome): string {
  if (!outcome.ok) return `error ${outcome.code}`
  try {
    return `value ${JSON.stringify(outcome.value)}`
  } catch {
    return 'value <unserializable>'
  }
}

function sameOutcome(a: Outcome, b: Outcome): boolean {
  if (a.ok && b.ok) {
    try {
      deepStrictEqual(a.value, b.value)
      return true
    } catch {
      return false
    }
  }
  if (!a.ok && !b.ok) return a.code === b.code
  return false
}

const clock = (): Date => FIXED_CLOCK
const openEnv = bonsai({ clock, functions: FUNCTIONS })
const typedEnvs = new Map<string, ReturnType<typeof bonsai>>()

function typedEnvFor(variables: Scenario['variables']): ReturnType<typeof bonsai> {
  const key = JSON.stringify(variables)
  let env = typedEnvs.get(key)
  if (env === undefined) {
    env = bonsai({
      clock,
      functions: FUNCTIONS,
      strict: true,
      variables: Object.fromEntries(variables.map(([name, desc]) => [name, toType(desc)])),
    })
    typedEnvs.set(key, env)
  }
  return env
}

interface Finding {
  readonly code: string
  message: string
  source: string
  context: string
  count: number
}

const findings = new Map<string, Finding>()

// Messages name the concrete operand kinds; strip quoted text and numbers so
// the same defect in different sources is reported once.
function findingKey(code: string, message: string): string {
  return `${code}:${message.replaceAll(/"[^"]*"/gu, '"…"').replaceAll(/-?\d+(?:\.\d+)?/gu, 'N')}`
}

function recordFinding(scenario: Scenario, outcome: Outcome & { ok: false }): void {
  const key = findingKey(outcome.code, outcome.message)
  const existing = findings.get(key)
  if (existing === undefined) {
    findings.set(key, {
      code: outcome.code,
      message: outcome.message,
      source: scenario.source,
      context: JSON.stringify(scenario.context),
      count: 1,
    })
    return
  }
  existing.count++
  if (scenario.source.length < existing.source.length) {
    existing.source = scenario.source
    existing.message = outcome.message
    existing.context = JSON.stringify(scenario.context)
  }
}

let soundnessChecked = 0

/** Whether a type has `any` inside it (types can share parts, so visit each once). */
function hasAny(type: Type, seen = new Set<Type>()): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  switch (type.kind) {
    case 'any':
      return true
    case 'list':
      return hasAny(type.element, seen)
    case 'map':
      return (
        (type.rest !== undefined && hasAny(type.rest, seen)) ||
        Object.values(type.fields).some((field) => hasAny(field, seen))
      )
    case 'union':
      return type.types.some((member) => hasAny(member, seen))
    case 'boolean':
    case 'duration':
    case 'function':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    case 'var':
    default:
      return false
  }
}

/**
 * Whether a failure inside `span` is gradual typing: some expression there has
 * a type the checker only knew as `any`, or a call there took an argument it
 * could only check at run time (an open object for an optional field).
 */
function isGradual(
  env: ReturnType<typeof bonsai>,
  source: string,
  span: { start: number; end: number } | undefined,
): boolean {
  if (span === undefined) return false
  const { checkEnv, parseLimits } = internalsOf(env)
  const analysis = analyze(parse(source, parseLimits), checkEnv)
  const inside = (node: { start: number; end: number }): boolean =>
    node.start >= span.start && node.end <= span.end
  for (const [node, type] of analysis.types) if (inside(node) && hasAny(type)) return true
  for (const [node, plan] of analysis.calls) if (inside(node) && plan.gradual === true) return true
  return false
}

const MISMATCH_STEPS = 1_000_000
const MISMATCH_DEPTH = 200

function mismatch(value: unknown, type: Type): string | undefined {
  const budget: ValidationBudget = {
    maxDepth: MISMATCH_DEPTH,
    remaining: MISMATCH_STEPS,
    deadline: 0,
    onExhausted: () => {
      throw new FuzzViolation('value too large to compare with its type')
    },
  }
  return describeMismatch(value, type, 'result', budget)
}

async function scenarioHolds(scenario: Scenario): Promise<boolean> {
  const { source, context } = scenario
  const envs = scenario.typed ? [openEnv, typedEnvFor(scenario.variables)] : [openEnv]
  for (const env of envs) {
    // (a) is enforced by capture(): any non-Bonsai throw is a violation.
    const checked = capture('check', () => env.check(source))
    if (!checked.ok) throw new FuzzViolation(`check threw ${checked.code} instead of reporting it`)

    const sync = capture('evaluateSync', () => env.evaluateSync(source, context))
    const viaAsync = await captureAsync('evaluate', () => env.evaluate(source, context))
    const viaCompiled = capture('compile().evaluateSync', () =>
      env.compile(source).evaluateSync(context),
    )

    // (b) the three evaluation paths agree.
    if (!sameOutcome(sync, viaAsync)) {
      throw new FuzzViolation(
        `evaluateSync gave ${describeOutcome(sync)} but evaluate gave ${describeOutcome(viaAsync)}`,
      )
    }
    if (!sameOutcome(sync, viaCompiled)) {
      throw new FuzzViolation(
        `evaluateSync gave ${describeOutcome(sync)} but compile().evaluateSync gave ${describeOutcome(viaCompiled)}`,
      )
    }

    // (c) a typed environment that accepted the source must not hit a type
    // failure, and its value must have the inferred (and any expected) type.
    const result = checked.value as { ok: boolean; type?: Type }
    if (env !== openEnv && result.ok) {
      soundnessChecked++
      // A failure where the checker saw `any` (a computed key on a declared
      // object, a reduce accumulator that kept growing) is gradual typing.
      const gradual = !sync.ok && isGradual(env, source, sync.span)
      // How many items a spread argument holds is only known at run time.
      const arity = sync.ok || (sync.code === 'NO_OVERLOAD' && source.includes('(...'))
      if (!sync.ok && SOUNDNESS_CODES.has(sync.code) && !gradual && !arity)
        recordFinding(scenario, sync)
      if (sync.ok && result.type !== undefined) {
        const problem = mismatch(sync.value, result.type)
        if (problem !== undefined)
          recordFinding(scenario, { ok: false, code: 'UNSOUND_TYPE', message: problem })
        // A program compiled with `expect` returns a value of that type: proven
        // statically, or checked at run time (a TYPE_ERROR) when it cannot be.
        if (env.check(source, { expect: scenario.expect }).ok) {
          const run = capture('compile(expect)', () =>
            env.compile(source, { expect: scenario.expect }).evaluateSync(context),
          )
          const wrong = run.ok ? mismatch(run.value, scenario.expect) : undefined
          if (wrong !== undefined)
            recordFinding(scenario, { ok: false, code: 'UNSOUND_EXPECT', message: wrong })
        }
        // A warning that the whole comparison is always false (or true) must hold.
        for (const d of (checked.value as { diagnostics: readonly Diagnostic[] }).diagnostics) {
          if (d.code !== 'ALWAYS_FALSE' || d.start !== 0 || d.end !== source.length) continue
          if (!d.message.startsWith('This comparison is always')) continue
          const claimed = d.message.includes('always true')
          if (typeof sync.value === 'boolean' && sync.value !== claimed)
            recordFinding(scenario, { ok: false, code: 'FALSE_WARNING', message: d.message })
        }
      }
    }

    // (d) printing is a faithful, idempotent round trip, in every call style.
    if (env === openEnv) checkPrinting(env, source, context, sync)

    // (e) explain() agrees with evaluation and its trace is plain data.
    if (env === openEnv) checkExplain(env, source, context, sync)

    // (f) partial evaluation with part of the context is faithful: its value,
    // or its residual evaluated with the full context, matches evaluation.
    if (env === openEnv) checkPartial(env, source, context, sync)
  }
  return true
}

const HASH_MULTIPLIER = 31
const FIELD_UNKNOWN_BIT = 0x100
const LIMIT_CODES = new Set([
  'STEP_LIMIT',
  'STRING_LIMIT',
  'LIST_LIMIT',
  'TOO_DEEP',
  'TIMEOUT',
  'ABORTED',
])

function checkPartial(
  env: ReturnType<typeof bonsai>,
  source: string,
  context: Record<string, unknown>,
  expected: Outcome,
): void {
  if (!expected.ok && LIMIT_CODES.has(expected.code)) return
  const compiled = capture('compile', () => env.compile(source))
  if (!compiled.ok) return
  const program = compiled.value as { partial: (known: object, options?: object) => unknown }
  // Deterministically hide some variables (and sometimes a single field).
  let hash = 0
  for (let i = 0; i < source.length; i++) hash = (hash * HASH_MULTIPLIER + source.charCodeAt(i)) | 0
  const names = Object.keys(context)
  const unknown = names.filter((_, i) => ((hash >>> i) & 1) === 1)
  if ((hash & FIELD_UNKNOWN_BIT) !== 0 && names.includes('items')) unknown.push('items.0')
  const known: Record<string, unknown> = {}
  for (const name of names) if (!unknown.includes(name)) known[name] = context[name]
  const result = capture('partial', () => program.partial(known, { unknown }))
  if (!result.ok) {
    if (LIMIT_CODES.has(result.code)) return
    throw new FuzzViolation(
      `partial threw ${result.code} for ${JSON.stringify(source)} (unknown ${unknown.join(',')})`,
    )
  }
  const partial = result.value as
    | { status: 'value'; value: unknown }
    | { status: 'error'; error: { code: string } }
    | { status: 'residual'; source: string; evaluateSync: (ctx: object) => unknown }
  let outcome: Outcome
  if (partial.status === 'value') outcome = { ok: true, value: partial.value }
  else if (partial.status === 'error')
    outcome = { ok: false, code: partial.error.code, message: '' }
  else {
    outcome = capture('residual', () => partial.evaluateSync(context))
    if (!outcome.ok && LIMIT_CODES.has(outcome.code)) return
  }
  if (!sameOutcome(expected, outcome)) {
    const shown =
      partial.status === 'residual' ? ` (residual ${JSON.stringify(partial.source)})` : ''
    throw new FuzzViolation(
      `partial of ${JSON.stringify(source)} with ${unknown.join(',') || 'nothing'} unknown gave ${describeOutcome(outcome)}${shown}, evaluation gave ${describeOutcome(expected)}`,
    )
  }
}

function checkExplain(
  env: ReturnType<typeof bonsai>,
  source: string,
  context: Record<string, unknown>,
  expected: Outcome,
): void {
  const explained = capture('explain', () => env.explain(source, context))
  if (!explained.ok) {
    // Only syntax and check errors may throw, and evaluation must throw the same.
    if (expected.ok || expected.code !== explained.code) {
      throw new FuzzViolation(
        `explain threw ${explained.code} but evaluateSync gave ${describeOutcome(expected)}`,
      )
    }
    return
  }
  const explanation = explained.value as {
    ok: boolean
    value?: unknown
    error?: { code: string }
    trace: unknown
    toString: () => string
  }
  const outcome: Outcome = explanation.ok
    ? { ok: true, value: explanation.value }
    : { ok: false, code: explanation.error?.code ?? '?', message: '' }
  if (!sameOutcome(expected, outcome)) {
    throw new FuzzViolation(
      `explain gave ${describeOutcome(outcome)} but evaluateSync gave ${describeOutcome(expected)}`,
    )
  }
  explanation.toString()
}

function checkPrinting(
  env: ReturnType<typeof bonsai>,
  source: string,
  context: Record<string, unknown>,
  expected: Outcome,
): void {
  const parsed = capture('parse', () => env.parse(source))
  if (!parsed.ok) return
  const compiled = capture('compile', () => env.compile(source))
  const trees = [parsed.value as Node]
  if (compiled.ok) trees.push((compiled.value as { ast: Node }).ast)
  for (const tree of trees) {
    for (const calls of ['preserve', 'method', 'function'] as const) {
      const printed = print(tree, { calls })
      const reparsed = capture('parse(print)', () => env.parse(printed))
      if (!reparsed.ok)
        throw new FuzzViolation(
          `print gave unparseable ${JSON.stringify(printed)} for ${JSON.stringify(source)}`,
        )
      const again = print(reparsed.value as Node, { calls })
      if (again !== printed) {
        throw new FuzzViolation(
          `print is not idempotent: ${JSON.stringify(printed)} then ${JSON.stringify(again)}`,
        )
      }
      const outcome = capture('evaluateSync(print)', () => env.evaluateSync(printed, context))
      if (!sameOutcome(expected, outcome)) {
        throw new FuzzViolation(
          `${JSON.stringify(source)} gave ${describeOutcome(expected)} but printed ${JSON.stringify(printed)} gave ${describeOutcome(outcome)}`,
        )
      }
    }
  }
}

// Junk targeted at the lexer/parser: random text plus structured fragments of
// operators, brackets, and keywords that reach deeper parser states than
// uniform random strings.
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
        '{',
        '}',
        '+',
        '|>',
        '?',
        ':',
        ';',
        'let',
        'x',
        '=',
        '=>',
        'try',
        'has',
        '__proto__',
        'map',
        '"',
        '`',
        '${',
        ',',
        '...',
        ' ',
        '1',
      ),
      { maxLength: 48 },
    )
    .map((parts) => parts.join('')),
)

const serviceEnv = typedEnvFor(FIXED_VARIABLES)
const service = createLanguageService(serviceEnv)

function junkHolds(source: string, offsetSeed: number): boolean {
  const offset = source.length === 0 ? 0 : offsetSeed % (source.length + 1)
  capture('parse', () => serviceEnv.parse(source))
  capture('check', () => serviceEnv.check(source))
  capture('service.diagnostics', () => service.diagnostics(source))
  capture('service.complete', () => service.complete(source, offset))
  capture('service.hover', () => service.hover(source, offset))
  return true
}

function reportAndExit<Ts extends unknown[]>(label: string, details: fc.RunDetails<Ts>): never {
  process.stdout.write(`✗ fuzz violation in ${label}\n`)
  const counterexample = details.counterexample
  if (counterexample) {
    process.stdout.write(`  counterexample: ${JSON.stringify(counterexample)}\n`)
  }
  process.stdout.write(`  seed: ${details.seed}  path: ${details.counterexamplePath ?? ''}\n`)
  const detail = details as unknown as { errorInstance?: unknown }
  const message = detail.errorInstance instanceof Error ? detail.errorInstance.message : 'unknown'
  process.stdout.write(`  error: ${message}\n`)
  process.exit(1)
}

function reportFindings(): void {
  process.stdout.write(
    `✗ soundness probe: ${String(findings.size)} distinct runtime type failure(s) in expressions the checker accepted\n`,
  )
  const sorted = [...findings.values()].sort((a, b) => b.count - a.count)
  for (const finding of sorted) {
    process.stdout.write(`- ${finding.code} (${String(finding.count)}x): ${finding.message}\n`)
    process.stdout.write(`    source:  ${finding.source}\n`)
    process.stdout.write(`    context: ${finding.context}\n`)
  }
}

async function main(): Promise<void> {
  const budgetMs = Number(process.argv[2] ?? process.env.FUZZ_MS ?? DEFAULT_BUDGET_MS)
  const started = performance.now()
  let totalCases = 0
  let batches = 0

  while (performance.now() - started < budgetMs) {
    const seed = Math.floor(Math.random() * MAX_SEED)

    const scenarios = await fc.check(fc.asyncProperty(scenarioArbitrary, scenarioHolds), {
      numRuns: RUNS_PER_BATCH,
      seed: seed ^ DIFFERENTIAL_SEED_SALT,
    })
    if (scenarios.failed) reportAndExit('error containment / evaluation parity', scenarios)

    const junk = fc.check(fc.property(junkArbitrary, fc.nat(), junkHolds), {
      numRuns: RUNS_PER_BATCH,
      seed: seed ^ JUNK_SEED_SALT,
    })
    if (junk.failed) reportAndExit('parser/checker/service robustness', junk)

    totalCases += scenarios.numRuns + junk.numRuns
    batches += 1
  }

  const seconds = Math.round((performance.now() - started) / MS_PER_SECOND)
  process.stdout.write(
    `fuzz: ${String(totalCases)} cases across ${String(batches)} batches in ${String(seconds)}s; ${String(soundnessChecked)} type-checked evaluations probed for soundness\n`,
  )
  if (findings.size > 0) {
    reportFindings()
    process.exit(1)
  }
  process.stdout.write('✓ no violations\n')
}

await main()
