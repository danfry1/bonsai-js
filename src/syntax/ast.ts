/**
 * The Bonsai syntax tree. Nodes are plain JSON-serializable objects; `start`
 * and `end` are UTF-16 offsets into the source. Treat node types as an open
 * set: new node types may be added in minor releases.
 */
export type Node =
  | LiteralNode
  | TemplateNode
  | VariableNode
  | LocalNode
  | ItNode
  | MemberNode
  | IndexNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | ConditionalNode
  | ListNode
  | MapNode
  | LambdaNode
  | LetNode
  | HasNode
  | TryNode

interface Base {
  readonly start: number
  readonly end: number
}

export interface LiteralNode extends Base {
  readonly type: 'Literal'
  readonly value: null | boolean | number | string
}

export interface TemplateNode extends Base {
  readonly type: 'Template'
  /** Alternating text and expressions; text is decoded. */
  readonly parts: readonly (string | Node)[]
}

/** A read of a context variable. */
export interface VariableNode extends Base {
  readonly type: 'Variable'
  readonly name: string
}

/** A read of a `let` binding or an explicit lambda parameter. */
export interface LocalNode extends Base {
  readonly type: 'Local'
  readonly name: string
}

/** The implicit lambda parameter `.`. */
export interface ItNode extends Base {
  readonly type: 'It'
}

export interface MemberNode extends Base {
  readonly type: 'Member'
  readonly object: Node
  readonly name: string
  readonly optional: boolean
}

export interface IndexNode extends Base {
  readonly type: 'Index'
  readonly object: Node
  readonly index: Node
  readonly optional: boolean
}

export type CallStyle = 'function' | 'method'

/**
 * A function call. For `method` style the receiver is `args[0]`: `x.f(a)`
 * is `f(x, a)`.
 */
export interface CallNode extends Base {
  readonly type: 'Call'
  readonly name: string
  readonly args: readonly (Node | SpreadNode)[]
  readonly style: CallStyle
  /** `x?.f()`: the call yields null without running when the receiver is null. */
  readonly optional: boolean
  /** Span of the function name, for diagnostics and editor features. */
  readonly nameStart: number
  readonly nameEnd: number
}

export type UnaryOperator = '!' | '-'

export interface UnaryNode extends Base {
  readonly type: 'Unary'
  readonly operator: UnaryOperator
  readonly operand: Node
}

export type BinaryOperator =
  | '??'
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not in'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '**'

export interface BinaryNode extends Base {
  readonly type: 'Binary'
  readonly operator: BinaryOperator
  readonly left: Node
  readonly right: Node
}

export interface ConditionalNode extends Base {
  readonly type: 'Conditional'
  readonly test: Node
  readonly then: Node
  readonly otherwise: Node
}

export interface SpreadNode extends Base {
  readonly type: 'Spread'
  readonly argument: Node
}

export interface ListNode extends Base {
  readonly type: 'List'
  readonly items: readonly (Node | SpreadNode)[]
}

export interface MapEntry extends Base {
  readonly type: 'Entry'
  /** A static key, or an expression for `[key]: value`. */
  readonly key: string | Node
  readonly value: Node
}

export interface MapNode extends Base {
  readonly type: 'Map'
  readonly entries: readonly (MapEntry | SpreadNode)[]
}

export interface LambdaNode extends Base {
  readonly type: 'Lambda'
  /** Parameter names; an implicit lambda (`.field`) has no named parameters. */
  readonly params: readonly string[]
  readonly implicit: boolean
  readonly body: Node
}

export interface LetNode extends Base {
  readonly type: 'Let'
  readonly name: string
  readonly value: Node
  readonly body: Node
}

/** `has(a.b)`: whether the key exists, even when its value is null. */
export interface HasNode extends Base {
  readonly type: 'Has'
  readonly target: MemberNode | IndexNode
}

/** `try(body, fallback)`: `fallback` when `body` fails with an evaluation error. */
export interface TryNode extends Base {
  readonly type: 'Try'
  readonly body: Node
  readonly fallback: Node
}

/** Visits every child node (not spreads or entries themselves, but their contents). */
export function forEachChild(node: Node, visit: (child: Node) => void): void {
  switch (node.type) {
    case 'Template':
      for (const part of node.parts) if (typeof part !== 'string') visit(part)
      return
    case 'Member':
      visit(node.object)
      return
    case 'Index':
      visit(node.object)
      visit(node.index)
      return
    case 'Call':
      for (const arg of node.args) visit(arg.type === 'Spread' ? arg.argument : arg)
      return
    case 'Unary':
      visit(node.operand)
      return
    case 'Binary':
      visit(node.left)
      visit(node.right)
      return
    case 'Conditional':
      visit(node.test)
      visit(node.then)
      visit(node.otherwise)
      return
    case 'List':
      for (const item of node.items) visit(item.type === 'Spread' ? item.argument : item)
      return
    case 'Map':
      for (const entry of node.entries) {
        if (entry.type === 'Spread') visit(entry.argument)
        else {
          if (typeof entry.key !== 'string') visit(entry.key)
          visit(entry.value)
        }
      }
      return
    case 'Lambda':
      visit(node.body)
      return
    case 'Let':
      visit(node.value)
      visit(node.body)
      return
    case 'Has':
      visit(node.target)
      return
    case 'Try':
      visit(node.body)
      visit(node.fallback)
      break
    case 'It':
    case 'Literal':
    case 'Local':
    case 'Variable':
      break
  }
}

/**
 * A shallow copy of `node` with every child replaced by `map(child)` (spreads
 * and map entries are copied around their contents). Leaves are returned as is.
 */
export function mapChildren(node: Node, map: (child: Node) => Node): Node {
  const item = (arg: Node | SpreadNode): Node | SpreadNode =>
    arg.type === 'Spread' ? { ...arg, argument: map(arg.argument) } : map(arg)
  switch (node.type) {
    case 'Template':
      return {
        ...node,
        parts: node.parts.map((part) => (typeof part === 'string' ? part : map(part))),
      }
    case 'Member':
      return { ...node, object: map(node.object) }
    case 'Index':
      return { ...node, object: map(node.object), index: map(node.index) }
    case 'Call':
      return { ...node, args: node.args.map(item) }
    case 'Unary':
      return { ...node, operand: map(node.operand) }
    case 'Binary':
      return { ...node, left: map(node.left), right: map(node.right) }
    case 'Conditional':
      return { ...node, test: map(node.test), then: map(node.then), otherwise: map(node.otherwise) }
    case 'List':
      return { ...node, items: node.items.map(item) }
    case 'Map':
      return {
        ...node,
        entries: node.entries.map((entry): MapEntry | SpreadNode => {
          if (entry.type === 'Spread') return { ...entry, argument: map(entry.argument) }
          const value = map(entry.value)
          return typeof entry.key === 'string'
            ? { ...entry, value }
            : { ...entry, key: map(entry.key), value }
        }),
      }
    case 'Lambda':
      return { ...node, body: map(node.body) }
    case 'Let':
      return { ...node, value: map(node.value), body: map(node.body) }
    case 'Has':
      return { ...node, target: map(node.target) as MemberNode | IndexNode }
    case 'Try':
      return { ...node, body: map(node.body), fallback: map(node.fallback) }
    case 'It':
    case 'Literal':
    case 'Local':
    case 'Variable':
    default:
      return node
  }
}
