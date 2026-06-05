// === Inferred Type Names ===

/** Closed set of type names produced by runtime type inference. */
export type InferredTypeName =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null'
  | 'undefined'

// === Policy Snapshot ===

/** Read-only snapshot of the security policy, returned by {@link BonsaiInstance.getPolicy}. */
export interface PolicySnapshot {
  readonly allowedProperties?: readonly string[]
  readonly deniedProperties?: readonly string[]
}

// === Property Resolution ===

/** Discriminated result from {@link resolvePropertyChain}. */
export type ResolveResult =
  | { found: true; value: unknown }
  | { found: false; reason: 'blocked' | 'not-object' | 'not-found' }

// === Source Positions ===

export interface SourcePosition {
  line: number
  column: number
  offset: number
}

// === Token Types ===

export type BinaryOperator =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '**'
  | 'in'
  | 'not'

export type UnaryOperator = '!' | '-' | '+'
export type BinaryExpressionOperator = Exclude<BinaryOperator, 'not'> | 'not in' | '??'

export type OperatorValue = BinaryOperator | UnaryOperator

export type PunctuationValue = '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ':' | '?'

interface BaseToken {
  start: number
  end: number
}

export type Token =
  | ({ type: 'Number'; value: string } & BaseToken)
  | ({ type: 'String'; value: string } & BaseToken)
  | ({ type: 'TemplateLiteral'; value: string } & BaseToken)
  | ({ type: 'Boolean'; value: 'true' | 'false' } & BaseToken)
  | ({ type: 'Null'; value: 'null' } & BaseToken)
  | ({ type: 'Undefined'; value: 'undefined' } & BaseToken)
  | ({ type: 'Identifier'; value: string } & BaseToken)
  | ({ type: 'Operator'; value: OperatorValue } & BaseToken)
  | ({ type: 'Punctuation'; value: PunctuationValue } & BaseToken)
  | ({ type: 'Pipe'; value: '|>' } & BaseToken)
  | ({ type: 'OptionalChain'; value: '?.' } & BaseToken)
  | ({ type: 'NullishCoalescing'; value: '??' } & BaseToken)
  | ({ type: 'Spread'; value: '...' } & BaseToken)
  | ({ type: 'EOF'; value: '' } & BaseToken)

export type TokenType = Token['type']

// === AST Nodes ===

interface BaseNode {
  start: number
  end: number
}

export interface NumberLiteral extends BaseNode {
  type: 'NumberLiteral'
  value: number
}

export interface StringLiteral extends BaseNode {
  type: 'StringLiteral'
  value: string
}

export interface BooleanLiteral extends BaseNode {
  type: 'BooleanLiteral'
  value: boolean
}

export interface NullLiteral extends BaseNode {
  type: 'NullLiteral'
  value: null
}

export interface UndefinedLiteral extends BaseNode {
  type: 'UndefinedLiteral'
  value: undefined
}

export interface Identifier extends BaseNode {
  type: 'Identifier'
  name: string
}

export interface BinaryExpression extends BaseNode {
  type: 'BinaryExpression'
  operator: BinaryExpressionOperator
  left: ASTNode
  right: ASTNode
}

export interface UnaryExpression extends BaseNode {
  type: 'UnaryExpression'
  operator: UnaryOperator
  operand: ASTNode
}

export interface ConditionalExpression extends BaseNode {
  type: 'ConditionalExpression'
  test: ASTNode
  consequent: ASTNode
  alternate: ASTNode
}

export interface MemberExpression extends BaseNode {
  type: 'MemberExpression'
  object: ASTNode
  property: ASTNode
  computed: boolean
}

export interface OptionalMemberExpression extends BaseNode {
  type: 'OptionalMemberExpression'
  object: ASTNode
  property: ASTNode
  computed: boolean
}

export interface ArrayLiteral extends BaseNode {
  type: 'ArrayLiteral'
  readonly elements: readonly (ASTNode | SpreadElement)[]
}

export interface ObjectLiteral extends BaseNode {
  type: 'ObjectLiteral'
  readonly properties: readonly ObjectProperty[]
}

export interface ObjectProperty extends BaseNode {
  type: 'ObjectProperty'
  key: ASTNode
  value: ASTNode
  computed: boolean
}

export interface CallExpression extends BaseNode {
  type: 'CallExpression'
  callee: ASTNode
  readonly args: readonly ASTNode[]
}

export interface PipeExpression extends BaseNode {
  type: 'PipeExpression'
  input: ASTNode
  transform: ASTNode
}

export interface TemplateLiteral extends BaseNode {
  type: 'TemplateLiteral'
  readonly parts: readonly (StringLiteral | ASTNode)[]
}

export interface SpreadElement extends BaseNode {
  type: 'SpreadElement'
  argument: ASTNode
}

