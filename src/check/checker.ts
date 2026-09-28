import { BonsaiLimitError, type Diagnostic, type DiagnosticCode } from '../errors.js'
import { RESULT_REFINERS } from '../functions/builtins.js'
import { isLambdaPosition, type FunctionDef, type Overload } from '../functions/define.js'
import {
  forEachChild,
  type CallNode,
  type LambdaNode,
  type MapEntry,
  type Node,
  type SpreadNode,
} from '../syntax/ast.js'
import {
  chargeTypeWork,
  exactObject,
  freshLiteral,
  fieldOf,
  formatType,
  isAssignable,
  isExact,
  isProvenAssignable,
  isNullable,
  nonNull,
  overlaps,
  sameType,
  t,
  TypeBudgetExceeded,
  unionMembers,
  unionOf,
  widen,
  widenFresh,
  withFields,
  withTypeBudget,
  type MapType,
  type Type,
} from '../types.js'

/** What the checker needs to know about an environment. */
export interface CheckEnv {
  /** Declared context variables; undefined when none are declared. */
  readonly variables: Readonly<Record<string, Type>> | undefined
  /** Unknown variables are errors (otherwise they have type `any`). */
  readonly strict: boolean
  lookup: (name: string) => FunctionDef | undefined
  functionNames: () => Iterable<string>
}

/** How the compiler should invoke a call. */
export interface CallPlan {
  readonly def: FunctionDef
  /** Candidate overload indices, in declaration order. */
  readonly candidates: readonly number[]
  /** True when the single candidate is proven by static types: no runtime dispatch. */
  readonly direct: boolean
  /** Some lambda argument's body calls an async host function. */
  readonly asyncLambda: boolean
  /**
   * An argument was accepted gradually: an open object that may hold an
   * optional key of the parameter with another type. Checked at run time.
   */
  readonly gradual?: boolean
}

export interface Analysis {
  /** The tree with implicit lambdas made explicit. */
  readonly root: Node
  readonly type: Type
  readonly diagnostics: readonly Diagnostic[]
  readonly calls: ReadonlyMap<CallNode, CallPlan>
  readonly types: ReadonlyMap<Node, Type>
  /** Whether evaluation may call an async host function. */
  readonly async: boolean
  /**
   * The checker could not prove the result matches the expected type (part of
   * it is `any`, or an open object may hold an unlisted key): check the result
   * at run time.
   */
  readonly checkResult: boolean
  readonly references: {
    readonly variables: readonly string[]
    readonly functions: readonly string[]
  }
  /** The scope at the probe variable, when one was requested and reached. */
  readonly probeScope?: ProbeScope | undefined
}

export interface CheckOptions {
  readonly expected?: Type | undefined
  /** Tooling: a variable name whose lexical scope should be recorded. */
  readonly probe?: string | undefined
}

/** The lexical scope at a probed position (for completions). */
export interface ProbeScope {
  readonly locals: ReadonlyMap<string, Type>
  readonly it: Type | undefined
}

/**
 * Paths (see pathKey) known to be non-null, as a chain of frames so entering a
 * condition adds only its own facts (a long `&&` chain stays linear).
 */
interface Facts {
  readonly keys: ReadonlySet<string>
  readonly parent: Facts | undefined
  /** Facts about `.` from enclosing frames do not reach a new implicit lambda. */
  readonly hidesIt: boolean
}

function hasFact(facts: Facts | undefined, key: string): boolean {
  const aboutIt = key === 'it' || key.startsWith('it.') || key.startsWith('it[')
  for (let frame = facts; frame !== undefined; frame = frame.parent) {
    if (frame.keys.has(key)) return true
    if (frame.hidesIt && aboutIt) return false
  }
  return false
}

interface Scope {
  readonly locals: ReadonlyMap<string, Type>
  /** Type of the implicit parameter `.` in the innermost implicit lambda. */
  readonly it: Type | undefined
  /** Paths known to be non-null here, from enclosing conditions. */
  readonly nonNull?: Facts | undefined
}

/**
 * Type work allowed per analysis: generous for the largest sources the parse
 * limits admit, small enough that a pathological one fails fast.
 */
const CHECK_BUDGET = 500_000

function containsIt(node: Node): boolean {
  if (node.type === 'It') return true
  let found = false
  forEachChild(node, (child) => {
    if (!found && containsIt(child)) found = true
  })
  return found
}

/** Whether a type explicitly admits null (unlike `any`, which admits everything). */
function mayBeNull(type: Type): boolean {
  return type.kind === 'null' || (type.kind === 'union' && type.types.some(mayBeNull))
}

/** The node whose value is the result (the body of lets, the last expression). */
function resultSpan(node: Node): Node {
  return node.type === 'Let' ? resultSpan(node.body) : node
}

/** Why `actual` does not satisfy `expected`, naming missing and unexpected fields. */
function expectationProblem(actual: Type, expected: Type): string | undefined {
  if (expected.kind === 'map' && actual.kind === 'map') {
    const missing = Object.keys(expected.fields).filter(
      (key) =>
        !Object.hasOwn(actual.fields, key) &&
        actual.rest === undefined &&
        !isNullable(expected.fields[key]),
    )
    const extra =
      expected.rest === undefined
        ? Object.keys(actual.fields).filter((key) => !Object.hasOwn(expected.fields, key))
        : []
    const wrong = Object.keys(expected.fields).filter((key) => {
      const field = fieldOf(actual, key)
      return field !== undefined && !isAssignable(field, expected.fields[key])
    })
    const rest = expected.rest
    const wrongRest =
      rest === undefined
        ? []
        : Object.keys(actual.fields).filter(
            (key) =>
              !Object.hasOwn(expected.fields, key) && !isAssignable(actual.fields[key], rest),
          )
    const parts: string[] = []
    if (missing.length > 0) parts.push(`missing ${missing.map((k) => `"${k}"`).join(', ')}`)
    if (extra.length > 0)
      parts.push(
        `unexpected ${extra.map((k) => `"${k}"`).join(', ')}${suggestAll(extra, Object.keys(expected.fields))}`,
      )
    for (const key of wrong) {
      parts.push(
        `"${key}" should be ${formatType(expected.fields[key])} but is ${formatType(fieldOf(actual, key) as Type)}`,
      )
    }
    for (const key of wrongRest) {
      parts.push(
        `"${key}" should be ${formatType(rest as Type)} but is ${formatType(actual.fields[key])}`,
      )
    }
    if (parts.length > 0)
      return `The result does not match ${formatType(expected)}: ${parts.join('; ')}`
    if (isAssignable(actual, expected)) return undefined
  }
  if (isAssignable(actual, expected)) return undefined
  return `Expected the expression to produce ${formatType(expected)} but it produces ${formatType(actual)}`
}

function suggestAll(names: readonly string[], candidates: readonly string[]): string {
  const hints = names.map((name) => suggest(name, candidates)).filter((hint) => hint !== '')
  return hints.length > 0 ? hints.join('') : ''
}

const pathKeys = new WeakMap<Node, string | null>()

/**
 * A stable key for a readable path, or undefined. `m.a` and `m["a"]` share a
 * key: segments are `."name"` (JSON-quoted, so no two paths collide) or `[n]`.
 */
function pathKey(node: Node): string | undefined {
  const cached = pathKeys.get(node)
  if (cached !== undefined) return cached ?? undefined
  const key = computePathKey(node)
  pathKeys.set(node, key ?? null)
  return key
}

function computePathKey(node: Node): string | undefined {
  switch (node.type) {
    case 'Variable':
      return `v:${node.name}`
    case 'Local':
      return `l:${node.name}`
    case 'It':
      return 'it'
    case 'Member': {
      const base = pathKey(node.object)
      return base === undefined ? undefined : `${base}.${JSON.stringify(node.name)}`
    }
    case 'Index': {
      const base = pathKey(node.object)
      if (base === undefined || node.index.type !== 'Literal') return undefined
      const { value } = node.index
      if (typeof value === 'string') return `${base}.${JSON.stringify(value)}`
      return typeof value === 'number' ? `${base}[${value}]` : undefined
    }
    case 'Binary':
    case 'Call':
    case 'Conditional':
    case 'Has':
    case 'Lambda':
    case 'Let':
    case 'List':
    case 'Literal':
    case 'Map':
    case 'Template':
    case 'Try':
    case 'Unary':
    default:
      return undefined
  }
}

const factMemo = [
  new WeakMap<Node, ReadonlySet<string>>(),
  new WeakMap<Node, ReadonlySet<string>>(),
]

/** Paths that are non-null whenever `condition` evaluates to `positive`. */
function nonNullFacts(condition: Node, positive: boolean): ReadonlySet<string> {
  const memo = factMemo[positive ? 1 : 0]
  let facts = memo.get(condition)
  if (facts === undefined) {
    facts = computeFacts(condition, positive)
    memo.set(condition, facts)
  }
  return facts
}

