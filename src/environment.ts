import { analyze, type Analysis, type CheckEnv } from './check/checker.js'
import { compileProgram, type CompiledProgram } from './compile/compiler.js'
import {
  BonsaiCheckError,
  BonsaiError,
  BonsaiLimitError,
  BonsaiRuntimeError,
  type Diagnostic,
} from './errors.js'
import { BUILTINS } from './functions/builtins.js'
import {
  assertHostSpec,
  assertType,
  conforms,
  describeMismatch,
  isRecord,
  overload,
  type FunctionDef,
  type ValidationBudget,
} from './functions/define.js'
import { partiallyEvaluate, type PartialOptions, type PartialResult } from './partial.js'
import { DEFAULT_RUNTIME_LIMITS, State, type RuntimeLimits } from './runtime/state.js'
import { errorText, isMap } from './runtime/values.js'
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TRACE_NODES,
  SNAPSHOT_ENTRIES,
  Tracer,
  reasonsOf,
  renderTrace,
  snapshot,
  snapshotTrace,
  type Trace,
} from './runtime/trace.js'
import type { Node } from './syntax/ast.js'
import { isName } from './syntax/lexer.js'
import { DEFAULT_PARSE_LIMITS, parse, type ParseLimits } from './syntax/parser.js'
import {
  formatType,
  isNullable,
  type AnyType,
  type Infer,
  type InferVariables,
  type Type,
} from './types.js'

// === public option types ===

/** Every field optional, and `undefined` accepted, even under `exactOptionalPropertyTypes`. */
type Optional<T> = { readonly [K in keyof T]?: T[K] | undefined }

export interface Limits extends Optional<ParseLimits>, Optional<RuntimeLimits> {
  /** Wall-clock budget per evaluation in milliseconds (0 = none). Default 0. */
  readonly timeout?: number | undefined
}

/**
 * The part of an `AbortSignal` evaluation reads. A standard `AbortSignal`
 * satisfies it; declaring it structurally keeps the types free of DOM or Node
 * library requirements.
 */
export interface AbortSignalLike {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener: (type: 'abort', listener: () => void, options?: { once?: boolean }) => void
  removeEventListener: (type: 'abort', listener: () => void) => void
}

export interface EvaluateOptions {
  /** Wall-clock budget for this evaluation in milliseconds (0 = none). */
  readonly timeout?: number | undefined
  /** Step budget for this evaluation (0 = none; overrides the environment limit). */
  readonly maxSteps?: number | undefined
  /** Cancels the evaluation. */
  readonly signal?: AbortSignalLike | undefined
}

type InferParams<P extends readonly Type[]> = Extract<
  { -readonly [K in keyof P]: Infer<P[K]> },
  unknown[]
>

/** A host function declaration. Create one with {@link fn}. */
export interface HostFunction {
  readonly params: readonly Type[]
  readonly returns: Type
  readonly required?: number | undefined
  readonly rest?: Type | undefined
  readonly async?: boolean | undefined
  readonly context?: boolean | undefined
  readonly description?: string | undefined
  /** Steps charged per call (default 32). */
  readonly cost?: number | undefined
  readonly run: (...args: never[]) => unknown
}

/** The declaration passed to {@link fn}, without `run`, `async`, and `context`. */
export interface FnSpec<P extends readonly Type[] = readonly Type[], R extends Type = Type> {
  /** Parameter types, in order. */
  readonly params: P
  /** Declared result type; results are checked against its kind. */
  readonly returns: R
  /** Number of required leading parameters (default: all). Missing optional arguments arrive as null. */
  readonly required?: number | undefined
  /** Type of further variadic arguments. */
  readonly rest?: Type | undefined
  readonly description?: string | undefined
  /**
   * Steps charged per call (default 32), so one evaluation makes at most
   * maxSteps / cost calls. Lower it for cheap pure functions; raise it for
   * expensive ones.
   */
  readonly cost?: number | undefined
}

/**
 * Declares a host function.
 *
 * ```ts
 * fn({ params: [t.string()], returns: t.boolean(), run: (perm) => user.can(perm) })
 * fn({ params: [t.string()], returns: t.string(), async: true, run: async (id) => lookup(id) })
 * fn({ params: [], returns: t.string(), context: true, run: (ctx) => String(ctx.tenant) })
 * ```
 */
export function fn<const P extends readonly Type[], R extends Type>(
  spec: FnSpec<P, R> &
    (
      | {
          readonly async?: false
          readonly context?: false
          readonly run: (...args: InferParams<P>) => Infer<R>
        }
      | {
          readonly async: true
          readonly context?: false
          readonly run: (...args: InferParams<P>) => Promise<Infer<R>>
        }
      | {
          readonly async?: false
          readonly context: true
          readonly run: (
            context: Readonly<Record<string, unknown>>,
            ...args: InferParams<P>
          ) => Infer<R>
        }
      | {
          readonly async: true
          readonly context: true
          readonly run: (
            context: Readonly<Record<string, unknown>>,
            ...args: InferParams<P>
          ) => Promise<Infer<R>>
        }
    ),
): HostFunction {
  assertHostSpec(spec, 'fn()')
  return Object.freeze({ ...spec })
}

/**
 * Declares host functions that read a typed evaluation context.
 *
 * ```ts
 * const contextFn = withContext<{ user: { id: string } }>()
 * const functions = { userId: contextFn({ params: [], returns: t.string(), run: (ctx) => ctx.user.id }) }
 * ```
 */
export function withContext<Ctx>() {
  return <const P extends readonly Type[], R extends Type>(
    spec: FnSpec<P, R> &
      (
        | {
            readonly async?: false
            readonly run: (context: Readonly<Ctx>, ...args: InferParams<P>) => Infer<R>
          }
        | {
            readonly async: true
            readonly run: (context: Readonly<Ctx>, ...args: InferParams<P>) => Promise<Infer<R>>
          }
      ),
  ): HostFunction => {
    assertHostSpec(spec, 'withContext()')
    return Object.freeze({ ...spec, context: true })
  }
}

/** A reusable bundle of host functions (and optionally variables). */
export interface Library {
  readonly name: string
  readonly functions?: Readonly<Record<string, HostFunction>> | undefined
  readonly variables?: Readonly<Record<string, Type>> | undefined
}

