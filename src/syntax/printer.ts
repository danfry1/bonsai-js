import {
  forEachChild,
  type BinaryOperator,
  type MapEntry,
  type Node,
  type SpreadNode,
} from './ast.js'
import { BLOCKED_NAMES, IDENTIFIER, isName } from './lexer.js'

export interface PrintOptions {
  /**
   * How calls are written. `preserve` (default) keeps each call's style;
   * `method` writes `x.f(a)` wherever a call has a first argument; `function`
   * writes `f(x, a)` everywhere. All three mean the same call.
   */
  readonly calls?: 'preserve' | 'method' | 'function' | undefined
}

// Binding strength of each printed form; higher binds tighter.
const LET = 0
const CONDITIONAL = 1
const UNARY = 10
const POSTFIX = 11

const BINARY: Readonly<Record<BinaryOperator, number>> = {
  '??': 2,
  '||': 3,
  '&&': 4,
  '==': 5,
  '!=': 5,
  '<': 6,
  '<=': 6,
  '>': 6,
  '>=': 6,
  in: 6,
  'not in': 6,
  '+': 7,
  '-': 7,
  '*': 8,
  '/': 8,
  '%': 8,
  '**': 9,
}

const COMPARISON_LEVELS = new Set([BINARY['=='], BINARY['<']])
/** Logical operators are associative, so a run of one needs no parentheses. */
const ASSOCIATIVE = new Set<BinaryOperator>(['&&', '||', '??'])
/** Call names the parser reads as syntax, not as calls. */
const SPECIAL_CALLS = new Set(['has', 'try'])

const validName = (name: unknown): name is string => typeof name === 'string' && isName(name)

const invalid = (message: string): never => {
  throw new TypeError(`Cannot print this tree: ${message}`)
}

/** Deeper than any tree the parser accepts at practical limits, and still stack-safe. */
const MAX_PRINT_DEPTH = 2000
const PRINT_OPTION_KEYS: ReadonlySet<string> = new Set(['calls'])

/**
 * Rejects cycles and excessive depth without recursing, so a hostile or broken
 * tree fails with a clear error instead of overflowing the stack.
 */
function assertShape(root: Node): void {
  const onPath = new Set<object>()
  const stack: { node: Node; depth: number; exit: boolean }[] = [
    { node: root, depth: 1, exit: false },
  ]
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const n = frame.node
    if (frame.exit) {
      onPath.delete(n)
      continue
    }
    if (typeof n !== 'object' || n === null) continue
    if (onPath.has(n)) invalid('the tree contains a cycle')
    if (frame.depth > MAX_PRINT_DEPTH)
      invalid(`the tree nests deeper than ${MAX_PRINT_DEPTH} levels`)
    onPath.add(n)
    stack.push({ node: n, depth: frame.depth, exit: true })
    const depth = frame.depth + 1
    try {
      forEachChild(n, (child) => {
        stack.push({ node: child, depth, exit: false })
      })
    } catch {
      // A malformed node: the full validation below reports it precisely.
    }
  }
}

/**
 * Rejects trees the parser could not have produced, and that would therefore
 * print as source meaning something else (or not parse at all). Trees from
 * `parse()` and `Program.ast` always pass.
 */