export interface LambdaAccessor extends BaseNode {
  type: 'LambdaAccessor'
  property: string
}

export interface LambdaExpression extends BaseNode {
  type: 'LambdaExpression'
  body: ASTNode
}

export interface LambdaIdentity extends BaseNode {
  type: 'LambdaIdentity'
}

export type ASTNode =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | UndefinedLiteral
  | Identifier
  | BinaryExpression
  | UnaryExpression
  | ConditionalExpression
  | MemberExpression
  | OptionalMemberExpression
  | ArrayLiteral
  | ObjectLiteral
  | CallExpression
  | PipeExpression
  | TemplateLiteral
  | SpreadElement
  | LambdaAccessor
  | LambdaExpression
  | LambdaIdentity

// === Configuration ===

/** Options for creating a Bonsai instance via {@link BonsaiInstance}. */
export interface BonsaiOptions {
  /** Cooperative timeout in milliseconds. 0 (default) disables timeout checks. */
  timeout?: number
  /** Maximum expression nesting depth. Default: 100. */
  maxDepth?: number
  /** Maximum array size produced during evaluation (literals, spread, and array-returning methods). Default: 100,000. */
  maxArrayLength?: number
  /** Maximum string size produced by a string-returning method (padStart, padEnd, repeat, join, concat, slice, ...). Default: 100,000. */
  maxStringLength?: number
  /** Allowlist of property/method names expressions can access. */
  allowedProperties?: string[]
  /** Denylist of property/method names expressions cannot access. */
  deniedProperties?: string[]
  /** LRU cache size for compiled expressions and parsed ASTs. Default: 256. */
  cacheSize?: number
}

/** A transform receives the piped value as its first argument: `value |> myTransform(arg)`. */
export type TransformFn = (value: unknown, ...args: unknown[]) => unknown

/** A function is called directly by name: `myFunction(arg1, arg2)`. */
export type FunctionFn = (...args: unknown[]) => unknown

/** The shape of an evaluation context object. */
export type BonsaiContext = object
type EmptyContext = Record<never, never>

/**
 * Evaluation/compiled call sites only require a `context` argument when the
 * instance context type has required keys. Untyped instances keep the current
 * ergonomic `evaluateSync(expr)` / `compiled.evaluateSync()` behavior.
 */
export type EvaluationContextArgs<TCtx extends BonsaiContext = Record<string, unknown>> =
  EmptyContext extends TCtx ? [context?: TCtx] : [context: TCtx]

/**
 * A context-aware function. Receives the live evaluation context as its first
 * parameter, followed by the call's argument values. The context is typed
 * `Readonly<TCtx>` to signal read-only intent; it is passed by reference and is
 * not copied or frozen, so treat it as read-only. Registered via
 * {@link BonsaiInstance.addContextFunction}.
 */
export type ContextFunctionFn<TCtx extends BonsaiContext = Record<string, unknown>> = (
  context: Readonly<TCtx>,
  ...args: unknown[]
) => unknown

/**
 * A registry entry for a callable invoked as `name(args)` in expressions,
 * tagged with its kind so the evaluator knows how to call it. Pure functions
 * receive only the call arguments; context functions receive the evaluation
 * context as their first parameter. Pure and context functions share one
 * namespace, so a name resolves to exactly one entry (last registration wins).
 */
export type RegisteredFunction =
  | { kind: 'pure'; fn: FunctionFn }
  | { kind: 'context'; fn: ContextFunctionFn }

/**
 * The extension surface handed to a {@link BonsaiPlugin}: everything needed to
 * register transforms and functions (and to compose other plugins via
 * {@link PluginRegistrar.use}), but deliberately *not* the context-consuming
 * members (`evaluate`, `evaluateSync`, `compile`).
 *
 * Omitting those is what makes this interface **covariant** in `TCtx`: the only
 * place `TCtx` appears is the `ctx` parameter of an {@link addContextFunction}
 * callback (an input of an input). A registrar for a wider context is therefore
 * usable wherever a registrar for a narrower one is expected, which is exactly
 * what lets {@link PluginRegistrar.use} accept a plugin whose context
 * requirement `TCtx` satisfies, soundly and without casts, for contexts declared
 * with either `type` or `interface`.
 *
 * The `TCtx`-bearing members are declared as property signatures so their
 * variance is exact, rather than the bivariance TypeScript grants to method
 * signatures.
 */