function computeFacts(condition: Node, positive: boolean): ReadonlySet<string> {
  const out = new Set<string>()
  switch (condition.type) {
    case 'Unary':
      return condition.operator === '!' ? nonNullFacts(condition.operand, !positive) : out
    case 'Binary': {
      const { operator, left, right } = condition
      if (operator === '&&' || operator === '||') {
        const a = nonNullFacts(left, positive)
        const b = nonNullFacts(right, positive)
        // a && b true (or a || b false): both hold. Otherwise only common facts.
        if ((operator === '&&') === positive) {
          if (a.size === 0) return b
          if (b.size === 0) return a
          return new Set([...a, ...b])
        }
        return new Set([...a].filter((key) => b.has(key)))
      }
      if (operator === '!=' || operator === '==') {
        const holds = (operator === '!=') === positive
        if (!holds) return out
        let subject: Node | undefined
        if (right.type === 'Literal' && right.value === null) subject = left
        else if (left.type === 'Literal' && left.value === null) subject = right
        const key = subject === undefined ? undefined : pathKey(subject)
        if (key !== undefined) out.add(key)
        return out
      }
      if (positive && ['<', '<=', '>', '>='].includes(operator)) {
        // An ordering comparison is only true when both sides are non-null.
        for (const side of [left, right]) {
          const key = pathKey(side)
          if (key !== undefined) out.add(key)
        }
      }
      return out
    }
    case 'Has': {
      // has(a.b.c) is true only when a.b is a map (so a and a.b are not null);
      // the value at a.b.c itself may be null.
      if (!positive) return out
      for (let node: Node = condition.target.object; ;) {
        const key = pathKey(node)
        if (key !== undefined) out.add(key)
        if (node.type !== 'Member' && node.type !== 'Index') break
        node = node.object
      }
      return out
    }
    case 'Call':
    case 'Conditional':
    case 'Index':
    case 'It':
    case 'Lambda':
    case 'Let':
    case 'List':
    case 'Literal':
    case 'Local':
    case 'Map':
    case 'Member':
    case 'Template':
    case 'Try':
    case 'Variable':
    default: {
      // A path used as a condition is non-null when it is true.
      const key = positive ? pathKey(condition) : undefined
      if (key !== undefined) out.add(key)
      return out
    }
  }
}

function withFacts(scope: Scope, facts: ReadonlySet<string>): Scope {
  if (facts.size === 0) return scope
  return { ...scope, nonNull: { keys: facts, parent: scope.nonNull, hidesIt: false } }
}

/** The field names of a path key suffix (`."a"."b"`), or undefined at an index. */
function pathSegments(suffix: string): string[] | undefined {
  const out: string[] = []
  const segment = /^\.(?<name>"(?:[^"\\]|\\.)*")/u
  let rest = suffix
  while (rest !== '') {
    const match = segment.exec(rest)
    if (match === null) return undefined
    out.push(JSON.parse(match.groups?.name ?? '""') as string)
    rest = rest.slice(match[0].length)
  }
  return out
}

/** Marks the value at `path` (segments after the root) as non-null inside `type`. */
function refinePath(type: Type, path: readonly string[]): Type {
  if (path.length === 0) return nonNull(type)
  if (type.kind === 'union') return unionOf(type.types.map((member) => refinePath(member, path)))
  if (type.kind !== 'map') return type
  const [head, ...rest] = path as [string, ...string[]]
  const field = fieldOf(type, head) ?? type.rest
  if (field === undefined) return type
  return withFields(type, { ...type.fields, [head]: refinePath(field, rest) })
}

const ANY = t.any()
const NUMBER = t.number()
const STRING = t.string()
const BOOLEAN = t.boolean()
const NULL = t.null()
const OPTIONAL_BOOLEAN = t.optional(BOOLEAN)
const NUMBER_OR_DURATION = t.union(NUMBER, t.duration())
/** Re-checks of a lambda whose parameter types depend on its own result. */
const MAX_LAMBDA_ROUNDS = 4

/** The element type of a list, or of a union of lists; undefined for anything else. */
function elementOf(type: Type | undefined): Type | undefined {
  if (type === undefined) return undefined
  if (type.kind === 'any' || type.kind === 'var') return ANY
  if (type.kind === 'list') return type.element
  if (type.kind !== 'union') return undefined
  const elements: Type[] = []
  for (const member of type.types) {
    const element = elementOf(member)
    if (element === undefined) return undefined
    elements.push(element)
  }
  return unionOf(elements)
}

/**
 * A map type, or a union of map types merged into one: keys every member has
 * keep their (joined) types, keys only some members have move to `rest`.
 */
function mapOf(type: Type): MapType | undefined {
  if (type.kind === 'map') return type
  if (type.kind !== 'union') return undefined
  const members = unionMembers(type)
  if (!members.every((m): m is MapType => m.kind === 'map')) return undefined
  const fields: Record<string, Type> = {}
  const partial: Type[] = []
  const keys = new Set(members.flatMap((m) => Object.keys(m.fields)))
  for (const key of keys) {
    const found = members.map((m) => fieldOf(m, key) ?? m.rest)
    const present = found.filter((f): f is Type => f !== undefined)
    if (present.length === members.length) fields[key] = unionOf(present)
    else partial.push(...present)
  }
  for (const m of members) if (m.rest !== undefined) partial.push(m.rest)
  if (partial.length > 0) {
    // A declared object may hold any other key, with any value.
    if (members.some((m) => m.rest === undefined && !isExact(m))) partial.push(ANY)
    return { kind: 'map', fields, rest: unionOf(partial) }
  }
  return members.every(isExact) ? exactObject(fields) : t.object(fields)
}

/**
 * Checks a parsed expression. Checking time is bounded: a source that would
 * need too much type work fails with a TOO_MANY_NODES limit error.
 */
export function analyze(root: Node, env: CheckEnv, options: CheckOptions = {}): Analysis {
  try {
    return withTypeBudget(CHECK_BUDGET, () => analyzeWithin(root, env, options))
  } catch (error) {
    if (!(error instanceof TypeBudgetExceeded)) throw error
    throw new BonsaiLimitError('TOO_COMPLEX', 'Expression is too complex to check', {
      span: { start: root.start, end: root.end },
    })
  }
}

