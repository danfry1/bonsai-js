/**
 * Cross-view fuzzer: every view of one generated expression must agree.
 *
 * The other fuzzers check one or two components at a time. This one generates
 * a typed environment (host functions of every kind, small limits, `strict:
 * false`, built flat or with `extend()` and libraries), a well-formed
 * expression over it (operators, built-ins, lambdas, `let`, `try`, `has`, `?.`,
 * `??`, map literals and spreads, templates, unions of objects, unicode, time
 * zones, range-end dates), data (sometimes of the wrong type), and per-call
 * options, then checks that each view gives the same answer:
 *   1. check soundness: when check() accepts with type T, evaluation returns a
 *      value of type T or fails with a code allowed for the construct (any
 *      error, where a sub-expression is typed `any`);
 *   2. evaluateSync, evaluate, explainSync, and explain agree (value or error
 *      code), and the explanation's root trace holds the result;
 *   3. print(parse(source)) re-parses to the same tree, checks to the same
 *      type, and evaluates the same; every node's span slices to source that
 *      parses to that node;
 *   4. partial() with a random split of the data (with and without an
 *      `unknown` list): a decided value or error equals the program's, and the
 *      residual equals the program on the full data, and (when it does not
 *      read the context) on just its dependsOn paths;
 *   5. for a boolean filter over `row`: toSQL in SQLite and Postgres (PGlite),
 *      and toMongo in mingo, select exactly the rows evaluation accepts, or
 *      refuse with UNTRANSLATABLE (a Postgres "value out of range" error is the
 *      one documented failure);
 *   6. the language service's diagnostics match check(), and hover matches the
 *      checked type of the node under the cursor;
 *   7. an environment built with extend() or a library checks and evaluates as
 *      the same declarations made by one bonsai() call;
 *   8. a getter in the context or known data that throws (a plain error or a
 *      Bonsai error from elsewhere) is HOST_ERROR in every view, never the
 *      thrown error itself, and partial() agrees with evaluation, inside try()
 *      too;
 *   X1-X7. a residual's explanation matches it (X1), it agrees with its program
 *      under another `now` (X2) and with validation toggled per call (X3), it
 *      reads nothing outside dependsOn (X4), rows that fail evaluation are those
 *      neither a filter nor its negation selects in SQL (X5), a context of
 *      exactly dependsOn validates (X6), and data broken on a dependsOn path is
 *      INVALID_CONTEXT or the program's own answer (X7).
 *
 * Value limits must match exactly; step and time budgets are soft (counted, not
 * failed), since different views do different work. A few classes are skipped
 * by documented design, each with its doc reference where it is skipped.
 *
 * The run is deterministic for a seed. It reports up to two shrunk examples of
 * each disagreement, the shortest sub-expression that still fails the same way,
 * with its environment and data, and exits non-zero.
 *
 *   bun run cross-fuzz                          # 60 s, seed from the clock
 *   bun run cross-fuzz --seconds 300 --seed 7   # a longer, repeatable run
 *
 * It runs under Bun, so SQLite is `bun:sqlite` (the same engine as the
 * `node:sqlite` the tests use).
 */
/* oxlint-disable no-magic-numbers -- probabilities, sizes, and sample values are the point */
/* oxlint-disable no-template-curly-in-string -- Bonsai template sources */
import { performance } from 'node:perf_hooks'
import { PGlite } from '@electric-sql/pglite'
import { Query } from 'mingo'
import {
  Duration,
  bonsai,
  fn,
  withContext,
  forEachChild,
  formatType,
  isAssignable,
  isBonsaiError,
  parse,
  print,
  t,
  type CheckResult,
  type Environment,
  type EnvironmentOptions,
  type HostFunction,
  type Node,
  type Program,
  type Type,
} from '../src/index.js'
import { toMongo, toSQL, type Columns } from '../src/query/index.js'
import { createLanguageService, type LanguageService } from '../src/service/index.js'

// === Command line ===

const argv: readonly string[] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const SECONDS = Number(flag('seconds') ?? 60)
const SEED = Number(flag('seed') ?? Date.now() % 0x7fff_ffff)
const MAX_DEPTH = 6
const CASES_PER_ENVIRONMENT = 25
const SHRINK_CANDIDATES = 200
const NOW = new Date('2026-10-10T12:00:00.000Z')

// === Random numbers (deterministic per seed) ===

interface Random {
  readonly next: () => number
  readonly int: (lo: number, hi: number) => number
  readonly pick: <T>(items: readonly T[]) => T
  readonly chance: (p: number) => boolean
}

function random(seed: number): Random {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  }
}

// === Types ===

const N: Type = t.number()
const S: Type = t.string()
const B: Type = t.boolean()
const TS: Type = t.timestamp()
const D: Type = t.duration()
const ANY: Type = t.any()

const isNullable = (type: Type): boolean =>
  type.kind === 'null' ||
  type.kind === 'any' ||
  (type.kind === 'union' && type.types.some(isNullable))

/** The type without its null member. */
function strip(type: Type): Type {
  if (type.kind !== 'union') return type
  const members = type.types.filter((member) => member.kind !== 'null')
  if (members.length === 1) return members[0]
  return members.length === 0 ? type : t.union(...members)
}

const opt = (type: Type): Type => (isNullable(type) ? type : t.optional(type))

function fits(source: Type, target: Type): boolean {
  try {
    return isAssignable(source, target)
  } catch {
    return false
  }
}

const ROW_TYPE = t.object({
  name: t.optional(S),
  city: t.optional(S),
  total: t.optional(N),
  qty: t.optional(N),
  active: t.optional(B),
  placed: t.optional(TS),
  wait: t.optional(D),
})
const COLUMNS: Columns = {
  name: 'text',
  city: 'text',
  total: 'number',
  qty: 'number',
  active: 'boolean',
  placed: 'timestamp',
  wait: 'duration',
}

const FIELD_NAMES = [
  'a',
  'b',
  'name',
  'age',
  'tags',
  'score',
  'in',
  'kind',
  'when',
  'span',
  'addr',
  'items',
]
const NUMBERS = [0, 1, -1, 2, 3, 0.5, -2.5, 10, 100, 1e6, 2 ** 53, -0, 0.1, 7, 42, 1e308, 1e-300]
const STRINGS = [
  '',
  'a',
  'abc',
  'Hello World',
  ' pad ',
  'é',
  'a,b,c',
  '😀x',
  'A',
  'k1',
  '1',
  'x-y',
  '2024-01-01',
  'apple',
  '%_',
  '\\',
  'a\nb',
  // Unicode: case mappings that change length, combining marks, ZWJ, titlecase, ligatures.
  'ß',
  'İstanbul',
  'é',
  '👨‍👩‍👧',
  'ǅ',
  ' x',
  'Ωmega',
  'ﬃ',
  'ΣΑΣ',
]
/** Strings rows may hold (all valid UTF-16, so Postgres accepts them). */
const ROW_STRINGS = [...STRINGS]
/** Data strings additionally include a lone surrogate (not sent to databases). */
STRINGS.push('\uD800', 'x\uDC00')
const ROW_DATES = [
  '2024-02-29T12:34:56.789Z',
  '1970-01-01T00:00:00.000Z',
  '1999-12-31T23:59:59.999Z',
  '2030-06-15T00:00:00.000Z',
  '1969-01-01T00:00:00.000Z',
  '2026-10-10T08:00:00.000Z',
  '2024-03-31T01:30:00.000Z',
  '2024-11-03T06:30:00.000Z',
  '9999-12-31T23:59:59.999Z',
  '0001-01-01T00:00:00.000Z',
]
// Data timestamps reach the ends of the Date range.
const DATES = [...ROW_DATES, '+275760-09-13T00:00:00.000Z', '-271821-04-20T00:00:00.000Z']
const ROW_DURATIONS = [0, 1000, 3_600_000, 86_400_000, -5000, 90_061_001, 1, 1_209_600_000]
const DURATIONS = [...ROW_DURATIONS, 8.64e15, -8.64e15, 2 ** 53 - 1, -1]
const CLOCKS = [
  NOW,
  new Date(8.64e15),
  new Date(-8.64e15),
  new Date(0),
  new Date('2024-03-31T01:30:00.000Z'),
  new Date('2024-11-03T06:30:00.000Z'),
  new Date('2024-02-29T23:59:59.999Z'),
]
/** A lone surrogate as JSON.stringify writes it; Postgres rejects such text. */
const LONE_SURROGATE = /\\ud[89a-f][0-9a-f]{2}/iu
const LIMIT_CODES = new Set([
  'STEP_LIMIT',
  'STRING_LIMIT',
  'LIST_LIMIT',
  'VALUE_DEPTH_LIMIT',
  'PATTERN_LIMIT',
  'TIMEOUT',
])
const RECORD_KEYS = ['k1', 'k2', 'a', '1', '10', 'x-y']

function genType(R: Random, depth: number): Type {
  const scalar = (): Type => R.pick([N, N, S, S, B, TS, D, t.enum('x', 'y', 'z'), t.union(N, S)])
  if (depth <= 0) return R.chance(0.25) ? opt(scalar()) : scalar()
  const kind = R.int(0, 9)
  if (kind <= 3) return R.chance(0.25) ? opt(scalar()) : scalar()
  if (kind <= 5) return t.list(genType(R, depth - 1))
  if (kind <= 8) {
    const fields: Record<string, Type> = {}
    const count = R.int(1, 4)
    for (let i = 0; i < count; i++) fields[R.pick(FIELD_NAMES)] = genType(R, depth - 1)
    const object = t.object(fields)
    return R.chance(0.2) ? opt(object) : object
  }
  if (R.chance(0.5)) return t.record(R.chance(0.5) ? genType(R, 0) : genType(R, depth - 1))
  // A union of two objects that share one field and differ by a literal `kind`.
  const shared = R.pick(FIELD_NAMES)
  const first: Record<string, Type> = { [shared]: genType(R, depth - 1), kind: t.literal('one') }
  const second: Record<string, Type> = { [shared]: genType(R, depth - 1), kind: t.literal('two') }
  if (R.chance(0.5)) first.only1 = genType(R, 0)
  if (R.chance(0.5)) second.only2 = genType(R, 0)
  const union = t.union(t.object(first), t.object(second))
  return R.chance(0.3) ? opt(union) : union
}

function genVariables(R: Random): { variables: Record<string, Type>; filter: boolean } {
  const variables: Record<string, Type> = {}
  const base: Record<string, Type> = {
    n: N,
    s: S,
    b: B,
    ts: TS,
    d: D,
    xs: t.list(N),
    on: t.optional(N),
    os: t.optional(S),
  }
  for (const [name, type] of Object.entries(base)) if (R.chance(0.6)) variables[name] = type
  variables.u = t.object({
    name: S,
    age: t.optional(N),
    tags: t.list(S),
    addr: t.optional(t.object({ city: t.optional(S), zip: N })),
    when: t.optional(TS),
  })
  if (R.chance(0.6)) {
    variables.items = t.list(
      t.object({ name: S, price: N, qty: t.optional(N), tags: t.list(S), wait: t.optional(D) }),
    )
  }
  if (R.chance(0.4)) variables.rec = t.record(N)
  if (R.chance(0.3)) variables.k = t.enum('x', 'y', 'z')
  for (const name of ['v1', 'v2']) if (R.chance(0.5)) variables[name] = genType(R, 2)
  const filter = R.chance(0.35)
  if (filter) variables.row = ROW_TYPE
  return { variables, filter }
}

// === Host functions and environment configuration ===

const contextFn = withContext<Record<string, unknown>>()

/** Every host function the generator knows, by name; each environment takes a subset. */
function allHostFunctions(cost: number): Record<string, HostFunction> {
  return {
    hn: fn({ params: [t.number()], returns: t.number(), run: (x) => x + 1 }),
    hs: fn({ params: [t.string()], returns: t.string(), run: (s) => `${s}!` }),
    hb: fn({ params: [t.number()], returns: t.boolean(), run: (x) => x > 2 }),
    hl: fn({
      params: [t.number()],
      returns: t.list(t.number()),
      run: (x) => Array.from({ length: Math.min(12, Math.abs(Math.trunc(x)) || 0) }, (_, i) => i),
    }),
    hd: fn({ params: [t.duration()], returns: t.timestamp(), run: (d) => new Date(d.ms) }),
    ha: fn({
      params: [t.number()],
      returns: t.number(),
      async: true,
      run: (x) => Promise.resolve(x * 2),
    }),
    hac: contextFn({
      params: [t.number()],
      returns: t.number(),
      async: true,
      run: (call, x) =>
        Promise.resolve((typeof call.context.n === 'number' ? call.context.n : 0) - x),
    }),
    hc: contextFn({
      params: [t.number()],
      returns: t.number(),
      run: (call, x) => (typeof call.context.n === 'number' ? call.context.n : 0) + x,
    }),
    hcx: fn({
      params: [],
      returns: t.string(),
      call: true,
      run: (call) => {
        const u = call.context.u as { name?: unknown } | undefined
        return typeof u?.name === 'string' ? u.name : '?'
      },
    }),
    ht: fn({
      params: [t.number()],
      returns: t.number(),
      run: (x) => {
        if (x > 5) throw new Error('boom')
        return x
      },
    }),
    hw: fn({
      params: [t.number()],
      returns: t.number(),
      // A wrong return type for negatives, undefined for zero: HOST_CONTRACT.
      run: (x) => {
        if (x < 0) return 'bad' as unknown as number
        if (x === 0) return undefined as unknown as number
        return x
      },
    }),
    ho: fn({
      params: [t.optional(t.number())],
      required: 0,
      returns: t.optional(t.number()),
      run: (x) => x,
    }),
    hr: fn({
      params: [t.string()],
      rest: t.number(),
      returns: t.number(),
      run: (s, ...xs) => s.length + xs.length,
    }),
    hk: fn({ params: [t.number()], returns: t.number(), cost, run: (x) => x }),
    // Overrides of built-ins.
    abs: fn({ params: [t.number()], returns: t.number(), run: (x) => Math.abs(x) * 2 }),
    trim: fn({ params: [t.string()], returns: t.string(), run: (s) => s.trim().toUpperCase() }),
  }
}

