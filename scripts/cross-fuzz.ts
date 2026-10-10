/**
 * Cross-view fuzzer: every view of one generated expression must agree.
 *
 * The other fuzzers check one or two components at a time. This one generates
 * a typed environment, a well-formed expression over it (operators, built-ins,
 * lambdas, `let`, `try`, `has`, `?.`, `??`, map literals and spreads,
 * templates), and conforming data, then checks that each view gives the same
 * answer:
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
 *      checked type of the node under the cursor.
 *
 * The run is deterministic for a seed. On the first disagreement it shrinks
 * the expression to the shortest sub-expression that still fails the same
 * way, prints it with the environment and data, and exits non-zero.
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
  forEachChild,
  formatType,
  isAssignable,
  isBonsaiError,
  parse,
  print,
  t,
  type CheckResult,
  type Environment,
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
]
const DATES = [
  '2024-02-29T12:34:56.789Z',
  '1970-01-01T00:00:00.000Z',
  '1999-12-31T23:59:59.999Z',
  '2030-06-15T00:00:00.000Z',
  '1969-01-01T00:00:00.000Z',
  '2026-10-10T08:00:00.000Z',
]
const DURATIONS = [0, 1000, 3_600_000, 86_400_000, -5000, 90_061_001, 1, 1_209_600_000]
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
  return t.record(genType(R, 0))
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
    name: maybe(() => R.pick(STRINGS)),
    city: maybe(() => R.pick(STRINGS)),
    total: maybe(() => R.pick(NUMBERS)),
    qty: maybe(() => R.pick(NUMBERS)),
    active: maybe(() => R.chance(0.5)),
    placed: maybe(() => new Date(R.pick(DATES))),
    wait: maybe(() => new Duration(R.pick(DURATIONS))),
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
]
const PATTERNS = [
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
const ZONES = ['"UTC"', '"Europe/Berlin"', '"America/New_York"', '"Asia/Kolkata"']
const DATE_LITERALS = [
  '"2024-02-29T12:00:00Z"',
  '"2000-01-01T00:00:00.000Z"',
  '"2026-10-10T00:00:00Z"',
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
  }
}

class Generator {
  private readonly R: Random
  private readonly variables: Readonly<Record<string, Type>>
  private readonly filter: boolean
  private fresh = 0

  constructor(R: Random, variables: Readonly<Record<string, Type>>, filter: boolean) {
    this.R = R
    this.variables = variables
    this.filter = filter
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
        return `timestamp(${R.pick([...DATE_LITERALS, '0', '1e12', '"2024-13-01"', '(-1)'])})`
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
        return `abs(${g(D)})`
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
  const known: Record<string, unknown> = {}
  const unknown: string[] = []
  for (const [name, value] of Object.entries(data)) {
    const roll = R.next()
    if (roll < 0.3) {
      unknown.push(name)
      continue
    }
    if (roll < 0.6 && isRecord(value)) {
      const part: Record<string, unknown> = {}
      for (const [field, fieldValue] of Object.entries(value)) {
        if (R.chance(0.5)) part[field] = fieldValue
        else unknown.push(`${name}.${field}`)
      }
      known[name] = part
      continue
    }
    known[name] = value
  }
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
  readonly env: Environment
  readonly service: LanguageService
  readonly variables: Readonly<Record<string, Type>>
  readonly filter: boolean
  readonly validateContext: boolean
  readonly source: string
  readonly data: Readonly<Record<string, unknown>>
  /** Seeds the choices the checks make (partial splits, hover offsets, rows). */
  readonly seed: number
}

interface Failure {
  readonly invariant: string
  readonly detail: Readonly<Record<string, unknown>>
}

type Tally = (name: string) => void

