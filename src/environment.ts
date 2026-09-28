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
  describeMismatch,
  overload,
  type FunctionDef,
  type ValidationBudget,
} from './functions/define.js'
import { DEFAULT_RUNTIME_LIMITS, State, type RuntimeLimits } from './runtime/state.js'
import type { Node } from './syntax/ast.js'
import { DEFAULT_PARSE_LIMITS, parse, type ParseLimits } from './syntax/parser.js'
import { isNullable, type AnyType, type Infer, type InferVariables, type Type } from './types.js'

// === public option types ===

export interface Limits extends Partial<ParseLimits>, Partial<RuntimeLimits> {
  /** Wall-clock budget per evaluation in milliseconds (0 = none). Default 0. */
  readonly timeout?: number
  /** Compiled programs kept per environment for evaluate(source). Default 256. */
  readonly cacheSize?: number
}

export interface EvaluateOptions {
  /** Wall-clock budget for this evaluation in milliseconds. */
  readonly timeout?: number
  /** Step budget for this evaluation (overrides the environment limit). */
  readonly maxSteps?: number
  /** Cancels the evaluation. */
  readonly signal?: AbortSignal
}

type InferParams<P extends readonly Type[]> = Extract<
  { -readonly [K in keyof P]: Infer<P[K]> },
  unknown[]
>

/** A host function declaration. Create one with {@link fn}. */
export interface HostFunction {
  readonly params: readonly Type[]
  readonly returns: Type
  readonly required?: number
  readonly rest?: Type
  readonly async?: boolean
  readonly context?: boolean
  readonly description?: string
  readonly run: (...args: never[]) => unknown
}

interface FnSpec<P extends readonly Type[], R extends Type> {
  /** Parameter types, in order. */
  readonly params: P
  /** Declared result type; results are checked against its kind. */
  readonly returns: R
  /** Number of required leading parameters (default: all). Missing optional arguments arrive as null. */
  readonly required?: number
  /** Type of further variadic arguments. */
  readonly rest?: Type
  readonly description?: string
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
  ): HostFunction => Object.freeze({ ...spec, context: true })
}

/** A reusable bundle of host functions (and optionally variables). */
export interface Library {
  readonly name: string
  readonly functions?: Readonly<Record<string, HostFunction>>
  readonly variables?: Readonly<Record<string, Type>>
}

