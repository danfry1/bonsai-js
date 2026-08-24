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

// === Static Type Metadata ===

/** JSON-serializable type vocabulary used by the optional static checker. */
export type BonsaiType =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'null' }
  | { readonly kind: 'undefined' }
  /** A single string, number, or boolean value; unions of literals model enums. */
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'array'; readonly element: BonsaiType }
  | {
      readonly kind: 'object'
      readonly properties: Readonly<Record<string, BonsaiType>>
      readonly additionalProperties?: BonsaiType | false
    }
  | { readonly kind: 'union'; readonly members: readonly BonsaiType[] }

/** Object-shaped static type accepted as a root context schema. */
export type BonsaiObjectType = Extract<BonsaiType, { readonly kind: 'object' }>

/** One declared extension parameter. Rest parameters must be last. */
export interface ParameterMetadata {
  readonly name: string
  readonly type: BonsaiType
  readonly optional?: boolean
  readonly rest?: boolean
  readonly description?: string
}

// === Policy Snapshot ===

/** Read-only snapshot of the security policy, returned by {@link BonsaiInstance.getPolicy}. */
export interface PolicySnapshot {
  readonly maxSourceLength: number
  readonly maxTokens: number
  readonly maxAstNodes: number
  readonly maxObjectProperties: number
  readonly maxCallArguments: number
  readonly maxDepth: number
  readonly maxArrayLength: number
  readonly maxStringLength: number
  readonly maxSteps: number
  readonly timeout: number
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
  readonly start: number
  readonly end: number
}

export interface NumberLiteral extends BaseNode {
  readonly type: 'NumberLiteral'
  readonly value: number
}

export interface StringLiteral extends BaseNode {
  readonly type: 'StringLiteral'
  readonly value: string
}

export interface BooleanLiteral extends BaseNode {
  readonly type: 'BooleanLiteral'
  readonly value: boolean
}

export interface NullLiteral extends BaseNode {
  readonly type: 'NullLiteral'
  readonly value: null
}

export interface UndefinedLiteral extends BaseNode {
  readonly type: 'UndefinedLiteral'
  readonly value: undefined
}

export interface Identifier extends BaseNode {
  readonly type: 'Identifier'
  readonly name: string
}

export interface BinaryExpression extends BaseNode {
  readonly type: 'BinaryExpression'
  readonly operator: BinaryExpressionOperator
  readonly left: ASTNode
  readonly right: ASTNode
}

export interface UnaryExpression extends BaseNode {
  readonly type: 'UnaryExpression'
  readonly operator: UnaryOperator
  readonly operand: ASTNode
}

export interface ConditionalExpression extends BaseNode {
  readonly type: 'ConditionalExpression'
  readonly test: ASTNode
  readonly consequent: ASTNode
  readonly alternate: ASTNode
}

export interface MemberExpression extends BaseNode {
  readonly type: 'MemberExpression'
  readonly object: ASTNode
  readonly property: ASTNode
  readonly computed: boolean
}

export interface OptionalMemberExpression extends BaseNode {
  readonly type: 'OptionalMemberExpression'
  readonly object: ASTNode
  readonly property: ASTNode
  readonly computed: boolean
}

export interface ArrayLiteral extends BaseNode {
  readonly type: 'ArrayLiteral'
  readonly elements: readonly (ASTNode | SpreadElement)[]
}

export interface ObjectLiteral extends BaseNode {
  readonly type: 'ObjectLiteral'
  readonly properties: readonly ObjectProperty[]
}

export interface ObjectProperty extends BaseNode {
  readonly type: 'ObjectProperty'
  readonly key: ASTNode
  readonly value: ASTNode
  readonly computed: boolean
}

export interface CallExpression extends BaseNode {
  readonly type: 'CallExpression'
  readonly callee: ASTNode
  readonly args: readonly ASTNode[]
}

export interface PipeExpression extends BaseNode {
  readonly type: 'PipeExpression'
  readonly input: ASTNode
  readonly transform: ASTNode
}

export interface TemplateLiteral extends BaseNode {
  readonly type: 'TemplateLiteral'
  readonly parts: readonly (StringLiteral | ASTNode)[]
}

export interface SpreadElement extends BaseNode {
  readonly type: 'SpreadElement'
  readonly argument: ASTNode
}

export interface LambdaAccessor extends BaseNode {
  readonly type: 'LambdaAccessor'
  readonly property: string
}

export interface LambdaExpression extends BaseNode {
  readonly type: 'LambdaExpression'
  readonly body: ASTNode
}

