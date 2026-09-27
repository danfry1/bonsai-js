import type { BinaryOperator, MapEntry, Node, SpreadNode } from './ast.js'

export interface PrintOptions {
  /**
   * How calls are written. `preserve` (default) keeps each call's style;
   * `method` writes `x.f(a)` wherever a call has a first argument; `function`
   * writes `f(x, a)` everywhere. All three mean the same call.
   */
  readonly calls?: 'preserve' | 'method' | 'function'
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
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const RESERVED = new Set(['true', 'false', 'null', 'let', 'in', 'not'])

/**
 * Prints a syntax tree as Bonsai source. `parse(print(tree))` means the same
 * as `tree`, with the fewest parentheses that keep it so. Comments and
 * original spacing are not part of the tree and are not reproduced.
 */
export function print(node: Node, options: PrintOptions = {}): string {
  const style = options.calls ?? 'preserve'

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
      const mixesNullish =
        (op === '??' && (child.operator === '&&' || child.operator === '||')) ||
        ((op === '&&' || op === '||') && child.operator === '??')
      if (mixesNullish) needed = true
    }
    // `-x ** y` is a syntax error; the base of ** must be parenthesized.
    if (op === '**' && side === 'left' && childLevel === UNARY) needed = true
    return wrap(expr(child), needed)
  }

  function receiver(n: Node): string {
    // `.` alone as a receiver prints as `.name(...)` without a second dot.
    return at(n, POSTFIX)
  }

  function args(list: readonly (Node | SpreadNode)[]): string {
    return list
      .map((arg) => (arg.type === 'Spread' ? `...${expr(arg.argument)}` : argument(arg)))
      .join(', ')
  }

  function argument(arg: Node): string {
    return arg.type === 'Lambda' ? lambda(arg) : expr(arg)
  }

  function lambda(n: Extract<Node, { type: 'Lambda' }>): string {
    if (n.implicit) return expr(n.body)
    const [only] = n.params
    const params = n.params.length === 1 && only !== undefined ? only : `(${n.params.join(', ')})`
    return `${params} => ${expr(n.body)}`
  }

  function propertyAccess(object: Node, name: string, optional: boolean): string {
    if (!IDENTIFIER.test(name))
      return `${receiver(object)}${optional ? '?.' : ''}[${stringLiteral(name)}]`
    if (object.type === 'It' && !optional) return `.${name}`
    return `${receiver(object)}${optional ? '?.' : '.'}${name}`
  }

  function entry(e: MapEntry | SpreadNode): string {
    if (e.type === 'Spread') return `...${expr(e.argument)}`
    if (typeof e.key !== 'string') return `[${expr(e.key)}]: ${expr(e.value)}`
    const key = IDENTIFIER.test(e.key) || RESERVED.has(e.key) ? e.key : stringLiteral(e.key)
    const shorthand =
      (e.value.type === 'Variable' || e.value.type === 'Local') &&
      e.value.name === e.key &&
      IDENTIFIER.test(e.key)
    return shorthand && !RESERVED.has(e.key) ? key : `${key}: ${expr(e.value)}`
  }

  function expr(n: Node): string {
    switch (n.type) {
      case 'Literal':
        return literal(n.value)
      case 'Template':
        return `\`${n.parts.map((part) => (typeof part === 'string' ? templateText(part) : `\${${expr(part)}}`)).join('')}\``
      case 'Variable':
      case 'Local':
        return n.name
      case 'It':
        return '.'
      case 'Member':
        return propertyAccess(n.object, n.name, n.optional)
      case 'Index':
        return `${n.object.type === 'It' && !n.optional ? '.' : receiver(n.object)}${n.optional ? '?.' : ''}[${expr(n.index)}]`
      case 'Call': {
        const [first, ...rest] = n.args
        const asMethod =
          first !== undefined &&
          first.type !== 'Spread' &&
          first.type !== 'Lambda' &&
          (style === 'method' || (style === 'preserve' && n.style === 'method') || n.optional)
        if (asMethod) {
          const dot = n.optional ? '?.' : '.'
          const head = first.type === 'It' && !n.optional ? '.' : `${receiver(first)}${dot}`
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
      default:
        return `try(${expr(n.body)}, ${expr(n.fallback)})`
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

function templateText(text: string): string {
  return text
    .replace(/[\\`]|\$\{/gu, (match) => `\\${match}`)
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
}
