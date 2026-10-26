import { analyze, type Analysis, type CheckEnv } from './check/checker.js'
import type { CompileOptions as CompilerOptions } from './compile/compiler.js'
import { raised } from './runtime/attribution.js'
import {
  BonsaiCheckError,
  BonsaiError,
  BonsaiLimitError,
  BonsaiRuntimeError,
  locate,
  type Diagnostic,
} from './errors.js'
import { BUILTINS } from './functions/builtins.js'
import { descriptionOf } from './functions/descriptions.js'
import {
  assertHostSpec,
  assertType,
  builtinsOption,
  isRecord,
  overload,
  type FunctionDef,
} from './functions/define.js'
import type { PartialData, PartialOptions, PartialResult } from './partial.js'
import {
  DEFAULT_RUNTIME_LIMITS,
  MAX_VALUE_DEPTH_LIMIT,
  type State,
  type RuntimeLimits,
} from './runtime/state.js'
import { recordCompiled, recordDeclared } from './declared.js'
import {
  assertKeys,
  numberOption,
  programRunner,
  timeoutOption,
  type EvaluationLimits,
  warmZones,
} from './program.js'
import type { ExplanationJSON, Trace } from './runtime/trace.js'
import type { Node } from './syntax/ast.js'
import { isName } from './syntax/lexer.js'
import { DEFAULT_PARSE_LIMITS, MAX_DEPTH_LIMIT, parse, type ParseLimits } from './syntax/parser.js'
import {
  isExact,
  isNullable,
  typeData,
  type AnyType,
  type InferChecked,
  type InferVariables,
  type Type,
} from './types.js'

// === public option types ===

/** Every field optional, and `undefined` accepted, even under `exactOptionalPropertyTypes`. */
type Optional<T> = { readonly [K in keyof T]?: T[K] | undefined }

export interface Limits extends Optional<ParseLimits>, Optional<RuntimeLimits> {
  /** Wall-clock budget per evaluation in milliseconds (0 = none; fractions allowed). Default 0. */
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
  /** Wall-clock budget for this evaluation in milliseconds (0 = none; fractions allowed). */
  readonly timeout?: number | undefined
  /** Step budget for this evaluation (0 = none; overrides the environment limit). */
  readonly maxSteps?: number | undefined
  /** Cancels the evaluation. */
  readonly signal?: AbortSignalLike | undefined
  /** The time now() returns in this evaluation, instead of the environment's clock. */
  readonly now?: Date | undefined
  /**
   * Validates the context for this evaluation (true) or not (false), instead
   * of the environment's `validateContext`; for a context already validated upstream.
   */
  readonly validateContext?: boolean | undefined
}

type InferParams<P extends readonly Type[]> = Extract<
  { -readonly [K in keyof P]: InferChecked<P[K]> },
  unknown[]
>

/** The arguments `run` receives: the declared parameters, then any rest arguments. */
type RunArgs<P extends readonly Type[], RT> = RT extends Type
  ? [...InferParams<P>, ...InferChecked<RT>[]]
  : InferParams<P>

/** What `run` may return: a nullable result also accepts `undefined`, which reads as null. */
type RunResult<R extends Type> =
  null extends InferChecked<R> ? InferChecked<R> | undefined : InferChecked<R>

/**
 * The standard `AbortSignal` when the consumer's types declare one (DOM or
 * Node), so it can be passed to `fetch`; otherwise {@link AbortSignalLike}.
 */
type HostAbortSignal = typeof globalThis extends { AbortSignal: { prototype: infer S } }
  ? S
  : AbortSignalLike

/** What a host function declared with `call: true` receives before its arguments. */
export interface HostCall<Ctx = Readonly<Record<string, unknown>>> {
  /** The evaluation context, read-only. */
  readonly context: Readonly<Ctx>
  /**
   * Aborted when the evaluation times out or is cancelled while it waits on
   * this call, so an async function can stop its own work (pass it to `fetch`).
   */
  readonly signal: HostAbortSignal
}

/** A host function declaration. Create one with {@link fn}. */
export interface HostFunction {
  readonly params: readonly Type[]
  readonly returns: Type
  readonly required?: number | undefined
  readonly rest?: Type | undefined
  readonly async?: boolean | undefined
  /** Whether `run` receives a {@link HostCall} before its arguments. */
  readonly call?: boolean | undefined
  readonly description?: string | undefined
  /** Steps charged per call (default 32). */
  readonly cost?: number | undefined
  readonly run: (...args: never[]) => unknown
}

/** The declaration passed to {@link fn}, without `run`, `async`, and `call`. */
export interface FnSpec<
  P extends readonly Type[] = readonly Type[],
  R extends Type = Type,
  RT extends Type | undefined = Type | undefined,