interface EnvConfig {
  readonly env: Environment
  /** The same environment built by one bonsai() call, when env was built with extend(). */
  readonly flat: Environment | undefined
  readonly host: ReadonlySet<string>
  readonly strict: boolean
  readonly validateContext: boolean
  readonly clock: Date
  readonly limits: Readonly<Record<string, number>>
  readonly describe: string
}

function genEnvironment(R: Random, variables: Record<string, Type>): EnvConfig {
  const cost = R.pick([1, 5, 32, 200, 10_000])
  const every = allHostFunctions(cost)
  const functions: Record<string, HostFunction> = {}
  if (R.chance(0.7)) {
    for (const [name, def] of Object.entries(every)) if (R.chance(0.5)) functions[name] = def
  }
  const limits: Record<string, number> = {}
  if (R.chance(0.5)) {
    if (R.chance(0.5)) limits.maxSteps = R.pick([5, 20, 50, 200, 1000, 5000])
    if (R.chance(0.3)) limits.maxListLength = R.pick([1, 2, 3, 5, 10])
    if (R.chance(0.3)) limits.maxStringLength = R.pick([1, 3, 8, 20])
    if (R.chance(0.2)) limits.maxValueDepth = R.pick([1, 2, 3, 5])
    if (R.chance(0.2)) limits.maxDepth = R.pick([4, 6, 8, 12])
    if (R.chance(0.1)) limits.maxNodes = R.pick([10, 30, 100])
    if (R.chance(0.1)) limits.maxSourceLength = R.pick([20, 60, 200])
    if (R.chance(0.1)) limits.maxPatternLength = R.pick([1, 3, 6])
    if (R.chance(0.2)) limits.timeout = R.pick([0, 1e-9])
  }
  const strictOption = R.chance(0.25) ? false : undefined
  const validateContext = R.chance(0.3)
  const clock = R.pick(CLOCKS)
  const options = {
    variables,
    functions,
    limits,
    clock: () => clock,
    validateContext,
    ...(strictOption === undefined ? {} : { strict: strictOption }),
  } as EnvironmentOptions
  const mode = R.pick(['flat', 'extend', 'library'] as const)
  let env: Environment
  let flat: Environment | undefined
  if (mode === 'flat') env = bonsai(options)
  else {
    // Split variables and functions between a base and the extension (or a library).
    const baseVars: Record<string, Type> = {}
    const moreVars: Record<string, Type> = {}
    for (const [name, type] of Object.entries(variables))
      (R.chance(0.5) ? baseVars : moreVars)[name] = type
    const baseFns: Record<string, HostFunction> = {}
    const moreFns: Record<string, HostFunction> = {}
    for (const [name, def] of Object.entries(functions))
      (R.chance(0.5) ? baseFns : moreFns)[name] = def
    const base = bonsai({
      variables: baseVars,
      functions: baseFns,
      limits,
      clock: () => clock,
      validateContext,
      ...(strictOption === undefined ? {} : { strict: strictOption }),
    })
    env =
      mode === 'extend'
        ? base.extend({ variables: moreVars, functions: moreFns })
        : base.extend({ libraries: [{ name: 'lib', functions: moreFns, variables: moreVars }] })
    // The same declarations in the same order, made by one bonsai() call.
    flat = bonsai({ ...options, variables: { ...env.variables } })
  }
  return {
    env,
    flat,
    host: new Set(Object.keys(functions)),
    strict: strictOption ?? true,
    validateContext,
    clock,
    limits,
    describe: JSON.stringify({
      mode,
      functions: Object.keys(functions),
      cost,
      limits,
      strict: strictOption,
      validateContext,
      clock: clock.toISOString(),
    }),
  }
}

/** Per-call evaluation options, passed alike to every view. */
function genOptions(R: Random): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (R.chance(0.2)) out.now = R.pick(CLOCKS)
  if (R.chance(0.15)) out.maxSteps = R.pick([0, 3, 10, 40, 300, 2000])
  if (R.chance(0.1)) out.timeout = R.pick([0, 1e-9])
  if (R.chance(0.2)) out.validateContext = R.chance(0.5)
  return out
}

/** A value of the wrong type for `type`, to exercise context validation. */
function corruptValue(R: Random, type: Type): unknown {
  const base = strip(type)
  switch (base.kind) {
    case 'number':
      return R.pick(['1', true, [], Number.NaN, Infinity])
    case 'string':
      return R.pick([1, null, false])
    case 'boolean':
      return R.pick([0, 'true'])
    case 'timestamp':
      return R.pick(['2024-01-01', 0, new Date(Number.NaN)])
    case 'duration':
      return R.pick([1000, 'PT1H'])
    case 'list':
      return R.pick(['x', {}, [Symbol.for('x')]])
    case 'map':
      return R.pick([[], 'x', 5])
    case 'any':
    case 'function':
    case 'literal':
    case 'never':
    case 'null':
    case 'opaque':
    case 'union':
    case 'var':
    default:
      return Symbol.for('bad')
  }
}

/** A value of `type`. Declared objects may carry an extra key, as rows do. */
function genValue(R: Random, type: Type, depth = 0): unknown {
  switch (type.kind) {
    case 'any':
      return R.pick([1, 'a', true, null])
    case 'boolean':
      return R.chance(0.5)
    case 'number':
      return R.chance(0.7) ? R.pick(NUMBERS.slice(0, 11)) : R.pick(NUMBERS)
    case 'string':
      return R.pick(STRINGS)
    case 'timestamp':
      return new Date(R.pick(DATES))
    case 'duration':
      return new Duration(R.pick(DURATIONS))
    case 'literal':
      return type.value
    case 'union':
      return genValue(R, R.pick(type.types), depth)
    case 'list':
      return Array.from({ length: depth > 3 ? 0 : R.int(0, 4) }, () =>
        genValue(R, type.element, depth + 1),
      )
    case 'map': {
      const out: Record<string, unknown> = {}
      for (const [name, field] of Object.entries(type.fields)) {
        if (isNullable(field) && R.chance(0.5)) {
          if (R.chance(0.5)) out[name] = null
          continue
        }
        out[name] = genValue(R, field, depth + 1)
      }
      if (type.rest) {
        const count = R.int(0, 3)
        for (let i = 0; i < count; i++) out[R.pick(RECORD_KEYS)] = genValue(R, type.rest, depth + 1)
      } else if (R.chance(0.15)) out.extra = R.pick([1, 'zz', null])
      return out
    }
    case 'null':
    case 'never':
    case 'opaque':
    case 'function':
    case 'var':
    default:
      return null
  }
}

interface Row {
  readonly id: number
  readonly name: string | null
  readonly city: string | null
  readonly total: number | null
  readonly qty: number | null
  readonly active: boolean | null
  readonly placed: Date | null
  readonly wait: Duration | null
}

function genRow(R: Random, id: number): Row {
  const maybe = <T>(value: () => T): T | null => (R.chance(0.2) ? null : value())
  return {
    id,
    name: maybe(() => R.pick(ROW_STRINGS)),
    city: maybe(() => R.pick(ROW_STRINGS)),
    total: maybe(() => R.pick(NUMBERS)),
    qty: maybe(() => R.pick(NUMBERS)),
    active: maybe(() => R.chance(0.5)),
    placed: maybe(() => new Date(R.pick(ROW_DATES))),
    wait: maybe(() => new Duration(R.pick(ROW_DURATIONS))),
  }
}

// === Expressions ===

const NUMBER_LITERALS = [
  '0',
  '1',
  '2',
  '3',
  '(-1)',
  '0.5',
  '10',
  '100',
  '2.5',
  '1_000',
  '0xff',
  '1e308',
  '7',
]
const STRING_LITERALS = [
  '""',
  '"a"',
  '"abc"',
  '"Hello"',
  '","',
  '"é"',
  '"😀"',
  "'x-y'",
  '"\\n"',
  '"k1"',
  '"apple"',
  '`t`',
  '"%"',
  '"A"',
  '"ß"',
  '"İ"',
  '"e\\u0301"',
  '"👨‍👩‍👧"',
  '"Σ"',
  '"ﬃ"',
]
const PATTERNS = [
  '"^.$"',
  '"(?i)ß"',
  '"(?i)SS"',
  '"(?i)straße"',
  '"\\\\p{L}+"',
  '"^\\\\w+$"',
  '"[😀]"',
  '"e\\u0301"',
  '"(?i)σ"',
  '"(a|b)*c"',
  '"^.{2}$"',
  '"("',
  '"\\\\u{1F600}"',
  '"^a"',
  '"b+"',
  '"(?i)hello"',
  '"[0-9]{2,}"',
  '"a|é"',
  '"^$"',
  '"\\\\d"',
  '"x-?y"',
  '"^.{0,3}$"',
]
const ZONES = [
  '"UTC"',
  '"Europe/Berlin"',
  '"America/New_York"',
  '"Asia/Kolkata"',
  '"Pacific/Chatham"',
  '"Asia/Kathmandu"',
  '"America/St_Johns"',
  '"Australia/Lord_Howe"',
  '"Pacific/Kiritimati"',
  '"Etc/GMT+12"',
  '"Pacific/Apia"',
  '"Mars/Base"',
  '"utc"',
  '"+05:30"',
]
const DATE_LITERALS = [
  '"2024-02-29T12:00:00Z"',
  '"2000-01-01T00:00:00.000Z"',
  '"2026-10-10T00:00:00Z"',
  '"+275760-09-13T00:00:00Z"',
  '"-271821-04-20T00:00:00Z"',
  '"9999-12-31T23:59:59.999Z"',
  '"2024-03-31T02:30:00+02:00"',
  '"2024-02-29"',
]
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

interface Path {
  readonly src: string
  readonly type: Type
  readonly kind: 'var' | 'member' | 'index' | 'it'
}

interface Scope {
  readonly scope: readonly { readonly src: string; readonly type: Type }[]
  /** The element type an implicit `.` reads inside a lambda, or null outside one. */
  readonly it: Type | null
  /** Set when the body read `.`, so the implicit lambda is well-formed. */
  readonly used: { value: boolean } | null
  paths?: { readonly named: readonly Path[]; readonly it: readonly Path[] }
}

/** Every path reachable from `src` within `depth` member or index steps. */
function navigate(src: string, type: Type, depth: number, out: Path[], kind: Path['kind']): void {
  out.push({ src, type, kind })
  if (depth <= 0) return
  const base = strip(type)
  const nullable = isNullable(type)
  const isIt = src === '.'
  const member = (field: string): string => (isIt ? `.${field}` : `${src}.${field}`)
  const index = (key: string): string => (isIt ? `.[${key}]` : `${src}[${key}]`)
  if (base.kind === 'map') {
    for (const [field, fieldType] of Object.entries(base.fields)) {
      const fieldSrc = IDENTIFIER.test(field) ? member(field) : index(`"${field}"`)
      navigate(fieldSrc, nullable ? opt(fieldType) : fieldType, depth - 1, out, 'member')
    }
    if (base.rest) {
      for (const key of ['k1', 'a'])
        navigate(index(`"${key}"`), opt(base.rest), depth - 1, out, 'index')
    }
  } else if (base.kind === 'list') {
    out.push({ src: member('length'), type: nullable ? opt(N) : N, kind: 'member' })
    navigate(index('0'), opt(base.element), depth - 1, out, 'index')
  } else if (base.kind === 'string') {
    out.push({ src: member('length'), type: nullable ? opt(N) : N, kind: 'member' })
  } else if (base.kind === 'union' && base.types.every((alt) => alt.kind === 'map')) {
    // A field every member declares reads as the union of the members' field types.
    const members = base.types.filter((alt) => alt.kind === 'map')
    for (const field of Object.keys(members[0]?.fields ?? {})) {
      if (!members.every((each) => Object.hasOwn(each.fields, field))) continue
      const fieldType = t.union(...members.map((each) => each.fields[field]))
      const fieldSrc = IDENTIFIER.test(field) ? member(field) : index(`"${field}"`)
      navigate(fieldSrc, nullable ? opt(fieldType) : fieldType, depth - 1, out, 'member')
    }
  }
}

