// === Source Positions ===

export interface SourcePosition {
  line: number
  column: number
  offset: number
}

// === Token Types ===

export type BinaryOperator =
  | '||' | '&&'
  | '==' | '!='
  | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | '%' | '**'
  | 'in' | 'not'

export type UnaryOperator = '!' | '-' | '+'
export type BinaryExpressionOperator = Exclude<BinaryOperator, 'not'> | 'not in' | '??'

export type OperatorValue = BinaryOperator | UnaryOperator

export type PunctuationValue = '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ':' | '?'

interface BaseToken {
  start: number
  end: number
}

export type Token =
  | { type: 'Number'; value: string } & BaseToken
  | { type: 'String'; value: string } & BaseToken
  | { type: 'TemplateLiteral'; value: string } & BaseToken
  | { type: 'Boolean'; value: 'true' | 'false' } & BaseToken
  | { type: 'Null'; value: 'null' } & BaseToken
  | { type: 'Undefined'; value: 'undefined' } & BaseToken
  | { type: 'Identifier'; value: string } & BaseToken
  | { type: 'Operator'; value: OperatorValue } & BaseToken
  | { type: 'Punctuation'; value: PunctuationValue } & BaseToken
  | { type: 'Pipe'; value: '|>' } & BaseToken
  | { type: 'OptionalChain'; value: '?.' } & BaseToken
  | { type: 'NullishCoalescing'; value: '??' } & BaseToken
  | { type: 'Spread'; value: '...' } & BaseToken
  | { type: 'EOF'; value: '' } & BaseToken

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
  /** Maximum array literal or spread size. Default: 100,000. */
  maxArrayLength?: number
  /** Allowlist of property/method names expressions can access. */
  allowedProperties?: string[]
  /** Denylist of property/method names expressions cannot access. */
  deniedProperties?: string[]
  /** LRU cache size for compiled expressions and parsed ASTs. Default: 256. */
  cacheSize?: number
}

/** A transform receives the piped value as its first argument: `value |> myTransform(arg)`. */
export type TransformFn = (value: unknown, ...args: unknown[]) => unknown | Promise<unknown>

/** A function is called directly by name: `myFunction(arg1, arg2)`. */
export type FunctionFn = (...args: unknown[]) => unknown | Promise<unknown>

/** A plugin receives the Bonsai instance and extends it with transforms or functions. */
export type BonsaiPlugin = (instance: BonsaiInstance) => void

/** Core Bonsai instance returned by `bonsai()`. */
export interface BonsaiInstance {
  /** Register a plugin that extends this instance with transforms/functions. */
  use(plugin: BonsaiPlugin): this
  /** Register a named transform for use with the pipe operator (`|>`). */
  addTransform(name: string, fn: TransformFn): this
  /** Register a named function callable as `name(args)` in expressions. */
  addFunction(name: string, fn: FunctionFn): this
  /** Remove a previously registered transform. Returns true if it existed. */
  removeTransform(name: string): boolean
  /** Remove a previously registered function. Returns true if it existed. */
  removeFunction(name: string): boolean
  /** Check whether a transform with the given name is registered. */
  hasTransform(name: string): boolean
  /** Check whether a function with the given name is registered. */
  hasFunction(name: string): boolean
  /** List all registered transform names. */
  listTransforms(): string[]
  /** List all registered function names. */
  listFunctions(): string[]
  /** Clear the compiled expression and AST caches. */
  clearCache(): void
  /** Pre-compile an expression for repeated evaluation. */
  compile(expression: string): CompiledExpression
  /** Evaluate an expression asynchronously. Required when transforms/functions are async. */
  evaluate<T = unknown>(expression: string, context?: Record<string, unknown>): Promise<T>
  /** Evaluate an expression synchronously. Throws if a transform/function returns a Promise. */
  evaluateSync<T = unknown>(expression: string, context?: Record<string, unknown>): T
  /** Check if an expression is syntactically valid without evaluating it. */
  validate(expression: string): ValidationResult
}

/** A pre-compiled expression that can be evaluated repeatedly with different contexts. */
export interface CompiledExpression {
  /** Evaluate asynchronously. Required when transforms/functions are async. */
  evaluate<T = unknown>(context?: Record<string, unknown>): Promise<T>
  /** Evaluate synchronously. Throws if a transform/function returns a Promise. */
  evaluateSync<T = unknown>(context?: Record<string, unknown>): T
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