function analyzeWithin(root: Node, env: CheckEnv, options: CheckOptions): Analysis {
  const diagnostics: Diagnostic[] = []
  const calls = new Map<CallNode, CallPlan>()
  const types = new Map<Node, Type>()
  const asyncNodes = new Set<Node>()
  const variables = new Set<string>()
  const functions = new Set<string>()
  let probeScope: ProbeScope | undefined

  const reported = new Set<string>()
  const report = (
    code: DiagnosticCode,
    message: string,
    at: { start: number; end: number },
    severity: 'error' | 'warning' = 'error',
  ): void => {
    const key = `${at.start}:${at.end}:${code}:${message}`
    if (reported.has(key)) return
    reported.add(key)
    diagnostics.push({ code, message, severity, start: at.start, end: at.end })
  }
  /** Drops diagnostics after `mark` (a re-check or a speculative check). */
  const truncate = (mark: number): void => {
    for (let i = mark; i < diagnostics.length; i++) {
      const d = diagnostics[i]
      reported.delete(`${d.start}:${d.end}:${d.code}:${d.message}`)
    }
    diagnostics.length = mark
  }

  /**
   * The last result of each call that takes a lambda, by the types of the
   * outer locals it reads. Re-checking an outer lambda (reduce's accumulator)
   * then reuses inner calls that do not depend on what changed, instead of
   * redoing their own re-checks (which would multiply with nesting depth).
   * One entry per node keeps `types` and `calls` consistent: only computing
   * this node writes the entries for its subtree.
   */
  const callMemo = new WeakMap<
    CallNode,
    { inputs: readonly Type[]; type: Type; diagnostics: readonly Diagnostic[] }
  >()

  // === pass 1: bind the implicit parameter ===

  // Binding only rewrites the tree around `.`; most expressions have none.
  const bound = containsIt(root) ? bind(root) : { node: root, free: false }
  if (bound.free) {
    const it = findIt(bound.node)
    report(
      'INVALID_LAMBDA',
      '"." (the current item) must be inside an argument of a function that takes a lambda, e.g. items.filter(.active)',
      it ?? bound.node,
    )
  }

  function bind(node: Node): { node: Node; free: boolean } {
    switch (node.type) {
      case 'It':
        return { node, free: true }
      case 'Literal':
      case 'Variable':
      case 'Local':
        return { node, free: false }
      case 'Lambda': {
        // A lambda outside a call argument position (the parser only allows
        // arguments, so this is a lambda in a non-function parameter).
        const body = bind(node.body)
        return { node: { ...node, body: body.node }, free: false }
      }
      case 'Call':
        return bindCall(node)
      case 'Template': {
        let free = false
        const parts = node.parts.map((part) => {
          if (typeof part === 'string') return part
          const r = bind(part)
          free ||= r.free
          return r.node
        })
        return { node: { ...node, parts }, free }
      }
      case 'Member': {
        const object = bind(node.object)
        return { node: { ...node, object: object.node }, free: object.free }
      }
      case 'Index': {
        const object = bind(node.object)
        const index = bind(node.index)
        return {
          node: { ...node, object: object.node, index: index.node },
          free: object.free || index.free,
        }
      }
      case 'Unary': {
        const operand = bind(node.operand)
        return { node: { ...node, operand: operand.node }, free: operand.free }
      }
      case 'Binary': {
        const left = bind(node.left)
        const right = bind(node.right)
        return {
          node: { ...node, left: left.node, right: right.node },
          free: left.free || right.free,
        }
      }
      case 'Conditional': {
        const test = bind(node.test)
        const then = bind(node.then)
        const otherwise = bind(node.otherwise)
        return {
          node: { ...node, test: test.node, then: then.node, otherwise: otherwise.node },
          free: test.free || then.free || otherwise.free,
        }
      }
      case 'List': {
        let free = false
        const items = node.items.map((item) => {
          const r = bindSpreadable(item)
          free ||= r.free
          return r.node
        })
        return { node: { ...node, items }, free }
      }
      case 'Map': {
        let free = false
        const entries = node.entries.map((entry): MapEntry | SpreadNode => {
          if (entry.type === 'Spread') {
            const r = bindSpreadable(entry)
            free ||= r.free
            return r.node as SpreadNode
          }
          const value = bind(entry.value)
          free ||= value.free
          if (typeof entry.key === 'string') return { ...entry, value: value.node }
          const key = bind(entry.key)
          free ||= key.free
          return { ...entry, key: key.node, value: value.node }
        })
        return { node: { ...node, entries }, free }
      }
      case 'Let': {
        const value = bind(node.value)
        const body = bind(node.body)
        return {
          node: { ...node, value: value.node, body: body.node },
          free: value.free || body.free,
        }
      }
      case 'Has': {
        const target = bind(node.target)
        return { node: { ...node, target: target.node as typeof node.target }, free: target.free }
      }
      case 'Try': {
        const body = bind(node.body)
        const fallback = bind(node.fallback)
        return {
          node: { ...node, body: body.node, fallback: fallback.node },
          free: body.free || fallback.free,
        }
      }
    }
    throw new Error('unreachable')
  }

  function bindSpreadable(item: Node | SpreadNode): { node: Node | SpreadNode; free: boolean } {
    if (item.type === 'Spread') {
      const r = bind(item.argument)
      return { node: { ...item, argument: r.node }, free: r.free }
    }
    return bind(item)
  }

  function bindCall(node: CallNode): { node: Node; free: boolean } {
    const def = env.lookup(node.name)
    let free = false
    let sawSpread = false
    const args = node.args.map((arg, index): Node | SpreadNode => {
      if (arg.type === 'Spread') {
        sawSpread = true
        const r = bindSpreadable(arg)
        free ||= r.free
        return r.node
      }
      // An unknown function reports itself; treat its arguments as lambdas so a
      // misspelled filter(.x) does not also report a stray `.`.
      const lambdaPosition = !sawSpread && (def === undefined || isLambdaPosition(def, index))
      if (arg.type === 'Lambda') {
        const body = bind(arg.body)
        if (body.free) {
          report(
            'INVALID_LAMBDA',
            'Use the lambda parameter instead of "." inside an explicit lambda',
            findIt(body.node) ?? arg,
          )
        }
        return { ...arg, body: body.node }
      }
      const r = bind(arg)
      if (lambdaPosition && r.free) {
        const lambda: LambdaNode = {
          type: 'Lambda',
          params: [],
          implicit: true,
          body: r.node,
          start: r.node.start,
          end: r.node.end,
        }
        return lambda
      }
      free ||= r.free
      return r.node
    })
    return { node: { ...node, args }, free }
  }

  // === pass 2: types ===

  const rootScope: Scope = { locals: new Map(), it: undefined }
  const raw = check(bound.node, rootScope, options.expected)
  // The expectation sees literal types (a plan enum accepts "pro"); the result shows base kinds.
  let checkResult = false
  if (options.expected !== undefined) {
    const problem = expectationProblem(raw, options.expected)
    if (problem !== undefined) report('EXPECTED_TYPE', problem, resultSpan(bound.node))
    checkResult = containsAny(raw) || !isProvenAssignable(raw, options.expected)
  }
  const type = widen(raw)

  /**
   * The type of `node`. `expected` is the type the context wants, so a literal
   * that fits it (`"pro"` for a plan enum) keeps its literal type in lists and maps.
   */
  function check(node: Node, scope: Scope, expected?: Type): Type {
    chargeTypeWork(1)
    let result = checkNode(node, scope, expected)
    if (scope.nonNull !== undefined) {
      const key = pathKey(node)
      if (key !== undefined && hasFact(scope.nonNull, key)) result = nonNull(result)
    }
    types.set(node, result)
    return result
  }

  function markAsync(node: Node, child: Node): void {
    if (asyncNodes.has(child)) asyncNodes.add(node)
  }

  /** The literal type when it satisfies the expected type, otherwise its base kind. */
  function fit(actual: Type, expected: Type | undefined): Type {
    return expected !== undefined &&
      expected.kind !== 'any' &&
      expected.kind !== 'var' &&
      isAssignable(actual, expected)
      ? actual
      : widen(actual)
  }

  function checkNode(node: Node, scope: Scope, expected: Type | undefined): Type {
    switch (node.type) {
      case 'Literal':
        return node.value === null ? NULL : freshLiteral(node.value)
      case 'Template':
        for (const part of node.parts) {
          if (typeof part === 'string') continue
          const partType = check(part, scope)
          markAsync(node, part)
          if (
            !isAssignable(
              partType,
              t.union(STRING, NUMBER, BOOLEAN, NULL, t.timestamp(), t.duration()),
            )
          ) {
            report('TYPE_ERROR', `Cannot render ${formatType(partType)} in a template`, part)
          }
        }
        return STRING
      case 'Variable': {
        if (node.name === options.probe) {
          probeScope = { locals: scope.locals, it: scope.it }
          return ANY
        }
        variables.add(node.name)
        const declared =
          env.variables !== undefined && Object.hasOwn(env.variables, node.name)
            ? env.variables[node.name]
            : undefined
        if (declared !== undefined) return declared
        if (env.strict) {
          report(
            'UNKNOWN_VARIABLE',
            `Unknown variable "${node.name}"${suggest(node.name, Object.keys(env.variables ?? {}))}`,
            node,
          )
        }
        return ANY
      }
      case 'Local':
        return scope.locals.get(node.name) ?? ANY
      case 'It':
        return scope.it ?? ANY
      case 'Member': {
        const objectType = check(node.object, scope)
        markAsync(node, node.object)
        return memberType(objectType, node.name, node)
      }
      case 'Index': {
        const objectType = check(node.object, scope)
        const indexType = check(node.index, scope)
        markAsync(node, node.object)
        markAsync(node, node.index)
        return indexedType(objectType, indexType, node)
      }
      case 'Call':
        return checkCall(node, scope)
      case 'Unary': {
        const operand = check(node.operand, scope)
        markAsync(node, node.operand)
        if (node.operator === '!') {
          expectLogic(operand, node.operand, '!')
          return BOOLEAN
        }
        // Negation takes numbers and durations; an unknown operand may be either.
        if (operand.kind === 'any' || operand.kind === 'var') return NUMBER_OR_DURATION
        if (operand.kind === 'never') return operand
        if (isAssignable(operand, NUMBER)) return NUMBER
        if (isAssignable(operand, t.duration())) return t.duration()
        if (isAssignable(operand, NUMBER_OR_DURATION)) return widen(operand)
        report('TYPE_ERROR', `Cannot negate ${formatType(operand)}`, node)
        return ANY
      }
      case 'Binary':
        return checkBinary(node, scope, expected)
      case 'Conditional': {
        const test = check(node.test, scope)
        expectLogic(test, node.test, 'A condition')
        const a = check(node.then, withFacts(scope, nonNullFacts(node.test, true)), expected)
        const b = check(node.otherwise, withFacts(scope, nonNullFacts(node.test, false)), expected)
        markAsync(node, node.test)
        markAsync(node, node.then)
        markAsync(node, node.otherwise)
        return unionOf([a, b])
      }
      case 'List': {
        const expectedItem = elementOf(expected)
        const elements: Type[] = []
        for (const item of node.items) {
          if (item.type === 'Spread') {
            const spread = check(item.argument, scope)
            markAsync(node, item.argument)
            const element = elementOf(nonNull(spread))
            if (element !== undefined) elements.push(element)
            else if (nonNull(spread).kind !== 'never')
              report(
                'TYPE_ERROR',
                `Only a list can be spread into a list, not ${formatType(spread)}`,
                item,
              )
          } else {
            elements.push(fit(check(item, scope, expectedItem), expectedItem))
            markAsync(node, item)
          }
        }
        return t.list(elements.length === 0 ? t.never() : unionOf(elements))
      }
      case 'Map': {
        const expectedMap = expected === undefined ? undefined : mapOf(nonNull(expected))
        const fields: Record<string, Type> = {}
        let rest: Type | undefined
        // A literal holds exactly its keys, unless a spread may add unknown ones.
        let exact = true
        for (const entry of node.entries) {
          if (entry.type === 'Spread') {
            const spread = check(entry.argument, scope)
            markAsync(node, entry.argument)
            const mapped = mapOf(nonNull(spread))
            if (mapped !== undefined) {
              // A spread may overwrite any earlier field it does not declare,
              // unless it is exact (a literal) and lists every key it has.
              const spreadExact = isExact(mapped)
              if (!spreadExact || mapped.rest !== undefined) {
                const keys = Object.keys(fields)
                chargeTypeWork(keys.length)
                for (const key of keys) {
                  if (!Object.hasOwn(mapped.fields, key)) {
                    if (mapped.rest !== undefined) fields[key] = unionOf([fields[key], mapped.rest])
                    else fields[key] = ANY
                  }
                }
              }
              chargeTypeWork(Object.keys(mapped.fields).length)
              if (mayBeNull(spread)) {
                // A null spread adds nothing: its keys may be absent.
                for (const [key, field] of Object.entries(mapped.fields)) {
                  fields[key] = Object.hasOwn(fields, key)
                    ? unionOf([fields[key], field])
                    : t.optional(field)
                }
              } else Object.assign(fields, mapped.fields)
              if (mapped.rest !== undefined)
                rest = rest === undefined ? mapped.rest : unionOf([rest, mapped.rest])
              else if (!spreadExact) exact = false
            } else if (nonNull(spread).kind === 'any') rest = ANY
            else if (nonNull(spread).kind === 'never') continue
            else
              report(
                'TYPE_ERROR',
                `Only a map can be spread into a map, not ${formatType(spread)}`,
                entry,
              )
            continue
          }
          const expectedField =
            expectedMap === undefined || typeof entry.key !== 'string'
              ? undefined
              : (fieldOf(expectedMap, entry.key) ?? expectedMap.rest)
          const valueType = fit(check(entry.value, scope, expectedField), expectedField)
          markAsync(node, entry.value)
          if (typeof entry.key === 'string') fields[entry.key] = valueType
          else {
            const keyType = check(entry.key, scope)
            markAsync(node, entry.key)
            if (!isAssignable(keyType, t.union(STRING, NUMBER))) {
              report(
                'TYPE_ERROR',
                `A map key must be a string, not ${formatType(keyType)}`,
                entry.key,
              )
            }
            rest = rest === undefined ? valueType : unionOf([rest, valueType])
          }
        }
        if (rest !== undefined) return { kind: 'map', fields, rest }
        return exact ? exactObject(fields) : t.object(fields)
      }
      case 'Lambda':
        report('INVALID_LAMBDA', 'A lambda can only be passed to a function that takes one', node)
        return ANY
      case 'Let': {
        const valueType = check(node.value, scope)
        markAsync(node, node.value)
        chargeTypeWork(scope.locals.size)
        const locals = new Map(scope.locals)
        locals.set(node.name, valueType)
        const bodyType = check(node.body, { ...scope, locals }, expected)
        markAsync(node, node.body)
        return bodyType
      }
      case 'Has': {
        // has() may probe a key a declared object does not list: it can still exist.
        const target = node.target
        if (target.type === 'Member') {
          const objectType = check(target.object, scope)
          markAsync(node, target.object)
          types.set(target, memberType(objectType, target.name, target, true))
        } else check(target, scope)
        markAsync(node, node.target)
        return BOOLEAN
      }
      case 'Try': {
        const a = check(node.body, scope, expected)
        const b = check(node.fallback, scope, expected)
        markAsync(node, node.body)
        markAsync(node, node.fallback)
        return unionOf([a, b])
      }
    }
    throw new Error('unreachable')
  }

  function expectLogic(actual: Type, at: Node, what: string): void {
    if (!isAssignable(actual, OPTIONAL_BOOLEAN)) {
      report('TYPE_ERROR', `${what} expects a boolean but got ${formatType(actual)}`, at)
    }
  }

  /**
   * The type of `object.name`. A key a declared object does not list may still
   * exist with any value (declared objects are open); `quiet` (for has()) and
   * unions where another member has the key read it as unknown instead of failing.
   */
  function memberType(objectType: Type, name: string, at: Node, quiet = false): Type {
    if (objectType.kind === 'any' || objectType.kind === 'var') return ANY
    if (objectType.kind === 'never') return t.never()
    if (objectType.kind === 'null') return NULL
    if (objectType.kind === 'union') {
      // Another member has the key (null has none: a?.x on a missing key still fails).
      const somewhere = objectType.types.some(
        (member) =>
          member.kind !== 'null' &&
          member.kind !== 'never' &&
          (member.kind !== 'map' ||
            fieldOf(member, name) !== undefined ||
            member.rest !== undefined),
      )
      return unionOf(
        objectType.types.map((member) => memberType(member, name, at, quiet || somewhere)),
      )
    }
    if (objectType.kind === 'map') {
      const field = fieldOf(objectType, name)
      if (field !== undefined) return field
      if (objectType.rest !== undefined) return t.optional(objectType.rest)
      // A map literal holds no other keys; a declared object may.
      if (quiet) return isExact(objectType) ? NULL : ANY
      report(
        'UNKNOWN_PROPERTY',
        `Property "${name}" does not exist on ${formatType(objectType)}${suggest(name, Object.keys(objectType.fields))}`,
        at,
      )
      return ANY
    }
    if (
      (objectType.kind === 'list' ||
        objectType.kind === 'string' ||
        (objectType.kind === 'literal' && typeof objectType.value === 'string')) &&
      name === 'length'
    ) {
      return NUMBER
    }
    const fn = env.lookup(name)
    report(
      'TYPE_ERROR',
      `Cannot read property "${name}" of ${formatType(objectType)}${fn === undefined ? '' : `; did you mean to call ${name}()?`}`,
      at,
    )
    return ANY
  }

  function indexedType(objectType: Type, indexType: Type, at: Node): Type {
    if (objectType.kind === 'any' || objectType.kind === 'var') return ANY
    if (objectType.kind === 'never') return t.never()
    if (objectType.kind === 'null') return NULL
    if (objectType.kind === 'union') {
      // A literal key reads like a member: m["b"] on a union is m.b.
      if (indexType.kind === 'literal' && typeof indexType.value === 'string')
        return memberType(objectType, indexType.value, at)
      return unionOf(objectType.types.map((member) => indexedType(member, indexType, at)))
    }
    if (
      objectType.kind === 'list' ||
      objectType.kind === 'string' ||
      (objectType.kind === 'literal' && typeof objectType.value === 'string')
    ) {
      if (!isAssignable(indexType, NUMBER))
        report('TYPE_ERROR', `An index must be a number, not ${formatType(indexType)}`, at)
      return t.optional(objectType.kind === 'list' ? objectType.element : STRING)
    }
    if (objectType.kind === 'map') {
      if (!isAssignable(indexType, t.union(STRING, NUMBER))) {
        report('TYPE_ERROR', `A map key must be a string, not ${formatType(indexType)}`, at)
        return ANY
      }
      if (indexType.kind === 'literal') return memberType(objectType, String(indexType.value), at)
      // Any key may exist on a declared object, with any value.
      if (objectType.rest === undefined && !isExact(objectType)) return ANY
      const members = Object.values(objectType.fields)
      if (objectType.rest !== undefined) members.push(objectType.rest)
      return t.optional(unionOf(members))
    }
    report('TYPE_ERROR', `Cannot index ${formatType(objectType)}`, at)
    return ANY
  }

  function checkBinary(
    node: Extract<Node, { type: 'Binary' }>,
    scope: Scope,
    expected: Type | undefined,
  ): Type {
    const nullish = node.operator === '??'
    // Joining lists: an expected list type (or the other operand's) is the
    // context for list literals, so plans + ["free"] stays a list of plans.
    const listContext =
      node.operator === '+' && expected !== undefined && elementOf(nonNull(expected)) !== undefined
        ? expected
        : undefined
    let leftExpected = listContext
    if (nullish && expected !== undefined) leftExpected = t.optional(expected)
    const left = check(node.left, scope, leftExpected)
    let rightScope = scope
    if (node.operator === '&&') rightScope = withFacts(scope, nonNullFacts(node.left, true))
    else if (node.operator === '||') rightScope = withFacts(scope, nonNullFacts(node.left, false))
    let rightExpected: Type | undefined = nullish ? expected : undefined
    if (node.operator === '+')
      rightExpected = listContext ?? (left.kind === 'list' ? left : undefined)
    const right = check(node.right, rightScope, rightExpected)
    markAsync(node, node.left)
    markAsync(node, node.right)
    const op = node.operator
    switch (op) {
      case '&&':
      case '||':
        expectLogic(left, node.left, `"${op}"`)
        expectLogic(right, node.right, `"${op}"`)
        return BOOLEAN
      case '??':
        if (!isNullable(left))
          report('NEVER_NULL', 'The left side of "??" is never null', node.left, 'warning')
        return unionOf([nonNull(left), right])
      case '==':
      case '!=':
        if (!overlaps(left, right)) {
          report(
            'ALWAYS_FALSE',
            `This comparison is always ${op === '==' ? 'false' : 'true'}: ${formatType(left)} and ${formatType(right)} have no values in common`,
            node,
            'warning',
          )
        }
        return BOOLEAN
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const a = widen(nonNull(left))
        const b = widen(nonNull(right))
        for (const [side, sideType] of [
          [node.left, left],
          [node.right, right],
        ] as const) {
          if (mayBeNull(sideType) && sideType.kind !== 'null') {
            report(
              'MAYBE_NULL',
              'This value may be null, and a comparison with null is false; check it first (x != null && ...) or use ??',
              side,
              'warning',
            )
          }
        }
        const comparable = ['number', 'string', 'timestamp', 'duration']
        const ok = (x: Type): boolean =>
          x.kind === 'any' || x.kind === 'var' || x.kind === 'never' || comparable.includes(x.kind)
        if (
          !ok(a) ||
          !ok(b) ||
          (a.kind !== b.kind &&
            a.kind !== 'any' &&
            b.kind !== 'any' &&
            a.kind !== 'never' &&
            b.kind !== 'never')
        ) {
          report('TYPE_ERROR', `Cannot compare ${formatType(left)} with ${formatType(right)}`, node)
        }
        return BOOLEAN
      }
      case 'in':
      case 'not in': {
        // A list literal's items keep their literal types: `plan in ["gold"]` can be always false.
        const literalItems =
          node.right.type === 'List' && node.right.items.every((item) => item.type !== 'Spread')
            ? node.right.items.map((item) => types.get(item) ?? ANY)
            : undefined
        const containers =
          literalItems === undefined
            ? nonNull(right)
            : t.list(literalItems.length === 0 ? t.never() : unionOf(literalItems))
        for (const container of containers.kind === 'union' ? containers.types : [containers]) {
          checkMembership(container, left, right, node)
        }
        return BOOLEAN
      }
      case '%':
      case '*':
      case '**':
      case '+':
      case '-':
      case '/':
      default:
        return arithmetic(op, left, right, node)
    }
  }

  function checkMembership(
    container: Type,
    left: Type,
    right: Type,
    node: Extract<Node, { type: 'Binary' }>,
  ): void {
    if (
      container.kind === 'string' ||
      (container.kind === 'literal' && typeof container.value === 'string')
    ) {
      if (!isAssignable(left, STRING))
        report(
          'TYPE_ERROR',
          `"in" on text needs text on the left, not ${formatType(left)}`,
          node.left,
        )
    } else if (container.kind === 'map') {
      if (!isAssignable(left, t.union(STRING, NUMBER)))
        report('TYPE_ERROR', `"in" on a map needs a string key, not ${formatType(left)}`, node.left)
    } else if (container.kind === 'list') {
      if (!overlaps(left, container.element) && container.element.kind !== 'never') {
        report(
          'ALWAYS_FALSE',
          `${formatType(left)} can never be in ${formatType(container)}`,
          node,
          'warning',
        )
      }
    } else if (container.kind !== 'any' && container.kind !== 'never' && container.kind !== 'var') {
      report(
        'TYPE_ERROR',
        `"in" needs a list, text, or map on the right, not ${formatType(right)}`,
        node.right,
      )
    }
  }

  function arithmetic(op: string, left: Type, right: Type, node: Node): Type {
    const a = widen(left)
    const b = widen(right)
    // `never` (e.g. an item of []) has no values, so no operation on it can fail.
    if (a.kind === 'never' || b.kind === 'never') return t.never()
    if (a.kind === 'any' || b.kind === 'any' || a.kind === 'var' || b.kind === 'var') {
      if (op === '+' && (a.kind === 'string' || b.kind === 'string')) return STRING
      return op === '+' || op === '-' || op === '*' || op === '/' ? ANY : NUMBER
    }
    const kinds = `${a.kind} ${op} ${b.kind}`
    const table: Record<string, Type> = {
      'number + number': NUMBER,
      'string + string': STRING,
      'duration + duration': t.duration(),
      'timestamp + duration': t.timestamp(),
      'duration + timestamp': t.timestamp(),
      'number - number': NUMBER,
      'timestamp - timestamp': t.duration(),
      'timestamp - duration': t.timestamp(),
      'duration - duration': t.duration(),
      'number * number': NUMBER,
      'duration * number': t.duration(),
      'number * duration': t.duration(),
      'number / number': NUMBER,
      'duration / number': t.duration(),
      'duration / duration': NUMBER,
      'number % number': NUMBER,
      'number ** number': NUMBER,
    }
    const known = table[kinds]
    if (known !== undefined) return known
    if (op === '+') {
      // Lists (or unions of lists) concatenate.
      const x = a.kind === 'list' || a.kind === 'union' ? elementOf(a) : undefined
      const y = b.kind === 'list' || b.kind === 'union' ? elementOf(b) : undefined
      if (x !== undefined && y !== undefined) return t.list(unionOf([x, y]))
    }
    if (a.kind === 'union' || b.kind === 'union') {
      // Each combination of members must be valid; the result joins them.
      const results: Type[] = []
      for (const x of a.kind === 'union' ? a.types : [a]) {
        for (const y of b.kind === 'union' ? b.types : [b]) {
          const r = x.kind === 'null' || y.kind === 'null' ? undefined : arithmeticQuiet(op, x, y)
          if (r === undefined) {
            results.length = 0
            break
          }
          results.push(r)
        }
        if (results.length === 0) break
      }
      if (results.length > 0) return unionOf(results)
    }
    const nullable = isNullable(a) || isNullable(b)
    if (nullable) {
      const retry = arithmeticQuiet(op, nonNull(a), nonNull(b))
      if (retry !== undefined) {
        report('TYPE_ERROR', `An operand of "${op}" may be null; use ?? to supply a default`, node)
        return retry
      }
    }
    let hint = ''
    if (op === '+' && (a.kind === 'string' || b.kind === 'string'))
      hint = '; use a template to build text'
    else if (
      (a.kind === 'timestamp' || b.kind === 'timestamp') &&
      (a.kind === 'number' || b.kind === 'number')
    )
      hint = '; use a duration such as days(30)'
    report(
      'TYPE_ERROR',
      `Cannot apply "${op}" to ${formatType(left)} and ${formatType(right)}${hint}`,
      node,
    )
    return ANY
  }

  function arithmeticQuiet(op: string, a: Type, b: Type): Type | undefined {
    const saved = diagnostics.length
    const result = arithmetic(op, a, b, { type: 'Literal', value: null, start: 0, end: 0 })
    const failed = diagnostics.length > saved
    truncate(saved)
    return failed ? undefined : result
  }

  // === calls ===

  function checkCall(node: CallNode, scope: Scope): Type {
    if (!node.args.some((arg) => arg.type === 'Lambda')) return checkCallNow(node, scope)
    const free = freeLocals(node)
    const inputs = free.names.map((name) => scope.locals.get(name) ?? ANY)
    if (free.it) inputs.push(scope.it ?? ANY)
    const last = callMemo.get(node)
    if (
      last !== undefined &&
      last.inputs.length === inputs.length &&
      last.inputs.every((input, i) => sameType(input, inputs[i] ?? ANY))
    ) {
      for (const d of last.diagnostics) report(d.code, d.message, d, d.severity)
      return last.type
    }
    const mark = diagnostics.length
    const result = checkCallNow(node, scope)
    callMemo.set(node, { inputs, type: result, diagnostics: diagnostics.slice(mark) })
    return result
  }

  function checkCallNow(node: CallNode, scope: Scope): Type {
    functions.add(node.name)
    const receiver = node.args[0]
    // Math.max(...) and friends. In an open environment the context may really
    // hold a variable with that name, so the hint is a warning there.
    if (
      node.style === 'method' &&
      receiver?.type === 'Variable' &&
      Object.hasOwn(JS_GLOBALS, receiver.name) &&
      (env.variables === undefined || !Object.hasOwn(env.variables, receiver.name))
    ) {
      const open = !env.strict && env.variables === undefined
      report(
        'UNKNOWN_VARIABLE',
        `There is no ${receiver.name} object; ${JS_GLOBALS[receiver.name] ?? ''}`,
        receiver,
        open ? 'warning' : 'error',
      )
      if (!open) return ANY
    }
    const def = env.lookup(node.name)
    // With one signature, a parameter type is the context for its argument, so
    // setPlans(["pro"]) keeps the literal a plan enum needs.
    const only = def?.overloads.length === 1 ? def.overloads[0] : undefined
    const contextFor = (index: number): Type | undefined => {
      const param = only?.params[index] ?? only?.rest
      return param === undefined || param.kind === 'function' || hasVar(param) ? undefined : param
    }
    // Argument types, except lambdas (checked once parameter types are known).
    const argTypes: (Type | undefined)[] = node.args.map((arg, index) => {
      if (arg.type === 'Lambda') return undefined
      if (arg.type === 'Spread') {
        const spread = check(arg.argument, scope)
        markAsync(node, arg.argument)
        if (elementOf(nonNull(spread)) === undefined && nonNull(spread).kind !== 'never') {
          report(
            'TYPE_ERROR',
            `Only a list can be spread into arguments, not ${formatType(spread)}`,
            arg,
          )
        }
        return spread
      }
      const argType = check(arg, scope, contextFor(index))
      markAsync(node, arg)
      return argType
    })
    if (def === undefined) {
      const alias = Object.hasOwn(FUNCTION_ALIASES, node.name)
        ? FUNCTION_ALIASES[node.name]
        : undefined
      const hint = alias === undefined ? suggest(node.name, env.functionNames()) : `; ${alias}`
      report('UNKNOWN_FUNCTION', `Unknown function "${node.name}"${hint}`, {
        start: node.nameStart,
        end: node.nameEnd,
      })
      for (const arg of node.args) if (arg.type === 'Lambda') checkLambda(arg, [], scope)
      return ANY
    }
    if (def.async === true) asyncNodes.add(node)

    let receiverNull = false
    if (node.optional && argTypes[0] !== undefined) {
      receiverNull = isNullable(argTypes[0])
      argTypes[0] = nonNull(argTypes[0])
      if (argTypes[0].kind === 'never') {
        // The receiver is always null, so the call never runs.
        for (const arg of node.args) if (arg.type === 'Lambda') checkLambda(arg, [], scope)
        calls.set(node, {
          def,
          candidates: def.overloads.map((_, i) => i),
          direct: false,
          asyncLambda: false,
        })
        return NULL
      }
    }

    const hasSpread = node.args.some((arg) => arg.type === 'Spread')
    if (hasSpread && def.overloads.some((o) => o.params.some((p) => p.kind === 'function'))) {
      report(
        'INVALID_LAMBDA',
        `Spread arguments cannot be used with ${node.name}(), which takes a lambda`,
        node,
      )
    }
    const candidates: number[] = []
    const bindings: Map<string, Type>[] = []
    def.overloads.forEach((candidate, index) => {
      const b = new Map<string, Type>()
      if (matchOverload(candidate, node, argTypes, b, hasSpread)) {
        candidates.push(index)
        bindings.push(b)
      }
    })

    if (candidates.length === 0 && !node.args.some((arg) => arg.type === 'Lambda')) {
      // A union argument (number | duration) is fine when every member has an
      // overload: the call dispatches on the value at run time.
      const distributed = distribute(def, node, argTypes, hasSpread)
      if (distributed !== undefined) {
        calls.set(node, {
          def,
          candidates: distributed.candidates,
          direct: false,
          asyncLambda: false,
        })
        return receiverNull ? t.optional(distributed.result) : distributed.result
      }
    }

    if (candidates.length === 0) {
      reportNoOverload(node, def, argTypes, hasSpread)
      for (const arg of node.args) if (arg.type === 'Lambda') checkLambda(arg, [], scope)
      calls.set(node, {
        def,
        candidates: def.overloads.map((_, i) => i),
        direct: false,
        asyncLambda: false,
      })
      return ANY
    }

    // Check lambda bodies against the first candidate's parameter types.
    const first = def.overloads[candidates[0]]
    const firstBindings = bindings[0]
    let asyncLambda = false
    node.args.forEach((arg, index) => {
      if (arg.type !== 'Lambda') return
      const param = first.params[index]
      if (param?.kind !== 'function') {
        report(
          'INVALID_LAMBDA',
          `${node.name}() does not take a lambda as argument ${index + 1}`,
          arg,
        )
        checkLambda(arg, [], scope)
        return
      }
      let paramTypes = param.params.map((p) => substitute(p, firstBindings))
      const mark = diagnostics.length
      let bodyType = checkLambda(arg, paramTypes, scope)
      unify(param.result, bodyType, firstBindings)
      // A parameter that takes the lambda's own result (reduce's accumulator)
      // widens with it: re-check until the parameter types are stable.
      for (let round = 1; ; round++) {
        // An error stands: its recovery type (`any`) would make the next round
        // clean and hide it.
        if (diagnostics.slice(mark).some((d) => d.severity === 'error')) break
        let next = param.params.map((p) => substitute(p, firstBindings))
        const changed = changedAt(next, paramTypes)
        if (changed.length === 0) break
        const last = round >= MAX_LAMBDA_ROUNDS
        if (last) next = next.map((p, i) => (changed.includes(i) ? ANY : p))
        truncate(mark)
        paramTypes = next
        bodyType = checkLambda(arg, paramTypes, scope)
        unify(param.result, bodyType, firstBindings)
        if (last) {
          // Still growing: what the lambda returns (and so the call's result) is
          // unknown, and checked at run time where it matters.
          for (const name of varNames(param.result)) firstBindings.set(name, ANY)
          break
        }
      }
      if (asyncNodes.has(arg.body)) asyncLambda = true
      if (
        !hasVar(param.result) &&
        param.result.kind !== 'any' &&
        !isAssignable(bodyType, param.result)
      ) {
        const expected = substitute(param.result, firstBindings)
        const onlyNull = expected.kind === 'boolean' && isAssignable(bodyType, OPTIONAL_BOOLEAN)
        report(
          onlyNull ? 'MAYBE_NULL' : 'TYPE_ERROR',
          `The lambda for ${node.name}() must return ${formatType(expected)} but returns ${formatType(bodyType)}`,
          arg.body,
          onlyNull ? 'warning' : 'error',
        )
      }
    })
    if (asyncLambda) asyncNodes.add(node)
    if (first.literals !== undefined) {
      const values = node.args.map((arg) => (arg.type === 'Literal' ? arg.value : undefined))
      const problem = first.literals(values)
      if (problem !== undefined) report('INVALID_ARGUMENT', problem, node)
    }
    if (def.host !== true && (def.name === 'filter' || def.name === 'find')) {
      const lambda = node.args[1]
      const element = firstBindings.get('T')
      if (lambda?.type === 'Lambda' && element !== undefined) {
        let itemPath: string | undefined
        if (lambda.implicit) itemPath = 'it'
        else if (lambda.params[0] !== undefined) itemPath = `l:${lambda.params[0]}`
        let refined = element
        for (const key of nonNullFacts(lambda.body, true)) {
          if (itemPath === undefined || (key !== itemPath && !key.startsWith(`${itemPath}.`)))
            continue
          const path = pathSegments(key.slice(itemPath.length))
          if (path !== undefined) refined = refinePath(refined, path)
        }
        firstBindings.set('T', refined)
      }
    }
    for (const name of first.ordered ?? []) {
      const boundType = firstBindings.get(name)
      if (boundType !== undefined && !orderable(boundType)) {
        report(
          'TYPE_ERROR',
          `${node.name}() can only order numbers, text, timestamps, or durations (one kind at a time), not ${formatType(boundType)}`,
          node,
        )
      }
    }

    const results = candidates.map((index, i) => {
      const candidate = def.overloads[index]
      const refined =
        def.host === true || !Object.hasOwn(RESULT_REFINERS, def.name)
          ? undefined
          : refine(
              RESULT_REFINERS[def.name],
              argTypes.map((a) => a ?? ANY),
            )
      return refined ?? widenFresh(substitute(candidate.result, bindings[i]))
    })
    const gradual =
      candidates.length === 1 &&
      argTypes.some((argType, index) => {
        const param = first.params[index] ?? first.rest
        return (
          argType !== undefined &&
          param !== undefined &&
          !containsAny(argType) &&
          !isProvenAssignable(argType, param)
        )
      })
    const proven =
      candidates.length === 1 &&
      !hasSpread &&
      !gradual &&
      argTypes.every(
        (argType, index) =>
          argType === undefined || isProven(argType, first.params[index] ?? first.rest ?? ANY),
      )
    calls.set(node, {
      def,
      candidates,
      direct: proven,
      asyncLambda,
      ...(gradual ? { gradual } : {}),
    })
    // Several overloads can only match when argument types are unknown; the
    // result is then unknown too, unless every candidate agrees.
    const merged = unionOf(results)
    const known = argTypes.every((argType) => argType === undefined || !containsAny(argType))
    let result = merged
    if (candidates.length > 1 && merged.kind === 'union') result = known ? results[0] : ANY
    return receiverNull ? t.optional(result) : result
  }

  function checkLambda(node: LambdaNode, params: readonly Type[], scope: Scope): Type {
    let inner: Scope
    // Facts about an outer item do not apply to the new item.
    const outer: Facts | undefined =
      scope.nonNull === undefined
        ? undefined
        : { keys: new Set(), parent: scope.nonNull, hidesIt: true }
    if (node.implicit) {
      inner = { locals: scope.locals, it: params[0] ?? ANY, nonNull: outer }
    } else {
      chargeTypeWork(scope.locals.size)
      const locals = new Map(scope.locals)
      node.params.forEach((name, index) => {
        locals.set(name, params[index] ?? ANY)
      })
      inner = { locals, it: undefined, nonNull: outer }
    }
    const bodyType = check(node.body, inner)
    types.set(node, bodyType)
    return bodyType
  }

  function matchOverload(
    candidate: Overload,
    node: CallNode,
    argTypes: readonly (Type | undefined)[],
    b: Map<string, Type>,
    hasSpread: boolean,
  ): boolean {
    const count = node.args.length
    const required = candidate.required ?? candidate.params.length
    if (!hasSpread) {
      if (count < required) return false
      if (count > candidate.params.length && candidate.rest === undefined) return false
    }
    for (let i = 0; i < count; i++) {
      const arg = node.args[i]
      const param = candidate.params[i] ?? candidate.rest
      if (param === undefined) return hasSpread
      if (arg.type === 'Spread') {
        // Its items may fill this and every later position (how many is only
        // known at run time), so each must fit all of them.
        const element = elementOf(nonNull(argTypes[i] ?? ANY)) ?? ANY
        if (element.kind === 'never') continue
        const positions = [...candidate.params.slice(i), candidate.rest]
        for (const position of positions) {
          if (position !== undefined && !unify(position, element, b)) return false
        }
        continue
      }
      if (arg.type === 'Lambda') {
        if (param.kind !== 'function') return false
        continue
      }
      if (param.kind === 'function') return false
      let argType = argTypes[i] as Type
      if (!hasSpread && i >= required && i < candidate.params.length) {
        // A null optional argument is omitted: the default is used.
        argType = nonNull(argType)
        if (argType.kind === 'never') continue
      }
      if (!unify(param, argType, b)) return false
    }
    return true
  }

  /** Overloads per member of the first union argument; undefined unless every member has one. */
  function distribute(
    def: FunctionDef,
    node: CallNode,
    argTypes: readonly (Type | undefined)[],
    hasSpread: boolean,
  ): { candidates: number[]; result: Type } | undefined {
    const index = argTypes.findIndex(
      (argType, i) =>
        argType !== undefined &&
        node.args[i]?.type !== 'Spread' &&
        !mayBeNull(argType) &&
        widen(argType).kind === 'union',
    )
    if (index < 0) return undefined
    const members = (widen(argTypes[index] as Type) as Extract<Type, { kind: 'union' }>).types
    const chosen = new Set<number>()
    const results: Type[] = []
    for (const member of members) {
      const args = argTypes.map((argType, i) => (i === index ? member : argType))
      let matched = false
      def.overloads.forEach((candidate, i) => {
        const b = new Map<string, Type>()
        if (
          matchOverload(candidate, node, args, b, hasSpread) &&
          (candidate.ordered ?? []).every((name) => orderable(b.get(name) ?? ANY))
        ) {
          matched = true
          chosen.add(i)
          results.push(widenFresh(substitute(candidate.result, b)))
        }
      })
      if (!matched) return undefined
    }
    return { candidates: [...chosen].sort((a, b) => a - b), result: unionOf(results) }
  }

  function reportNoOverload(
    node: CallNode,
    def: FunctionDef,
    argTypes: readonly (Type | undefined)[],
    hasSpread: boolean,
  ): void {
    // Would the call type-check if nullable arguments were non-null?
    const relaxed = argTypes.map((a) => (a === undefined ? a : nonNull(a)))
    const nullableFix = def.overloads.some((candidate) =>
      matchOverload(candidate, node, relaxed, new Map(), hasSpread),
    )
    if (nullableFix) {
      // `any` could be anything, not specifically null: blame an argument that may be null.
      const receiverIsNullable =
        node.style === 'method' && argTypes[0] !== undefined && mayBeNull(argTypes[0])
      const nullableIndex = argTypes.findIndex(
        (argType) => argType !== undefined && mayBeNull(argType),
      )
      const culprit = node.args[receiverIsNullable ? 0 : Math.max(nullableIndex, 0)]
      report(
        'NULLABLE_RECEIVER',
        receiverIsNullable
          ? `The value before .${node.name}() may be null; use ?.${node.name}() or ?? to supply a default`
          : `An argument of ${node.name}() may be null; use ?? to supply a default`,
        culprit ?? node,
      )
      return
    }
    const shown = node.args
      .map((arg, i) => (arg.type === 'Lambda' ? 'lambda' : formatType(argTypes[i] ?? ANY)))
      .join(', ')
    const signatures = def.overloads
      .map((candidate) => signatureText(def.name, candidate))
      .join('; ')
    report(
      'NO_OVERLOAD',
      `${node.name}(${shown}) does not match ${def.overloads.length > 1 ? 'any of ' : ''}${signatures}`,
      node,
    )
  }

  return {
    root: bound.node,
    type,
    diagnostics,
    calls,
    types,
    async: asyncNodes.has(bound.node),
    checkResult,
    references: { variables: [...variables], functions: [...functions] },
    probeScope,
  }
}