class Generator {
  private readonly R: Random
  private readonly variables: Readonly<Record<string, Type>>
  private readonly filter: boolean
  private fresh = 0
  private readonly host: ReadonlySet<string>
  private readonly strict: boolean
  private readonly maxDepth: number

  constructor(
    R: Random,
    variables: Readonly<Record<string, Type>>,
    filter: boolean,
    host: ReadonlySet<string> = new Set(),
    strict = true,
    maxDepth = 128,
  ) {
    this.R = R
    this.variables = variables
    this.filter = filter
    this.host = host
    this.strict = strict
    this.maxDepth = maxDepth
  }

  /** A host function call producing `type`, if the environment has one. */
  private hostCall(type: Type, g: (type: Type) => string): string | null {
    const R = this.R
    const has = (name: string): boolean => this.host.has(name)
    const options: string[] = []
    const base = strip(type)
    if (base.kind === 'number') {
      for (const name of ['hn', 'ha', 'hac', 'hc', 'ht', 'hw', 'hk'])
        if (has(name)) options.push(R.chance(0.2) ? `${g(N)}.${name}()` : `${name}(${g(N)})`)
      if (has('ho')) options.push(`(ho(${R.chance(0.5) ? g(opt(N)) : ''}) ?? ${g(N)})`)
      if (has('hr'))
        options.push(
          `hr(${g(S)}${R.chance(0.5) ? `, ${g(N)}` : ''}${R.chance(0.3) ? `, ${g(N)}` : ''})`,
        )
      if (has('abs')) options.push(`abs(${g(N)})`)
    } else if (base.kind === 'string') {
      if (has('hs')) options.push(`hs(${g(S)})`)
      if (has('hcx')) options.push('hcx()')
      if (has('trim')) options.push(`${g(S)}.trim()`)
    } else if (base.kind === 'boolean') {
      if (has('hb')) options.push(`hb(${g(N)})`)
    } else if (base.kind === 'list') {
      if (has('hl') && fits(N, base.element)) options.push(`hl(${g(N)})`)
    } else if (base.kind === 'timestamp' && has('hd')) {
      options.push(`hd(${g(D)})`)
    }
    return options.length === 0 ? null : R.pick(options)
  }