export interface EnvironmentOptions<
  V extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
> {
  /** Declared context variables and their types. */
  readonly variables?: V | undefined
  /**
   * Report unknown variables as errors. Default: true when `variables` is
   * declared (even as `{}`), false for an open environment.
   */
  readonly strict?: boolean | undefined
  /** Host functions by name. A host function replaces a built-in of the same name. */
  readonly functions?: Readonly<Record<string, HostFunction>> | undefined
  /** Libraries of host functions and variables; a name defined twice is an error. */
  readonly libraries?: readonly Library[] | undefined
  readonly limits?: Limits | undefined
  /**
   * Compiled programs kept for `evaluate(source)` and `evaluateSync(source)`. Default 256; 0
   * disables the cache. The cache also holds at most 256K characters of source in total, and
   * never a source longer than 16K characters.
   */
  readonly cacheSize?: number | undefined
  /** Source of now(). Default: the system clock. */
  readonly clock?: (() => Date) | undefined
  /**
   * Check the context against the declared variable types before every
   * evaluation (deep, proportional to the data) and fail with INVALID_CONTEXT
   * naming the first mismatching path. Default: false.
   */
  readonly validateContext?: boolean | undefined
}

export type CheckResult =
  | { readonly ok: true; readonly type: Type; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly ok: false
      readonly type: Type | undefined
      readonly diagnostics: readonly Diagnostic[]
    }

type Args<Ctx> =
  Record<string, never> extends Ctx
    ? [context?: Ctx, options?: EvaluateOptions]
    : [context: Ctx, options?: EvaluateOptions]

/** A checked, compiled expression. Immutable and safe to share. */
export interface Program<Ctx = object, R = unknown> {
  readonly source: string
  /** The syntax tree after implicit lambdas are made explicit. */
  readonly ast: Node
  /** The statically inferred result type. */
  readonly type: Type
  /** Whether the expression calls an async host function (evaluateSync rejects it). */
  readonly async: boolean
  /** Non-fatal findings from the checker. */
  readonly warnings: readonly Diagnostic[]
  readonly references: {
    readonly variables: readonly string[]
    readonly functions: readonly string[]
  }
  evaluate: (...args: Args<Ctx>) => Promise<R>
  evaluateSync: (...args: Args<Ctx>) => R
  /**
   * Evaluates and records the value of every sub-expression, so you can show
   * why the result came out as it did. Never rejects for evaluation errors:
   * they are returned in the explanation. Slower than evaluate.
   */
  explain: (...args: ExplainArgs<Ctx>) => Promise<Explanation<R>>
  /** Like explain, synchronously; an expression that calls an async host function is an ASYNC_IN_SYNC error. */
  explainSync: (...args: ExplainArgs<Ctx>) => Explanation<R>
  /**
   * Evaluates what can be evaluated from partial data. Returns the value when
   * the known data decides it, or a simplified residual expression (source and
   * syntax tree) that needs only the unknown data. Evaluating the residual with
   * the full data gives the same result as evaluating this program.
   */
  partial: (
    known: Partial<Ctx> & Record<string, unknown>,
    options?: PartialOptions,
  ) => PartialResult<R>
}

export interface ExplainOptions extends EvaluateOptions {
  /** How many lambda runs to record per call (the rest are counted). Default 20. */
  readonly maxIterations?: number
  /** Sub-expressions to record in total before stopping (the result stays exact). Default 10,000. */
  readonly maxTraceNodes?: number
  /**
   * Also evaluate the side of && and || that short-circuiting would skip, so
   * reasons() lists every failing condition rather than the first. Those
   * parts are marked `extra`; their errors are ignored and the result is
   * unchanged. Host functions on those parts do run. Default false.
   */
  readonly exhaustive?: boolean
}

type ExplainArgs<Ctx> =
  Record<string, never> extends Ctx
    ? [context?: Ctx, options?: ExplainOptions]
    : [context: Ctx, options?: ExplainOptions]

/** The result of explain(): the outcome plus a trace of every sub-expression. */
export type Explanation<R> = (
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: BonsaiError }
) & {
  /** The root of the trace; its `value` is the result. Values are live references. */
  readonly trace: Trace
  /** True when maxTraceNodes stopped recording before evaluation finished. */
  readonly truncated: boolean
  /**
   * The conditions that decided the result, following &&, ||, and ! down to
   * the comparisons and values (or the error) behind it.
   */
  reasons: () => Trace[]
  /** The trace as an indented, human-readable tree. */
  toString: () => string
  /**
   * A JSON-safe snapshot: values are bounded copies (cycles, bigints, dates,
   * and durations handled) and getters are never run. `JSON.stringify` uses it.
   */
  toJSON: () => unknown
}

export interface CompileOptions<E extends Type = Type> {
  /** The type the expression must produce; also types the program's result. */
  readonly expect?: E | undefined
}

export interface FunctionInfo {
  readonly name: string
  readonly description: string
  readonly host: boolean
  readonly async: boolean
  readonly signatures: readonly {
    readonly params: readonly Type[]
    readonly required: number
    readonly rest?: Type
    readonly returns: Type
  }[]
}

export interface Environment<Ctx = object> {
  /** Declared variables, or undefined for an open environment. */
  readonly variables: Readonly<Record<string, Type>> | undefined
  readonly strict: boolean
  /** Parses without checking. */
  parse: (source: string) => Node
  /** Parses and checks, reporting every finding instead of throwing. */
  check: (source: string, options?: CompileOptions) => CheckResult
  /** Parses, checks, and compiles. Throws BonsaiSyntaxError / BonsaiCheckError / BonsaiLimitError. */
  compile: <E extends Type = AnyType>(
    source: string,
    options?: CompileOptions<E>,
  ) => Program<Ctx, Infer<E>>
  /** Compiles (cached) and evaluates asynchronously. */
  evaluate: <R = unknown>(source: string, ...args: Args<Ctx>) => Promise<R>
  /** Compiles (cached) and evaluates synchronously. */
  evaluateSync: <R = unknown>(source: string, ...args: Args<Ctx>) => R
  /** Compiles (cached) and explains; see Program.explain. Rejects only for syntax and check errors. */
  explain: <R = unknown>(source: string, ...args: ExplainArgs<Ctx>) => Promise<Explanation<R>>
  /** Compiles (cached) and explains synchronously. Throws only for syntax and check errors. */
  explainSync: <R = unknown>(source: string, ...args: ExplainArgs<Ctx>) => Explanation<R>
  /** Looks up a function (host or built-in). */
  describeFunction: (name: string) => FunctionInfo | undefined
  /** Every callable function, host functions first. */
  listFunctions: () => FunctionInfo[]
  /** A new environment with more variables, functions, or libraries. */
  extend: <V2 extends Readonly<Record<string, Type>> = Record<never, never>>(
    options: EnvironmentOptions<V2>,
  ) => Environment<Ctx & ContextOf<V2>>
}