export interface PluginRegistrar<TCtx extends BonsaiContext = Record<string, unknown>> {
  /**
   * Apply another plugin. Accepts any plugin whose required context `TCtx`
   * satisfies: a plugin written for this exact context, a context-agnostic
   * plugin (`BonsaiPlugin`, i.e. `BonsaiPlugin<object>`), or one written against
   * any context that `TCtx` is assignable to. A plugin that requires a field
   * this context does not provide is a type error.
   */
  use: (plugin: BonsaiPlugin<TCtx>) => this
  /** Register a named transform for use with the pipe operator (`|>`). */
  addTransform: (name: string, fn: TransformFn) => this
  /** Register a named function callable as `name(args)` in expressions. */
  addFunction: (name: string, fn: FunctionFn) => this
  /**
   * Register a context-aware function callable as `name(args)` in expressions.
   * The function receives the live evaluation context as its first parameter
   * (typed `Readonly<TCtx>` for read-only intent; passed by reference, not
   * copied or frozen). Shares a namespace with {@link addFunction}: registering
   * the same name with either overwrites the previous registration.
   *
   * The callback may read any subset of `TCtx`; reading a field `TCtx` does not
   * declare is a type error, so a function can never observe context the
   * evaluator is not guaranteed to supply.
   */
  addContextFunction: (name: string, fn: ContextFunctionFn<TCtx>) => this
  /** Remove a previously registered transform. Returns true if it existed. */
  removeTransform: (name: string) => boolean
  /** Remove a previously registered function (pure or context-aware). Returns true if it existed. */
  removeFunction: (name: string) => boolean
  /** Check whether a transform with the given name is registered. */
  hasTransform: (name: string) => boolean
  /** Check whether a function (pure or context-aware) with the given name is registered. */
  hasFunction: (name: string) => boolean
  /** Check whether a function with the given name was registered via {@link addContextFunction}. */
  isContextFunction: (name: string) => boolean
  /** List all registered transform names. */
  listTransforms: () => string[]
  /** List all registered function names (both pure and context-aware). */
  listFunctions: () => string[]
}

/**
 * A plugin extends an instance with transforms and functions. It receives a
 * {@link PluginRegistrar}, never the full instance, so it cannot evaluate
 * against a context it did not supply.
 *
 * `TCtx` is the context the plugin *requires* (the fields its context functions
 * read). It defaults to `object`, the top of the context lattice that every
 * context satisfies, so a plugin registering only transforms/pure functions is
 * context-agnostic and applies to any instance.
 */
export type BonsaiPlugin<TCtx extends BonsaiContext = object> = (
  registrar: PluginRegistrar<TCtx>,
) => void

/**
 * Core Bonsai instance returned by `bonsai()`. Extends {@link PluginRegistrar}
 * with the context-consuming members plus instance-level utilities. The
 * context-bearing members are property signatures so their context parameter is
 * checked with strict (sound) variance.
 */
export interface BonsaiInstance<
  TCtx extends BonsaiContext = Record<string, unknown>,
> extends PluginRegistrar<TCtx> {
  /** Returns a read-only snapshot of the security policy for autocomplete filtering. */
  getPolicy: () => PolicySnapshot
  /** Clear the compiled expression and AST caches. */
  clearCache: () => void
  /** Pre-compile an expression for repeated evaluation. */
  compile: (expression: string) => CompiledExpression<TCtx>
  /** Evaluate an expression asynchronously. Required when transforms/functions are async. */
  evaluate: <T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>) => Promise<T>
  /** Evaluate an expression synchronously. Throws if a transform/function returns a Promise. */
  evaluateSync: <T = unknown>(expression: string, ...args: EvaluationContextArgs<TCtx>) => T
  /** Check if an expression is syntactically valid without evaluating it. */
  validate: (expression: string) => ValidationResult
}

/** A pre-compiled expression that can be evaluated repeatedly with different contexts. */
export interface CompiledExpression<TCtx extends BonsaiContext = Record<string, unknown>> {
  /** Evaluate asynchronously. Required when transforms/functions are async. */
  evaluate: <T = unknown>(...args: EvaluationContextArgs<TCtx>) => Promise<T>
  /** Evaluate synchronously. Throws if a transform/function returns a Promise. */
  evaluateSync: <T = unknown>(...args: EvaluationContextArgs<TCtx>) => T
  /** The optimized AST after constant folding and dead branch elimination. */
  readonly ast: ASTNode
  /** The original expression string. */
  readonly source: string
}

/** Identifiers, transforms, and functions referenced by a parsed expression. */
export interface ExpressionReferences {
  identifiers: string[]
  transforms: string[]
  functions: string[]
}

/** Result of {@link BonsaiInstance.validate}. Discriminated on the `valid` field. */
export type ValidationResult =
  | { valid: true; errors: []; ast: ASTNode; references: ExpressionReferences }
  | { valid: false; errors: ValidationError[] }

/** A syntax error with position information from {@link BonsaiInstance.validate}. */
export interface ValidationError {
  message: string
  position: { line: number; column: number }
  suggestion?: string
  formatted?: string
}