  /** A form nested about as deep as the environment's maxDepth. */
  private deep(type: Type, g: (type: Type) => string): string | null {
    const R = this.R
    const k = Math.max(1, this.maxDepth + R.int(-3, 1))
    if (k > 140) return null
    const kind = strip(type).kind
    if (kind === 'number') {
      return R.pick([
        () => `${'('.repeat(k)}${g(N)}${' + 1)'.repeat(k)}`,
        () => `${'-('.repeat(k)}${g(N)}${')'.repeat(k)}`,
        () => `(${'['.repeat(k)}${g(N)}${']'.repeat(k)}${'[0]'.repeat(k)} ?? 0)`,
        () => `${'abs('.repeat(k)}${g(N)}${')'.repeat(k)}`,
      ])()
    }
    if (kind === 'boolean') {
      return R.pick([
        () => `${'!'.repeat(k)}${g(B)}`,
        () => `${`(${g(B)} ? `.repeat(k)}${g(B)}${' : false)'.repeat(k)}`,
      ])()
    }
    return kind === 'string' ? `${'('.repeat(k)}${g(S)}${' + "x")'.repeat(k)}` : null
  }

  root(): Scope {
    return {
      scope: Object.entries(this.variables).map(([src, type]) => ({ src, type })),
      it: null,
      used: null,
    }
  }

  private pathsOf(ctx: Scope): NonNullable<Scope['paths']> {
    if (!ctx.paths) {
      const named: Path[] = []
      for (const entry of ctx.scope) navigate(entry.src, entry.type, 3, named, 'var')
      const it: Path[] = []
      if (ctx.it) navigate('.', ctx.it, 3, it, 'it')
      ctx.paths = { named, it }
    }
    return ctx.paths
  }

  /** A path of type `type`, preferring `.` inside an implicit lambda and `row` in a filter. */
  pathOf(type: Type, ctx: Scope, keep: (path: Path) => boolean = () => true): string | null {
    const R = this.R
    const { named, it } = this.pathsOf(ctx)
    const fromNamed = named.filter((path) => keep(path) && fits(path.type, type))
    const fromIt = it.filter((path) => keep(path) && fits(path.type, type))
    let pool = fromNamed
    if (fromIt.length > 0 && (R.chance(0.6) || fromNamed.length === 0)) pool = fromIt
    if (pool.length === 0) return null
    if (this.filter && pool === fromNamed) {
      const rowPaths = pool.filter((path) => path.src.startsWith('row'))
      if (rowPaths.length > 0 && R.chance(0.7)) pool = rowPaths
    }
    if (pool === fromIt && ctx.used) ctx.used.value = true
    return R.pick(pool).src
  }

  private name(): string {
    this.fresh += 1
    return `p${String(this.fresh)}`
  }

  /** A lambda over `element` producing `body`: an implicit `.` body when one reads `.`. */
  lambda(element: Type, body: Type, ctx: Scope, depth: number, withIndex = false): string {
    const R = this.R
    if (R.chance(0.65)) {
      const inner: Scope = { scope: ctx.scope, it: element, used: { value: false } }
      const source = this.gen(body, inner, depth)
      if (inner.used?.value === true) return source
    }
    const param = this.name()
    const scope = [...ctx.scope, { src: param, type: element }]
    if (withIndex && R.chance(0.4)) {
      const index = this.name()
      scope.push({ src: index, type: N })
      return `(${param}, ${index}) => ${this.gen(body, { scope, it: null, used: null }, depth)}`
    }
    return `${param} => ${this.gen(body, { scope, it: null, used: null }, depth)}`
  }

  /** A non-null list in scope, or a generated one, with its element type. */
  private anyList(ctx: Scope, depth: number): { src: string; element: Type } {
    const R = this.R
    const { named, it } = this.pathsOf(ctx)
    const lists = [...named, ...it].filter(
      (path) => strip(path.type).kind === 'list' && !isNullable(path.type),
    )
    if (lists.length > 0 && R.chance(0.8)) {
      const path = R.pick(lists)
      if (path.src.startsWith('.') && ctx.used) ctx.used.value = true
      const list = strip(path.type)
      return { src: path.src, element: list.kind === 'list' ? list.element : ANY }
    }
    const element = R.pick([N, S, TS, D])
    return { src: this.gen(t.list(element), ctx, depth - 1), element }
  }

  private scalarType(): Type {
    return this.R.pick([N, N, S, S, B, TS, D])
  }

  gen(type: Type, ctx: Scope, depth: number): string {
    for (let tries = 0; tries < 6; tries++) {
      const source = this.genOnce(type, ctx, depth)
      if (source !== null) return source
    }
    return this.leaf(type, ctx) ?? 'null'
  }

  private leaf(type: Type, ctx: Scope): string | null {
    const R = this.R
    // Outside strict mode, a name or field nobody declared reads as `any`.
    if (!this.strict && R.chance(0.06))
      return R.pick(['zz', 'u.zz', 'u.addr?.zz', 'zz?.q', 'u.tags.zz', 'u["zz"]'])
    const path = R.chance(0.7) ? this.pathOf(type, ctx) : null
    if (path !== null) return path
    const base = strip(type)
    switch (base.kind) {
      case 'number':
        return R.pick(NUMBER_LITERALS)
      case 'string':
        return R.pick(STRING_LITERALS)
      case 'boolean':
        return R.pick(['true', 'false'])
      case 'timestamp':
        return `timestamp(${R.pick(DATE_LITERALS)})`
      case 'duration':
        return `${R.pick(['days', 'hours', 'minutes', 'seconds', 'milliseconds'])}(${R.pick(['1', '2', '0', '1.5', '(-3)', '0.0004'])})`
      case 'literal':
        return JSON.stringify(base.value)
      case 'list':
        return `[${this.leaf(base.element, ctx) ?? 'null'}]`
      case 'map':
        return '{}'
      case 'null':
        return 'null'
      case 'any':
        return this.leaf(this.scalarType(), ctx)
      case 'union':
        return this.leaf(R.pick(base.types), ctx)
      case 'never':
      case 'opaque':
      case 'function':
      case 'var':
      default:
        return null
    }
  }

  /** Forms that produce any type: `?:`, `let`, `try`, `??`. */
  private generic(type: Type, ctx: Scope, depth: number): string | null {
    const R = this.R
    switch (R.int(0, 6)) {
      case 0:
        return `(${this.gen(B, ctx, depth - 1)} ? ${this.gen(type, ctx, depth - 1)} : ${this.gen(type, ctx, depth - 1)})`
      case 1: {
        const valueType = this.scalarType()
        const value = this.gen(valueType, ctx, depth - 1)
        const name = this.name()
        const inner: Scope = {
          scope: [...ctx.scope, { src: name, type: valueType }],
          it: ctx.it,
          used: ctx.used,
        }
        return `(let ${name} = ${value}; ${this.gen(type, inner, depth - 1)})`
      }
      case 2:
        return `try(${this.gen(type, ctx, depth - 1)}, ${this.gen(type, ctx, depth - 1)})`
      case 3:
        return `(${this.gen(opt(type), ctx, depth - 1)} ?? ${this.gen(type, ctx, depth - 1)})`
      case 4:
        return `(${this.gen(t.list(type), ctx, depth - 1)}.first() ?? ${this.gen(type, ctx, depth - 1)})`
      default:
        return null
    }
  }

  /** Forms that may produce null. */
  private nullable(type: Type, ctx: Scope, depth: number): string | null {
    const R = this.R
    const base = strip(type)
    const list = (): string => this.gen(t.list(base), ctx, depth - 1)
    switch (R.int(0, 7)) {
      case 0:
        return 'null'
      case 1:
        return this.pathOf(type, ctx, (path) => isNullable(path.type))
      case 2:
        return `${list()}.${R.pick(['first', 'last'])}()`
      case 3:
        return `${list()}.find(${this.lambda(base, B, ctx, depth - 1)})`
      case 4:
        return `${list()}[${R.pick(['0', '1', '(-1)', '0.5', '5'])}]`
      case 5:
        return base.kind === 'string'
          ? `${this.gen(opt(S), ctx, depth - 1)}?.${R.pick(['trim', 'toUpperCase', 'toLowerCase'])}()`
          : null
      case 6:
        return base.kind === 'number'
          ? `${this.gen(opt(S), ctx, depth - 1)}?.indexOf(${this.gen(S, ctx, depth - 1)})`
          : null
      default:
        return `${list()}.at(${R.pick(['0', '(-1)', '2'])})`
    }
  }

  private genOnce(type: Type, ctx: Scope, depth: number): string | null {
    const R = this.R
    if (depth <= 0 || R.chance(0.15)) return this.leaf(type, ctx)
    if (R.chance(0.12)) {
      const generic = this.generic(type, ctx, depth)
      if (generic !== null) return generic
    }
    if (isNullable(type) && type.kind !== 'any' && R.chance(0.35)) {
      const nullable = this.nullable(type, ctx, depth)
      if (nullable !== null) return nullable
    }
    const base = strip(type)
    const g = (inner: Type): string => this.gen(inner, ctx, depth - 1)
    if (this.host.size > 0 && R.chance(0.15)) {
      const call = this.hostCall(base, g)
      if (call !== null) return call
    }
    if (R.chance(0.02)) {
      const shallow = (inner: Type): string => this.gen(inner, ctx, 0)
      const deep = this.deep(base, shallow)
      if (deep !== null) return deep
    }
    switch (base.kind) {
      case 'any':
        return this.gen(this.scalarType(), ctx, depth)
      case 'union':
        return this.gen(R.pick(base.types), ctx, depth)
      case 'literal':
        return JSON.stringify(base.value)
      case 'null':
        return 'null'
      case 'number':
        return this.number(ctx, depth, g)
      case 'string':
        return this.string(ctx, depth, g)
      case 'boolean':
        return this.boolean(ctx, depth, g)
      case 'timestamp':
        return this.timestamp(g)
      case 'duration':
        return this.duration(g)
      case 'list':
        return this.list(base.element, type, ctx, depth, g)
      case 'map': {
        if (base.rest && Object.keys(base.fields).length === 0) {
          switch (R.int(0, 3)) {
            case 0:
              return `{${R.pick(['k1', 'a', '"x-y"'])}: ${g(base.rest)}, [${g(S)}]: ${g(base.rest)}}`
            case 1:
              return `{...${g(opt(type))}, k2: ${g(base.rest)}}`
            case 2:
              return base.rest.kind === 'any'
                ? `{ ...${this.pathOf(t.object({}), ctx) ?? '{}'} }`
                : null
            default:
              return null
          }
        }
        const entries = Object.entries(base.fields).map(
          ([field, fieldType]) =>
            `${IDENTIFIER.test(field) ? field : JSON.stringify(field)}: ${g(fieldType)}`,
        )
        return `{${entries.join(', ')}}`
      }
      case 'never':
      case 'opaque':
      case 'function':
      case 'var':
      default:
        return null
    }
  }

  private number(ctx: Scope, depth: number, g: (type: Type) => string): string | null {
    const R = this.R
    switch (R.int(0, 24)) {
      case 0:
      case 1:
        return `(${g(N)} ${R.pick(['+', '-', '*', '/', '%'])} ${g(N)})`
      case 2:
        return `(${g(N)} ** ${R.pick(['2', '0.5', '(-1)', '3'])})`
      case 3:
        return `(-${g(N)})`
      case 4:
        return `${g(R.chance(0.5) ? S : t.list(this.scalarType()))}.length`
      case 5: {
        const list = this.anyList(ctx, depth)
        return R.chance(0.5)
          ? `count(${list.src})`
          : `${list.src}.count(${this.lambda(list.element, B, ctx, depth - 1, true)})`
      }
      case 6: {
        const list = this.anyList(ctx, depth)
        return `${list.src}.findIndex(${this.lambda(list.element, B, ctx, depth - 1, true)})`
      }
      case 7:
        return `${g(S)}.${R.pick(['indexOf', 'lastIndexOf'])}(${g(S)})`
      case 8:
        return `sum(${g(t.list(opt(N)))})`
      case 9:
        return `${R.pick(['round', 'floor', 'ceil', 'trunc', 'abs', 'sqrt'])}(${g(N)})`
      case 10:
        return `round(${g(N)}, ${R.pick(['0', '1', '2', '(-1)'])})`
      case 11:
        return `clamp(${g(N)}, ${g(N)}, ${g(N)})`
      case 12:
        return `${R.pick(['min', 'max'])}(${g(N)}, ${g(N)}${R.chance(0.3) ? `, ${g(N)}` : ''})`
      case 13:
        return `(${g(t.list(N))}.${R.pick(['min', 'max'])}() ?? ${g(N)})`
      case 14:
        return `${R.pick(['inDays', 'inHours', 'inMinutes', 'inSeconds', 'inMilliseconds'])}(${g(D)})`
      case 15:
        return `${R.pick(['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek'])}(${g(TS)}${R.chance(0.4) ? `, ${R.pick(ZONES)}` : ''})`
      case 16:
        return `(${g(D)} / ${g(D)})`
      case 17:
        return `toNumber(${R.pick(['"12"', '"1.5e3"', '" 7 "', '"0x10"', '"abc"', '""'])})`
      case 18: {
        const acc = this.name()
        const item = this.name()
        const list = this.gen(t.list(N), ctx, depth - 1)
        const inner: Scope = {
          scope: [...ctx.scope, { src: acc, type: N }, { src: item, type: N }],
          it: null,
          used: null,
        }
        return `${list}.reduce((${acc}, ${item}) => ${this.gen(N, inner, depth - 1)}, ${g(N)})`
      }
      case 19:
        return `(avg(${g(t.list(opt(N)))}) ?? 0)`
      case 20:
        return `toNumber(${g(N)})`
      case 21:
        return `${g(t.list(N))}.indexOf(${g(N)})`
      default:
        return null
    }
  }

  private string(ctx: Scope, depth: number, g: (type: Type) => string): string | null {
    const R = this.R
    switch (R.int(0, 26)) {
      case 0:
      case 1: {
        const tail = R.pick(['', '!', `\${${g(opt(this.scalarType()))}}`])
        return `\`${R.pick(['', 'x', 'a b'])}\${${g(this.scalarType())}}${tail}\``
      }
      case 2:
        return `(${g(S)} + ${g(S)})`
      case 3:
        return `${g(S)}.${R.pick(['toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd'])}()`
      case 4:
        return `${g(S)}.slice(${g(N)}${R.chance(0.5) ? `, ${g(N)}` : ''})`
      case 5:
        return `${R.pick(['replace', 'replaceAll'])}(${g(S)}, ${g(S)}, ${g(S)})`
      case 6:
        return `${R.pick(['padStart', 'padEnd'])}(${g(S)}, ${R.pick(['0', '3', '8', '(-1)'])}${R.chance(0.5) ? `, ${R.pick(STRING_LITERALS)}` : ''})`
      case 7:
        return `${g(S)}.repeat(${R.pick(['0', '2', '3', '0.5', '(-1)'])})`
      case 8:
        return `${g(t.list(R.pick([S, N, opt(S), TS, D, B])))}.join(${R.chance(0.5) ? R.pick(STRING_LITERALS) : ''})`
      case 9:
        return `toString(${g(R.pick([N, S, B, TS, D, opt(N)]))})`
      case 10:
        return `toFixed(${g(N)}, ${R.pick(['0', '2', '5', '(-1)', '101'])})`
      case 11:
        return `formatNumber(${g(N)}${R.chance(0.5) ? `, ${R.pick(['0', '2', 'null'])}` : ''}${R.chance(0.3) ? `, ${R.pick(['"en-US"', '"de-DE"', 'null'])}` : ''})`
      case 12:
        return `formatDate(${g(TS)}, ${R.pick(['"yyyy-MM-dd"', '"HH:mm:ss.SSS"', '"EEEE d MMMM yy h a"', '"\'at\' HH"', '"M/d"'])}${R.chance(0.4) ? `, ${R.pick(ZONES)}` : ''})`
      case 13:
        return `(${g(S)}.at(${g(N)}) ?? "")`
      case 14:
        return `type(${g(R.pick([N, S, B, TS, D, opt(N), t.list(N), ANY]))})`
      case 15:
        return `${g(S)}.split(${R.pick(STRING_LITERALS)}${R.chance(0.3) ? ', 2' : ''}).join("|")`
      case 16:
        return `(${g(t.list(S))}.first() ?? "")`
      case 17:
        return `keys(${g(t.record(ANY))}).join()`
      case 18:
        return `formatCurrency(${g(N)}, ${R.pick(['"USD"', '"EUR"', '"JPY"'])})`
      case 19:
        return `toString(${g(t.list(S))}.length)`
      case 20: {
        const list = this.anyList(ctx, depth)
        return `${list.src}.map(${this.lambda(list.element, S, ctx, depth - 1, true)}).join(",")`
      }
      case 21:
        return `${g(S)}.split("").${R.pick(['reverse()', 'unique()', 'sort()'])}.join(${R.chance(0.5) ? '""' : '"|"'})`
      case 22:
        return `(${g(S)}.at(${R.pick(['0', '(-1)', '1'])}) ?? "")`
      default:
        return null
    }
  }

  private boolean(ctx: Scope, depth: number, g: (type: Type) => string): string | null {
    const R = this.R
    const textCall = (): string => R.pick(['startsWith', 'endsWith', 'includes'])
    switch (R.int(0, 26)) {
      case 0:
      case 1:
      case 2: {
        const operand = R.pick([N, S, TS, D, opt(N), opt(S)])
        return `(${g(operand)} ${R.pick(['<', '<=', '>', '>='])} ${g(operand)})`
      }
      case 3:
      case 4: {
        const operand = R.pick([
          N,
          S,
          B,
          TS,
          D,
          opt(N),
          opt(S),
          t.list(N),
          t.record(N),
          t.enum('x', 'y'),
        ])
        return `(${g(operand)} ${R.pick(['==', '!='])} ${g(operand)})`
      }
      case 5: {
        const item = R.pick([N, S, opt(S), TS, B])
        return `(${g(item)} ${R.pick(['in', 'not in'])} ${g(t.list(item))})`
      }
      case 6:
        return `(${g(S)} ${R.pick(['in', 'not in'])} ${g(S)})`
      case 7:
        return `(${g(S)} in ${g(t.record(ANY))})`
      case 8:
      case 9:
        return `(${g(B)} ${R.pick(['&&', '||'])} ${g(B)})`
      case 10:
        return `!${g(B)}`
      case 11: {
        const path = this.pathOf(ANY, ctx, (p) => p.kind === 'member' || p.kind === 'index')
        return path === null ? null : `has(${path})`
      }
      case 12:
        return `${g(S)}.${textCall()}(${g(S)})`
      case 13:
        return `(${g(opt(S))}?.${textCall()}(${g(S)}) ?? ${R.pick(['false', 'true'])})`
      case 14:
        return `matches(${g(S)}, ${R.pick(PATTERNS)})`
      case 15:
      case 16: {
        const list = this.anyList(ctx, depth)
        return `${list.src}.${R.pick(['some', 'every', 'none'])}(${this.lambda(list.element, B, ctx, depth - 1, true)})`
      }
      case 17:
        return `isEmpty(${g(R.pick([t.list(N), S, t.record(N), opt(S)]))})`
      case 18:
        return `(${g(opt(B))} ?? ${g(B)})`
      case 19:
        return `(${g(opt(B))} ${R.pick(['==', '!='])} ${R.pick(['true', 'false', 'null'])})`
      case 20:
        return `(${g(R.pick([opt(N), opt(S), opt(TS), opt(D), opt(B)]))} ${R.pick(['==', '!='])} null)`
      case 21:
        return `${g(t.list(N))}.includes(${g(N)})`
      case 22:
        return `(${g(opt(S))}?.${textCall()}(${g(S)}) ${R.pick(['== true', '!= false', '== null'])})`
      case 23:
        return `(${g(TS)} ${R.pick(['-', '+'])} ${g(D)} ${R.pick(['<', '>='])} ${g(TS)})`
      case 24:
        return `(now() - ${g(TS)} ${R.pick(['<', '>'])} ${g(D)})`
      default:
        return null
    }
  }

  private timestamp(g: (type: Type) => string): string | null {
    const R = this.R
    switch (R.int(0, 12)) {
      case 0:
      case 1:
        return `(${g(TS)} ${R.pick(['+', '-'])} ${g(D)})`
      case 2:
        return `(${g(D)} + ${g(TS)})`
      case 3:
        return `${R.pick(['addDays', 'addMonths', 'addYears'])}(${g(TS)}, ${R.pick(['1', '(-1)', '12', '0.5', '31'])}${R.chance(0.4) ? `, ${R.pick(ZONES)}` : ''})`
      case 4:
        return `${R.pick(['startOfDay', 'startOfMonth', 'startOfYear'])}(${g(TS)}${R.chance(0.4) ? `, ${R.pick(ZONES)}` : ''})`
      case 5:
        return `timestamp(${R.pick([...DATE_LITERALS, '0', '1e12', '"2024-13-01"', '(-1)', '8.64e15', '(-8.64e15)', '8.640000000000001e15'])})`
      case 6:
        return `${R.pick(['min', 'max'])}(${g(TS)}, ${g(TS)})`
      case 7:
        return 'now()'
      case 8:
        return `timestamp(${g(TS)})`
      default:
        return null
    }
  }

  private duration(g: (type: Type) => string): string | null {
    const R = this.R
    switch (R.int(0, 12)) {
      case 0:
        return `${R.pick(['days', 'hours', 'minutes', 'seconds', 'milliseconds', 'weeks'])}(${g(N)})`
      case 1:
      case 2:
        return `(${g(D)} ${R.pick(['+', '-'])} ${g(D)})`
      case 3:
        return `(${g(D)} * ${g(N)})`
      case 4:
        return `(${g(N)} * ${g(D)})`
      case 5:
        return `(${g(D)} / ${g(N)})`
      case 6:
        return this.host.has('abs') ? null : `abs(${g(D)})`
      case 11:
        return `${R.pick(['milliseconds', 'days', 'seconds'])}(${R.pick(['8.64e15', '(-8.64e15)', '1e8', '9007199254740991', '1e16'])})`
      case 7:
        return `(${g(TS)} - ${g(TS)})`
      case 8:
        return `duration(${R.pick(['"PT1H"', '"P1D"', '"PT0.5S"', '"-PT1M"', '"P1W"', '"x"'])})`
      case 9:
        return `sum(${g(t.list(opt(D)))})`
      case 10:
        return `${R.pick(['min', 'max'])}(${g(D)}, ${g(D)})`
      default:
        return null
    }
  }

  private list(
    element: Type,
    type: Type,
    ctx: Scope,
    depth: number,
    g: (type: Type) => string,
  ): string | null {
    const R = this.R
    switch (R.int(0, 16)) {
      case 0:
      case 1: {
        const items = Array.from({ length: R.int(0, 3) }, () => g(element))
        if (R.chance(0.3)) items.push(`...${g(opt(t.list(element)))}`)
        return `[${items.join(', ')}]`
      }
      case 2:
      case 3:
        return `${g(type)}.filter(${this.lambda(element, B, ctx, depth - 1, true)})`
      case 4:
      case 5: {
        const list = this.anyList(ctx, depth)
        return `${list.src}.map(${this.lambda(list.element, element, ctx, depth - 1, true)})`
      }
      case 6: {
        const key = R.pick([N, S, TS])
        return `${g(type)}.sortBy(${this.lambda(element, key, ctx, depth - 1)}${R.chance(0.3) ? ', "desc"' : ''})`
      }
      case 7:
        return fits(element, N) || fits(element, S)
          ? `${g(type)}.sort(${R.chance(0.3) ? '"desc"' : ''})`
          : null
      case 8:
        return `${g(type)}.${R.pick(['reverse', 'unique'])}()`
      case 9:
        return `${g(type)}.slice(${R.pick(['0', '1', '(-1)', '0.5'])}${R.chance(0.5) ? `, ${R.pick(['2', '(-1)', '10'])}` : ''})`
      case 10:
        return `(${g(type)} + ${g(type)})`
      case 11: {
        const list = this.anyList(ctx, depth)
        return `${list.src}.flatMap(${this.lambda(list.element, R.chance(0.5) ? type : element, ctx, depth - 1)})`
      }
      case 12:
        return fits(S, element) ? `${g(S)}.split(${R.pick(STRING_LITERALS)})` : null
      case 13:
        return fits(S, element) ? `keys(${g(t.record(ANY))})` : null
      case 14:
        return `values(${g(t.record(element))})`
      case 15:
        return `entries(${g(t.record(element))}).map(.value)`
      default:
        return null
    }
  }
}

// === Comparing values ===

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime() || (Number.isNaN(a.getTime()) && Number.isNaN(b.getTime()))
  }
  if (a instanceof Duration && b instanceof Duration) return Object.is(a.ms, b.ms)
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return (
      ka.length === kb.length && ka.every((key, i) => key === kb[i] && deepEqual(a[key], b[key]))
    )
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Duration)
  )
}