// === helpers ===

/** Whether values of a type can be ordered (one kind: numbers, text, timestamps, durations). */
function orderable(type: Type): boolean {
  const kind = widen(nonNull(type)).kind
  return ['any', 'never', 'var', 'number', 'string', 'timestamp', 'duration'].includes(kind)
}

/** A result refiner, applied per member when the first argument is a union (flat() of `a[] | b[]`). */
function refine(
  refiner: ((args: readonly Type[]) => Type | undefined) | undefined,
  args: readonly Type[],
): Type | undefined {
  if (refiner === undefined) return undefined
  const direct = refiner(args)
  const first = args[0]
  if (direct !== undefined || first?.kind !== 'union') return direct
  const results: Type[] = []
  for (const member of first.types) {
    const result = refiner([member, ...args.slice(1)])
    if (result === undefined) return undefined
    results.push(result)
  }
  return unionOf(results)
}

const freeMemo = new WeakMap<Node, { names: readonly string[]; it: boolean }>()

/** The outer locals (and whether the outer `.`) a node reads. */
function freeLocals(root: Node): { names: readonly string[]; it: boolean } {
  const cached = freeMemo.get(root)
  if (cached !== undefined) return cached
  const names = new Set<string>()
  let it = false
  const visit = (node: Node, bound: ReadonlySet<string>, itBound: boolean): void => {
    switch (node.type) {
      case 'Local':
        if (!bound.has(node.name)) names.add(node.name)
        return
      case 'It':
        if (!itBound) it = true
        return
      case 'Lambda':
        if (node.implicit) visit(node.body, bound, true)
        else visit(node.body, new Set([...bound, ...node.params]), itBound)
        return
      case 'Let':
        visit(node.value, bound, itBound)
        visit(node.body, new Set([...bound, node.name]), itBound)
        return
      case 'Binary':
      case 'Call':
      case 'Conditional':
      case 'Has':
      case 'Index':
      case 'List':
      case 'Literal':
      case 'Map':
      case 'Member':
      case 'Template':
      case 'Try':
      case 'Unary':
      case 'Variable':
      default:
        forEachChild(node, (child) => {
          visit(child, bound, itBound)
        })
    }
  }
  visit(root, new Set(), false)
  const result = { names: [...names].sort(), it }
  freeMemo.set(root, result)
  return result
}