export interface LambdaIdentity extends BaseNode {
  readonly type: 'LambdaIdentity'
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

/** Structural limits applied before an expression can reach evaluation. */
export interface SyntaxLimits {
  /** Maximum UTF-16 source length. Default: 100,000. */
  maxSourceLength?: number
  /** Maximum number of lexical tokens, excluding EOF. Default: 25,000. */
  maxTokens?: number
  /** Maximum number of AST and object-property nodes. Default: 10,000. */
  maxAstNodes?: number
  /** Maximum number of properties in an object literal. Default: 10,000. */
  maxObjectProperties?: number
  /** Maximum number of arguments in one call, checked both syntactically and after spread expansion. Default: 1,000. */
  maxCallArguments?: number
}

/** Options for creating a Bonsai instance via {@link BonsaiInstance}. */
export interface BonsaiOptions extends SyntaxLimits {
  /** Cooperative timeout in milliseconds. 0 (default) disables timeout checks. */
  timeout?: number
  /** Maximum expression nesting depth. Default: 100. */
  maxDepth?: number
  /** Maximum array size produced during evaluation (literals, spread, and array-returning methods). Default: 100,000. */
  maxArrayLength?: number
  /** Maximum string size produced by a string-returning method (padStart, padEnd, repeat, join, concat, slice, ...). Default: 100,000. */
  maxStringLength?: number
  /**
   * Maximum number of evaluator steps a single evaluation may take, a
   * deterministic bound on work that applies without a wall-clock timeout. A
   * "step" is one accounted evaluator operation: a compound-node visit, a
   * lambda-callback invocation (once per visited element in a higher-order
   * method), spread element, template/literal-loop element, or pre-charged unit
   * of linear native work based on receiver length. Work inside an opaque
   * registered extension is NOT counted. A native call cannot be interrupted
   * once started, so charging occurs before the intrinsic is invoked.
   * Default: 1,000,000. Set to 0 to disable.
   */
  maxSteps?: number
  /** Allowlist of property/method names expressions can access. */
  allowedProperties?: string[]
  /** Denylist of property/method names expressions cannot access. */
  deniedProperties?: string[]
  /** LRU cache size for compiled expressions and parsed ASTs. Default: 256. */
  cacheSize?: number
}

/** Controls for one evaluation. Values override the instance defaults for that run only. */
export interface EvaluationOptions {
  /** Cooperative wall-clock timeout in milliseconds. */
  timeout?: number
  /** Deterministic evaluator step budget. Set to 0 to disable for this run. */
  maxSteps?: number
  /** Cancels async waits and is sampled during synchronous evaluator work. */
  signal?: AbortSignal
}

/** A transform receives the piped value as its first argument: `value |> myTransform(arg)`. */
export type TransformFn = (value: unknown, ...args: unknown[]) => unknown

/**
 * Relational array typing that cannot be expressed by a fixed return type.
 * Callback rules consume an optional Bonsai lambda in the first transform
 * argument and infer it against the input array's element type.
 */
export type ArrayTransformTypeRule =
  | 'preserve'
  | 'optional-element'
  | 'flatten'
  | 'map'
  | 'filter'
  | 'find'
  | 'some'
  | 'every'

/** Declarative transform information consumed by tooling without calling the transform. */
export interface TransformMetadata {
  /**
   * Type accepted as the piped input. Omit when every type is accepted. Used
   * by the checker for exact matching and by autocomplete (widened to its
   * runtime kind) to filter `|>` suggestions.
   */
  readonly inputType?: BonsaiType
  /** Types of arguments after the piped input value. */
  readonly parameters?: readonly ParameterMetadata[]
  /** Return type. Lets autocomplete continue inference through `a |> t |> ` chains. */
  readonly returnType?: BonsaiType
  /** Generic array input/result relationship used by the checker. */
  readonly arrayTypeRule?: ArrayTransformTypeRule
  /** Short human-readable description for editors and generated documentation. */
  readonly description?: string
}

/** Preferred declarative form for registering a transform. */
export interface TransformDefinition extends TransformMetadata {
  readonly name: string
  readonly evaluate: TransformFn
}

/** A function is called directly by name: `myFunction(arg1, arg2)`. */
export type FunctionFn = (...args: unknown[]) => unknown

/** Declarative function information consumed by tooling without calling the function. */
export interface FunctionMetadata {
  /** Declared call parameters for static checking and signature help. */
  readonly parameters?: readonly ParameterMetadata[]
  /** Return type, consumed by the checker and shown by autocomplete. */
  readonly returnType?: BonsaiType
  /** Short human-readable description for editors and generated documentation. */
  readonly description?: string
}

/** Preferred declarative form for registering a pure function. */
export interface FunctionDefinition extends FunctionMetadata {
  readonly name: string
  readonly evaluate: FunctionFn
}

/** The shape of an evaluation context object. */
export type BonsaiContext = object
type EmptyContext = Record<never, never>

/**
 * Evaluation/compiled call sites only require a `context` argument when the
 * instance context type has required keys. Untyped instances keep the current
 * ergonomic `evaluateSync(expr)` / `compiled.evaluateSync()` behavior.
 */
export type EvaluationContextArgs<TCtx extends BonsaiContext = Record<string, unknown>> =
  EmptyContext extends TCtx
    ? [context?: TCtx, options?: EvaluationOptions]
    : [context: TCtx, options?: EvaluationOptions]

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

/** Preferred declarative form for registering a context-aware function. */
export interface ContextFunctionDefinition<
  TCtx extends BonsaiContext = Record<string, unknown>,
> extends FunctionMetadata {
  readonly name: string
  readonly evaluate: ContextFunctionFn<TCtx>
}

/**
 * A registry entry for a callable invoked as `name(args)` in expressions,
 * tagged with its kind so the evaluator knows how to call it. Pure functions
 * receive only the call arguments; context functions receive the evaluation
 * context as their first parameter. Pure and context functions share one
 * namespace, so a name resolves to exactly one entry.
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
  addTransform: (name: string, fn: TransformFn, metadata?: TransformMetadata) => this
  /** Explicitly replace an existing transform. Throws when the name is not registered. */
  replaceTransform: (name: string, fn: TransformFn, metadata?: TransformMetadata) => this
  /** Register a transform using the preferred self-describing definition form. */
  defineTransform: (definition: TransformDefinition) => this
  /** Register a named function callable as `name(args)` in expressions. */
  addFunction: (name: string, fn: FunctionFn, metadata?: FunctionMetadata) => this
  /** Explicitly replace an existing pure or context-aware function with a pure function. */
  replaceFunction: (name: string, fn: FunctionFn, metadata?: FunctionMetadata) => this
  /** Register a pure function using the preferred self-describing definition form. */
  defineFunction: (definition: FunctionDefinition) => this
  /**
   * Register a context-aware function callable as `name(args)` in expressions.
   * The function receives the live evaluation context as its first parameter
   * (typed `Readonly<TCtx>` for read-only intent; passed by reference, not
   * copied or frozen). Shares a namespace with {@link addFunction}; duplicate
   * names are rejected so plugins cannot silently replace each other.
   *
   * The callback may read any subset of `TCtx`; reading a field `TCtx` does not
   * declare is a type error, so a function can never observe context the
   * evaluator is not guaranteed to supply.
   */
  addContextFunction: (
    name: string,
    fn: ContextFunctionFn<TCtx>,
    metadata?: FunctionMetadata,
  ) => this
  /** Explicitly replace an existing pure or context-aware function with a context function. */
  replaceContextFunction: (
    name: string,
    fn: ContextFunctionFn<TCtx>,
    metadata?: FunctionMetadata,
  ) => this
  /** Register a context-aware function using the preferred self-describing definition form. */
  defineContextFunction: (definition: ContextFunctionDefinition<TCtx>) => this
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
  /** Read declarative metadata for a registered transform. */
  getTransformMetadata: (name: string) => TransformMetadata | undefined
  /** List all registered function names (both pure and context-aware). */
  listFunctions: () => string[]
  /** Read declarative metadata for a registered function. */
  getFunctionMetadata: (name: string) => FunctionMetadata | undefined
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
  /**
   * Permanently lock the extension registry. Sealing is idempotent; every
   * later registration/removal attempt throws.
   */
  seal: () => this
  /** Whether the extension registry has been sealed. */
  isSealed: () => boolean
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
  /**
   * Parse an expression and extract its references without evaluating it.
   * Syntax only: it does not verify that referenced bindings exist or check
   * types; use `bonsai-js/checker` for that.
   */
  validate: (expression: string) => ValidationResult
}

/** A pre-compiled expression that can be evaluated repeatedly with different contexts. */
export interface CompiledExpression<TCtx extends BonsaiContext = Record<string, unknown>> {
  /** Evaluate asynchronously. Required when transforms/functions are async. */
  evaluate: <T = unknown>(...args: EvaluationContextArgs<TCtx>) => Promise<T>
  /** Evaluate synchronously. Throws if a transform/function returns a Promise. */
  evaluateSync: <T = unknown>(...args: EvaluationContextArgs<TCtx>) => T
  /** The deeply frozen optimized AST after constant folding and dead branch elimination. */
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

/**
 * Result of {@link BonsaiInstance.validate}. Discriminated on the `valid` field:
 * narrow with `if (result.valid)` to reach `references`/`ast`, or the `errors`.
 */
export type ValidationResult =
  | { valid: true; errors: []; ast: ASTNode; references: ExpressionReferences }
  | { valid: false; errors: ValidationError[] }

/** A syntax error with position information from {@link BonsaiInstance.validate}. */
export interface ValidationError {
  /** Human-readable message without source context. */
  message: string
  /** 1-based line/column of the error in the source expression. */
  position: { line: number; column: number }
  /** Message with source context and a caret pointing at the error. Always present. */
  formatted: string
}