export interface EnvironmentOptions<V extends Readonly<Record<string, Type>>> {
  /** Declared context variables and their types. */
  readonly variables?: V
  /** Report unknown variables as errors. Default: false. */
  readonly strict?: boolean
  /** Host functions by name. A host function replaces a built-in of the same name. */
  readonly functions?: Readonly<Record<string, HostFunction>>
  /** Libraries of host functions; a name defined twice is an error. */
  readonly libraries?: readonly Library[]
  readonly limits?: Limits
  /** Source of now(). Default: the system clock. */
  readonly clock?: () => Date
  /**
   * Check the context against the declared variable types before every
   * evaluation (deep, proportional to the data) and fail with INVALID_CONTEXT
   * naming the first mismatching path. Default: false.
   */
  readonly validateContext?: boolean
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
export interface Program<Ctx, R> {
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
}

export interface CompileOptions<E extends Type> {
  /** The type the expression must produce; also types the program's result. */
  readonly expect?: E
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

export interface Environment<Ctx> {
  /** Declared variables, or undefined for an open environment. */
  readonly variables: Readonly<Record<string, Type>> | undefined
  readonly strict: boolean
  /** Parses without checking. */
  parse: (source: string) => Node
  /** Parses and checks, reporting every finding instead of throwing. */
  check: (source: string, options?: CompileOptions<Type>) => CheckResult
  /** Parses, checks, and compiles. Throws BonsaiSyntaxError / BonsaiCheckError / BonsaiLimitError. */
  compile: <E extends Type = AnyType>(
    source: string,
    options?: CompileOptions<E>,
  ) => Program<Ctx, Infer<E>>
  /** Compiles (cached) and evaluates asynchronously. */
  evaluate: <R = unknown>(source: string, ...args: Args<Ctx>) => Promise<R>
  /** Compiles (cached) and evaluates synchronously. */
  evaluateSync: <R = unknown>(source: string, ...args: Args<Ctx>) => R
  /** Looks up a function (host or built-in). */
  describeFunction: (name: string) => FunctionInfo | undefined
  /** Every callable function, host functions first. */
  listFunctions: () => FunctionInfo[]
  /** A new environment with more variables, functions, or libraries. */
  extend: <V2 extends Readonly<Record<string, Type>> = Record<never, never>>(
    options: EnvironmentOptions<V2>,
  ) => Environment<Ctx & ContextOf<V2>>
}

type ContextOf<V> = [keyof V] extends [never] ? Record<string, unknown> : InferVariables<V>

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

/** Compiled programs kept per environment unless `limits.cacheSize` says otherwise. */
const DEFAULT_CACHE_SIZE = 256
const RESERVED_FUNCTION_NAMES = new Set(['has', 'try', 'true', 'false', 'null', 'let', 'in', 'not'])
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

interface Settings {
  readonly variables: Readonly<Record<string, Type>> | undefined
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
  if (!IDENTIFIER.test(name) || RESERVED_FUNCTION_NAMES.has(name)) {
    throw new TypeError(`Invalid function name "${name}"`)
  }
  if (typeof host.run !== 'function') throw new TypeError(`Function "${name}" needs a run function`)
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
  options: EnvironmentOptions<Readonly<Record<string, Type>>>,
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
  options: EnvironmentOptions<Readonly<Record<string, Type>>>,
): Readonly<Record<string, Type>> | undefined {
  let out: Record<string, Type> | undefined = base === undefined ? undefined : { ...base }
  const add = (name: string, type: Type): void => {
    if (!IDENTIFIER.test(name)) throw new TypeError(`Invalid variable name "${name}"`)
    out ??= {}
    out[name] = type
  }
  for (const library of options.libraries ?? [])
    for (const [k, v] of Object.entries(library.variables ?? {})) add(k, v)
  for (const [k, v] of Object.entries(options.variables ?? {})) add(k, v)
  return out === undefined ? undefined : Object.freeze(out)
}

/** Limits where 0 means "none"; every other limit must be at least 1. */
const ZERO_DISABLES = new Set(['maxSteps', 'timeout', 'cacheSize'])

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const minimum = ZERO_DISABLES.has(name) ? 0 : 1
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(
      minimum === 0
        ? `Limit "${name}" must be a non-negative integer (0 disables it)`
        : `Limit "${name}" must be a positive integer`,
    )
  }
  return value
}

function settingsFrom(
  base: Settings | undefined,
  options: EnvironmentOptions<Readonly<Record<string, Type>>>,
): Settings {
  const limits = options.limits ?? {}
  const parseBase = base?.parseLimits ?? DEFAULT_PARSE_LIMITS
  const runtimeBase = base?.runtimeLimits ?? DEFAULT_RUNTIME_LIMITS
  return {
    variables: mergeVariables(base?.variables, options),
    strict: options.strict ?? base?.strict ?? false,
    host: mergeFunctions(base?.host ?? new Map(), options),
    parseLimits: Object.freeze({
      maxSourceLength: positiveInt(
        'maxSourceLength',
        limits.maxSourceLength,
        parseBase.maxSourceLength,
      ),
      maxDepth: positiveInt('maxDepth', limits.maxDepth, parseBase.maxDepth),
      maxNodes: positiveInt('maxNodes', limits.maxNodes, parseBase.maxNodes),
    }),
    runtimeLimits: Object.freeze({
      maxSteps: positiveInt('maxSteps', limits.maxSteps, runtimeBase.maxSteps),
      maxStringLength: positiveInt(
        'maxStringLength',
        limits.maxStringLength,
        runtimeBase.maxStringLength,
      ),
      maxListLength: positiveInt('maxListLength', limits.maxListLength, runtimeBase.maxListLength),
      maxValueDepth: positiveInt('maxValueDepth', limits.maxValueDepth, runtimeBase.maxValueDepth),
      maxPatternLength: positiveInt(
        'maxPatternLength',
        limits.maxPatternLength,
        runtimeBase.maxPatternLength,
      ),
    }),
    timeout: positiveInt('timeout', limits.timeout, base?.timeout ?? 0),
    cacheSize: positiveInt('cacheSize', limits.cacheSize, base?.cacheSize ?? DEFAULT_CACHE_SIZE),
    clock: options.clock ?? base?.clock ?? (() => new Date()),
    validateContext: options.validateContext ?? base?.validateContext ?? false,
  }
}