function assertPrintable(root: Node): void {
  assertShape(root)
  // Names bound by enclosing `let`s and explicit lambdas.
  const scope: string[] = []
  const bind = (name: unknown, what: string): void => {
    if (!validName(name)) return invalid(`${what} ${JSON.stringify(name)} is not a valid name`)
    if (scope.includes(name)) invalid(`${what} "${name}" is already bound in this scope`)
    scope.push(name)
  }
  const visit = (n: Node, asArgument: boolean): void => {
    if (typeof n !== 'object' || n === null) invalid(`${String(n)} is not a node`)
    switch (n.type) {
      case 'It':
        return
      case 'Literal': {
        const v: unknown = n.value
        if (v !== null && typeof v !== 'boolean' && typeof v !== 'number' && typeof v !== 'string')
          invalid(`a literal cannot hold ${typeof v}`)
        return
      }
      case 'Template':
        for (const part of n.parts) if (typeof part !== 'string') visit(part, false)
        return
      case 'Variable':
        if (!validName(n.name)) invalid(`variable ${JSON.stringify(n.name)} is not a valid name`)
        if (scope.includes(n.name))
          invalid(`variable "${n.name}" would print as the local binding of the same name`)
        return
      case 'Local':
        if (!scope.includes(n.name)) invalid(`local ${JSON.stringify(n.name)} is not bound here`)
        return
      case 'Member':
        if (typeof n.name !== 'string' || BLOCKED_NAMES.has(n.name))
          invalid(`property ${JSON.stringify(n.name)} is not accessible`)
        visit(n.object, false)
        return
      case 'Index':
        visit(n.object, false)
        visit(n.index, false)
        return
      case 'Call': {
        if (!validName(n.name) || SPECIAL_CALLS.has(n.name))
          invalid(`${JSON.stringify(n.name)} is not a callable function name`)
        const [first] = n.args
        if (
          n.optional &&
          (first === undefined || first.type === 'Spread' || first.type === 'Lambda')
        )
          invalid(`"?.${n.name}()" needs a receiver`)
        for (const arg of n.args) {
          if (arg.type === 'Spread') visit(arg.argument, false)
          else visit(arg, true)
        }
        return
      }
      case 'Unary':
        if (n.operator !== '!' && n.operator !== '-')
          invalid(`unknown unary operator ${JSON.stringify(n.operator)}`)
        visit(n.operand, false)
        return
      case 'Binary':
        if (!Object.hasOwn(BINARY, n.operator))
          invalid(`unknown operator ${JSON.stringify(n.operator)}`)
        visit(n.left, false)
        visit(n.right, false)
        return
      case 'Conditional':
        visit(n.test, false)
        visit(n.then, false)
        visit(n.otherwise, false)
        return
      case 'List':
        for (const item of n.items) visit(item.type === 'Spread' ? item.argument : item, false)
        return
      case 'Map':
        for (const entry of n.entries) {
          if (entry.type === 'Spread') visit(entry.argument, false)
          else if (entry.type === 'Entry') {
            if (typeof entry.key === 'string') {
              if (BLOCKED_NAMES.has(entry.key)) invalid(`"${entry.key}" cannot be used as a key`)
            } else visit(entry.key, false)
            visit(entry.value, false)
          } else invalid(`unknown map entry ${JSON.stringify((entry as { type?: unknown }).type)}`)
        }
        return
      case 'Lambda': {
        if (!asArgument) invalid('a lambda can only be a function argument')
        if (n.implicit) {
          if (n.params.length > 0) invalid('an implicit lambda has no named parameters')
          visit(n.body, false)
          return
        }
        const depth = scope.length
        for (const param of n.params) bind(param, 'lambda parameter')
        visit(n.body, false)
        scope.length = depth
        return
      }
      case 'Let': {
        visit(n.value, false)
        const depth = scope.length
        bind(n.name, 'let binding')
        visit(n.body, false)
        scope.length = depth
        return
      }
      case 'Has':
        if (n.target.type !== 'Member' && n.target.type !== 'Index')
          invalid('has(...) takes a property path')
        visit(n.target, false)
        return
      case 'Try':
        visit(n.body, false)
        visit(n.fallback, false)
        return
      default:
        invalid(`unknown node type ${JSON.stringify((n as { type?: unknown }).type)}`)
    }
  }
  visit(root, false)
}

/**
 * Prints a syntax tree as Bonsai source. `parse(print(tree))` means the same
 * as `tree`, with the fewest parentheses that keep it so. Comments and
 * original spacing are not part of the tree and are not reproduced.
 */
