import type { Diagnostic, DiagnosticCode } from '../errors.js'
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
  fieldOf,
  formatType,
  isAssignable,
  isNullable,
  nonNull,
  overlaps,
  t,
  unionOf,
  widen,
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

interface Scope {
  readonly locals: ReadonlyMap<string, Type>
  /** Type of the implicit parameter `.` in the innermost implicit lambda. */
  readonly it: Type | undefined
  /** Paths (see pathKey) known to be non-null here, from enclosing conditions. */
  readonly nonNull?: ReadonlySet<string>
}

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
    if (parts.length > 0)
      return `The result does not match ${formatType(expected)}: ${parts.join('; ')}`
    return undefined
  }
  if (isAssignable(actual, expected)) return undefined
  return `Expected the expression to produce ${formatType(expected)} but it produces ${formatType(actual)}`
}

function suggestAll(names: readonly string[], candidates: readonly string[]): string {
  const hints = names.map((name) => suggest(name, candidates)).filter((hint) => hint !== '')
  return hints.length > 0 ? hints.join('') : ''
}

/** A stable key for a readable path (`user.address.city`), or undefined. */
function pathKey(node: Node): string | undefined {
  switch (node.type) {
    case 'Variable':
      return `v:${node.name}`
    case 'Local':
      return `l:${node.name}`
    case 'It':
      return 'it'
    case 'Member': {
      const base = pathKey(node.object)
      return base === undefined ? undefined : `${base}.${node.name}`
    }
    case 'Index': {
      const base = pathKey(node.object)
      if (base === undefined || node.index.type !== 'Literal') return undefined
      return `${base}[${JSON.stringify(node.index.value)}]`
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

/** Paths that are non-null whenever `condition` evaluates to `positive`. */
function nonNullFacts(condition: Node, positive: boolean): Set<string> {
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
        if ((operator === '&&') === positive) return new Set([...a, ...b])
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
    case 'Call':
    case 'Conditional':
    case 'Has':
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
  return { ...scope, nonNull: new Set([...(scope.nonNull ?? []), ...facts]) }
}

/** Marks the value at `path` (segments after the root) as non-null inside `type`. */
function refinePath(type: Type, path: readonly string[]): Type {
  if (path.length === 0) return nonNull(type)
  if (type.kind === 'union') return unionOf(type.types.map((member) => refinePath(member, path)))
  if (type.kind !== 'map') return type
  const [head, ...rest] = path as [string, ...string[]]
  const field = fieldOf(type, head) ?? type.rest
  if (field === undefined) return type
  return { ...type, fields: { ...type.fields, [head]: refinePath(field, rest) } }
}

const ANY = t.any()
const NUMBER = t.number()
const STRING = t.string()
const BOOLEAN = t.boolean()
const NULL = t.null()
const OPTIONAL_BOOLEAN = t.optional(BOOLEAN)

export function analyze(root: Node, env: CheckEnv, options: CheckOptions = {}): Analysis {
  const diagnostics: Diagnostic[] = []
  const calls = new Map<CallNode, CallPlan>()
  const types = new Map<Node, Type>()
  const asyncNodes = new Set<Node>()
  const variables = new Set<string>()
  const functions = new Set<string>()
  let probeScope: ProbeScope | undefined

  const report = (
    code: DiagnosticCode,
    message: string,
    at: { start: number; end: number },
    severity: 'error' | 'warning' = 'error',
  ): void => {
    if (
      diagnostics.some(
        (d) => d.start === at.start && d.end === at.end && d.code === code && d.message === message,
      )
    )
      return
    diagnostics.push({ code, message, severity, start: at.start, end: at.end })
  }

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
  let type = check(bound.node, rootScope)
  type = widen(type)
  if (options.expected !== undefined) {
    const problem = expectationProblem(type, options.expected)
    if (problem !== undefined) report('EXPECTED_TYPE', problem, resultSpan(bound.node))
  }

  function check(node: Node, scope: Scope): Type {
    let result = checkNode(node, scope)
    if (scope.nonNull !== undefined && scope.nonNull.size > 0) {
      const key = pathKey(node)
      if (key !== undefined && scope.nonNull.has(key)) result = nonNull(result)
    }
    types.set(node, result)
    return result
  }

  function markAsync(node: Node, child: Node): void {
    if (asyncNodes.has(child)) asyncNodes.add(node)
  }

  function checkNode(node: Node, scope: Scope): Type {
    switch (node.type) {
      case 'Literal':
        return node.value === null ? NULL : t.literal(node.value)
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
        if (isAssignable(operand, NUMBER)) return NUMBER
        if (isAssignable(operand, t.duration())) return t.duration()
        report('TYPE_ERROR', `Cannot negate ${formatType(operand)}`, node)
        return ANY
      }
      case 'Binary':
        return checkBinary(node, scope)
      case 'Conditional': {
        const test = check(node.test, scope)
        expectLogic(test, node.test, 'A condition')
        const a = check(node.then, withFacts(scope, nonNullFacts(node.test, true)))
        const b = check(node.otherwise, withFacts(scope, nonNullFacts(node.test, false)))
        markAsync(node, node.test)
        markAsync(node, node.then)
        markAsync(node, node.otherwise)
        return unionOf([a, b])
      }
      case 'List': {
        const elements: Type[] = []
        for (const item of node.items) {
          if (item.type === 'Spread') {
            const spread = check(item.argument, scope)
            markAsync(node, item.argument)
            const listed = nonNull(spread)
            if (listed.kind === 'list') elements.push(listed.element)
            else if (listed.kind === 'never') continue
            else if (listed.kind !== 'any')
              report(
                'TYPE_ERROR',
                `Only a list can be spread into a list, not ${formatType(spread)}`,
                item,
              )
            else elements.push(ANY)
          } else {
            elements.push(widen(check(item, scope)))
            markAsync(node, item)
          }
        }
        return t.list(elements.length === 0 ? t.never() : unionOf(elements))
      }
      case 'Map': {
        const fields: Record<string, Type> = {}
        let rest: Type | undefined
        for (const entry of node.entries) {
          if (entry.type === 'Spread') {
            const spread = check(entry.argument, scope)
            markAsync(node, entry.argument)
            const mapped = nonNull(spread)
            if (mapped.kind === 'map') {
              // Host maps can carry keys their type does not declare, so a
              // spread may overwrite any earlier field.
              for (const key of Object.keys(fields)) {
                if (!Object.hasOwn(mapped.fields, key))
                  fields[key] =
                    mapped.rest === undefined ? ANY : unionOf([fields[key], mapped.rest])
              }
              Object.assign(fields, mapped.fields)
              if (mapped.rest !== undefined)
                rest = rest === undefined ? mapped.rest : unionOf([rest, mapped.rest])
            } else if (mapped.kind === 'any') rest = ANY
            else if (mapped.kind === 'never') continue
            else
              report(
                'TYPE_ERROR',
                `Only a map can be spread into a map, not ${formatType(spread)}`,
                entry,
              )
            continue
          }
          const valueType = widen(check(entry.value, scope))
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
        return rest === undefined ? t.object(fields) : { kind: 'map', fields, rest }
      }
      case 'Lambda':
        report('INVALID_LAMBDA', 'A lambda can only be passed to a function that takes one', node)
        return ANY
      case 'Let': {
        const valueType = check(node.value, scope)
        markAsync(node, node.value)
        const locals = new Map(scope.locals)
        locals.set(node.name, valueType)
        const bodyType = check(node.body, { ...scope, locals })
        markAsync(node, node.body)
        return bodyType
      }
      case 'Has': {
        check(node.target, scope)
        markAsync(node, node.target)
        return BOOLEAN
      }
      case 'Try': {
        const a = check(node.body, scope)
        const b = check(node.fallback, scope)
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

  function memberType(objectType: Type, name: string, at: Node): Type {
    if (objectType.kind === 'any' || objectType.kind === 'var') return ANY
    if (objectType.kind === 'never') return t.never()
    if (objectType.kind === 'null') return NULL
    if (objectType.kind === 'union') {
      return unionOf(objectType.types.map((member) => memberType(member, name, at)))
    }
    if (objectType.kind === 'map') {
      const field = fieldOf(objectType, name)
      if (field !== undefined) return field
      if (objectType.rest !== undefined) return t.optional(objectType.rest)
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
    if (objectType.kind === 'union')
      return unionOf(objectType.types.map((member) => indexedType(member, indexType, at)))
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
      const members = Object.values(objectType.fields)
      if (objectType.rest !== undefined) members.push(objectType.rest)
      return t.optional(unionOf(members))
    }
    report('TYPE_ERROR', `Cannot index ${formatType(objectType)}`, at)
    return ANY
  }

  function checkBinary(node: Extract<Node, { type: 'Binary' }>, scope: Scope): Type {
    const left = check(node.left, scope)
    let rightScope = scope
    if (node.operator === '&&') rightScope = withFacts(scope, nonNullFacts(node.left, true))
    else if (node.operator === '||') rightScope = withFacts(scope, nonNullFacts(node.left, false))
    const right = check(node.right, rightScope)
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
        const containers = nonNull(right)
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
          `${formatType(left)} can never be in ${formatType(right)}`,
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
    if (op === '+' && a.kind === 'list' && b.kind === 'list')
      return t.list(unionOf([a.element, b.element]))
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
    diagnostics.length = saved
    return failed ? undefined : result
  }

  // === calls ===

  function checkCall(node: CallNode, scope: Scope): Type {
    functions.add(node.name)
    const receiver = node.args[0]
    if (
      node.style === 'method' &&
      receiver?.type === 'Variable' &&
      Object.hasOwn(JS_GLOBALS, receiver.name) &&
      (env.variables === undefined || !Object.hasOwn(env.variables, receiver.name))
    ) {
      report(
        'UNKNOWN_VARIABLE',
        `There is no ${receiver.name} object; ${JS_GLOBALS[receiver.name] ?? ''}`,
        receiver,
      )
      return ANY
    }
    const def = env.lookup(node.name)
    // Argument types, except lambdas (checked once parameter types are known).
    const argTypes: (Type | undefined)[] = node.args.map((arg) => {
      if (arg.type === 'Lambda') return undefined
      const argType = check(arg.type === 'Spread' ? arg.argument : arg, scope)
      markAsync(node, arg.type === 'Spread' ? arg.argument : arg)
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
      const paramTypes = param.params.map((p) => substitute(p, firstBindings))
      const bodyType = checkLambda(arg, paramTypes, scope)
      if (asyncNodes.has(arg.body)) asyncLambda = true
      unify(param.result, bodyType, firstBindings)
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
          refined = refinePath(
            refined,
            key === itemPath ? [] : key.slice(itemPath.length + 1).split('.'),
          )
        }
        firstBindings.set('T', refined)
      }
    }
    for (const name of first.ordered ?? []) {
      const boundType = firstBindings.get(name)
      if (boundType === undefined) continue
      const kind = widen(nonNull(boundType))
      if (
        !['any', 'never', 'var', 'number', 'string', 'timestamp', 'duration'].includes(kind.kind)
      ) {
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
          : RESULT_REFINERS[def.name]?.(argTypes.map((a) => a ?? ANY))
      return refined ?? substitute(candidate.result, bindings[i])
    })
    const proven =
      candidates.length === 1 &&
      !hasSpread &&
      argTypes.every(
        (argType, index) =>
          argType === undefined || isProven(argType, first.params[index] ?? first.rest ?? ANY),
      )
    calls.set(node, { def, candidates, direct: proven, asyncLambda })
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
    const outer =
      scope.nonNull === undefined
        ? undefined
        : new Set([...scope.nonNull].filter((key) => !key.startsWith('it')))
    if (node.implicit) {
      inner = { locals: scope.locals, it: params[0] ?? ANY, nonNull: outer }
    } else {
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
        const spread = argTypes[i]
        const element = spread?.kind === 'list' ? spread.element : ANY
        if (!unify(param, element, b)) return false
        continue
      }
      if (arg.type === 'Lambda') {
        if (param.kind !== 'function') return false
        continue
      }
      if (param.kind === 'function') return false
      if (!unify(param, argTypes[i] as Type, b)) return false
    }
    return true
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
      const receiverIsNullable =
        node.style === 'method' && argTypes[0] !== undefined && isNullable(argTypes[0])
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
    references: { variables: [...variables], functions: [...functions] },
    probeScope,
  }
}

// === helpers ===

function isProven(argType: Type, param: Type): boolean {
  if (param.kind === 'any' || param.kind === 'var') return argType.kind !== 'never'
  if (containsAny(argType)) return false
  return isAssignable(argType, param)
}

function containsAny(type: Type): boolean {
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

/** Binds type variables in `param` from `arg`; false when they cannot match. */
function unify(param: Type, arg: Type, b: Map<string, Type>): boolean {
  if (arg.kind === 'any') return true
  if (arg.kind === 'never') {
    bindNever(param, b)
    return true
  }
  switch (param.kind) {
    case 'var': {
      const existing = b.get(param.name)
      if (existing?.kind === 'never') {
        b.set(param.name, widen(arg))
        return true
      }
      if (existing === undefined) {
        b.set(param.name, widen(arg))
        return true
      }
      if (isAssignable(arg, existing)) return true
      if (isAssignable(existing, widen(arg))) {
        b.set(param.name, widen(arg))
        return true
      }
      b.set(param.name, unionOf([existing, widen(arg)]))
      return true
    }
    case 'list':
      if (arg.kind === 'list') return unify(param.element, arg.element, b)
      if (arg.kind === 'union') return arg.types.every((member) => unify(param, member, b))
      return false
    case 'map': {
      if (arg.kind === 'union') return arg.types.every((member) => unify(param, member, b))
      if (arg.kind !== 'map') return false
      if (param.rest !== undefined && Object.keys(param.fields).length === 0) {
        const members = Object.values(arg.fields)
        if (arg.rest !== undefined) members.push(arg.rest)
        return members.length === 0 || unify(param.rest, unionOf(members), b)
      }
      return isAssignable(arg, param)
    }
    case 'union': {
      if (!hasVar(param)) return isAssignable(arg, param)
      // e.g. `list<U> | U`: prefer the structured member.
      const members = param.types
      const listMember = members.find((m) => m.kind === 'list')
      if (listMember !== undefined && arg.kind === 'list') return unify(listMember, arg, b)
      const concrete = members.filter((m) => !hasVar(m))
      if (concrete.some((m) => isAssignable(arg, m))) return true
      const variable = members.find((m) => m.kind === 'var')
      if (variable !== undefined) return unify(variable, nonNull(arg), b)
      return false
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