class ProgramCache<V> {
  private readonly map = new Map<string, V>()
  private readonly size: number

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
    if (this.size === 0) return
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string)
  }
}

const EMPTY_CONTEXT: Record<string, unknown> = Object.freeze({})

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

function contextOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return EMPTY_CONTEXT
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BonsaiRuntimeError('INVALID_ARGUMENT', 'The evaluation context must be an object')
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
  const cache = new ProgramCache<Program<Ctx, unknown>>(settings.cacheSize)

  function parseSource(source: string): Node {
    if (typeof source !== 'string') throw new TypeError('An expression must be a string')
    return parse(source, settings.parseLimits)
  }

  function analyzeSource(source: string, expect: Type | undefined): Analysis {
    return analyze(parseSource(source), checkEnv, { expected: expect })
  }

  function makeProgram<R>(source: string, analysis: Analysis): Program<Ctx, R> {
    let syncCode: CompiledProgram | undefined
    let asyncCode: CompiledProgram | undefined
    let pooled: State | undefined
    let pooledInUse = false

    const syncProgram = (): CompiledProgram => (syncCode ??= compileProgram(analysis, 'sync'))
    const asyncProgram = (): CompiledProgram =>
      (asyncCode ??= analysis.async ? compileProgram(analysis, 'async') : syncProgram())

    function prepare(
      state: State,
      context: unknown,
      options: EvaluateOptions | undefined,
      locals: number,
    ): void {
      const ctx = contextOf(context)
      if (settings.validateContext && settings.variables !== undefined) {
        validateContext(ctx, settings.variables, source, {
          maxDepth: settings.runtimeLimits.maxValueDepth,
          maxSteps: options?.maxSteps ?? settings.runtimeLimits.maxSteps,
          timeout: options?.timeout ?? settings.timeout,
        })
      }
      state.reset(
        ctx,
        source,
        locals,
        options?.maxSteps ?? settings.runtimeLimits.maxSteps,
        options?.timeout ?? settings.timeout,
        options?.signal,
      )
    }

    function runSync(context: unknown, options: EvaluateOptions | undefined): R {
      if (analysis.async) {
        throw new BonsaiRuntimeError(
          'ASYNC_IN_SYNC',
          'This expression calls an async function; use evaluate() instead of evaluateSync()',
          { source },
        )
      }
      const code = syncProgram()
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
        prepare(state, context, options, code.localCount)
        const result = code.run(state)
        state.checkTime()
        return result as R
      } finally {
        state.release()
        if (reuse) pooledInUse = false
      }
    }

    async function runAsync(context: unknown, options: EvaluateOptions | undefined): Promise<R> {
      if (!analysis.async) return settle(runSync(context, options))
      const code = asyncProgram()
      const state = new State(settings.runtimeLimits, settings.clock)
      try {
        prepare(state, context, options, code.localCount)
        const result = await code.run(state)
        state.checkTime()
        return settle(result as R)
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

    return Object.freeze({
      source,
      ast: analysis.root,
      type: analysis.type,
      async: analysis.async,
      warnings: analysis.diagnostics.filter((d) => d.severity === 'warning'),
      references: analysis.references,
      evaluate: (...args: Args<Ctx>) => runAsync(args[0], args[1]),
      evaluateSync: (...args: Args<Ctx>) => runSync(args[0], args[1]),
    })
  }

  function compile<R>(source: string, expect: Type | undefined): Program<Ctx, R> {
    const analysis = analyzeSource(source, expect)
    const errors = analysis.diagnostics.filter((d) => d.severity === 'error')
    if (errors.length > 0) throw new BonsaiCheckError(source, errors)
    return makeProgram<R>(source, analysis)
  }

  function cached(source: string): Program<Ctx, unknown> {
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
    check(source: string, options?: CompileOptions<Type>): CheckResult {
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
        ? { ok: true, type: analysis.type, diagnostics: analysis.diagnostics }
        : { ok: false, type: analysis.type, diagnostics: analysis.diagnostics }
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