/**
 * The context type of an environment with declared variables `V`. An open
 * environment (no variables) accepts any object, including values typed by an
 * interface.
 */
export type ContextOf<V> = [keyof V] extends [never] ? object : InferVariables<V>

// === implementation ===

/** Internals shared with the language service (not public API). */
export interface EnvironmentInternals {
  readonly checkEnv: CheckEnv
  readonly parseLimits: ParseLimits
}

const internals = new WeakMap<object, EnvironmentInternals>()

export function internalsOf(env: Environment<never>): EnvironmentInternals {
  const found = internals.get(env)
  if (found === undefined) throw new TypeError('Not a Bonsai environment')
  return found
}

/** Compiled programs kept per environment unless `cacheSize` says otherwise. */
const DEFAULT_CACHE_SIZE = 256

interface Settings {
  readonly variables: Readonly<Record<string, Type>> | undefined
  /** The explicit `strict` option, if one was given (here or in a base environment). */
  readonly strictOption: boolean | undefined
  readonly strict: boolean
  readonly host: ReadonlyMap<string, FunctionDef>
  readonly parseLimits: ParseLimits
  readonly runtimeLimits: RuntimeLimits
  readonly timeout: number
  readonly cacheSize: number
  readonly clock: () => Date
  readonly validateContext: boolean
}

function toDef(name: string, host: HostFunction): FunctionDef {
  // `has` and `try` read as syntax, so a function with either name could never be called.
  if (!isName(name) || name === 'has' || name === 'try') {
    throw new TypeError(`Invalid function name "${name}"`)
  }
  assertHostSpec(host, `Function "${name}"`)
  const run = host.run as (...args: unknown[]) => unknown
  const count = host.params.length
  host.params.forEach((param, index) => {
    if (index >= (host.required ?? count) && !isNullable(param)) {
      throw new TypeError(
        `Optional parameter ${index + 1} of "${name}" receives null when omitted; declare it as t.optional(...)`,
      )
    }
  })
  return Object.freeze({
    name,
    description: host.description ?? '',
    host: true,
    async: host.async === true,
    context: host.context === true,
    ...(host.cost === undefined ? {} : { cost: host.cost }),
    overloads: [
      overload(
        host.params,
        host.returns,
        (args) => {
          // Missing optional arguments arrive as null.
          const offset = host.context === true ? 1 : 0
          while (args.length < count + offset) args.push(null)
          return run(...args)
        },
        {
          required: host.required ?? count,
          ...(host.rest === undefined ? {} : { rest: host.rest }),
        },
      ),
    ],
  })
}

function mergeFunctions(
  base: ReadonlyMap<string, FunctionDef>,
  options: EnvironmentOptions,
): Map<string, FunctionDef> {
  const out = new Map(base)
  const added = new Map<string, string>()
  const add = (name: string, def: HostFunction, origin: string): void => {
    const previous = added.get(name)
    if (previous !== undefined) {
      throw new TypeError(`Function "${name}" is defined by both ${previous} and ${origin}`)
    }
    added.set(name, origin)
    out.set(name, toDef(name, def))
  }
  for (const library of options.libraries ?? []) {
    for (const [name, def] of Object.entries(library.functions ?? {}))
      add(name, def, `library "${library.name}"`)
  }
  for (const [name, def] of Object.entries(options.functions ?? {}))
    add(name, def, 'the functions option')
  return out
}

function mergeVariables(
  base: Readonly<Record<string, Type>> | undefined,
  options: EnvironmentOptions,
): Readonly<Record<string, Type>> | undefined {
  // Declaring `variables` (even as {}) makes the environment declared, and so strict by default.
  let out: Record<string, Type> | undefined =
    base === undefined && options.variables === undefined ? undefined : { ...base }
  const added = new Map<string, string>()
  const add = (name: string, type: Type, origin: string): void => {
    if (!isName(name)) {
      throw new TypeError(`Invalid variable name "${name}" (in ${origin})`)
    }
    const previous = added.get(name)
    if (previous !== undefined) {
      throw new TypeError(`Variable "${name}" is declared by both ${previous} and ${origin}`)
    }
    added.set(name, origin)
    assertType(type, `Variable "${name}"`)
    out ??= {}
    out[name] = type
  }
  for (const library of options.libraries ?? []) {
    for (const [k, v] of Object.entries(library.variables ?? {}))
      add(k, v, `library "${library.name}"`)
  }
  for (const [k, v] of Object.entries(options.variables ?? {})) add(k, v, 'the variables option')
  return out === undefined ? undefined : Object.freeze(out)
}

/** A number option: TypeError when it is not a number, RangeError when out of range. */
function numberOption(name: string, value: unknown, fallback: number, minimum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`)
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      minimum === 0
        ? `${name} must be a non-negative integer (0 disables it)`
        : `${name} must be a positive integer`,
    )
  }
  return value
}

const OPTION_KEYS = new Set([
  'variables',
  'strict',
  'functions',
  'libraries',
  'limits',
  'cacheSize',
  'clock',
  'validateContext',
])
const LIMIT_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_PARSE_LIMITS),
  ...Object.keys(DEFAULT_RUNTIME_LIMITS),
  'timeout',
])
const LIBRARY_KEYS = new Set(['name', 'functions', 'variables'])

function assertKeys(value: unknown, allowed: ReadonlySet<string>, what: string): void {
  if (!isRecord(value)) throw new TypeError(`${what} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(
        `Unknown ${what.toLowerCase()} key "${key}" (expected one of: ${[...allowed].join(', ')})`,
      )
    }
  }
}