/** Whether a value has a type (an absent field reads as null). */
function conforms(value: unknown, type: Type): boolean {
  switch (type.kind) {
    case 'any':
      return value !== undefined
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number'
    case 'string':
      return typeof value === 'string'
    case 'timestamp':
      return value instanceof Date
    case 'duration':
      return value instanceof Duration
    case 'literal':
      return value === type.value
    case 'union':
      return type.types.some((member) => conforms(value, member))
    case 'list':
      return Array.isArray(value) && value.every((item) => conforms(item ?? null, type.element))
    case 'map': {
      if (!isRecord(value)) return false
      for (const [field, fieldType] of Object.entries(type.fields)) {
        if (!conforms(Object.hasOwn(value, field) ? (value[field] ?? null) : null, fieldType))
          return false
      }
      if (type.rest) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(type.fields, key) && !conforms(value[key], type.rest)) return false
        }
      }
      return true
    }
    case 'opaque':
      return true
    case 'never':
    case 'function':
    case 'var':
    default:
      return false
  }
}

const RUNTIME_CODES = new Set([
  'DIVISION_BY_ZERO',
  'NON_FINITE',
  'INVALID_ARGUMENT',
  'STRING_LIMIT',
  'LIST_LIMIT',
  'STEP_LIMIT',
  'VALUE_DEPTH_LIMIT',
  'PATTERN_LIMIT',
  'HOST_ERROR',
  'HOST_CONTRACT',
  'TIMEOUT',
])

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

function attempt(run: () => unknown): Outcome {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return { ok: false, error }
  }
}

async function attemptAsync(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

const codeOf = (error: unknown): string =>
  isBonsaiError(error)
    ? error.code
    : `RAW ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`

const same = (a: Outcome, b: Outcome): boolean =>
  a.ok && b.ok ? deepEqual(a.value, b.value) : !a.ok && !b.ok && codeOf(a.error) === codeOf(b.error)

function serialize(value: unknown): string {
  return JSON.stringify(value, function replace(this: Record<string, unknown>, key, item: unknown) {
    const raw = this[key]
    if (raw instanceof Date)
      return { $date: Number.isNaN(raw.getTime()) ? 'Invalid' : raw.toISOString() }
    if (raw instanceof Duration) return { $duration: raw.ms }
    if (typeof item === 'number' && !Number.isFinite(item)) return String(item)
    if (Object.is(item, -0)) return '-0'
    return item
  })
}

const show = (outcome: Outcome): string =>
  outcome.ok ? serialize(outcome.value) : `error ${codeOf(outcome.error)}`

// === Syntax trees ===

function nodesOf(root: Node): Node[] {
  const out: Node[] = []
  const visit = (node: Node): void => {
    out.push(node)
    forEachChild(node, visit)
  }
  visit(root)
  return out
}

/** A tree without positions, with locals read as variables (as parsing source gives). */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'start' || key === 'end' || key === 'nameStart' || key === 'nameEnd') continue
    out[key] = shape(item)
  }
  if (out.type === 'Local') out.type = 'Variable'
  return out
}

const sameShape = (a: unknown, b: unknown): boolean =>
  JSON.stringify(shape(a)) === JSON.stringify(shape(b))

// === Databases ===

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[]
  run: (...params: unknown[]) => unknown
}
interface SqliteDatabase {
  exec: (sql: string) => void
  query: (sql: string) => SqliteStatement
  close: () => void
}
// A computed specifier, so TypeScript (without Bun's types) does not resolve it.
const SQLITE_MODULE = 'bun:sqlite'
const { Database } = (await import(SQLITE_MODULE)) as {
  Database: new (path: string) => SqliteDatabase
}

const sqlite = new Database(':memory:')
sqlite.exec(
  'create table t (id integer, name text, city text, total real, qty real, active integer, placed integer, wait integer) strict',
)
const postgres = new PGlite()
await postgres.exec(
  'create table t (id int, name text, city text, total float8, qty float8, active boolean, placed timestamptz, wait bigint)',
)

async function loadRows(rows: readonly Row[]): Promise<void> {
  sqlite.exec('delete from t')
  const insert = sqlite.query('insert into t values (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const row of rows) {
    insert.run(
      row.id,
      row.name,
      row.city,
      row.total,
      row.qty,
      row.active === null ? null : Number(row.active),
      row.placed?.getTime() ?? null,
      row.wait?.ms ?? null,
    )
  }
  await postgres.exec('delete from t')
  for (const row of rows) {
    await postgres.query('insert into t values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      row.id,
      row.name,
      row.city,
      row.total,
      row.qty,
      row.active,
      row.placed?.toISOString() ?? null,
      row.wait?.ms ?? null,
    ])
  }
}

const idsOf = (rows: readonly unknown[]): number[] =>
  rows.map((row) => Number((row as { id: unknown }).id))

// === Partial evaluation helpers ===

/** Known data: some variables whole, some in part, the rest unknown (listed). */
function splitData(
  R: Random,
  data: Readonly<Record<string, unknown>>,
): { known: Record<string, unknown>; unknown: string[] } {
  const unknown: string[] = []
  // Splits objects at any depth: `u.addr.city` unknown while `u.addr.zip` is known.
  const split = (
    from: Readonly<Record<string, unknown>>,
    prefix: string,
    level: number,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(from)) {
      const path = prefix === '' ? name : `${prefix}.${name}`
      const roll = R.next()
      if (roll < 0.3) {
        unknown.push(path)
        // Sometimes the unknown value is given anyway: unknown wins.
        if (R.chance(0.2)) out[name] = value
        continue
      }
      if (roll < 0.65 && isRecord(value) && level < 3) {
        out[name] = split(value, path, level + 1)
        continue
      }
      out[name] = value
    }
    return out
  }
  const known = split(data, '', 0)
  // Paths that name nothing in the data, and a path below a list.
  if (R.chance(0.15))
    unknown.push(R.pick(['zz', 'u.zz', 'u.addr.zz.q', 'items.0', 'u.tags.length']))
  return { known, unknown }
}

/** The data cut down to the given paths. */
function pruneTo(
  paths: readonly string[],
  full: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const segments = path.split('.')
    let from: unknown = full
    let to = out
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      if (!isRecord(from) || !Object.hasOwn(from, segment)) break
      const value = from[segment]
      if (i === segments.length - 1 || !isRecord(value)) {
        to[segment] = value
        break
      }
      const next = to[segment]
      if (next === value) break
      if (!isRecord(next)) to[segment] = {}
      to = to[segment] as Record<string, unknown>
      from = value
    }
  }
  return out
}

// === One case ===

interface Case {
  readonly cfg: EnvConfig
  readonly service: LanguageService
  readonly variables: Readonly<Record<string, Type>>
  readonly filter: boolean
  readonly source: string
  readonly data: Readonly<Record<string, unknown>>
  /** Per-call options every view gets alike. */
  readonly options: Readonly<Record<string, unknown>>
  readonly exhaustive: boolean
  /** The data holds a value of the wrong type. */
  readonly corrupted: boolean
  /** Seeds the choices the checks make (partial splits, hover offsets, rows). */
  readonly seed: number
}

interface Failure {
  readonly invariant: string
  readonly detail: Readonly<Record<string, unknown>>
}

type Tally = (name: string) => void

const isLimit = (outcome: Outcome): boolean =>
  !outcome.ok && isBonsaiError(outcome.error) && LIMIT_CODES.has(outcome.error.code)
const stepish = (outcome: Outcome): boolean =>
  !outcome.ok &&
  isBonsaiError(outcome.error) &&
  ['STEP_LIMIT', 'TIMEOUT'].includes(outcome.error.code)
const isTimeout = (outcome: Outcome): boolean =>
  !outcome.ok && isBonsaiError(outcome.error) && outcome.error.code === 'TIMEOUT'

const fromExplanation = (outcome: Outcome): Outcome => {
  if (!outcome.ok) return outcome
  const explanation = outcome.value as ReturnType<Program['explainSync']>
  return explanation.ok
    ? { ok: true, value: explanation.value }
    : { ok: false, error: explanation.error }
}

type Residual = Extract<ReturnType<Program['partial']>, { readonly status: 'residual' }>
type Runnable = Pick<Program, 'async' | 'evaluate' | 'evaluateSync'>

/** Evaluates sync where it can, async where it must. */
function runOn(
  target: Runnable,
  data: unknown,
  options: Record<string, unknown>,
): Promise<Outcome> {
  return target.async
    ? attemptAsync(() => target.evaluate(data, options))
    : Promise.resolve(attempt(() => target.evaluateSync(data, options)))
}

/** A copy of plain data (objects and lists), sharing everything else. */
function copyData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyData)
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyData(item)]))
  return value
}

/** Whether `known` gives the path (or a non-object above it). */
function knownPath(known: Readonly<Record<string, unknown>>, segments: readonly string[]): boolean {
  let at: unknown = known
  for (const segment of segments) {
    if (!isRecord(at)) return true
    if (!Object.hasOwn(at, segment)) return false
    at = at[segment]
  }
  return true
}