> {
  /** Parameter types, in order. */
  readonly params: P
  /** Declared result type; results are checked against its kind. */
  readonly returns: R
  /** Number of required leading parameters (default: all). Missing optional arguments arrive as null. */
  readonly required?: number | undefined
  /** Type of further variadic arguments. */
  readonly rest?: RT
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
 * fn({ params: [t.string()], returns: t.number(), async: true, call: true,
 *   run: async (call, id) => (await fetch(`/stock/${id}`, { signal: call.signal })).json() })
 * ```
 */
export function fn<
  const P extends readonly Type[],
  R extends Type,
  RT extends Type | undefined = undefined,
>(
  spec: FnSpec<P, R, RT> &
    (
      | {
          readonly async?: false | undefined
          readonly call?: false | undefined
          readonly run: (...args: RunArgs<P, RT>) => RunResult<R>
        }
      | {
          readonly async: true
          readonly call?: false | undefined
          readonly run: (...args: RunArgs<P, RT>) => Promise<RunResult<R>>
        }
      | {
          readonly async?: false | undefined
          readonly call: true
          readonly run: (call: HostCall, ...args: RunArgs<P, RT>) => RunResult<R>
        }
      | {
          readonly async: true
          readonly call: true
          readonly run: (call: HostCall, ...args: RunArgs<P, RT>) => Promise<RunResult<R>>
        }
    ),
): HostFunction {
  assertHostSpec(spec, 'fn()')
  return Object.freeze({ ...spec })
}

/**
 * Declares host functions that read a typed evaluation context: like `fn`
 * with `call: true`, with `call.context` typed as `Readonly<Ctx>`.
 *
 * ```ts
 * const contextFn = withContext<{ user: { id: string } }>()
 * const functions = { userId: contextFn({ params: [], returns: t.string(), run: (call) => call.context.user.id }) }
 * ```
 */
export function withContext<Ctx>() {
  return <const P extends readonly Type[], R extends Type, RT extends Type | undefined = undefined>(
    spec: FnSpec<P, R, RT> &
      (
        | {
            readonly async?: false | undefined
            /** Implied; may be written out when moving a function over from `fn`. */
            readonly call?: true | undefined
            readonly run: (call: HostCall<Ctx>, ...args: RunArgs<P, RT>) => RunResult<R>
          }
        | {
            readonly async: true
            readonly call?: true | undefined
            readonly run: (call: HostCall<Ctx>, ...args: RunArgs<P, RT>) => Promise<RunResult<R>>
          }
      ),
  ): HostFunction => {
    assertHostSpec(spec, 'withContext()')
    return Object.freeze({ ...spec, call: true })
  }
}

/**
 * A reusable bundle of host functions (and optionally variables). Declare one
 * with `satisfies Library` (not `: Library`) so its variables keep their types
 * and become part of the context type of every environment that uses it.
 */
export interface Library<
  V extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
> {
  readonly name: string
  readonly functions?: Readonly<Record<string, HostFunction>> | undefined
  readonly variables?: V | undefined
}

/** No declared variables: the empty record, which adds nothing to a context type. */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- intentionally empty
export type NoVariables = Record<never, never>

/**
 * The variables one library declares. A library annotated `: Library` has the
 * wide default (any string key), which names no variable, so it adds nothing.
 */
type VariablesOf<Lib> = Lib extends { readonly variables?: infer V }
  ? string extends keyof NonNullable<V>
    ? NoVariables
    : NonNullable<V>
  : NoVariables

/**
 * The variables a list of libraries declares, merged. Only a list whose
 * elements are known (written inline, or `as const`) contributes; a value
 * typed as `Library[]` adds nothing to the context type.
 */
type LibraryVariables<L> = L extends readonly [infer First, ...infer Rest]
  ? VariablesOf<First> & LibraryVariables<Rest>
  : NoVariables

/**
 * Any further keys, as a context with `strict: false` may carry. Its values are
 * `any` because only that lets an interface or a class instance (which have no
 * index signature) still satisfy it; declared keys keep their own types.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the only index signature interfaces and classes satisfy
type MoreKeys = Readonly<Record<string, any>>

/**
 * The context type of an environment with variables `V` and libraries `L`.
 * With `strict: false` (`S`), undeclared variables are allowed, so the context
 * may carry keys beyond the declared ones.
 */
export type ContextFor<V, L, S = undefined> = [S] extends [false]
  ? ContextOf<V & LibraryVariables<L>> & MoreKeys
  : ContextOf<V & LibraryVariables<L>>

/**
 * `Ctx` with the variables `New` declares replacing those of the same name,
 * as extend() replaces them at run time ("later wins"). Remapping keys (not
 * Omit) keeps an index signature and the other keys' types.
 */
type Override<Ctx, New> = [keyof New] extends [never]
  ? Ctx
  : { [K in keyof Ctx as K extends keyof New ? never : K]: Ctx[K] } & New

/** The context type extend() produces: re-declared variables replaced, strict: false loosened. */
export type Extended<Ctx, V, L, S> = [S] extends [false]
  ? Override<Ctx, ContextOf<V & LibraryVariables<L>>> & MoreKeys
  : Override<Ctx, ContextOf<V & LibraryVariables<L>>>

export interface EnvironmentOptions<
  V extends Readonly<Record<string, Type>> = Readonly<Record<string, Type>>,
  L extends readonly Library[] = readonly Library[],
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
  readonly libraries?: L | undefined
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
  /**
   * The built-ins available, from bonsai-js/builtins. Default: all of them
   * (none in bonsai-js/runtime/core). Calling one left out is a CHECK error, so
   * an environment that checks rules for bonsai-js/runtime/core passes the same
   * list as the runtime. On extend(), these are added to the base's.
   */
  readonly builtins?: readonly Builtin[] | undefined
}

declare const builtinBrand: unique symbol

/** A built-in function from bonsai-js/builtins, for the `builtins` option. */
export interface Builtin {
  readonly name: string
  readonly [builtinBrand]: true
}

/**
 * What check() found. Only `ok`, `type`, and `diagnostics` are data (and the
 * JSON form); `program`, `ast`, and `typeOf` are accessors computed on demand,
 * so spreading the result or `structuredClone` does not copy them.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the same erased context as a bare Program
export type CheckResult<Ctx = any, R = unknown> = Checked<Program<Ctx, R>>

/** What check() found, over the kind of program it compiles. */
type Checked<P> = (
  | {
      readonly ok: true
      readonly type: Type
      readonly diagnostics: readonly Diagnostic[]
      /**
       * The checked expression, compiled when first read: a program equal to
       * the one compile() returns, without parsing and checking again.
       */
      readonly program: P
    }
  | {
      readonly ok: false
      readonly type: Type | undefined
      readonly diagnostics: readonly Diagnostic[]
    }
) & {
  /**
   * The checked syntax tree (implicit lambdas made explicit, as `program.ast`),
   * or undefined when the source did not parse.
   */
  readonly ast: Node | undefined
  /** The inferred type of a node of `ast`, or undefined for another tree's node. */
  readonly typeOf: (node: Node) => Type | undefined
}

export type Args<Ctx> =
  Record<string, never> extends Ctx
    ? [context?: Ctx, options?: EvaluateOptions]
    : [context: Ctx, options?: EvaluateOptions]

/**
 * A checked, compiled expression. Immutable and safe to share. A bare
 * `Program` accepts any context, so a program typed for one context can be
 * stored as a `Program`.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the erased context type every typed program is assignable to
export interface Program<Ctx = any, R = unknown> {
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
  partial: (known: PartialData<Ctx> & object, options?: PartialOptions) => PartialResult<Ctx, R>
}

export interface ExplainOptions extends EvaluateOptions {
  /** How many lambda runs to record per call (the rest are counted). Default 20. */
  readonly maxIterations?: number | undefined
  /** Sub-expressions to record in total before stopping (the result stays exact). Default 10,000. */
  readonly maxTraceNodes?: number | undefined
  /**
   * Also evaluate the side of && and || that short-circuiting would skip, so
   * reasons() lists every failing condition rather than the first. Those
   * parts are marked `extra`; their evaluation errors are ignored and the
   * result is unchanged. They spend from the same step and time budget, so a
   * limit reached there (STEP_LIMIT, TIMEOUT, a size limit) fails the
   * explanation even when evaluation alone would stay inside it. Host
   * functions on those parts do run. Default false.
   */
  readonly exhaustive?: boolean | undefined
}

type ExplainArgs<Ctx> =
  Record<string, never> extends Ctx
    ? [context?: Ctx, options?: ExplainOptions]
    : [context: Ctx, options?: ExplainOptions]

/** The result of explain(): the outcome plus a trace of every sub-expression. */
export type Explanation<R = unknown> = (
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
  reasons: () => readonly Trace[]
  /** The trace as an indented, human-readable tree. */
  toString: () => string
  /**
   * A JSON-safe snapshot: values are bounded copies (cycles, bigints, dates,
   * and durations handled) and getters are never run. `JSON.stringify` uses it.
   */
  toJSON: () => ExplanationJSON
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
  /** Whether a host function receives a {@link HostCall} (declared `call: true`). */
  readonly call: boolean
  /** Steps charged per call, when the host function declares a `cost` (otherwise 32). */
  readonly cost?: number
  readonly signatures: readonly {
    readonly params: readonly Type[]
    readonly required: number
    readonly rest?: Type
    readonly returns: Type
  }[]
}

/** An environment. A bare `Environment` accepts any context, like a bare `Program`. */
// oxlint-disable-next-line typescript/no-explicit-any -- the erased context type every typed environment is assignable to
export interface Environment<Ctx = any> {
  /** Declared variables, or undefined for an open environment. */
  readonly variables: Readonly<Record<string, Type>> | undefined
  readonly strict: boolean
  /** Parses without checking. */
  parse: (source: string) => Node
  /**
   * Parses and checks, reporting every finding instead of throwing. When `ok`,
   * `program` is the compiled expression, so an editor needs only this call.
   */
  check: <E extends Type = AnyType>(
    source: string,
    options?: CompileOptions<E>,
  ) => CheckResult<Ctx, InferChecked<E>>
  /**
   * Parses, checks, and compiles. Throws BonsaiSyntaxError / BonsaiCheckError /
   * BonsaiLimitError. Cached: the same source and expected type return the same program.
   */
  compile: <E extends Type = AnyType>(
    source: string,
    options?: CompileOptions<E>,
  ) => Program<Ctx, InferChecked<E>>
  /**
   * Compiles (cached) and partially evaluates; see Program.partial. Throws for
   * syntax, check, and limit errors, and a TypeError or RangeError for invalid options.
   * `R` is an unchecked type assertion, as for evaluate().
   */
  partial: <R = unknown>(
    source: string,
    known: PartialData<Ctx> & object,
    options?: PartialOptions,
  ) => PartialResult<Ctx, R>
  /**
   * Compiles (cached) and evaluates asynchronously. `R` is an unchecked type
   * assertion on the result, like a cast; for a checked result type, use
   * `compile(source, { expect })` and evaluate the program.
   */
  evaluate: <R = unknown>(source: string, ...args: Args<Ctx>) => Promise<R>
  /**
   * Compiles (cached) and evaluates synchronously. `R` is an unchecked type
   * assertion, as for evaluate().
   */
  evaluateSync: <R = unknown>(source: string, ...args: Args<Ctx>) => R
  /**
   * Compiles (cached) and explains; see Program.explain. Rejects for syntax and
   * check errors and parse limits, and with a TypeError or RangeError for invalid options.
   * `R` is an unchecked type assertion, as for evaluate().
   */
  explain: <R = unknown>(source: string, ...args: ExplainArgs<Ctx>) => Promise<Explanation<R>>
  /**
   * Compiles (cached) and explains synchronously. Throws for syntax and check
   * errors and parse limits, and a TypeError or RangeError for invalid options.
   * `R` is an unchecked type assertion, as for evaluate().
   */
  explainSync: <R = unknown>(source: string, ...args: ExplainArgs<Ctx>) => Explanation<R>
  /** Looks up a function (host or built-in). */
  describeFunction: (name: string) => FunctionInfo | undefined
  /** Every callable function, host functions first. */
  listFunctions: () => readonly FunctionInfo[]
  /**
   * A new environment with more variables, functions, or libraries. A
   * variable or function declared again replaces the earlier one.
   */
  extend: <
    const V2 extends Readonly<Record<string, Type>> = NoVariables,
    const L2 extends readonly Library[] = [],
    const S2 extends boolean | undefined = undefined,
  >(
    options: EnvironmentOptions<V2, L2> & { readonly strict?: S2 },
  ) => Environment<Extended<Ctx, V2, L2, S2>>
}

/**
 * A program from `bonsai-js/lite`: a {@link Program} without `explain`,
 * `explainSync`, and `partial`. Every Program is also a LiteProgram, so code
 * that only evaluates can accept either.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the same erased context as a bare Program
export type LiteProgram<Ctx = any, R = unknown> = Omit<
  Program<Ctx, R>,
  'explain' | 'explainSync' | 'partial'
>

/** What a `bonsai-js/lite` environment's check() found. */
// oxlint-disable-next-line typescript/no-explicit-any -- the same erased context as a bare Program
export type LiteCheckResult<Ctx = any, R = unknown> = Checked<LiteProgram<Ctx, R>>

/**
 * An environment from `bonsai-js/lite`: an {@link Environment} without
 * `explain`, `explainSync`, and `partial`, whose programs are LitePrograms.
 * Every Environment is also a LiteEnvironment.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the same erased context as a bare Environment
export interface LiteEnvironment<Ctx = any> extends Omit<
  Environment<Ctx>,
  'check' | 'compile' | 'extend' | 'explain' | 'explainSync' | 'partial'
> {
  /** See Environment.check. */
  check: <E extends Type = AnyType>(
    source: string,
    options?: CompileOptions<E>,
  ) => LiteCheckResult<Ctx, InferChecked<E>>
  /** See Environment.compile. */
  compile: <E extends Type = AnyType>(
    source: string,
    options?: CompileOptions<E>,
  ) => LiteProgram<Ctx, InferChecked<E>>
  /** See Environment.extend. */
  extend: <
    const V2 extends Readonly<Record<string, Type>> = NoVariables,
    const L2 extends readonly Library[] = [],
    const S2 extends boolean | undefined = undefined,
  >(
    options: EnvironmentOptions<V2, L2> & { readonly strict?: S2 },
  ) => LiteEnvironment<Extended<Ctx, V2, L2, S2>>
}

/**
 * The context type of declared variables `V`. An open environment (no
 * variables) accepts any object, including values typed by an interface, and
 * so does a schema only known at run time (`Record<string, Type>`), whose
 * variables are not known statically.
 */
type ContextOf<V> = [keyof V] extends [never]
  ? object
  : string extends keyof V
    ? MoreKeys
    : InferVariables<V>

// === implementation ===

/** Internals shared with the language service (not public API). */
export interface EnvironmentInternals {
  readonly checkEnv: CheckEnv
  readonly parseLimits: ParseLimits
}

const internals = new WeakMap<object, EnvironmentInternals>()

export function internalsOf(env: object): EnvironmentInternals {
  const found = internals.get(env)
  if (found === undefined) throw new TypeError('Not a Bonsai environment')
  return found
}

/** Compiled programs kept per environment unless `cacheSize` says otherwise. */
const DEFAULT_CACHE_SIZE = 256

/** An environment's settings (not public API). */
export interface Settings {
  readonly variables: Readonly<Record<string, Type>> | undefined
  /** The explicit `strict` option, if one was given (here or in a base environment). */
  readonly strictOption: boolean | undefined
  readonly strict: boolean
  readonly host: ReadonlyMap<string, FunctionDef>
  /** The built-ins available (host functions of the same name replace them). */
  readonly builtins: ReadonlyMap<string, FunctionDef>
  readonly parseLimits: ParseLimits
  readonly runtimeLimits: RuntimeLimits
  readonly timeout: number
  readonly cacheSize: number
  readonly clock: () => Date
  readonly validateContext: boolean
  /** Explaining and partial evaluation, when the entry point provides them. */
  readonly features: Features | undefined
}

/**
 * What a program shares with the features that extend it (not public API):
 * its source, analysis, and settings, and how it prepares, checks, and settles
 * an evaluation.
 */
export interface ProgramCore<R> {
  readonly source: string
  readonly analysis: Analysis
  readonly expect: Type | undefined
  readonly settings: Settings
  readonly checkEnv: CheckEnv
  readonly compileOptions: CompilerOptions
  /** Set when the program is a partial-evaluation residual. */
  readonly residualOf: ResidualOf | undefined
  prepare: (
    state: State,
    ctx: Record<string, unknown>,
    limits: EvaluationLimits,
    locals: number,
  ) => void
  checked: (result: unknown, state: State) => void
  settle: (result: R) => R
  /** Compiles a residual of this program and returns how it runs. */
  residual: (analysis: Analysis, residualOf: ResidualOf) => ResidualRunner
}

/** The program methods a feature set provides (not public API). */
export interface ProgramFeatures<Ctx, R> {
  explainSync: (
    context: unknown,
    options: ExplainOptions | undefined,
    promised?: boolean,
  ) => Explanation<R>
  explainAsync: (context: unknown, options: ExplainOptions | undefined) => Promise<Explanation<R>>
  partial: (program: object, known: object, options: unknown) => PartialResult<Ctx, R>
}

/**
 * Explaining and partial evaluation, supplied by the entry point (not public
 * API): kept out of this module so a bundle that only checks and evaluates
 * does not carry them.
 */
export interface Features {
  program: <Ctx, R>(core: ProgramCore<R>) => ProgramFeatures<Ctx, R>
}

/**
 * What a residual keeps from its partial evaluation. Built by the features,
 * so a bundle without partial() carries none of how residuals run.
 */
export interface ResidualOf {
  /** Its printed source: the text of its explanations. */
  readonly source: string
  /** How it reads its bindings: see `CompileOptions.constant`. */
  readonly constant: NonNullable<CompilerOptions['constant']>
  /**
   * Checks the caller's context before a run: present where `call: true`
   * host functions read it whole, and valid against `variables` (when
   * validating) on the paths the residual reads.
   */
  readonly prepare: (
    state: State,
    ctx: Record<string, unknown>,
    variables: Readonly<Record<string, Type>> | undefined,
    limits: EvaluationLimits,
  ) => void
}

/** How a partial-evaluation residual runs and explains, with the caller's context. */
export interface ResidualRunner {
  /** Whether the residual calls an async host function. */
  async: boolean
  runSync: (ctx: unknown, options: unknown) => unknown
  runAsync: (ctx: unknown, options: unknown) => Promise<unknown>
  explainSync: (ctx: unknown, options: unknown) => Explanation
  explainAsync: (ctx: unknown, options: unknown) => Promise<Explanation>
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
    call: host.call === true,
    ...(host.cost === undefined ? {} : { cost: host.cost }),
    overloads: [
      overload(
        host.params,
        host.returns,
        (args) => {
          // Missing optional arguments arrive as null.
          const offset = host.call === true ? 1 : 0
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

const OPTION_KEYS = new Set([
  'variables',
  'strict',
  'functions',
  'libraries',
  'limits',
  'cacheSize',
  'clock',
  'validateContext',
  'builtins',
])
const LIMIT_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_PARSE_LIMITS),
  ...Object.keys(DEFAULT_RUNTIME_LIMITS),
  'timeout',
])
const LIBRARY_KEYS = new Set(['name', 'functions', 'variables'])

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
      Object.keys(defaults).map((name) => {
        const value = numberOption(
          `Limit "${name}"`,
          limits[name],
          base[name],
          name === 'maxSteps' ? 0 : 1,
        )
        const cap = DEPTH_CAPS[name]
        if (cap !== undefined && value > cap)
          throw new RangeError(`Limit "${name}" must be at most ${cap}`)
        return [name, value]
      }),
    ),
  )
}

/** Depth limits are capped: deeper nesting would run out of call stack. */
const DEPTH_CAPS: Readonly<Record<string, number>> = {
  maxDepth: MAX_DEPTH_LIMIT,
  maxValueDepth: MAX_VALUE_DEPTH_LIMIT,
}

/**
 * Settings from options, over a base (extend) or, for a new environment or
 * runtime, over the entry point's built-ins.
 */
export function settingsFrom(
  base: Settings | undefined,
  options: unknown,
  builtins: ReadonlyMap<string, FunctionDef> = new Map(),
): Settings {
  assertOptions(options)
  const limits = (options.limits ?? {}) as Readonly<Record<string, unknown>>
  const variables = mergeVariables(base?.variables, options)
  const strictOption = options.strict ?? base?.strictOption
  return {
    variables,
    strictOption,
    strict: strictOption ?? variables !== undefined,
    host: mergeFunctions(base?.host ?? new Map(), options),
    builtins: builtinsOption(
      options.builtins,
      base?.builtins ?? (options.builtins === undefined ? builtins : new Map()),
    ),
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
    timeout: timeoutOption('Limit "timeout"', limits.timeout, base?.timeout ?? 0),
    cacheSize: numberOption(
      'cacheSize',
      options.cacheSize,
      base?.cacheSize ?? DEFAULT_CACHE_SIZE,
      0,
    ),
    clock: options.clock === undefined ? (base?.clock ?? systemClock) : checkedClock(options.clock),
    validateContext: options.validateContext ?? base?.validateContext ?? false,
    features: base?.features,
  }
}

/**
 * Source characters the program cache holds in total, and the longest source it
 * keeps. A compiled program can retain a hundred times its source in memory, so
 * the cache is bounded by size as well as by count.
 */
const CACHE_CHARS = 262_144
const CACHE_MAX_SOURCE = 16_384

/**
 * Approximately least recently used ("second chance"): a hit only marks its
 * entry, so the hot path is one lookup. When the cache is full, the oldest
 * entry is evicted, unless it was used since it last reached the front (or is
 * the entry being added), in which case it moves to the back unmarked.
 */
export class ProgramCache<V> {
  private readonly map = new Map<string, { readonly value: V; used: boolean }>()
  private readonly size: number
  private chars = 0

  constructor(size: number) {
    this.size = size
  }

  get(key: string): V | undefined {
    const slot = this.map.get(key)
    if (slot === undefined) return undefined
    slot.used = true
    return slot.value
  }

  set(key: string, value: V): void {
    if (this.size === 0 || key.length > CACHE_MAX_SOURCE) return
    if (this.map.delete(key)) this.chars -= key.length
    this.map.set(key, { value, used: false })
    this.chars += key.length
    while (this.map.size > this.size || this.chars > CACHE_CHARS) {
      const [oldest, slot] = this.map.entries().next().value as [
        string,
        { readonly value: V; used: boolean },
      ]
      this.map.delete(oldest)
      if (slot.used || oldest === key) {
        slot.used = false
        this.map.set(oldest, slot)
      } else {
        this.chars -= oldest.length
      }
    }
  }
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([])

/**
 * What check() found. `ok`, `type`, and `diagnostics` are the JSON form; the
 * tree is read on demand (a prototype getter), so an editor checking on every
 * keystroke pays only for what it uses.
 */
class CheckFailure {
  readonly ok: boolean = false
  readonly type: Type | undefined
  readonly diagnostics: readonly Diagnostic[]
  /** The inferred type of a node of `ast`, or undefined for another tree's node. */
  readonly typeOf: (node: Node) => Type | undefined
  readonly #analysis: Analysis | undefined

  constructor(type: Type | undefined, diagnostics: readonly Diagnostic[], analysis?: Analysis) {
    this.type = type
    this.diagnostics = diagnostics
    this.#analysis = analysis
    this.typeOf = (node) => {
      const found = analysis?.types.get(node)
      return found === undefined ? undefined : deepFreeze(found)
    }
  }

  get ast(): Node | undefined {
    return this.#analysis === undefined ? undefined : deepFreeze(this.#analysis.root)
  }
}

/** A check that passed: also the compiled program, made the first time it is read. */
class CheckSuccess extends CheckFailure {
  override readonly ok: boolean = true
  readonly #program: () => unknown

  constructor(
    type: Type,
    diagnostics: readonly Diagnostic[],
    analysis: Analysis,
    program: () => unknown,
  ) {
    super(type, diagnostics, analysis)
    this.#program = program
  }

  get program(): unknown {
    return this.#program()
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

const systemClock = (): Date => new Date()

/** A host clock whose results are checked: now() must be a valid timestamp. */
function checkedClock(clock: () => Date): () => Date {
  return () => {
    let value: unknown
    try {
      value = clock()
    } catch (error) {
      throw raised(new BonsaiRuntimeError('HOST_ERROR', 'The clock failed', { cause: error }))
    }
    if (!(value instanceof Date) || Number.isNaN(Date.prototype.getTime.call(value))) {
      throw raised(
        new BonsaiRuntimeError(
          'HOST_CONTRACT',
          'The clock must return a valid Date (for example () => new Date())',
        ),
      )
    }
    return value
  }
}

/** Whether a type has an exact map type anywhere in it. */
function holdsExact(type: Type): boolean {
  const stack: Type[] = [type]
  const seen = new Set<Type>()
  while (stack.length > 0) {
    const next = stack.pop() as Type
    if (seen.has(next)) continue
    seen.add(next)
    if (isExact(next)) return true
    if (next.kind === 'list') stack.push(next.element)
    else if (next.kind === 'union') stack.push(...next.types)
    else if (next.kind === 'map') {
      stack.push(...Object.values(next.fields))
      if (next.rest !== undefined) stack.push(next.rest)
    }
  }
  return false
}

/** Reads compile(), check(), and the runtime's load() options: only `expect`, which must be a type built with t. Returns a frozen copy of it. */
export function expectOption(options: unknown, what: 'Compile' | 'Load'): Type | undefined {
  if (options === undefined) return undefined
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError(`${what} options must be an object`)
  let expect: unknown
  try {
    for (const key of Object.keys(options)) {
      if (key !== 'expect')
        throw new TypeError(
          `Unknown ${what.toLowerCase()} option key "${key}" (expected one of: expect)`,
        )
    }
    expect = (options as { expect?: unknown }).expect
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError(`${what} options could not be read`, { cause: error })
  }
  if (expect === undefined) return undefined
  // Checked, copied, and the copy checked: the program and its cache key use
  // one private copy, so no getter, toJSON, or later change can split them.
  assertType(expect, `${what} option "expect"`)
  const own = typeData(expect)
  if (own !== expect) assertType(own, `${what} option "expect"`)
  return own
}

function createEnvironment<Ctx>(settings: Settings): Environment<Ctx> {
  const checkEnv: CheckEnv = {
    variables: settings.variables,
    strict: settings.strict,
    lookup: (name) => settings.host.get(name) ?? settings.builtins.get(name),
    *functionNames() {
      yield* settings.host.keys()
      for (const name of settings.builtins.keys()) if (!settings.host.has(name)) yield name
    },
  }
  // Each entry records the source and expected type it was compiled for: a key
  // alone could collide (a comment may end a source with what looks like a type).
  const cache = new ProgramCache<{
    readonly program: Program<Ctx>
    readonly source: string
    readonly expect: string | undefined
  }>(settings.cacheSize)

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
          limit: error.limit ?? null,
        })
      }
      throw error
    }
  }

  function makeProgram<R>(source: string, analysis: Analysis, expect?: Type): Program<Ctx, R>
  function makeProgram(
    source: string,
    analysis: Analysis,
    expect: Type | undefined,
    residualOf: ResidualOf,
  ): ResidualRunner
  function makeProgram<R>(
    source: string,
    analysis: Analysis,
    expect?: Type,
    residualOf?: ResidualOf,
  ): Program<Ctx, R> | ResidualRunner {
    // Residuals are not warmed: partial() runs often, and a zone it writes into
    // the residual as text loads on first use (the shared data is already loaded).
    if (residualOf === undefined) warmZones(analysis)
    // When the checker cannot prove the result matches `expect` (part of it is
    // `any`, or an open object may hold an unlisted key), it is checked at run
    // time, so the declared result type holds.
    const guard = expect !== undefined && analysis.checkResult ? expect : undefined
    const { prepare, checked, settle, runSync, runAsync, compileOptions } = programRunner<R>({
      source,
      analysis,
      guard,
      settings,
      residualOf,
    })

    const features = settings.features?.program<Ctx, R>({
      source,
      analysis,
      expect,
      settings,
      checkEnv,
      compileOptions,
      residualOf,
      prepare,
      checked,
      settle,
      residual: (residualAnalysis, residualFrom) =>
        makeProgram(source, residualAnalysis, expect, residualFrom),
    })

    if (residualOf !== undefined) {
      // Only partial() makes residuals, so the features that made this one are present.
      const made = features as ProgramFeatures<Ctx, R>
      // A residual is used only through its runner, so no Program is built for
      // it (freezing its type and references would be work on every partial());
      // its tree is the result's `ast`, and compiles lazily, so it is frozen.
      deepFreeze(analysis.root)
      const runner: ResidualRunner = {
        async: analysis.async,
        runSync: (ctx, options) => runSync(ctx, options as EvaluateOptions | undefined),
        runAsync: (ctx, options) => runAsync(ctx, options as EvaluateOptions | undefined),
        explainSync: (ctx, options) => made.explainSync(ctx, options as ExplainOptions | undefined),
        explainAsync: (ctx, options) =>
          made.explainAsync(ctx, options as ExplainOptions | undefined),
      }
      return runner
    }
    // Programs are shared: the tree compiles lazily, so it must not change afterwards.
    // A lite program is typed as a LiteProgram by its entry point.
    const program = Object.freeze({
      // Without features (bonsai-js/lite), a program has no explain or partial.
      ...(features === undefined
        ? {}
        : {
            explain: (...args: ExplainArgs<Ctx>) => features.explainAsync(args[0], args[1]),
            explainSync: (...args: ExplainArgs<Ctx>) => features.explainSync(args[0], args[1]),
            partial: (known: object, options?: PartialOptions) =>
              features.partial(program, known, options),
          }),
      source,
      ast: deepFreeze(analysis.root),
      type: deepFreeze(analysis.type),
      async: analysis.async,
      warnings: deepFreeze(
        locate(
          source,
          analysis.diagnostics.filter((d) => d.severity === 'warning'),
        ),
      ),
      references: deepFreeze(analysis.references),
      evaluate: (...args: Args<Ctx>) => runAsync(args[0], args[1]),
      evaluateSync: (...args: Args<Ctx>) => runSync(args[0], args[1]),
    })
    recordDeclared(program, settings.variables)
    recordCompiled(program, {
      source,
      analysis,
      expect,
      lookup: checkEnv.lookup,
      variables: settings.variables,
    })
    return program as Program<Ctx, R>
  }

  function compile<R>(source: string, expect: Type | undefined): Program<Ctx, R> {
    const analysis = analyzeSource(source, expect)
    const errors = analysis.diagnostics.filter((d) => d.severity === 'error')
    if (errors.length > 0) throw new BonsaiCheckError(source, errors)
    return makeProgram<R>(source, analysis, expect)
  }

  /**
   * compile(), through the program cache: programs are immutable, so the same
   * source with an equal expected type shares one. `expect` is expectOption's
   * plain copy, so its JSON is the type the program is checked against.
   */
  function cachedCompile<R>(source: string, expect: Type | undefined): Program<Ctx, R> {
    if (typeof source !== 'string') throw new TypeError('An expression must be a string')
    // An exact map type (a checked program's inferred type passed back as
    // `expect`) checks differently from a declared one with the same JSON.
    if (expect !== undefined && holdsExact(expect)) return compile<R>(source, expect)
    const expectKey = expect === undefined ? undefined : JSON.stringify(expect)
    const key = expectKey === undefined ? source : `${source}\u0000${expectKey}`
    const entry = cache.get(key)
    if (entry !== undefined && entry.source === source && entry.expect === expectKey)
      return entry.program as Program<Ctx, R>
    const program = compile<R>(source, expect)
    cache.set(key, { program, source, expect: expectKey })
    return program
  }

  function cached(source: string): Program<Ctx> {
    return cachedCompile(source, undefined)
  }

  function info(def: FunctionDef): FunctionInfo {
    return {
      name: def.name,
      description: descriptionOf(def),
      host: def.host === true,
      async: def.async === true,
      call: def.call === true,
      ...(def.cost === undefined ? {} : { cost: def.cost }),
      signatures: def.overloads.map((o) => ({
        params: o.params,
        required: o.required ?? o.params.length,
        returns: o.result,
        ...(o.rest === undefined ? {} : { rest: o.rest }),
      })),
    }
  }

  // A lite environment is typed as a LiteEnvironment by its entry point.
  const env = Object.freeze({
    variables: settings.variables,
    strict: settings.strict,
    parse: parseSource,
    check<E extends Type = AnyType>(
      source: string,
      options?: CompileOptions<E>,
    ): CheckResult<Ctx, InferChecked<E>> {
      const expect = expectOption(options, 'Compile')
      let analysis: Analysis
      try {
        analysis = analyzeSource(source, expect)
      } catch (error) {
        if (!(error instanceof BonsaiError)) throw error
        const diagnostics = locate(source, [
          {
            code: error.code === 'SYNTAX' ? 'SYNTAX' : 'LIMIT',
            message: error.message,
            severity: 'error',
            start: error.span?.start ?? 0,
            end: error.span?.end ?? source.length,
          },
        ])
        return Object.freeze(new CheckFailure(undefined, diagnostics, undefined)) as CheckResult<
          Ctx,
          InferChecked<E>
        >
      }
      const diagnostics =
        analysis.diagnostics.length === 0 ? NO_DIAGNOSTICS : locate(source, analysis.diagnostics)
      const type = deepFreeze(analysis.type)
      if (analysis.diagnostics.some((d) => d.severity === 'error'))
        return Object.freeze(new CheckFailure(type, diagnostics, analysis)) as CheckResult<
          Ctx,
          InferChecked<E>
        >
      let program: Program<Ctx, InferChecked<E>> | undefined
      return Object.freeze(
        new CheckSuccess(
          type,
          diagnostics,
          analysis,
          () => (program ??= makeProgram<InferChecked<E>>(source, analysis, expect)),
        ),
      ) as CheckResult<Ctx, InferChecked<E>>
    },
    compile: <E extends Type = AnyType>(source: string, options?: CompileOptions<E>) =>
      cachedCompile<InferChecked<E>>(source, expectOption(options, 'Compile')),
    // Without features (bonsai-js/lite), an environment has no partial or explain.
    ...(settings.features === undefined
      ? {}
      : {
          partial: <R>(
            source: string,
            known: PartialData<Ctx> & object,
            options?: PartialOptions,
          ) => cached(source).partial(known, options) as PartialResult<Ctx, R>,
        }),
    evaluate<R>(source: string, ...args: Args<Ctx>): Promise<R> {
      try {
        return cached(source).evaluate(...args) as Promise<R>
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    evaluateSync: <R>(source: string, ...args: Args<Ctx>) =>
      cached(source).evaluateSync(...args) as R,
    ...(settings.features === undefined
      ? {}
      : {
          explain<R>(source: string, ...args: ExplainArgs<Ctx>): Promise<Explanation<R>> {
            try {
              return cached(source).explain(...args) as Promise<Explanation<R>>
            } catch (error) {
              return Promise.reject(error instanceof Error ? error : new Error(String(error)))
            }
          },
          explainSync: <R>(source: string, ...args: ExplainArgs<Ctx>) =>
            cached(source).explainSync(...args) as Explanation<R>,
        }),
    describeFunction(name: string): FunctionInfo | undefined {
      const def = checkEnv.lookup(name)
      return def === undefined ? undefined : info(def)
    },
    listFunctions(): FunctionInfo[] {
      return [...checkEnv.functionNames()].map((name) => info(checkEnv.lookup(name) as FunctionDef))
    },
    extend<
      V2 extends Readonly<Record<string, Type>>,
      L2 extends readonly Library[],
      S2 extends boolean | undefined,
    >(options: EnvironmentOptions<V2, L2> & { readonly strict?: S2 }) {
      return createEnvironment<Extended<Ctx, V2, L2, S2>>(settingsFrom(settings, options))
    },
  })
  internals.set(env, { checkEnv, parseLimits: settings.parseLimits })
  return env as Environment<Ctx>
}

/**
 * An environment from `bonsai()` options, with the features its entry point
 * provides (not public API): `bonsai-js` passes explaining and partial
 * evaluation, `bonsai-js/lite` passes none.
 */
export function environmentWith<Ctx>(
  features: Features | undefined,
  options: unknown,
): Environment<Ctx> {
  return createEnvironment<Ctx>({ ...settingsFrom(undefined, options, BUILTINS), features })
}