/** Indices where two parameter-type lists differ. */
function changedAt(next: readonly Type[], previous: readonly Type[]): number[] {
  const out: number[] = []
  next.forEach((type, i) => {
    if (!sameType(type, previous[i] ?? ANY)) out.push(i)
  })
  return out
}

function isProven(argType: Type, param: Type): boolean {
  if (param.kind === 'any' || param.kind === 'var') return argType.kind !== 'never'
  if (containsAny(argType)) return false
  return isAssignable(argType, param)
}

const containsAnyMemo = new WeakMap<Type, boolean>()

/** Whether a type is only partly known statically (`any` somewhere inside). */
function containsAny(type: Type): boolean {
  if (type.kind !== 'list' && type.kind !== 'map' && type.kind !== 'union')
    return type.kind === 'any' || type.kind === 'var'
  let result = containsAnyMemo.get(type)
  if (result === undefined) {
    result = computeContainsAny(type)
    containsAnyMemo.set(type, result)
  }
  return result
}

function computeContainsAny(type: Type): boolean {
  switch (type.kind) {
    case 'any':
    case 'var':
      return true
    case 'list':
      return containsAny(type.element)
    case 'map':
      return (
        (type.rest !== undefined && containsAny(type.rest)) ||
        Object.values(type.fields).some(containsAny)
      )
    case 'union':
      return type.types.some(containsAny)
    case 'boolean':
    case 'duration':
    case 'function':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    default:
      return false
  }
}