/** Environment options come from configuration: mistakes there are programming errors. */
function assertOptions(options: unknown): asserts options is EnvironmentOptions {
  assertKeys(options, OPTION_KEYS, 'Options')
  const o = options as Record<string, unknown>
  if (o.limits !== undefined) assertKeys(o.limits, LIMIT_KEYS, 'Limits')
  if (o.variables !== undefined && !isRecord(o.variables))
    throw new TypeError('variables must be an object of types')
  if (o.functions !== undefined && !isRecord(o.functions))
    throw new TypeError('functions must be an object of fn() declarations')
  if (o.libraries !== undefined) {
    if (!Array.isArray(o.libraries)) throw new TypeError('libraries must be an array')
    const names = new Set<string>()
    for (const library of o.libraries) {
      assertKeys(library, LIBRARY_KEYS, 'Library')
      const l = library as Record<string, unknown>
      if (typeof l.name !== 'string' || l.name === '') throw new TypeError('A library needs a name')
      if (names.has(l.name)) throw new TypeError(`Library "${l.name}" is listed twice`)
      names.add(l.name)
      if (l.functions !== undefined && !isRecord(l.functions))
        throw new TypeError(`functions of library "${l.name}" must be an object`)
      if (l.variables !== undefined && !isRecord(l.variables))
        throw new TypeError(`variables of library "${l.name}" must be an object`)
    }
  }
  for (const flag of ['strict', 'validateContext'] as const) {
    if (o[flag] !== undefined && typeof o[flag] !== 'boolean')
      throw new TypeError(`${flag} must be a boolean`)
  }
  if (o.clock !== undefined && typeof o.clock !== 'function')
    throw new TypeError('clock must be a function returning a Date')
}

type Numbers = Readonly<Record<string, number>>

/**
 * The limits in `defaults` (parse or runtime), overridden by `limits` over
 * `current`. 0 turns `maxSteps` off; every other limit must be at least 1.
 */
function pickLimits(
  defaults: object,
  current: object,
  limits: Readonly<Record<string, unknown>>,
): Numbers {
  const base = current as Numbers
  return Object.freeze(
    Object.fromEntries(
      Object.keys(defaults).map((name) => [
        name,
        numberOption(`Limit "${name}"`, limits[name], base[name], name === 'maxSteps' ? 0 : 1),
      ]),
    ),
  )
}

function settingsFrom(base: Settings | undefined, options: unknown): Settings {
  assertOptions(options)
  const limits = (options.limits ?? {}) as Readonly<Record<string, unknown>>
  const variables = mergeVariables(base?.variables, options)
  const strictOption = options.strict ?? base?.strictOption
  return {
    variables,
    strictOption,
    strict: strictOption ?? variables !== undefined,
    host: mergeFunctions(base?.host ?? new Map(), options),
    parseLimits: pickLimits(
      DEFAULT_PARSE_LIMITS,
      base?.parseLimits ?? DEFAULT_PARSE_LIMITS,
      limits,
    ) as unknown as ParseLimits,
    runtimeLimits: pickLimits(
      DEFAULT_RUNTIME_LIMITS,
      base?.runtimeLimits ?? DEFAULT_RUNTIME_LIMITS,
      limits,
    ) as unknown as RuntimeLimits,
    timeout: numberOption('Limit "timeout"', limits.timeout, base?.timeout ?? 0, 0),
    cacheSize: numberOption(
      'cacheSize',
      options.cacheSize,
      base?.cacheSize ?? DEFAULT_CACHE_SIZE,
      0,
    ),
    clock: options.clock === undefined ? (base?.clock ?? systemClock) : checkedClock(options.clock),
    validateContext: options.validateContext ?? base?.validateContext ?? false,
  }
}

/**
 * Source characters the program cache holds in total, and the longest source it
 * keeps. A compiled program can retain a hundred times its source in memory, so
 * the cache is bounded by size as well as by count.
 */
const CACHE_CHARS = 262_144
const CACHE_MAX_SOURCE = 16_384

class ProgramCache<V> {
  private readonly map = new Map<string, V>()
  private readonly size: number
  private chars = 0

  constructor(size: number) {
    this.size = size
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: string, value: V): void {
    if (this.size === 0 || key.length > CACHE_MAX_SOURCE) return
    if (this.map.delete(key)) this.chars -= key.length
    this.map.set(key, value)
    this.chars += key.length
    while (this.map.size > this.size || this.chars > CACHE_CHARS) {
      const oldest = this.map.keys().next().value as string
      this.map.delete(oldest)
      this.chars -= oldest.length
    }
  }
}

const EMPTY_CONTEXT: Record<string, unknown> = Object.freeze({})

const EVALUATE_OPTION_KEYS = new Set(['timeout', 'maxSteps', 'signal'])

interface EvaluationLimits {
  readonly maxSteps: number
  readonly timeout: number
  readonly signal: AbortSignal | undefined
}

/** Whether a value has an AbortSignal's members; a signal whose getters throw does not. */
function looksLikeSignal(signal: object): boolean {
  try {
    const s = signal as Record<string, unknown>
    return (
      typeof s.aborted === 'boolean' &&
      typeof s.addEventListener === 'function' &&
      typeof s.removeEventListener === 'function'
    )
  } catch {
    return false
  }
}

/** Validates per-evaluation options the way `limits` are validated; nothing fails open. */
function evaluationLimits(options: unknown, settings: Settings): EvaluationLimits {
  if (options === undefined) {
    return {
      maxSteps: settings.runtimeLimits.maxSteps,
      timeout: settings.timeout,
      signal: undefined,
    }
  }
  // Options are the caller's own object; one whose getters or Proxy traps throw
  // is invalid options (a TypeError), never an error from inside evaluation.
  let o: Record<string, unknown>
  try {
    assertKeys(options, EVALUATE_OPTION_KEYS, 'Evaluate option')
    const read = options as Record<string, unknown>
    o = { maxSteps: read.maxSteps, timeout: read.timeout, signal: read.signal }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error
    throw new TypeError(`Evaluate options could not be read: ${errorText(error)}`, { cause: error })
  }
  const signal = o.signal
  if (
    signal !== undefined &&
    (typeof signal !== 'object' || signal === null || !looksLikeSignal(signal))
  ) {
    throw new TypeError('signal must be an AbortSignal')
  }
  return {
    maxSteps: numberOption('maxSteps', o.maxSteps, settings.runtimeLimits.maxSteps, 0),
    timeout: numberOption('timeout', o.timeout, settings.timeout, 0),
    // A structurally checked AbortSignalLike; evaluation only reads the members checked above.
    signal: signal as AbortSignal | undefined,
  }
}