export function print(node: Node, options: PrintOptions = {}): string {
  if (typeof options !== 'object' || options === null)
    throw new TypeError('print() options must be an object')
  for (const key of Object.keys(options)) {
    if (!PRINT_OPTION_KEYS.has(key))
      throw new TypeError(`Unknown print() option "${key}" (expected: calls)`)
  }
  const style = options.calls ?? 'preserve'
  if (style !== 'preserve' && style !== 'method' && style !== 'function')
    throw new TypeError('calls must be "preserve", "method", or "function"')
  assertPrintable(node)

  function levelOf(n: Node): number {
    switch (n.type) {
      case 'Let':
        return LET
      case 'Conditional':
        return CONDITIONAL
      case 'Binary':
        return BINARY[n.operator]
      case 'Unary':
        return UNARY
      case 'Literal':
        return typeof n.value === 'number' && (n.value < 0 || Object.is(n.value, -0))
          ? UNARY
          : POSTFIX
      case 'Lambda':
        return n.implicit ? levelOf(n.body) : LET
      case 'Call':
      case 'Has':
      case 'Index':
      case 'It':
      case 'List':
      case 'Local':
      case 'Map':
      case 'Member':
      case 'Template':
      case 'Try':
      case 'Variable':
      default:
        return POSTFIX
    }
  }

  const wrap = (text: string, needed: boolean): string => (needed ? `(${text})` : text)

  /** Prints `n` where an expression of at least `level` is expected. */
  function at(n: Node, level: number): string {
    return wrap(expr(n), levelOf(n) < level)
  }

  function binaryOperand(
    parent: Extract<Node, { type: 'Binary' }>,
    child: Node,
    side: 'left' | 'right',
  ): string {
    const op = parent.operator
    const level = BINARY[op]
    const childLevel = levelOf(child)
    let needed = childLevel < level
    if (childLevel === level) {
      if (op === '**') needed = side === 'left'
      else if (COMPARISON_LEVELS.has(level)) needed = true
      else if (side === 'right')
        needed = !(ASSOCIATIVE.has(op) && child.type === 'Binary' && child.operator === op)
    }
    if (child.type === 'Binary') {
      // Beside "??", every other binary operator needs parentheses (the parser requires them).
      const mixesNullish =
        (op === '??' && child.operator !== '??') ||
        ((op === '&&' || op === '||') && child.operator === '??')
      if (mixesNullish) needed = true
    }
    // `-x ** y` is a syntax error; the base of ** must be parenthesized.
    if (op === '**' && side === 'left' && childLevel === UNARY) needed = true
    return wrap(expr(child), needed)
  }

  function args(list: readonly (Node | SpreadNode)[]): string {
    return list
      .map((arg) => {
        if (arg.type === 'Spread') return `...${expr(arg.argument)}`
        return arg.type === 'Lambda' ? lambda(arg) : expr(arg)
      })
      .join(', ')
  }

  function lambda(n: Extract<Node, { type: 'Lambda' }>): string {
    if (n.implicit) return expr(n.body)
    const [only] = n.params
    const params = n.params.length === 1 && only !== undefined ? only : `(${n.params.join(', ')})`
    return `${params} => ${expr(n.body)}`
  }

  function propertyAccess(object: Node, name: string, optional: boolean): string {
    if (!IDENTIFIER.test(name))
      return `${at(object, POSTFIX)}${optional ? '?.' : ''}[${stringLiteral(name)}]`
    if (object.type === 'It' && !optional) return `.${name}`
    return `${at(object, POSTFIX)}${optional ? '?.' : '.'}${name}`
  }

  function entry(e: MapEntry | SpreadNode): string {
    if (e.type === 'Spread') return `...${expr(e.argument)}`
    if (typeof e.key !== 'string') return `[${expr(e.key)}]: ${expr(e.value)}`
    const key = IDENTIFIER.test(e.key) ? e.key : stringLiteral(e.key)
    // Validation proved variable and local names are names (not keywords).
    const shorthand =
      (e.value.type === 'Variable' || e.value.type === 'Local') && e.value.name === e.key
    return shorthand ? key : `${key}: ${expr(e.value)}`
  }

  function expr(n: Node): string {
    switch (n.type) {
      case 'Literal':
        return literal(n.value)
      case 'Template':
        return `\`${templateParts(n.parts)
          .map((part) => (typeof part === 'string' ? templateText(part) : `\${${expr(part)}}`))
          .join('')}\``
      case 'Variable':
      case 'Local':
        return n.name
      case 'It':
        return '.'
      case 'Member':
        return propertyAccess(n.object, n.name, n.optional)
      case 'Index':
        return `${n.object.type === 'It' && !n.optional ? '.' : at(n.object, POSTFIX)}${n.optional ? '?.' : ''}[${expr(n.index)}]`
      case 'Call': {
        const [first, ...rest] = n.args
        const asMethod =
          first !== undefined &&
          first.type !== 'Spread' &&
          first.type !== 'Lambda' &&
          (style === 'method' || (style === 'preserve' && n.style === 'method') || n.optional)
        if (asMethod) {
          const dot = n.optional ? '?.' : '.'
          const head = first.type === 'It' && !n.optional ? '.' : `${at(first, POSTFIX)}${dot}`
          return `${head}${n.name}(${args(rest)})`
        }
        return `${n.name}(${args(n.args)})`
      }
      case 'Unary': {
        const operand = at(n.operand, UNARY)
        // Keep `- -x` from printing as the invalid `--x`.
        const space = n.operator === '-' && operand.startsWith('-') ? ' ' : ''
        return `${n.operator}${space}${operand}`
      }
      case 'Binary':
        return `${binaryOperand(n, n.left, 'left')} ${n.operator} ${binaryOperand(n, n.right, 'right')}`
      case 'Conditional':
        return `${at(n.test, CONDITIONAL + 1)} ? ${expr(n.then)} : ${expr(n.otherwise)}`
      case 'List':
        return `[${args(n.items)}]`
      case 'Map':
        return n.entries.length === 0 ? '{}' : `{ ${n.entries.map(entry).join(', ')} }`
      case 'Lambda':
        return lambda(n)
      case 'Let':
        return `let ${n.name} = ${expr(n.value)}; ${expr(n.body)}`
      case 'Has':
        return `has(${expr(n.target)})`
      case 'Try':
        return `try(${expr(n.body)}, ${expr(n.fallback)})`
      default:
        return invalid(`unknown node type ${JSON.stringify((n as { type?: unknown }).type)}`)
    }
  }

  return expr(node)
}