/** Whether a value of type `arg` can be passed for parameter `param` (tooling). */
export function acceptsArgument(param: Type, arg: Type): boolean {
  return unify(param, arg, new Map())
}

/** Binds type variables in `param` from `arg`; false when they cannot match. */
function unify(param: Type, arg: Type, b: Map<string, Type>): boolean {
  if (arg.kind === 'any') {
    // Anything may flow into every type variable here: `any` absorbs them, so
    // e.g. reduce's result is not typed from its lambda alone when the initial
    // value is unknown.
    for (const name of varNames(param)) b.set(name, ANY)
    return true
  }
  if (arg.kind === 'never') {
    bindNever(param, b)
    return true
  }
  switch (param.kind) {
    case 'var': {
      // Bound as given: a declared enum stays an enum through first(), sort(),
      // reduce(); literals from the source widen when a list or map holds them.
      const existing = b.get(param.name)
      if (existing?.kind === 'any') return true
      if (existing === undefined || existing.kind === 'never') {
        b.set(param.name, arg)
        return true
      }
      if (isAssignable(arg, existing)) return true
      if (isAssignable(existing, arg)) {
        b.set(param.name, arg)
        return true
      }
      b.set(param.name, unionOf([existing, arg]))
      return true
    }
    case 'list':
      if (arg.kind === 'list') return unify(param.element, arg.element, b)
      if (arg.kind === 'union') return arg.types.every((member) => unify(param, member, b))
      return false
    case 'map': {
      if (arg.kind === 'union') return arg.types.every((member) => unify(param, member, b))
      if (arg.kind !== 'map') return false
      if (!hasVar(param)) return isAssignable(arg, param)
      if (param.rest !== undefined && Object.keys(param.fields).length === 0) {
        const members = Object.values(arg.fields)
        if (arg.rest !== undefined) members.push(arg.rest)
        // A declared object may hold unlisted keys, of any type.
        else if (!isExact(arg)) members.push(ANY)
        return members.length === 0 || unify(param.rest, unionOf(members), b)
      }
      return isAssignable(arg, param)
    }
    case 'union': {
      if (!hasVar(param)) return isAssignable(arg, param)
      // e.g. `list<U> | U` (flatMap): each member of the argument binds on its
      // own, so lists give their elements and other values (null too) bind U.
      const members = param.types
      const listMember = members.find((m) => m.kind === 'list')
      const variable = members.find((m) => m.kind === 'var')
      const concrete = members.filter((m) => !hasVar(m))
      for (const member of arg.kind === 'union' ? arg.types : [arg]) {
        if (listMember !== undefined && member.kind === 'list') {
          if (!unify(listMember, member, b)) return false
        } else if (!concrete.some((m) => isAssignable(member, m))) {
          if (variable === undefined || !unify(variable, member, b)) return false
        }
      }
      return true
    }
    case 'any':
    case 'boolean':
    case 'duration':
    case 'function':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    default:
      return isAssignable(arg, param)
  }
}