/** Freezes a syntax tree (or any tree of plain objects and arrays) in place, without recursion. */
function deepFreeze<T>(root: T): T {
  // Visits frozen objects too: a frozen type can hold a type the checker built
  // unfrozen (and shares between analyses).
  const seen = new Set<object>()
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || seen.has(value)) continue
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value)) pending.push(child)
  }
  return root
}

function validateContext(
  ctx: Record<string, unknown>,
  variables: Readonly<Record<string, Type>>,
  source: string,
  limits: { maxDepth: number; maxSteps: number; timeout: number },
): void {
  const budget: ValidationBudget = {
    maxDepth: limits.maxDepth,
    remaining: limits.maxSteps > 0 ? limits.maxSteps : Number.POSITIVE_INFINITY,
    deadline: limits.timeout > 0 ? performance.now() + limits.timeout : 0,
    onExhausted: (reason) => {
      if (reason === 'depth') {
        throw new BonsaiLimitError('TOO_DEEP', `Context nests deeper than ${limits.maxDepth}`, {
          source,
        })
      }
      if (reason === 'time')
        throw new BonsaiLimitError('TIMEOUT', 'Context validation timed out', { source })
      throw new BonsaiLimitError('STEP_LIMIT', 'Context validation exceeded the step limit', {
        source,
      })
    },
  }
  for (const [name, type] of Object.entries(variables)) {
    const value = Object.hasOwn(ctx, name) ? ctx[name] : undefined
    const problem = describeMismatch(value, type, name, budget)
    if (problem !== undefined) {
      throw new BonsaiRuntimeError('INVALID_CONTEXT', `Invalid context: ${problem}`, { source })
    }
  }
}

/**
 * Reading host data (a getter, a Proxy trap, a `then` hook) can throw. Such a
 * failure is a HOST_ERROR, never a raw JavaScript error.
 */
function hostDataFailure(error: unknown, source: string): BonsaiError {
  if (error instanceof BonsaiError) return error
  return new BonsaiRuntimeError('HOST_ERROR', `Reading host data failed: ${errorText(error)}`, {
    source,
    cause: error,
  })
}

const systemClock = (): Date => new Date()

/** A host clock whose results are checked: now() must be a valid timestamp. */
function checkedClock(clock: () => Date): () => Date {
  return () => {
    let value: unknown
    try {
      value = clock()
    } catch (error) {
      throw new BonsaiRuntimeError('HOST_ERROR', 'The clock failed', { cause: error })
    }
    if (!(value instanceof Date) || Number.isNaN(Date.prototype.getTime.call(value))) {
      throw new BonsaiRuntimeError(
        'HOST_CONTRACT',
        'The clock must return a valid Date (for example () => new Date())',
      )
    }
    return value
  }
}

const EXPLAIN_OPTION_KEYS: ReadonlySet<string> = new Set([
  ...EVALUATE_OPTION_KEYS,
  'maxIterations',
  'maxTraceNodes',
  'exhaustive',
])

interface ExplainSettings {
  readonly maxIterations: number
  readonly maxNodes: number
  readonly exhaustive: boolean
  /** The evaluation options among them, validated by evaluationLimits. */
  readonly evaluate: EvaluateOptions | undefined
}

/** Reads explain options once, with the same TypeError/RangeError rules as evaluate's. */
function explainSettings(options: unknown): ExplainSettings {
  if (options === undefined) {
    return {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxNodes: DEFAULT_MAX_TRACE_NODES,
      exhaustive: false,
      evaluate: undefined,
    }
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Explain options must be an object')
  let copy: Record<string, unknown>
  try {
    copy = { ...(options as Record<string, unknown>) }
  } catch {
    throw new TypeError('Explain options could not be read')
  }
  for (const key of Object.keys(copy)) {
    if (!EXPLAIN_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `Unknown explain option key "${key}" (expected one of: ${[...EXPLAIN_OPTION_KEYS].join(', ')})`,
      )
    }
  }
  const count = (name: string, fallback: number): number => {
    const value = copy[name]
    if (value === undefined) return fallback
    if (typeof value !== 'number') throw new TypeError(`Explain option "${name}" must be a number`)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`Explain option "${name}" must be a non-negative integer`)
    return value
  }
  if (copy.exhaustive !== undefined && typeof copy.exhaustive !== 'boolean')
    throw new TypeError('Explain option "exhaustive" must be a boolean')
  const {
    maxIterations: _iterations,
    maxTraceNodes: _nodes,
    exhaustive: _exhaustive,
    ...evaluate
  } = copy
  return {
    maxIterations: count('maxIterations', DEFAULT_MAX_ITERATIONS),
    maxNodes: count('maxTraceNodes', DEFAULT_MAX_TRACE_NODES),
    exhaustive: copy.exhaustive === true,
    evaluate,
  }
}

const PARTIAL_OPTION_KEYS: ReadonlySet<string> = new Set(['unknown', 'callHostFunctions', 'now'])
const PATH = /^[^.]+(?:\.[^.]+)*$/u

/** Reads partial() options once, with the same TypeError rules as the other options. */
function partialOptions(options: unknown): PartialOptions {
  if (options === undefined) return {}
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Partial options must be an object')
  let copy: Record<string, unknown>
  try {
    copy = { ...(options as Record<string, unknown>) }
    if (Array.isArray(copy.unknown)) copy.unknown = [...(copy.unknown as unknown[])]
  } catch {
    throw new TypeError('Partial options could not be read')
  }
  for (const key of Object.keys(copy)) {
    if (!PARTIAL_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `Unknown partial option key "${key}" (expected one of: ${[...PARTIAL_OPTION_KEYS].join(', ')})`,
      )
    }
  }
  const unknown = copy.unknown
  if (
    unknown !== undefined &&
    (!Array.isArray(unknown) || !unknown.every((p) => typeof p === 'string' && PATH.test(p)))
  )
    throw new TypeError('Partial option "unknown" must be a list of variable names or dotted paths')
  if (copy.callHostFunctions !== undefined && typeof copy.callHostFunctions !== 'boolean')
    throw new TypeError('Partial option "callHostFunctions" must be a boolean')
  const now = copy.now
  let validNow = now === undefined
  try {
    validNow ||= now instanceof Date && !Number.isNaN(Date.prototype.getTime.call(now))
  } catch {
    // An object that only inherits from Date.prototype is not a Date.
  }
  if (!validNow) throw new TypeError('Partial option "now" must be a valid Date')
  return copy
}

function contextOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return EMPTY_CONTEXT
  let map: boolean
  try {
    // A Proxy (even a revoked one) answers these through its traps.
    map = typeof value === 'object' && isMap(value)
  } catch (error) {
    throw new BonsaiRuntimeError('HOST_ERROR', 'Reading the evaluation context failed', {
      cause: error,
    })
  }
  if (!map) {
    throw new BonsaiRuntimeError(
      'INVALID_ARGUMENT',
      'The evaluation context must be a plain object or class instance',
    )
  }
  return value as Record<string, unknown>
}

function createEnvironment<Ctx>(settings: Settings): Environment<Ctx> {
  const checkEnv: CheckEnv = {
    variables: settings.variables,
    strict: settings.strict,
    lookup: (name) => settings.host.get(name) ?? BUILTINS.get(name),
    *functionNames() {
      yield* settings.host.keys()
      for (const name of BUILTINS.keys()) if (!settings.host.has(name)) yield name
    },
  }
  const cache = new ProgramCache<Program<Ctx>>(settings.cacheSize)

  function parseSource(source: string): Node {
    if (typeof source !== 'string') throw new TypeError('An expression must be a string')
    return parse(source, settings.parseLimits)
  }

  function analyzeSource(source: string, expect: Type | undefined): Analysis {
    const root = parseSource(source)
    try {
      return analyze(root, checkEnv, { expected: expect })
    } catch (error) {
      // The checker has no source text; attach it so the error can show where.
      if (error instanceof BonsaiLimitError && error.source === undefined) {
        throw new BonsaiLimitError(error.code, error.message, {
          source,
          ...(error.span === undefined ? {} : { span: error.span }),
        })
      }
      throw error
    }
  }

  /** How a partial-evaluation residual runs: its context plus the caller's own one. */
  interface ResidualRunner {
    runSync: (ctx: object, hostContext: object, options: unknown) => unknown
    runAsync: (ctx: object, hostContext: object, options: unknown) => Promise<unknown>
  }

  function makeProgram<R>(
    source: string,
    analysis: Analysis,
    expect?: Type,
    asResidual?: (runner: ResidualRunner) => void,
  ): Program<Ctx, R> {
    // When the checker cannot prove the result matches `expect` (part of it is
    // `any`, or an open object may hold an unlisted key), it is checked at run
    // time, so the declared result type holds.
    const guard = expect !== undefined && analysis.checkResult ? expect : undefined
    const checked = (result: unknown, state: State): void => {
      if (guard !== undefined && !conforms(result, guard, state)) {
        throw new BonsaiRuntimeError(
          'TYPE_ERROR',
          `The result does not match the expected type ${formatType(guard)}`,
          { source },
        )
      }
    }
    // The limits of an evaluation without options: built once, not per run.
    const defaultLimits = evaluationLimits(undefined, settings)
    const limitsOf = (options: EvaluateOptions | undefined): EvaluationLimits =>
      options === undefined ? defaultLimits : evaluationLimits(options, settings)
    let syncCode: CompiledProgram | undefined
    let asyncCode: CompiledProgram | undefined
    let pooled: State | undefined
    let pooledInUse = false

    const syncProgram = (): CompiledProgram => (syncCode ??= compileProgram(analysis, 'sync'))
    const asyncProgram = (): CompiledProgram =>
      (asyncCode ??= analysis.async ? compileProgram(analysis, 'async') : syncProgram())

    // Options and the context's shape are the caller's own mistakes (TypeError,
    // RangeError, INVALID_ARGUMENT), so they are checked before anything reads
    // host data and are never reported as host failures.
    function prepare(
      state: State,
      ctx: Record<string, unknown>,
      limits: EvaluationLimits,
      locals: number,
      hostContext: Record<string, unknown> | undefined,
    ): void {
      if (settings.validateContext && settings.variables !== undefined) {
        validateContext(ctx, settings.variables, source, {
          maxDepth: settings.runtimeLimits.maxValueDepth,
          maxSteps: limits.maxSteps,
          timeout: limits.timeout,
        })
      }
      state.reset(ctx, source, locals, limits.maxSteps, limits.timeout, limits.signal)
      if (hostContext !== undefined) state.hostCtx = hostContext
    }

    function runSync(
      context: unknown,
      options: EvaluateOptions | undefined,
      hostContext?: Record<string, unknown>,
    ): R {
      if (analysis.async) {
        throw new BonsaiRuntimeError(
          'ASYNC_IN_SYNC',
          'This expression calls an async function; use evaluate() instead of evaluateSync()',
          { source },
        )
      }
      const code = syncProgram()
      const limits = limitsOf(options)
      const ctx = contextOf(context)
      let state: State
      const reuse = !pooledInUse
      if (reuse) {
        pooled ??= new State(settings.runtimeLimits, settings.clock)
        state = pooled
        pooledInUse = true
      } else {
        state = new State(settings.runtimeLimits, settings.clock)
      }
      try {
        prepare(state, ctx, limits, code.localCount, hostContext)
        const result = code.run(state)
        checked(result, state)
        state.checkTime()
        return result as R
      } catch (error) {
        throw hostDataFailure(error, source)
      } finally {
        state.release()
        if (reuse) pooledInUse = false
      }
    }

    async function runAsync(
      context: unknown,
      options: EvaluateOptions | undefined,
      hostContext?: Record<string, unknown>,
    ): Promise<R> {
      if (!analysis.async) {
        const result = runSync(context, options, hostContext)
        try {
          return settle(result)
        } catch (error) {
          throw hostDataFailure(error, source)
        }
      }
      const code = asyncProgram()
      const limits = limitsOf(options)
      const ctx = contextOf(context)
      const state = new State(settings.runtimeLimits, settings.clock)
      try {
        prepare(state, ctx, limits, code.localCount, hostContext)
        const result = await code.run(state)
        checked(result, state)
        state.checkTime()
        return settle(result as R)
      } catch (error) {
        throw hostDataFailure(error, source)
      } finally {
        state.release()
      }
    }

    // Returning a thenable from an async function would call its `then`
    // (an ORM query object would execute), so it is an error instead.
    function settle(result: R): R {
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new BonsaiRuntimeError(
          'TYPE_ERROR',
          'evaluate() cannot return a promise-like value; use evaluateSync()',
          { source },
        )
      }
      return result
    }

    let traceSync: CompiledProgram | undefined
    let traceAsync: CompiledProgram | undefined

    function explanation(
      tracer: Tracer,
      outcome: { ok: true; value: R } | { ok: false; error: BonsaiError },
    ): Explanation<R> {
      const trace = tracer.finish()
      const truncated = tracer.truncated
      return Object.freeze({
        ...outcome,
        trace,
        truncated,
        reasons: () => reasonsOf(trace),
        toString: () => renderTrace(trace, truncated),
        toJSON: () => {
          // One budget for the whole snapshot, however often a value recurs in the trace.
          const budget = { left: SNAPSHOT_ENTRIES }
          return {
            ok: outcome.ok,
            ...(outcome.ok
              ? { value: snapshot(outcome.value, budget) }
              : { error: { code: outcome.error.code, message: outcome.error.message } }),
            truncated,
            trace: snapshotTrace(trace, budget),
          }
        },
      })
    }

    function failure(error: unknown): { ok: false; error: BonsaiError } {
      return { ok: false, error: hostDataFailure(error, source) }
    }

    function tracerFor(explain: ExplainSettings): Tracer {
      return new Tracer(
        source,
        analysis.root,
        explain.maxIterations,
        explain.maxNodes,
        explain.exhaustive,
      )
    }

    function explainSync(context: unknown, options: ExplainOptions | undefined): Explanation<R> {
      const explain = explainSettings(options)
      const tracer = tracerFor(explain)
      if (analysis.async) {
        return explanation(
          tracer,
          failure(
            new BonsaiRuntimeError(
              'ASYNC_IN_SYNC',
              'This expression calls an async function; use explain() instead of explainSync()',
              { source },
            ),
          ),
        )
      }
      const code = (traceSync ??= compileProgram(analysis, 'sync', { trace: true }))
      const limits = evaluationLimits(explain.evaluate, settings)
      const ctx = contextOf(context)
      const state = new State(settings.runtimeLimits, settings.clock)
      try {
        prepare(state, ctx, limits, code.localCount, undefined)
        state.tracer = tracer
        const value = code.run(state) as R
        checked(value, state)
        state.checkTime()
        return explanation(tracer, { ok: true, value })
      } catch (error) {
        return explanation(tracer, failure(error))
      } finally {
        state.release()
      }
    }

    async function explainAsync(
      context: unknown,
      options: ExplainOptions | undefined,
    ): Promise<Explanation<R>> {
      if (!analysis.async) return explainSync(context, options)
      const explain = explainSettings(options)
      const tracer = tracerFor(explain)
      const code = (traceAsync ??= compileProgram(analysis, 'async', { trace: true }))
      const limits = evaluationLimits(explain.evaluate, settings)
      const ctx = contextOf(context)
      const state = new State(settings.runtimeLimits, settings.clock)
      try {
        prepare(state, ctx, limits, code.localCount, undefined)
        state.tracer = tracer
        const value = settle((await code.run(state)) as R)
        checked(value, state)
        state.checkTime()
        return explanation(tracer, { ok: true, value })
      } catch (error) {
        return explanation(tracer, failure(error))
      } finally {
        state.release()
      }
    }

    // Sub-trees compiled on their own for partial evaluation, by free locals.
    const subtrees = new WeakMap<Node, Map<string, CompiledProgram>>()

    function partial(known: Record<string, unknown>, rawOptions: unknown): PartialResult<R> {
      const options = partialOptions(rawOptions)
      const context = contextOf(known)
      const now = options.now
      const state = new State(
        settings.runtimeLimits,
        now === undefined ? settings.clock : () => now,
      )
      state.reset(context, source, 0, settings.runtimeLimits.maxSteps, settings.timeout, undefined)
      try {
        // Known variables are validated as evaluation validates them; a variable
        // with an unknown path inside it is incomplete by design, so it is not.
        if (settings.validateContext && settings.variables !== undefined) {
          const unknownPaths = options.unknown ?? []
          const knownVariables = Object.fromEntries(
            Object.entries(settings.variables).filter(
              ([name]) =>
                Object.hasOwn(context, name) &&
                !unknownPaths.some((path) => path === name || path.startsWith(`${name}.`)),
            ),
          )
          try {
            validateContext(context, knownVariables, source, {
              maxDepth: settings.runtimeLimits.maxValueDepth,
              maxSteps: settings.runtimeLimits.maxSteps,
              timeout: settings.timeout,
            })
          } catch (error) {
            if (error instanceof BonsaiRuntimeError) return { status: 'error', error }
            throw error
          }
        }
        const result = partiallyEvaluate<R>(
          {
            analysis,
            contextOf,
            hostKind: (name) => {
              const def = settings.host.get(name)
              return def === undefined
                ? undefined
                : { async: def.async === true, context: def.context === true }
            },
            charge: () => {
              state.charge(1)
            },
            evaluate: (node, locals) => {
              const key = locals.map(([name]) => name).join('\u0000')
              let byLocals = subtrees.get(node)
              if (byLocals === undefined) subtrees.set(node, (byLocals = new Map()))
              let code = byLocals.get(key)
              if (code === undefined) {
                code = compileProgram({ ...analysis, root: node }, 'sync', {
                  locals: locals.map(([name]) => name),
                })
                byLocals.set(key, code)
              }
              state.ensureLocals(code.localCount)
              locals.forEach(([, value], slot) => {
                state.locals[slot] = value
              })
              try {
                return code.run(state)
              } catch (error) {
                throw hostDataFailure(error, source)
              }
            },
            compileResidual: (residual, bindingTypes) => {
              // Checked with the declared types (and each known value's type
              // from the original analysis), so calls resolve to the overloads
              // the original program chose. The original expression passed
              // the checker; inlining known values can make a failing branch
              // statically visible, and that failure must happen at run time,
              // as it would have, so findings here do not stop compilation.
              // Analyzed as a tree (not re-parsed), so the printer's parentheses
              // cannot push it past the parse depth limit.
              const variables =
                settings.variables === undefined
                  ? undefined
                  : { ...settings.variables, ...bindingTypes }
              let runner: ResidualRunner | undefined
              makeProgram<unknown>(
                source,
                analyze(residual, { ...checkEnv, variables, strict: false }, { expected: expect }),
                expect,
                (made) => {
                  runner = made
                },
              )
              return runner as ResidualRunner
            },
          },
          context,
          options,
        )
        // A decided result still has to match `expect`, as evaluation would check it.
        if (result.status === 'value') {
          try {
            checked(result.value, state)
          } catch (error) {
            if (error instanceof BonsaiRuntimeError) return { status: 'error', error }
            throw error
          }
        }
        return result
      } catch (error) {
        // Reading `known` is reading host data: a throwing Proxy or getter is a HOST_ERROR.
        throw hostDataFailure(error, source)
      } finally {
        state.release()
      }
    }

    asResidual?.({
      runSync: (ctx, hostContext, options) =>
        runSync(
          ctx,
          options as EvaluateOptions | undefined,
          hostContext as Record<string, unknown>,
        ),
      runAsync: (ctx, hostContext, options) =>
        runAsync(
          ctx,
          options as EvaluateOptions | undefined,
          hostContext as Record<string, unknown>,
        ),
    })
    // Programs are shared: the tree compiles lazily, so it must not change afterwards.
    return Object.freeze({
      explain: (...args: ExplainArgs<Ctx>) => explainAsync(args[0], args[1]),
      explainSync: (...args: ExplainArgs<Ctx>) => explainSync(args[0], args[1]),
      partial: (known: Record<string, unknown>, options?: PartialOptions) =>
        partial(known, options),
      source,
      ast: deepFreeze(analysis.root),
      type: deepFreeze(analysis.type),
      async: analysis.async,
      warnings: deepFreeze(analysis.diagnostics.filter((d) => d.severity === 'warning')),
      references: deepFreeze(analysis.references),
      evaluate: (...args: Args<Ctx>) => runAsync(args[0], args[1]),
      evaluateSync: (...args: Args<Ctx>) => runSync(args[0], args[1]),
    })
  }

  function compile<R>(source: string, expect: Type | undefined): Program<Ctx, R> {
    const analysis = analyzeSource(source, expect)
    const errors = analysis.diagnostics.filter((d) => d.severity === 'error')
    if (errors.length > 0) throw new BonsaiCheckError(source, errors)
    return makeProgram<R>(source, analysis, expect)
  }

  function cached(source: string): Program<Ctx> {
    let program = cache.get(source)
    if (program === undefined) {
      program = compile(source, undefined)
      cache.set(source, program)
    }
    return program
  }

  function info(def: FunctionDef): FunctionInfo {
    return {
      name: def.name,
      description: def.description,
      host: def.host === true,
      async: def.async === true,
      signatures: def.overloads.map((o) => ({
        params: o.params,
        required: o.required ?? o.params.length,
        returns: o.result,
        ...(o.rest === undefined ? {} : { rest: o.rest }),
      })),
    }
  }

  const env: Environment<Ctx> = Object.freeze({
    variables: settings.variables,
    strict: settings.strict,
    parse: parseSource,
    check(source: string, options?: CompileOptions): CheckResult {
      let analysis: Analysis
      try {
        analysis = analyzeSource(source, options?.expect)
      } catch (error) {
        if (!(error instanceof BonsaiError)) throw error
        return {
          ok: false,
          type: undefined,
          diagnostics: [
            {
              code: error.code === 'SYNTAX' ? 'SYNTAX' : 'LIMIT',
              message: error.message,
              severity: 'error',
              start: error.span?.start ?? 0,
              end: error.span?.end ?? source.length,
            },
          ],
        }
      }
      const ok = !analysis.diagnostics.some((d) => d.severity === 'error')
      return ok
        ? { ok: true, type: deepFreeze(analysis.type), diagnostics: analysis.diagnostics }
        : { ok: false, type: deepFreeze(analysis.type), diagnostics: analysis.diagnostics }
    },
    compile: <E extends Type = AnyType>(source: string, options?: CompileOptions<E>) =>
      compile<Infer<E>>(source, options?.expect),
    evaluate<R>(source: string, ...args: Args<Ctx>): Promise<R> {
      try {
        return cached(source).evaluate(...args) as Promise<R>
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    evaluateSync: <R>(source: string, ...args: Args<Ctx>) =>
      cached(source).evaluateSync(...args) as R,
    explain<R>(source: string, ...args: ExplainArgs<Ctx>): Promise<Explanation<R>> {
      try {
        return cached(source).explain(...args) as Promise<Explanation<R>>
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    explainSync: <R>(source: string, ...args: ExplainArgs<Ctx>) =>
      cached(source).explainSync(...args) as Explanation<R>,
    describeFunction(name: string): FunctionInfo | undefined {
      const def = checkEnv.lookup(name)
      return def === undefined ? undefined : info(def)
    },
    listFunctions(): FunctionInfo[] {
      return [...checkEnv.functionNames()].map((name) => info(checkEnv.lookup(name) as FunctionDef))
    },
    extend<V2 extends Readonly<Record<string, Type>>>(options: EnvironmentOptions<V2>) {
      return createEnvironment<Ctx & ContextOf<V2>>(settingsFrom(settings, options))
    },
  })
  internals.set(env, { checkEnv, parseLimits: settings.parseLimits })
  return env
}

/**
 * Creates an environment: the variables, functions, and limits expressions are
 * checked and evaluated against.
 *
 * ```ts
 * const env = bonsai({ variables: { user: t.object({ age: t.number() }) } })
 * const adult = env.compile('user.age >= 18', { expect: t.boolean() })
 * adult.evaluateSync({ user: { age: 30 } }) // true
 * ```
 */
export function bonsai<const V extends Readonly<Record<string, Type>> = Record<never, never>>(
  options: EnvironmentOptions<V> = {},
): Environment<ContextOf<V>> {
  return createEnvironment<ContextOf<V>>(settingsFrom(undefined, options))
}