function literal(value: null | boolean | number | string): string {
  if (typeof value === 'string') return stringLiteral(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`Cannot print the non-finite number ${String(value)}`)
    return Object.is(value, -0) ? '-0' : String(value)
  }
  return String(value)
}

const HEX = 16
const PAD = 2
const ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
}

/** A double-quoted string using only escapes the Bonsai lexer understands. */
function stringLiteral(text: string): string {
  // eslint-disable-next-line no-control-regex -- escaping control characters is the point
  return `"${text.replace(/[\u0000-\u001f"\\]/gu, (ch) => ESCAPES[ch] ?? `\\x${ch.charCodeAt(0).toString(HEX).padStart(PAD, '0')}`)}"`
}

/**
 * Template parts with adjacent text joined, so text is escaped as a whole: `$`
 * and `{b}` printed apart would read back as the interpolation `${b}`.
 */
function templateParts<P>(parts: readonly (string | P)[]): (string | P)[] {
  const out: (string | P)[] = []
  for (const part of parts) {
    const last = out[out.length - 1]
    if (typeof part === 'string' && typeof last === 'string') out[out.length - 1] = last + part
    else out.push(part)
  }
  return out
}

function templateText(text: string): string {
  return text
    .replace(/[\\`]|\$\{/gu, (match) => `\\${match}`)
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
}