/** The data behind a Proxy that records every path read through it. */
function recordReads(data: Readonly<Record<string, unknown>>): {
  readonly proxied: unknown
  readonly leaves: Set<string>
  readonly touched: Set<string>
} {
  const leaves = new Set<string>()
  const touched = new Set<string>()
  const wrap = (value: unknown, path: string): unknown => {
    if (!isRecord(value)) return value
    const at = (key: string): string => (path === '' ? key : `${path}.${key}`)
    return new Proxy(value, {
      get(target, key, receiver) {
        const item: unknown = Reflect.get(target, key, receiver)
        if (typeof key !== 'string') return item
        if (isRecord(item)) {
          touched.add(at(key))
          return wrap(item, at(key))
        }
        if (
          Object.hasOwn(target, key) ||
          (path !== '' && !(key in Object.prototype) && key !== 'then')
        )
          touched.add(at(key))
        return item
      },
      ownKeys(target) {
        // Listing an object's keys reads it whole.
        if (path !== '') leaves.add(path)
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string') touched.add(at(key))
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      has(target, key) {
        if (typeof key === 'string') touched.add(at(key))
        return Reflect.has(target, key)
      },
    })
  }
  return { proxied: wrap(data, ''), leaves, touched }
}

interface ResidualCase {
  readonly R: Random
  readonly c: Case
  readonly program: Program
  readonly result: Residual
  readonly known: Readonly<Record<string, unknown>>
  /** partial() was given `now`, so now() may be decided in the residual. */
  readonly partialNow: boolean
  readonly at: Readonly<Record<string, unknown>>
  readonly tally: Tally
}

/**
 * X2, X3, X4, X6, X7: a residual against its program under another `now`, with
 * validation toggled, on data that records reads, on exactly its dependsOn
 * data, and on data broken along a dependsOn path. Every run takes the same
 * plain options (no step or time budget), so the comparisons are exact.
 */
async function residualInvariants(rc: ResidualCase): Promise<Failure | undefined> {
  const { R, c, program, result, known, at, tally } = rc
  const fail = (invariant: string, detail: Record<string, unknown>): Failure => ({
    invariant,
    detail: { ...at, residual: result.source, ...detail },
  })
  const plain: Record<string, unknown> = c.options.now === undefined ? {} : { now: c.options.now }
  const validating = (c.options.validateContext as boolean | undefined) ?? c.cfg.validateContext
  const programBase = await runOn(program, c.data, plain)
  const residualBase = await runOn(result, c.data, plain)
  if (isLimit(programBase) || isLimit(residualBase)) return undefined

  // X2. now() is read when the residual runs, unless partial() was given `now`.
  if (!rc.partialNow) {
    tally('X2 residual agrees under another now')
    const other = { ...plain, now: new Date('2031-03-04T05:06:07.000Z') }
    const fromProgram = await runOn(program, c.data, other)
    const fromResidual = await runOn(result, c.data, other)
    if (!same(fromProgram, fromResidual) && !isLimit(fromProgram) && !isLimit(fromResidual))
      return fail('X2 residual differs under another now', {
        program: show(fromProgram),
        got: show(fromResidual),
      })
  }

  // X3. On conforming data, turning validation on or off per call changes nothing.
  if (c.cfg.limits.maxValueDepth === undefined) {
    tally('X3 validateContext toggled per call')
    const toggled = { ...plain, validateContext: !validating }
    const residualToggled = await runOn(result, c.data, toggled)
    const programToggled = await runOn(program, c.data, toggled)
    if (!same(residualBase, residualToggled) && !isLimit(residualToggled))
      return fail('X3 residual differs with validateContext toggled', {
        got: show(residualToggled),
      })
    if (!same(programBase, programToggled) && !isLimit(programToggled))
      return fail('X3 program differs with validateContext toggled', {
        got: show(programToggled),
      })
  }

  if (result.readsContext) return undefined
  const dependsOn = result.dependsOn
  const covers = (path: string): boolean =>
    dependsOn.some((d) => path === d || path.startsWith(`${d}.`))
  const toward = (path: string): boolean =>
    covers(path) || dependsOn.some((d) => d.startsWith(`${path}.`))

  // X4. The residual reads nothing outside its dependsOn paths.
  tally('X4 dependsOn covers every read')
  const recorded = recordReads(c.data)
  const proxied = await runOn(result, recorded.proxied, plain)
  if (!same(residualBase, proxied))
    return fail('X4 residual differs on recorded data', { got: show(proxied) })
  for (const path of recorded.leaves)
    if (!covers(path)) return fail('X4 residual reads outside dependsOn', { dependsOn, read: path })
  for (const path of recorded.touched)
    if (!toward(path))
      return fail('X4 residual touches outside dependsOn', { dependsOn, read: path })

  // X6. A context of exactly dependsOn passes validation.
  tally('X6 a dependsOn-only context validates')
  const validated = await runOn(result, pruneTo(dependsOn, c.data), {
    ...plain,
    validateContext: true,
  })
  if (!validated.ok && codeOf(validated.error) === 'INVALID_CONTEXT')
    return fail('X6 a dependsOn-only context is rejected', {
      dependsOn,
      message: (validated.error as Error).message,
    })

  // X7. Data broken on a dependsOn path: the residual is INVALID_CONTEXT, or gives
  // the program's unvalidated answer; it is never stricter than the program.
  if (dependsOn.length === 0) return undefined
  const path = R.pick(dependsOn).split('.')
  const segments = R.chance(0.5) ? path : [...path, R.pick(['a', 'k1', 'name', 'zip', 'x'])]
  if (knownPath(known, segments)) return undefined
  const broken = copyData(c.data) as Record<string, unknown>
  let parent: Record<string, unknown> = broken
  for (const segment of segments.slice(0, -1)) {
    const next = parent[segment]
    if (!isRecord(next)) return undefined
    parent = next
  }
  const bad = R.pick([
    'str',
    5,
    true,
    Number.NaN,
    Infinity,
    [],
    {},
    null,
    undefined,
    [Number.NaN],
    { a: 1 },
  ])
  const last = segments[segments.length - 1]
  if (bad === undefined) delete parent[last]
  else parent[last] = bad
  tally('X7 data broken on a dependsOn path')
  const residualValidated = await runOn(result, broken, { ...plain, validateContext: true })
  const programValidated = await runOn(program, broken, { ...plain, validateContext: true })
  const programUnvalidated = await runOn(program, broken, { ...plain, validateContext: false })
  if ([residualValidated, programValidated, programUnvalidated].some(isLimit)) return undefined
  const invalid = (outcome: Outcome): boolean =>
    !outcome.ok && codeOf(outcome.error) === 'INVALID_CONTEXT'
  const detail = {
    dependsOn,
    broke: segments.join('.'),
    bad: serialize(bad),
    residual: show(residualValidated),
    program: show(programValidated),
    programUnvalidated: show(programUnvalidated),
  }
  if (invalid(residualValidated) && !invalid(programValidated))
    return fail('X7 residual stricter than its program', detail)
  if (!invalid(residualValidated) && !same(residualValidated, programUnvalidated))
    return fail('X7 residual accepts broken data and differs', detail)
  return undefined
}

/** An error a getter in host data throws: a plain one, or a Bonsai error from elsewhere. */
function hostDataError(R: Random): unknown {
  const capture = (go: () => unknown): unknown => {
    try {
      go()
    } catch (error) {
      return error
    }
    return new Error('expected a throw')
  }
  switch (R.int(0, 2)) {
    case 0:
      return new Error('getter failed')
    case 1:
      return capture(() => parse('1 +'))
    default:
      return capture(() =>
        bonsai().evaluateSync('[1, 2, 3].map(. * 2).length', {}, { maxSteps: 2 }),
      )
  }
}

const FALLBACKS: Readonly<Record<string, string>> = { number: '0', string: '""', boolean: 'false' }
/** The generated host functions declared `call: true` (they read the context). */
const CONTEXT_FUNCTIONS: ReadonlySet<string> = new Set(['hc', 'hac', 'hcx'])

interface HostDataCase {
  readonly R: Random
  readonly c: Case
  readonly program: Program
  readonly tally: Tally
}

/**
 * 8. A getter in the context or the known data that throws: every view gives
 * HOST_ERROR (with the thrown error as its cause) or a value, never the thrown
 * error itself, and partial() agrees with evaluation, including inside try().
 */
async function throwingHostData(hc: HostDataCase): Promise<Failure | undefined> {
  const { R, c, program, tally } = hc
  const read = program.references.variables.filter((name) => Object.hasOwn(c.data, name))
  if (read.length === 0) return undefined
  const name = R.pick(read)
  const thrown = hostDataError(R)
  const withGetter = (from: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const out = { ...from }
    Object.defineProperty(out, name, {
      enumerable: true,
      configurable: true,
      get() {
        throw thrown
      },
    })
    return out
  }
  const context = withGetter(c.data)
  const fail = (invariant: string, detail: Record<string, unknown>): Failure => ({
    invariant,
    detail: { getter: name, thrown: codeOf(thrown), ...detail },
  })
  const leaks = (outcome: Outcome): boolean =>
    !outcome.ok && (outcome.error === thrown || !isBonsaiError(outcome.error))

  const plain: Record<string, unknown> = c.options.now === undefined ? {} : { now: c.options.now }
  tally('8 host data that throws')
  const views: [string, Outcome][] = [
    ['evaluate', await attemptAsync(() => program.evaluate(context, plain))],
    ['explain', fromExplanation(await attemptAsync(() => program.explain(context, plain)))],
  ]
  if (!program.async) {
    views.push(['evaluateSync', attempt(() => program.evaluateSync(context, plain))])
    views.push(['explainSync', fromExplanation(attempt(() => program.explainSync(context, plain)))])
  }
  const ref = views[0][1]
  const tinyTimeout = c.cfg.limits.timeout === 1e-9
  for (const [view, outcome] of views) {
    if (leaks(outcome))
      return fail(`8 ${view} lets the getter's error through`, { got: show(outcome) })
    if (tinyTimeout && (isTimeout(ref) || isTimeout(outcome))) {
      tally('8 timing divergence under a tiny timeout (skipped)')
      return undefined
    }
    if (!same(ref, outcome))
      return fail(`8 ${view} differs from evaluate`, { evaluate: show(ref), got: show(outcome) })
  }

  // partial() with the throwing getter in the known data, plain and inside try().
  const sources = [c.source]
  const fallback = FALLBACKS[strip(program.type).kind]
  if (fallback !== undefined) sources.push(`try(${c.source}, ${fallback})`)
  for (const source of sources) {
    const compiled = attempt(() => c.cfg.env.compile(source))
    if (!compiled.ok) continue
    const target = compiled.value as Program
    const expected = await runOn(target, context, plain)
    if (isLimit(expected)) continue
    const inTry = source !== c.source
    tally(`8 partial with a throwing known getter${inTry ? ' inside try()' : ''}`)
    const partial = attempt(() => target.partial(context, { unknown: [], ...plain }))
    const detail = { source, evaluation: show(expected) }
    if (!partial.ok) {
      if (leaks(partial))
        return fail("8 partial lets the getter's error through", {
          ...detail,
          got: show(partial),
        })
      // partial() has its own step budget, so its budget errors are soft.
      if (stepish(partial)) {
        tally('8 soft: partial reaches its step budget')
        continue
      }
      // partial() may fail as evaluation does, never where evaluation recovers.
      if (expected.ok || codeOf(expected.error) !== codeOf(partial.error)) {
        const readsContext = target.references.functions.some((f) => CONTEXT_FUNCTIONS.has(f))
        if (readsContext && codeOf(partial.error) === 'HOST_ERROR')
          return fail('8 partial reads a throwing known root for a call: true function', {
            ...detail,
            got: show(partial),
          })
        return fail(
          inTry
            ? '8 partial throws inside try() where evaluation recovers'
            : '8 partial throws where evaluation does not',
          { ...detail, got: show(partial) },
        )
      }
      continue
    }
    const result = partial.value as ReturnType<Program['partial']>
    let got: Outcome
    if (result.status === 'value') got = { ok: true, value: result.value }
    else if (result.status === 'error') got = { ok: false, error: result.error }
    else got = await runOn(result, context, plain)
    if (leaks(got))
      return fail("8 partial's result lets the getter's error through", {
        ...detail,
        got: show(got),
      })
    if (!same(expected, got) && !isLimit(got))
      return fail('8 partial differs from evaluation with a throwing getter', {
        ...detail,
        status: result.status,
        got: show(got),
      })
  }
  return undefined
}

/** Checks every view of one case; the first disagreement, or undefined. */
async function checkCase(c: Case, tally: Tally): Promise<Failure | undefined> {
  const R = random(c.seed)
  const fail = (invariant: string, detail: Record<string, unknown> = {}): Failure => ({
    invariant,
    detail,
  })
  const { service, source, data, cfg } = c
  const env = cfg.env
  const opts = c.options
  const tinyTimeout = opts.timeout === 1e-9 || cfg.limits.timeout === 1e-9
  const validating = (opts.validateContext as boolean | undefined) ?? cfg.validateContext
  const effectiveNow = (opts.now as Date | undefined) ?? cfg.clock

  const checked = attempt(() => env.check(source))
  if (!checked.ok) return fail('check throws', { error: codeOf(checked.error) })
  const check = checked.value as CheckResult

  // 6a. Service diagnostics match check().
  const listed = attempt(() => service.diagnostics(source))
  if (!listed.ok) return fail('service diagnostics throw', { error: codeOf(listed.error) })
  tally('6 diagnostics match check')
  const summary = (
    list: readonly {
      code: string
      severity: string
      start: number
      end: number
      message: string
    }[],
  ): string => JSON.stringify(list.map((d) => [d.code, d.severity, d.start, d.end, d.message]))
  const fromService = summary(listed.value as CheckResult['diagnostics'])
  const fromCheck = summary(check.diagnostics)
  if (fromService !== fromCheck)
    return fail('service diagnostics differ from check', { check: fromCheck, service: fromService })

  // 7a. An environment built with extend() checks as the one built flat.
  if (cfg.flat) {
    tally('7 extend matches flat (check)')
    const flatChecked = attempt(() => cfg.flat?.check(source))
    if (!flatChecked.ok) return fail('flat check throws', { error: codeOf(flatChecked.error) })
    const flatCheck = flatChecked.value as CheckResult
    if (
      summary(flatCheck.diagnostics) !== fromCheck ||
      flatCheck.ok !== check.ok ||
      (check.ok && flatCheck.ok && formatType(flatCheck.type) !== formatType(check.type))
    ) {
      return fail('extend() checks differently from flat', {
        extended: fromCheck,
        flat: summary(flatCheck.diagnostics),
      })
    }
  }
  if (!check.ok || check.ast === undefined) return undefined
  const program: Program = check.program
  const nodes = nodesOf(check.ast)

  // 6b. Hover matches the checked type.
  for (let h = 0; h < 3; h++) {
    const node = R.pick(nodes)
    if (node.type === 'Lambda') continue
    const offset = R.int(node.start, Math.max(node.start, node.end - 1))
    const accepted = new Set<string>()
    for (const candidate of nodes) {
      if (candidate.start > offset || offset > candidate.end) continue
      const type = check.typeOf(candidate)
      if (!type) continue
      accepted.add(formatType(type))
      if (type.kind === 'literal') accepted.add(typeof type.value)
    }
    const hovered = attempt(() => service.hover(source, offset))
    tally('6 hover matches typeOf')
    if (!hovered.ok) return fail('hover throws', { offset, error: codeOf(hovered.error) })
    const hover = hovered.value as ReturnType<LanguageService['hover']>
    if (!hover) {
      if (accepted.size > 0) return fail('hover finds nothing', { offset })
      continue
    }
    if (hover.documentation !== undefined || /^\w+\(/u.test(hover.detail)) continue
    if (!accepted.has(hover.detail))
      return fail('hover differs from typeOf', { offset, hover, accepted: [...accepted] })
  }

  // 2. Every way of evaluating agrees.
  const sync = attempt(() => program.evaluateSync(data, opts))
  const async = await attemptAsync(() => program.evaluate(data, opts))
  const explainedSync = attempt(() => program.explainSync(data, opts))
  const explainedAsync = await attemptAsync(() => program.explain(data, opts))
  tally('2 evaluate, explain agree')
  const ref = program.async ? async : sync
  const views: [string, Outcome][] = [
    ['evaluate', async],
    ['explain', fromExplanation(explainedAsync)],
  ]
  if (program.async) {
    tally('2 async program rejects in sync views')
    for (const [name, outcome] of [
      ['evaluateSync', sync],
      ['explainSync', fromExplanation(explainedSync)],
    ] as const) {
      if (outcome.ok || codeOf(outcome.error) !== 'ASYNC_IN_SYNC')
        return fail(`async program: ${name} is not ASYNC_IN_SYNC`, {
          got: show(outcome),
          evaluate: show(async),
        })
    }
  } else {
    views.push(['explainSync', fromExplanation(explainedSync)])
  }
  for (const [name, outcome] of views) {
    if (same(ref, outcome)) continue
    if (tinyTimeout && (isTimeout(ref) || isTimeout(outcome))) {
      tally('2 timing divergence under a tiny timeout (skipped)')
      return undefined
    }
    return fail(`${name} differs from ${program.async ? 'evaluate' : 'evaluateSync'}`, {
      ref: show(ref),
      [name]: show(outcome),
    })
  }
  for (const explained of [explainedSync, explainedAsync]) {
    if (!explained.ok) {
      if (explained === explainedSync && program.async) continue
      return fail('explain throws', { error: codeOf(explained.error) })
    }
    const explanation = explained.value as ReturnType<Program['explainSync']>
    if (explanation.ok && !deepEqual(explanation.trace.value, explanation.value)) {
      return fail('trace root holds another value', { root: serialize(explanation.trace.value) })
    }
    if (!explanation.ok && explanation.trace.error?.code !== explanation.error.code) {
      // Context validation fails before the root is evaluated: an unevaluated root.
      if (!explanation.trace.evaluated && explanation.trace.error === undefined) {
        tally('2 explain fails before evaluating (root unevaluated)')
        continue
      }
      // Skipped by design: the deadline is checked when the evaluation completes, so a
      // value can be computed and then reported as TIMEOUT. limits.md: `timeout` is
      // wall-clock time and varies with load; `maxSteps` is the deterministic limit.
      if (explanation.error.code === 'TIMEOUT' && explanation.trace.evaluated) {
        tally('2 skipped: TIMEOUT reached after the root was evaluated (documented)')
        continue
      }
      return fail('trace root holds another error', {
        root: explanation.trace.error?.code,
        evaluated: explanation.trace.evaluated,
      })
    }
  }
  for (const outcome of [sync, async]) {
    if (!outcome.ok && !isBonsaiError(outcome.error))
      return fail('raw error', { error: codeOf(outcome.error) })
  }

  // 2b. explain({ exhaustive: true }): same result, or a limit reached in the extra parts.
  if (c.exhaustive) {
    const runs: [string, Outcome][] = [
      [
        'explain exhaustive',
        await attemptAsync(() => program.explain(data, { ...opts, exhaustive: true })),
      ],
    ]
    if (!program.async)
      runs.push([
        'explainSync exhaustive',
        attempt(() => program.explainSync(data, { ...opts, exhaustive: true })),
      ])
    for (const [name, run] of runs) {
      tally('2 exhaustive explain agrees')
      if (!run.ok) return fail(`${name} throws`, { error: codeOf(run.error) })
      const result = fromExplanation(run)
      if (same(ref, result)) {
        const explanation = run.value as ReturnType<Program['explainSync']>
        if (explanation.ok && !deepEqual(explanation.trace.value, explanation.value))
          return fail(`${name}: trace root holds another value`, {
            root: serialize(explanation.trace.value),
          })
        continue
      }
      if (isLimit(result)) {
        tally('2 exhaustive explain hit a limit evaluation did not (documented)')
        continue
      }
      if (tinyTimeout && (isTimeout(ref) || isTimeout(result))) continue
      return fail(`${name} differs from evaluation`, { ref: show(ref), exhaustive: show(result) })
    }
  }

  // 7b. The flat environment evaluates the same.
  if (cfg.flat) {
    tally('7 extend matches flat (evaluate)')
    const flatOutcome = await attemptAsync(() =>
      (cfg.flat as Environment).compile(source).evaluate(data, opts),
    )
    if (!same(ref, flatOutcome) && !(tinyTimeout && (isTimeout(ref) || isTimeout(flatOutcome))))
      return fail('extend() evaluates differently from flat', {
        ref: show(ref),
        flat: show(flatOutcome),
      })
  }

  // 1. Check soundness.
  tally('1 check soundness')
  if (c.corrupted && validating) {
    tally('1 validation on a bad context')
    if (ref.ok || codeOf(ref.error) !== 'INVALID_CONTEXT') {
      // Validation may run only on what the expression reads; record and move on.
      if (ref.ok && !conforms(ref.value, program.type))
        return fail('validated evaluation returns a value outside its type', {
          type: formatType(program.type),
          value: serialize(ref.value),
        })
    }
  } else if (!c.corrupted) {
    if (ref.ok) {
      if (!conforms(ref.value, program.type)) {
        return fail('value outside its checked type', {
          type: formatType(program.type),
          value: serialize(ref.value),
        })
      }
    } else if (isBonsaiError(ref.error) && !RUNTIME_CODES.has(ref.error.code)) {
      const readsAny = nodes.some((node) =>
        JSON.stringify(check.typeOf(node) ?? null).includes('"any"'),
      )
      if (!readsAny) {
        return fail('unexpected error code', {
          type: formatType(program.type),
          error: ref.error.code,
          message: ref.error.message,
        })
      }
    }
  }

  // 3. Printing and spans.
  const printed = attempt(() => print(parse(source)))
  if (!printed.ok) return fail('print throws', { error: codeOf(printed.error) })
  tally('3 print round trip')
  const text = printed.value as string
  const reparsed = attempt(() => parse(text))
  if (!reparsed.ok) return fail('printed source does not parse', { printed: text })
  if (!sameShape(reparsed.value, parse(source)))
    return fail('printed source parses to another tree', { printed: text })
  const rechecked = env.check(text)
  if (!rechecked.ok && rechecked.diagnostics.every((d) => d.code === 'LIMIT')) {
    // Skipped by design: print() writes numbers in one form (`1e16` as
    // `10000000000000000`), so printed source can pass a parse limit the original
    // met. printer.md: "print() is a canonicalizer, not a formatter".
    tally('3 skipped: printed source exceeds a parse limit (documented)')
  } else if (!rechecked.ok) {
    return fail('printed source does not check', {
      printed: text,
      diagnostics: rechecked.diagnostics.map((d) => d.message),
    })
  } else {
    if (formatType(rechecked.type) !== formatType(program.type)) {
      return fail('printed source checks to another type', {
        printed: text,
        type: formatType(rechecked.type),
      })
    }
    const reevaluated = await attemptAsync(() => rechecked.program.evaluate(data, opts))
    const timing = tinyTimeout && (isTimeout(ref) || isTimeout(reevaluated))
    if (!same(ref, reevaluated) && !timing) {
      if (stepish(ref) || stepish(reevaluated)) {
        tally('3 soft: printed source reaches the step limit differently')
      } else {
        return fail('printed source evaluates differently', {
          printed: text,
          original: show(ref),
          printedResult: show(reevaluated),
        })
      }
    }
  }
  for (const node of nodes) {
    if (node.type === 'Lambda' || node.type === 'It') continue
    if (nodesOf(node).some((inner) => inner.type === 'It' || inner.type === 'Lambda')) continue
    const slice = source.slice(node.start, node.end)
    tally('3 spans slice to their node')
    const sliced = attempt(() => parse(slice))
    if (!sliced.ok) return fail('span does not parse', { slice, node: node.type })
    if (!sameShape(sliced.value, node))
      return fail('span parses to another tree', { slice, node: node.type })
  }

  // 4. Partial evaluation.
  // Whether the reference failed in context validation (a residual validates only
  // what it reads, and partial() takes no validateContext option).
  let validationFailed = false
  if (
    validating &&
    !ref.ok &&
    ['INVALID_CONTEXT', 'VALUE_DEPTH_LIMIT'].includes(codeOf(ref.error))
  ) {
    const unvalidated = await attemptAsync(() =>
      program.evaluate(data, { ...opts, validateContext: false }),
    )
    validationFailed = !same(ref, unvalidated)
  }
  for (const mode of ['default', 'list', 'complete'] as const) {
    const split =
      mode === 'complete' ? { known: { ...data }, unknown: [] as string[] } : splitData(R, data)
    const { known, unknown } = split
    const partialOptions: Record<string, unknown> = {}
    if (mode !== 'default') partialOptions.unknown = unknown
    const callHost = R.chance(0.5)
    if (callHost) partialOptions.callHostFunctions = true
    if (R.chance(0.5)) partialOptions.now = effectiveNow
    if (opts.maxSteps !== undefined && R.chance(0.5)) partialOptions.maxSteps = opts.maxSteps
    const partial = attempt(() => program.partial(known, partialOptions))
    tally(`4 partial agrees (${mode}${callHost ? ', callHostFunctions' : ''})`)
    const at = {
      known: serialize(known),
      options: serialize(partialOptions),
      full: show(ref),
    }
    if (!partial.ok) {
      const code = codeOf(partial.error)
      if (code === 'STEP_LIMIT' || code === 'TIMEOUT') continue
      if (code === 'SOURCE_TOO_LONG') {
        // Skipped by design. partial.md: "a residual longer than maxSourceLength is a
        // SOURCE_TOO_LONG limit error".
        tally('4 skipped: residual longer than maxSourceLength (documented)')
        continue
      }
      // A value limit evaluation also reaches.
      if (LIMIT_CODES.has(code) && !ref.ok && codeOf(ref.error) === code) {
        tally('4 partial throws the limit evaluation reaches')
        continue
      }
      if (code === 'VALUE_DEPTH_LIMIT' && cfg.validateContext && validating !== cfg.validateContext)
        continue
      if (code === 'VALUE_DEPTH_LIMIT' && cfg.validateContext && validationFailed) continue
      // Evaluation failed validating data partial() treats as unknown (unknown wins),
      // so its outcome says nothing about what partial() may reach first.
      if (validationFailed) {
        tally('4 partial throws after a context validation failure (unknown data)')
        continue
      }
      // The program stopped on its step or time budget first, so it says nothing.
      if (stepish(ref)) {
        tally('4 soft: partial throws a limit after the program reached its step budget')
        continue
      }
      return fail(
        LIMIT_CODES.has(code)
          ? 'partial throws a value limit evaluation does not reach'
          : 'partial throws',
        { ...at, error: code },
      )
    }
    const result = partial.value as ReturnType<Program['partial']>
    if (validationFailed) {
      tally(
        '4 partial after a context validation failure (documented: residual validates dependsOn)',
      )
      continue
    }
    if (c.corrupted) {
      tally('4 partial on a bad context (outcome not compared)')
      continue
    }
    if (result.status === 'value') {
      if (!ref.ok || !deepEqual(result.value, ref.value)) {
        if (isLimit(ref)) {
          tally('4 partial decides a value where evaluation hits a limit')
          continue
        }
        return fail('partial decides another value', { ...at, value: serialize(result.value) })
      }
      continue
    }
    if (result.status === 'error') {
      if (result.error.code === 'INVALID_CONTEXT' && cfg.validateContext && mode === 'default')
        continue
      if (ref.ok || codeOf(ref.error) !== result.error.code) {
        // Step and time budgets are soft: partial() and the program do different work.
        if (stepish(ref) || ['STEP_LIMIT', 'TIMEOUT'].includes(result.error.code)) {
          tally('4 soft: partial decides another step-limit outcome')
          continue
        }
        return fail('partial decides another error', { ...at, error: result.error.code })
      }
      continue
    }
    const onFull = result.async
      ? await attemptAsync(() => result.evaluate(data, opts))
      : attempt(() => result.evaluateSync(data, opts))
    if (!same(ref, onFull)) {
      if (tinyTimeout && (isTimeout(ref) || isTimeout(onFull))) continue
      if (stepish(ref) || stepish(onFull)) {
        tally('4 soft: residual reaches the step limit differently on the full data')
        continue
      }
      return fail('residual differs on the full data', {
        ...at,
        residual: result.source,
        got: show(onFull),
      })
    }
    if (!result.async) {
      const onFullAsync = await attemptAsync(() => result.evaluate(data, opts))
      const timing = tinyTimeout && (isTimeout(onFull) || isTimeout(onFullAsync))
      if (!same(onFull, onFullAsync) && !timing)
        return fail('residual evaluate differs from evaluateSync', {
          ...at,
          residual: result.source,
        })
    }
    if (!result.readsContext) {
      const pruned = pruneTo(result.dependsOn, data)
      const onDependsOn = result.async
        ? await attemptAsync(() => result.evaluate(pruned, opts))
        : attempt(() => result.evaluateSync(pruned, opts))
      if (!same(ref, onDependsOn) && !(tinyTimeout && isTimeout(onDependsOn))) {
        if (stepish(ref) || stepish(onDependsOn)) {
          tally('4 soft: residual on dependsOn reaches the step limit differently')
        } else {
          return fail('residual differs on its dependsOn data', {
            ...at,
            residual: result.source,
            dependsOn: result.dependsOn,
            got: show(onDependsOn),
          })
        }
      }
    }
    const explained = await attemptAsync(() =>
      result.explain(data, { ...opts, exhaustive: c.exhaustive }),
    )
    if (!explained.ok)
      return fail('residual explain throws', {
        ...at,
        residual: result.source,
        error: codeOf(explained.error),
      })
    // X1. The residual's explanation holds the residual's value or error code.
    tally('X1 residual explain matches evaluate')
    const residualExplained = fromExplanation(explained)
    const timing = tinyTimeout && (isTimeout(onFull) || isTimeout(residualExplained))
    if (
      !same(onFull, residualExplained) &&
      !(c.exhaustive && isLimit(residualExplained)) &&
      !timing
    )
      return fail('residual explain differs from evaluate', {
        ...at,
        residual: result.source,
        evaluate: show(onFull),
        explain: show(residualExplained),
      })
    if (c.corrupted || stepish(onFull)) continue
    const failure = await residualInvariants({
      R,
      c,
      program,
      result,
      known,
      partialNow: partialOptions.now !== undefined,
      at,
      tally,
    })
    if (failure) return failure
  }

  // 8. Host data that throws.
  if (!c.corrupted && R.chance(0.3)) {
    const failure = await throwingHostData({ R, c, program, tally })
    if (failure) return failure
  }

  // 5. Query translation.
  const isFilter =
    c.filter &&
    !c.corrupted &&
    strip(program.type).kind === 'boolean' &&
    program.references.variables.includes('row')
  if (!isFilter) return undefined
  const known: Record<string, unknown> = { ...data }
  delete known.row
  for (const name of Object.keys(c.variables))
    if (name !== 'row' && !(name in known)) known[name] = null
  const rows = Array.from({ length: R.int(3, 8) }, (_, i) => genRow(R, i + 1))
  const want: number[] = []
  const failing: number[] = []
  for (const row of rows) {
    const accepted = program.async
      ? await attemptAsync(() => program.evaluate({ ...known, row }, opts))
      : attempt(() => program.evaluateSync({ ...known, row }, opts))
    // A limit has no SQL equivalent: rows that reach one say nothing.
    if (isLimit(accepted)) {
      tally('5 query skipped: a row reached a limit')
      return undefined
    }
    if (accepted.ok && accepted.value === true) want.push(row.id)
    if (!accepted.ok) failing.push(row.id)
  }
  const callHost = R.chance(0.5)
  const at = { known: serialize(known), rows: serialize(rows), want, callHostFunctions: callHost }
  tally(`5 queries select the evaluated rows${callHost ? ' (callHostFunctions)' : ''}`)
  await loadRows(rows)
  const wellFormed = !LONE_SURROGATE.test(serialize(known))
  const queryOptions = {
    row: 'row',
    known,
    now: effectiveNow,
    ...(callHost ? { callHostFunctions: true } : {}),
  }
  // X5. Rows whose evaluation fails are exactly those neither the filter nor its
  // negation selects (query.md: failing rows are N - count(F) - count(!F)).
  const negated = attempt(() => env.compile(`!(${source})`))
  if (negated.ok) {
    const options = { ...queryOptions, columns: COLUMNS, dialect: 'sqlite' } as const
    const forFilter = attempt(() => toSQL(program, options))
    const forNegation = attempt(() => toSQL(negated.value as Program, options))
    if (forFilter.ok && forNegation.ok) {
      tally('X5 failing rows are selected by neither the filter nor its negation')
      const select = (query: unknown): number[] => {
        const { sql, params } = query as ReturnType<typeof toSQL>
        return idsOf(sqlite.query(`select id from t where ${sql} order by id`).all(...params))
      }
      const selected = new Set([...select(forFilter.value), ...select(forNegation.value)])
      const neither = rows.map((row) => row.id).filter((id) => !selected.has(id))
      if (JSON.stringify(neither) !== JSON.stringify(failing))
        return fail('X5 failing rows differ from rows neither query selects', {
          ...at,
          failing,
          neither,
        })
    }
  }
  for (const dialect of ['sqlite', 'postgres'] as const) {
    if (dialect === 'postgres' && !wellFormed) continue
    const query = attempt(() => toSQL(program, { ...queryOptions, columns: COLUMNS, dialect }))
    if (!query.ok) {
      if (codeOf(query.error) === 'UNTRANSLATABLE') continue
      if (isBonsaiError(query.error) && LIMIT_CODES.has(query.error.code)) continue
      if (isBonsaiError(query.error) && want.length === 0) continue
      return fail(`toSQL (${dialect}) throws`, { ...at, error: codeOf(query.error) })
    }
    const { sql, params } = query.value as ReturnType<typeof toSQL>
    let got: number[]
    try {
      got =
        dialect === 'sqlite'
          ? idsOf(sqlite.query(`select id from t where ${sql} order by id`).all(...params))
          : idsOf(
              (await postgres.query(`select id from t where ${sql} order by id`, [...params])).rows,
            )
    } catch (error) {
      if (
        dialect === 'postgres' &&
        /value out of range: (?:overflow|underflow)/u.test(String(error))
      )
        continue
      return fail(`${dialect} rejects the SQL`, { ...at, sql, error: String(error) })
    }
    if (JSON.stringify(got) !== JSON.stringify(want))
      return fail(`${dialect} selects other rows`, { ...at, sql, params: serialize(params), got })
  }
  const mongo = attempt(() => toMongo(program, { ...queryOptions, fields: COLUMNS }))
  if (!mongo.ok) {
    if (codeOf(mongo.error) === 'UNTRANSLATABLE') return undefined
    if (isBonsaiError(mongo.error) && LIMIT_CODES.has(mongo.error.code)) return undefined
    if (isBonsaiError(mongo.error) && want.length === 0) return undefined
    return fail('toMongo throws', { ...at, error: codeOf(mongo.error) })
  }
  const { filter } = mongo.value as ReturnType<typeof toMongo>
  let got: number[]
  try {
    const query = new Query(filter)
    got = rows
      .filter((row) => {
        const document: Record<string, unknown> = { ...row, wait: row.wait?.ms ?? null }
        if (row.id % 2 === 1)
          for (const key of Object.keys(document)) if (document[key] === null) delete document[key]
        return query.test(document)
      })
      .map((row) => row.id)
  } catch (error) {
    return fail('mingo rejects the filter', {
      ...at,
      filter: serialize(filter),
      error: String(error),
    })
  }
  if (JSON.stringify(got) !== JSON.stringify(want))
    return fail('mingo selects other rows', { ...at, filter: serialize(filter), got })
  return undefined
}

// === Shrinking ===

/** The distinct sub-expressions of a source, shortest first (spans slice to source). */
function subExpressions(source: string): string[] {
  const tree = attempt(() => parse(source))
  if (!tree.ok) return []
  const slices = nodesOf(tree.value as Node)
    .filter((node) => node.type !== 'Lambda')
    .map((node) => source.slice(node.start, node.end))
    .filter((slice) => slice.length < source.length)
  return [...new Set(slices)].sort((a, b) => a.length - b.length).slice(0, SHRINK_CANDIDATES)
}

/** The shortest sub-expression of the source that fails the same invariant. */
async function shrink(
  c: Case,
  failure: Failure,
): Promise<{ readonly c: Case; readonly failure: Failure }> {
  let best = c
  let bestFailure = failure
  for (;;) {
    let smaller: { c: Case; failure: Failure } | undefined
    for (const source of subExpressions(best.source)) {
      const candidate = { ...best, source }
      const found = await checkCase(candidate, () => undefined)
      if (found?.invariant === bestFailure.invariant) {
        smaller = { c: candidate, failure: found }
        break
      }
    }
    if (!smaller) break
    best = smaller.c
    bestFailure = smaller.failure
  }
  return { c: best, failure: bestFailure }
}

// === Main ===

const MAX_REPORTS_PER_INVARIANT = 2

/**
 * Invariants known to fail on main, each with the finding it waits on. They are
 * still run and reported, but do not fail the run; remove an entry with its fix.
 */
const EXPECTED_FAILURES: Readonly<Record<string, string>> = {
  // partial() collects the known roots a call: true residual needs by reading each
  // root's value (src/partial.ts, knownRoots), so a throwing getter is HOST_ERROR
  // even where evaluation never reads it or recovers inside try().
  '8 partial reads a throwing known root for a call: true function': 'F9-1',
}

async function main(): Promise<void> {
  const R = random(SEED)
  const counts = new Map<string, number>()
  const failures = new Map<string, number>()
  const tally: Tally = (name) => {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const started = performance.now()
  const deadline = started + SECONDS * 1000
  let cases = 0
  let environments = 0
  while (performance.now() < deadline) {
    environments += 1
    const { variables, filter } = genVariables(R)
    const cfg = genEnvironment(R, variables)
    const service = createLanguageService(cfg.env)
    const generator = new Generator(
      R,
      variables,
      filter,
      cfg.host,
      cfg.strict,
      cfg.limits.maxDepth ?? (R.chance(0.1) ? 128 : 10),
    )
    for (let i = 0; i < CASES_PER_ENVIRONMENT && performance.now() < deadline; i++) {
      const target: Type =
        filter && R.chance(0.7)
          ? B
          : R.pick([
              N,
              S,
              B,
              TS,
              D,
              t.list(N),
              t.list(S),
              ANY,
              t.optional(N),
              t.object({ a: N, b: S }),
            ])
      const source = generator.gen(target, generator.root(), R.int(1, MAX_DEPTH))
      const data: Record<string, unknown> = {}
      for (const [name, type] of Object.entries(variables)) {
        if (isNullable(type) && R.chance(0.2)) continue
        data[name] = genValue(R, type)
      }
      let corrupted = false
      if (R.chance(0.08)) {
        const names = Object.keys(variables)
        const name = R.pick(names)
        data[name] = corruptValue(R, variables[name])
        corrupted = true
      }
      const c: Case = {
        cfg,
        service,
        variables,
        filter,
        source,
        data,
        options: genOptions(R),
        exhaustive: R.chance(0.3),
        corrupted,
        seed: R.int(0, 0x7fff_ffff),
      }
      cases += 1
      let failure: Failure | undefined
      try {
        failure = await checkCase(c, tally)
      } catch (error) {
        failure = {
          invariant: 'harness or library crash',
          detail: { error: String(error), stack: (error as Error).stack },
        }
      }
      if (failure) {
        const seen = failures.get(failure.invariant) ?? 0
        failures.set(failure.invariant, seen + 1)
        if (seen < MAX_REPORTS_PER_INVARIANT) {
          const small =
            failure.invariant === 'harness or library crash'
              ? { c, failure }
              : await shrink(c, failure)
          report(small.c, small.failure, c.source)
        }
      }
    }
  }
  const seconds = Math.round((performance.now() - started) / 1000)
  process.stdout.write(
    `cross-fuzz: seed ${String(SEED)}, ${String(cases)} cases over ${String(environments)} environments in ${String(seconds)}s\n`,
  )
  for (const [name, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`  ${name}: ${String(count)}\n`)
  }
  let unexpected = 0
  for (const [name, count] of failures) {
    const known = EXPECTED_FAILURES[name]
    process.stdout.write(
      `  ${known === undefined ? 'FAILED' : `EXPECTED (${known})`} ${name}: ${String(count)}\n`,
    )
    if (known === undefined) unexpected += count
  }
  if (unexpected > 0) {
    process.stdout.write('✗ views disagreed\n')
    process.exitCode = 1
  } else process.stdout.write('✓ every view agreed\n')
}

function report(c: Case, failure: Failure, original: string): void {
  process.stdout.write(`\n✗ cross-fuzz: ${failure.invariant} (seed ${String(SEED)})\n`)
  process.stdout.write(`  source:    ${c.source}\n`)
  if (original !== c.source) process.stdout.write(`  shrunk from: ${original}\n`)
  const variables = Object.fromEntries(
    Object.entries(c.variables).map(([name, type]) => [name, formatType(type)]),
  )
  process.stdout.write(`  variables: ${JSON.stringify(variables)}\n`)
  process.stdout.write(`  env:       ${c.cfg.describe}\n`)
  process.stdout.write(
    `  options:   ${serialize(c.options)} exhaustive=${String(c.exhaustive)} corrupted=${String(c.corrupted)}\n`,
  )
  process.stdout.write(`  data:      ${serialize(c.data)}\n`)
  for (const [key, value] of Object.entries(failure.detail)) {
    process.stdout.write(`  ${key}: ${typeof value === 'string' ? value : serialize(value)}\n`)
  }
}

try {
  await main()
} finally {
  await postgres.close()
  sqlite.close()
}