/** A `never` argument (e.g. the element of `[]`) binds every free variable to never. */
function bindNever(param: Type, b: Map<string, Type>): void {
  switch (param.kind) {
    case 'var':
      if (!b.has(param.name)) b.set(param.name, t.never())
      return
    case 'list':
      bindNever(param.element, b)
      return
    case 'map':
      if (param.rest !== undefined) bindNever(param.rest, b)
      for (const field of Object.values(param.fields)) bindNever(field, b)
      return
    case 'union':
      for (const member of param.types) bindNever(member, b)
      break
    case 'any':
    case 'boolean':
    case 'duration':
    case 'function':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
      break
  }
}

/** The names of the type variables in a type. */
function varNames(type: Type): string[] {
  switch (type.kind) {
    case 'var':
      return [type.name]
    case 'list':
      return varNames(type.element)
    case 'map':
      return [
        ...Object.values(type.fields).flatMap(varNames),
        ...(type.rest === undefined ? [] : varNames(type.rest)),
      ]
    case 'union':
      return type.types.flatMap(varNames)
    case 'function':
      return [...type.params.flatMap(varNames), ...varNames(type.result)]
    case 'any':
    case 'boolean':
    case 'duration':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    default:
      return []
  }
}

function hasVar(type: Type): boolean {
  switch (type.kind) {
    case 'var':
      return true
    case 'list':
      return hasVar(type.element)
    case 'map':
      return (
        (type.rest !== undefined && hasVar(type.rest)) || Object.values(type.fields).some(hasVar)
      )
    case 'union':
      return type.types.some(hasVar)
    case 'function':
      return type.params.some(hasVar) || hasVar(type.result)
    case 'any':
    case 'boolean':
    case 'duration':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    default:
      return false
  }
}