/** Checks every view of one case; the first disagreement, or undefined. */
async function checkCase(c: Case, tally: Tally): Promise<Failure | undefined> {
  const R = random(c.seed)
  const fail = (invariant: string, detail: Record<string, unknown> = {}): Failure => ({
    invariant,
    detail,
  })
  const { env, service, source, data } = c

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
    // A function name hovers as its signature.
    if (hover.documentation !== undefined || /^\w+\(/u.test(hover.detail)) continue
    if (!accepted.has(hover.detail))
      return fail('hover differs from typeOf', { offset, hover, accepted: [...accepted] })
  }

  // 2. Every way of evaluating agrees.
  const sync = attempt(() => program.evaluateSync(data))
  const async = await attemptAsync(() => program.evaluate(data))
  const explainedSync = attempt(() => program.explainSync(data))
  const explainedAsync = await attemptAsync(() => program.explain(data))
  tally('2 evaluate, explain agree')
  const fromExplanation = (outcome: Outcome): Outcome => {
    if (!outcome.ok) return outcome
    const explanation = outcome.value as ReturnType<Program['explainSync']>
    return explanation.ok
      ? { ok: true, value: explanation.value }
      : { ok: false, error: explanation.error }
  }
  if (!same(sync, async))
    return fail('evaluateSync differs from evaluate', { sync: show(sync), async: show(async) })
  if (!same(sync, fromExplanation(explainedSync)))
    return fail('explainSync differs from evaluateSync', {
      sync: show(sync),
      explain: show(fromExplanation(explainedSync)),
    })
  if (!same(sync, fromExplanation(explainedAsync)))
    return fail('explain differs from evaluateSync', {
      sync: show(sync),
      explain: show(fromExplanation(explainedAsync)),
    })
  if (explainedSync.ok) {
    const explanation = explainedSync.value as ReturnType<Program['explainSync']>
    if (explanation.ok && !deepEqual(explanation.trace.value, explanation.value)) {
      return fail('trace root holds another value', { root: serialize(explanation.trace.value) })
    }
    if (!explanation.ok && explanation.trace.error?.code !== explanation.error.code) {
      return fail('trace root holds another error', { root: explanation.trace.error?.code })
    }
  }
  for (const outcome of [sync, async]) {
    if (!outcome.ok && !isBonsaiError(outcome.error))
      return fail('raw error', { error: codeOf(outcome.error) })
  }

  // 1. Check soundness.
  tally('1 check soundness')
  if (sync.ok) {
    if (!conforms(sync.value, program.type)) {
      return fail('value outside its checked type', {
        type: formatType(program.type),
        value: serialize(sync.value),
      })
    }
  } else if (isBonsaiError(sync.error) && !RUNTIME_CODES.has(sync.error.code)) {
    const readsAny = nodes.some((node) =>
      JSON.stringify(check.typeOf(node) ?? null).includes('"any"'),
    )
    if (!readsAny) {
      return fail('unexpected error code', {
        type: formatType(program.type),
        error: sync.error.code,
        message: sync.error.message,
      })
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
  if (!rechecked.ok)
    return fail('printed source does not check', {
      printed: text,
      diagnostics: rechecked.diagnostics.map((d) => d.message),
    })
  if (formatType(rechecked.type) !== formatType(program.type)) {
    return fail('printed source checks to another type', {
      printed: text,
      type: formatType(rechecked.type),
    })
  }
  const reevaluated = attempt(() => rechecked.program.evaluateSync(data))
  if (!same(sync, reevaluated))
    return fail('printed source evaluates differently', {
      printed: text,
      original: show(sync),
      printedResult: show(reevaluated),
    })
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
  for (const withList of [false, true]) {
    const { known, unknown } = splitData(R, data)
    const partial = attempt(() => program.partial(known, withList ? { unknown } : undefined))
    tally('4 partial agrees')
    const at = {
      known: serialize(known),
      unknown: withList ? unknown : 'default',
      full: show(sync),
    }
    if (!partial.ok) {
      const limit =
        isBonsaiError(partial.error) && ['STEP_LIMIT', 'TIMEOUT'].includes(partial.error.code)
      if (!limit) return fail('partial throws', { ...at, error: codeOf(partial.error) })
      continue
    }
    const result = partial.value as ReturnType<Program['partial']>
    if (result.status === 'value') {
      if (!sync.ok || !deepEqual(result.value, sync.value))
        return fail('partial decides another value', { ...at, value: serialize(result.value) })
      continue
    }
    if (result.status === 'error') {
      // A known object given in part, with no unknown list, fails validation (documented).
      if (result.error.code === 'INVALID_CONTEXT' && c.validateContext && !withList) continue
      if (sync.ok || codeOf(sync.error) !== result.error.code)
        return fail('partial decides another error', { ...at, error: result.error.code })
      continue
    }
    const onFull = attempt(() => result.evaluateSync(data))
    if (!same(sync, onFull))
      return fail('residual differs on the full data', {
        ...at,
        residual: result.source,
        got: show(onFull),
      })
    const onFullAsync = await attemptAsync(() => result.evaluate(data))
    if (!same(onFull, onFullAsync))
      return fail('residual evaluate differs from evaluateSync', { ...at, residual: result.source })
    if (!result.readsContext) {
      const pruned = pruneTo(result.dependsOn, data)
      const onDependsOn = attempt(() => result.evaluateSync(pruned))
      if (!same(sync, onDependsOn)) {
        return fail('residual differs on its dependsOn data', {
          ...at,
          residual: result.source,
          dependsOn: result.dependsOn,
          got: show(onDependsOn),
        })
      }
    }
    const explained = attempt(() => result.explainSync(data))
    if (explained.ok && (explained.value as { ok: boolean }).ok !== onFull.ok) {
      return fail('residual explain differs from evaluate', { ...at, residual: result.source })
    }
  }

  // 5. Query translation.
  const isFilter =
    c.filter &&
    strip(program.type).kind === 'boolean' &&
    program.references.variables.includes('row')
  if (!isFilter) return undefined
  const known: Record<string, unknown> = { ...data }
  delete known.row
  for (const name of Object.keys(c.variables))
    if (name !== 'row' && !(name in known)) known[name] = null
  const rows = Array.from({ length: R.int(3, 8) }, (_, i) => genRow(R, i + 1))
  const want: number[] = []
  for (const row of rows) {
    const accepted = attempt(() => program.evaluateSync({ ...known, row }))
    if (accepted.ok && accepted.value === true) want.push(row.id)
  }
  const at = { known: serialize(known), rows: serialize(rows), want }
  tally('5 queries select the evaluated rows')
  await loadRows(rows)
  for (const dialect of ['sqlite', 'postgres'] as const) {
    const query = attempt(() =>
      toSQL(program, { row: 'row', known, now: NOW, columns: COLUMNS, dialect }),
    )
    if (!query.ok) {
      if (codeOf(query.error) === 'UNTRANSLATABLE') continue
      // A translation that fails as every row's evaluation does.
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
  const mongo = attempt(() => toMongo(program, { row: 'row', known, now: NOW, fields: COLUMNS }))
  if (!mongo.ok) {
    if (codeOf(mongo.error) === 'UNTRANSLATABLE') return undefined
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
        // Odd rows leave out their null fields, as documents often do.
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

async function main(): Promise<void> {
  const R = random(SEED)
  const counts = new Map<string, number>()
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
    const validateContext = R.chance(0.3)
    const env = bonsai({ variables, clock: () => NOW, validateContext })
    const service = createLanguageService(env)
    const generator = new Generator(R, variables, filter)
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
      const c: Case = {
        env,
        service,
        variables,
        filter,
        validateContext,
        source,
        data,
        seed: R.int(0, 0x7fff_ffff),
      }
      cases += 1
      const failure = await checkCase(c, tally)
      if (failure) {
        const small = await shrink(c, failure)
        report(small.c, small.failure, c.source)
        process.exit(1)
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
  process.stdout.write('✓ every view agreed\n')
}

function report(c: Case, failure: Failure, original: string): void {
  process.stdout.write(`✗ cross-fuzz: ${failure.invariant} (seed ${String(SEED)})\n`)
  process.stdout.write(`  source:    ${c.source}\n`)
  if (original !== c.source) process.stdout.write(`  shrunk from: ${original}\n`)
  const variables = Object.fromEntries(
    Object.entries(c.variables).map(([name, type]) => [name, formatType(type)]),
  )
  process.stdout.write(`  variables: ${JSON.stringify(variables)}\n`)
  process.stdout.write(`  validateContext: ${String(c.validateContext)}\n`)
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