function substitute(type: Type, b: ReadonlyMap<string, Type>): Type {
  switch (type.kind) {
    case 'var':
      return b.get(type.name) ?? ANY
    case 'list':
      return t.list(substitute(type.element, b))
    case 'map': {
      const fields: Record<string, Type> = {}
      for (const [key, value] of Object.entries(type.fields)) fields[key] = substitute(value, b)
      const mapped: MapType =
        type.rest === undefined
          ? { kind: 'map', fields }
          : { kind: 'map', fields, rest: substitute(type.rest, b) }
      return mapped
    }
    case 'union':
      return unionOf(type.types.map((member) => substitute(member, b)))
    case 'function':
      return {
        kind: 'function',
        params: type.params.map((p) => substitute(p, b)),
        result: substitute(type.result, b),
      }
    case 'any':
    case 'boolean':
    case 'duration':
    case 'literal':
    case 'never':
    case 'null':
    case 'number':
    case 'opaque':
    case 'string':
    case 'timestamp':
    default:
      return type
  }
}

export function signatureText(name: string, candidate: Overload): string {
  const required = candidate.required ?? candidate.params.length
  const params = candidate.params.map(
    (param, i) => `${formatType(param)}${i >= required ? '?' : ''}`,
  )
  if (candidate.rest !== undefined) params.push(`...${formatType(candidate.rest)}`)
  return `${name}(${params.join(', ')}): ${formatType(candidate.result)}`
}

function findIt(node: Node): Node | undefined {
  if (node.type === 'It') return node
  let found: Node | undefined
  const visit = (child: Node): void => {
    found ??= findIt(child)
  }
  if (node.type === 'Lambda') return undefined
  forEachChild(node, visit)
  return found
}

/** Names from other languages, with the Bonsai spelling. */
const FUNCTION_ALIASES: Readonly<Record<string, string>> = {
  length: 'length is a property: write x.length',
  size: 'use the length property: x.length',
  len: 'use the length property: x.length',
  count: 'use count(list) or x.length',
  contains: 'did you mean "includes"?',
  substring: 'did you mean "slice"?',
  substr: 'did you mean "slice"?',
  lower: 'did you mean "toLowerCase"?',
  upper: 'did you mean "toUpperCase"?',
  lowercase: 'did you mean "toLowerCase"?',
  uppercase: 'did you mean "toUpperCase"?',
  test: 'did you mean "matches"?',
  match: 'did you mean "matches"?',
  regex: 'did you mean "matches"?',
  distinct: 'did you mean "unique"?',
  uniq: 'did you mean "unique"?',
  average: 'did you mean "avg"?',
  mean: 'did you mean "avg"?',
  exists: 'did you mean "some"?',
  any: 'did you mean "some"?',
  all: 'did you mean "every"?',
  int: 'did you mean "toNumber" (with trunc to drop decimals)?',
  parseInt: 'did you mean "toNumber"?',
  parseFloat: 'did you mean "toNumber"?',
  Number: 'did you mean "toNumber"?',
  String: 'did you mean "toString"?',
  str: 'did you mean "toString"?',
  concat: 'use + to join lists or strings',
  push: 'use + to append: list + [item]',
  today: 'use startOfDay(now())',
  date: 'did you mean "timestamp"?',
  format: 'use formatDate, formatNumber, or a template',
  isNull: 'compare with == null',
}

/** JavaScript globals people reach for, with what to write instead. */
const JS_GLOBALS: Readonly<Record<string, string>> = {
  Math: 'call the function directly, e.g. max(a, b), round(x), abs(x)',
  Date: 'use now() or timestamp("2026-01-31")',
  JSON: 'expressions work on values directly',
  Object: 'use keys(map), values(map), entries(map)',
  Number: 'use toNumber(x)',
  String: 'use toString(x)',
  Array: 'use a list literal [...]',
}

/** "Did you mean" suffix using edit distance. */
function suggest(name: string, candidates: Iterable<string>): string {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best === undefined ? '' : `; did you mean "${best}"?`
}

/** Any distance larger than every suggestion threshold. */
const FAR_APART = 99

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return FAR_APART
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}
