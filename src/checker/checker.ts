import type {
  ASTNode,
  BonsaiInstance,
  BonsaiType,
  ParameterMetadata,
  TransformMetadata,
  FunctionMetadata,
} from '../types.js'
import { parse } from '../parser.js'
import { BonsaiSecurityError, ExpressionError } from '../errors.js'
import {
  methodsForReceiverType,
  methodSignatureArgument,
  methodSignatureCode,
  methodSignatureHasRest,
  methodSignatureParamCount,
  methodSignatureRequired,
  type MethodArgumentCode,
  type MethodReceiverType,
} from '../safe-methods.js'
import { BLOCKED_PROPERTIES, isCanonicalIndex } from '../execution-context.js'
import {
  formatType,
  fromInferredTypeName,
  isAssignable,
  literalBaseKind,
  t,
  unionOf,
} from './schema.js'
import type {
  BonsaiChecker,
  CheckDiagnostic,
  CheckDiagnosticCode,
  CheckerOptions,
  CheckOptions,
  CheckResult,
} from './types.js'

interface LambdaType {
  readonly kind: 'lambda'
  readonly returns: BonsaiType
}

type CheckedType = BonsaiType | LambdaType

type MemberNode = ASTNode & { object: ASTNode; property: ASTNode; computed: boolean }

const PRIMITIVE = t.union(t.string(), t.number(), t.boolean(), t.null(), t.undefined())
// Elements that `join`/`toSorted` may stringify without running a host hook.
const STRING_PRIMITIVE_ELEMENT = PRIMITIVE

interface MethodSignature {
  /** Parameter types by position; the last entry repeats when `rest` is true. */
  readonly params: readonly BonsaiType[]
  readonly required: number
  readonly rest?: boolean
  /** Return type when it does not depend on the receiver's element type. */
  readonly returns?: BonsaiType
}

function methodArgumentType(kind: MethodArgumentCode): BonsaiType {
  switch (kind) {
    case 's':
      return t.string()
    case 'n':
      return t.number()
    case 'p':
      return PRIMITIVE
    case 'a':
      return t.union(PRIMITIVE, t.array(t.unknown()))
    case 'l':
    case 'u':
      return t.unknown()
  }
  return t.unknown()
}

function fixedMethodReturn(key: string): BonsaiType | undefined {
  const separator = key.indexOf('.')
  const receiver = key.slice(0, separator)
  const name = key.slice(separator + 1)
  if (receiver === 'number') return t.string()
  if (receiver === 'string') {
    if (['startsWith', 'endsWith', 'includes'].includes(name)) return t.boolean()
    if (['indexOf', 'lastIndexOf', 'charCodeAt'].includes(name)) return t.number()
    if (name === 'at') return t.optional(t.string())
    if (name === 'split') return t.array(t.string())
    return t.string()
  }
  if (['includes', 'some', 'every'].includes(name)) return t.boolean()
  if (['indexOf', 'lastIndexOf', 'findIndex'].includes(name)) return t.number()
  if (name === 'join') return t.string()
  return undefined
}

// Built-in method signatures are derived from the same lightweight table the
// runtime enforces. Receiver-dependent array result types are handled below.
const METHOD_SIGNATURES: Readonly<Record<string, MethodSignature>> = Object.freeze(
  Object.fromEntries(
    (['string', 'array', 'number'] as const).flatMap((receiver) =>
      methodsForReceiverType(receiver).map((name) => {
        const code = methodSignatureCode(receiver, name)
        if (code === undefined) throw new TypeError(`Missing method signature: ${receiver}.${name}`)
        const key = `${receiver}.${name}`
        const returns = fixedMethodReturn(key)
        const params = Array.from({ length: methodSignatureParamCount(code) }, (_, index) =>
          methodArgumentType(methodSignatureArgument(code, index) as MethodArgumentCode),
        )
        return [
          key,
          Object.freeze({
            params: Object.freeze(params),
            required: methodSignatureRequired(code),
            ...(methodSignatureHasRest(code) ? { rest: true } : {}),
            ...(returns === undefined ? {} : { returns }),
          }),
        ] as const
      }),
    ),
  ),
)

const HOF_METHODS = new Set(['map', 'filter', 'find', 'findIndex', 'some', 'every', 'flatMap'])
// Array methods whose result keeps the receiver's element type.
const ELEMENT_PRESERVING = new Set([
  'slice',
  'filter',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
  'concat',
  'flat',
])
const PRIMITIVE_KINDS = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'unknown'])

function asValue(type: CheckedType): BonsaiType {
  return type.kind === 'lambda' ? t.unknown() : type
}

/** The runtime `typeof`-style kind of a type, widening literals to their base. */
function baseKind(type: BonsaiType): string {
  return type.kind === 'literal' ? literalBaseKind(type.value) : type.kind
}

function memberName(node: ASTNode, computed = false): string | undefined {
  if (!computed && node.type === 'Identifier') return node.name
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'NumberLiteral') return String(node.value)
  return undefined
}

function nonNullable(type: BonsaiType): BonsaiType {
  if (type.kind !== 'union') {
    return type.kind === 'null' || type.kind === 'undefined' ? t.unknown() : type
  }
  return unionOf(
    type.members.filter((member) => member.kind !== 'null' && member.kind !== 'undefined'),
  )
}

function containsNullish(type: BonsaiType): boolean {
  if (type.kind === 'null' || type.kind === 'undefined') return true
  return type.kind === 'union' && type.members.some(containsNullish)
}

function everyMember(type: BonsaiType, predicate: (member: BonsaiType) => boolean): boolean {
  return type.kind === 'union' ? type.members.every(predicate) : predicate(type)
}

function anyMember(type: BonsaiType, predicate: (member: BonsaiType) => boolean): boolean {
  return type.kind === 'union' ? type.members.some(predicate) : predicate(type)
}

function fromMetadata(metadata: TransformMetadata | FunctionMetadata | undefined): BonsaiType {
  return metadata?.returnType ?? t.unknown()
}

function isPrimitiveKind(type: BonsaiType): boolean {
  return PRIMITIVE_KINDS.has(baseKind(type))
}

/** Every member of `type` (widening literals) has the given runtime kind. */
function allOfKind(type: BonsaiType, kind: string): boolean {
  return everyMember(type, (member) => baseKind(member) === kind)
}

export function createChecker(
  instance: BonsaiInstance,
  defaults: CheckerOptions = {},
): BonsaiChecker {
  return {
    check(expression, options = {}) {
      return checkExpression(instance, expression, { ...defaults, ...options })
    },
  }
}

export function checkExpression(
  instance: BonsaiInstance,
  expression: string,
  options: CheckOptions = {},
): CheckResult {
  const diagnostics: CheckDiagnostic[] = []
  let ast: ASTNode
  try {
    ast = parse(expression, instance.getPolicy())
  } catch (error: unknown) {
    if (error instanceof BonsaiSecurityError) {
      return {
        valid: false,
        type: t.unknown(),
        diagnostics: [
          {
            code: 'RESOURCE_LIMIT',
            message: error.message,
            severity: 'error',
            start: 0,
            end: Math.min(1, expression.length),
          },
        ],
      }
    }
    if (!(error instanceof ExpressionError)) throw error
    return {
      valid: false,
      type: t.unknown(),
      diagnostics: [
        {
          code: 'SYNTAX_ERROR',
          message: error.rawMessage,
          severity: 'error',
          start: error.start,
          end: error.end,
        },
      ],
    }
  }

  const policy = instance.getPolicy()
  const allowed = policy.allowedProperties ? new Set(policy.allowedProperties) : undefined
  const denied = policy.deniedProperties ? new Set(policy.deniedProperties) : undefined
  const contextSchema = options.schema
  let lambdaBodyDepth = 0

  const report = (code: CheckDiagnosticCode, message: string, node: ASTNode): void => {
    diagnostics.push({ code, message, severity: 'error', start: node.start, end: node.end })
  }

  const checkPropertyPolicy = (name: string, node: ASTNode): void => {
    if (BLOCKED_PROPERTIES.has(name)) {
      report('PROPERTY_NOT_ALLOWED', `Property "${name}" is always blocked`, node)
    } else if (allowed !== undefined && !allowed.has(name) && !isCanonicalIndex(name)) {
      report('PROPERTY_NOT_ALLOWED', `Property "${name}" is not in allowedProperties`, node)
    } else if (denied?.has(name) === true) {
      report('PROPERTY_NOT_ALLOWED', `Property "${name}" is in deniedProperties`, node)
    }
  }

  const rootType = (name: string, node: ASTNode): BonsaiType => {
    if (contextSchema?.kind === 'object') {
      const property = Object.hasOwn(contextSchema.properties, name)
        ? contextSchema.properties[name]
        : undefined
      if (property !== undefined) return property
      if (
        contextSchema.additionalProperties !== undefined &&
        contextSchema.additionalProperties !== false
      ) {
        // An undeclared key may be absent at runtime.
        return t.optional(contextSchema.additionalProperties)
      }
    }
    if (options.allowUnknownIdentifiers === true) return t.unknown()
    report('UNKNOWN_IDENTIFIER', `Unknown context identifier "${name}"`, node)
    return t.unknown()
  }

  const checkExpected = (actual: BonsaiType, expected: BonsaiType, node: ASTNode): void => {
    if (!isAssignable(actual, expected)) {
      report(
        'TYPE_MISMATCH',
        `Expected ${formatType(expected)}, received ${formatType(actual)}`,
        node,
      )
    }
  }

  const checkArity = (count: number, required: number, max: number, target: ASTNode): void => {
    if (count < required || count > max) {
      let expected = `${String(required)}–${String(max)}`
      if (max === Infinity) expected = `at least ${String(required)}`
      else if (required === max) expected = String(required)
      report('ARGUMENT_COUNT', `Expected ${expected} arguments, received ${String(count)}`, target)
    }
  }

  // Infer each argument (from `startIndex`) and check it against the declared
  // parameters. `target` anchors arity diagnostics to the whole call.
  const checkParameters = (
    args: readonly ASTNode[],
    parameters: readonly ParameterMetadata[] | undefined,
    target: ASTNode,
    lambdaElement?: BonsaiType,
    startIndex = 0,
  ): void => {
    if (parameters === undefined) {
      for (let index = startIndex; index < args.length; index++) infer(args[index], lambdaElement)
      return
    }
    const required = parameters.filter(
      (parameter) => parameter.optional !== true && parameter.rest !== true,
    ).length
    const rest = parameters.at(-1)?.rest === true ? parameters.at(-1) : undefined
    checkArity(args.length, required, rest === undefined ? parameters.length : Infinity, target)
    for (let index = startIndex; index < args.length; index++) {
      const parameter = parameters[index] ?? rest
      const actual = asValue(infer(args[index], lambdaElement))
      if (parameter !== undefined) checkExpected(actual, parameter.type, args[index])
    }
  }

  /**
   * Type of reading `name` (or a computed key) from a value of type `object`.
   * Shared by member access and the lambda accessor shorthand so `.length` on
   * string/array elements and unknown-property reporting behave identically.
   */
  const resolveMemberType = (
    object: BonsaiType,
    name: string | undefined,
    computed: boolean,
    node: ASTNode,
    propertyNode: ASTNode,
  ): BonsaiType => {
    const results: BonsaiType[] = []
    const resolve = (candidate: BonsaiType): void => {
      if (candidate.kind === 'unknown') {
        results.push(candidate)
        return
      }
      if (candidate.kind === 'union') {
        for (const member of candidate.members) resolve(member)
        return
      }
      // Reading from a nullish receiver yields undefined at runtime.
      if (candidate.kind === 'null' || candidate.kind === 'undefined') {
        results.push(t.undefined())
        return
      }
      const kind = baseKind(candidate)
      if (candidate.kind === 'array' || kind === 'string') {
        const element = candidate.kind === 'array' ? candidate.element : t.string()
        if (name === 'length') results.push(t.number())
        else if (name !== undefined && isCanonicalIndex(name)) results.push(t.optional(element))
        else if (computed) results.push(t.optional(element))
        else {
          // Only own properties are readable, so `items.count` or `items.map`
          // (without a call) is undefined at runtime; almost always a typo.
          report(
            'UNKNOWN_PROPERTY',
            `Unknown property "${name ?? ''}" on ${formatType(candidate)} (only "length" and indices are readable)`,
            propertyNode,
          )
          results.push(t.undefined())
        }
        return
      }
      if (candidate.kind !== 'object') {
        report('UNKNOWN_PROPERTY', `Type ${formatType(candidate)} has no readable properties`, node)
        results.push(t.unknown())
        return
      }
      if (name === undefined) {
        results.push(
          candidate.additionalProperties === false
            ? t.undefined()
            : t.optional(candidate.additionalProperties ?? t.unknown()),
        )
        return
      }
      const property = Object.hasOwn(candidate.properties, name)
        ? candidate.properties[name]
        : undefined
      if (property !== undefined) results.push(property)
      else if (
        candidate.additionalProperties !== undefined &&
        candidate.additionalProperties !== false
      ) {
        results.push(t.optional(candidate.additionalProperties))
      } else {
        report('UNKNOWN_PROPERTY', `Unknown property "${name}"`, propertyNode)
        results.push(t.unknown())
      }
    }
    resolve(object)
    return unionOf(results)
  }

  const inferMember = (node: MemberNode, lambdaElement?: BonsaiType): BonsaiType => {
    const object = asValue(infer(node.object, lambdaElement))
    const name = memberName(node.property, node.computed)
    if (name !== undefined) checkPropertyPolicy(name, node.property)
    if (node.computed) {
      const keyType = asValue(infer(node.property, lambdaElement))
      if (!everyMember(keyType, isPrimitiveKind)) {
        report('TYPE_MISMATCH', 'Computed property keys must be primitive', node.property)
      }
    }
    return resolveMemberType(object, name, node.computed, node, node.property)
  }

  const inferHof = (
    name: string,
    input: BonsaiType,
    args: readonly ASTNode[],
  ): BonsaiType | undefined => {
    if (!HOF_METHODS.has(name)) return undefined
    const element = input.kind === 'array' ? input.element : t.unknown()
    const callback = args[0]
    let returns: BonsaiType = t.unknown()
    if (callback !== undefined) {
      const callbackType = infer(callback, element)
      if (callbackType.kind === 'lambda') returns = callbackType.returns
      else report('TYPE_MISMATCH', 'Higher-order operations require a Bonsai lambda', callback)
    }
    if (name === 'map') return t.array(returns)
    if (name === 'filter') return t.array(element)
    if (name === 'find') return t.optional(element)
    if (name === 'findIndex') return t.number()
    if (name === 'some' || name === 'every') return t.boolean()
    if (name === 'flatMap') return t.array(returns.kind === 'array' ? returns.element : returns)
    return undefined
  }

  const inferArrayTransform = (
    rule: TransformMetadata['arrayTypeRule'],
    input: BonsaiType,
    args: readonly ASTNode[],
  ): BonsaiType | undefined => {
    if (rule === undefined) return undefined
    const element = input.kind === 'array' ? input.element : t.unknown()
    if (rule === 'preserve') return input.kind === 'array' ? input : t.array(t.unknown())
    if (rule === 'optional-element') return t.optional(element)
    if (rule === 'flatten') {
      return t.array(element.kind === 'array' ? element.element : element)
    }

    const callback = args[0]
    let returns = element
    if (callback !== undefined) {
      const callbackType = infer(callback, element)
      if (callbackType.kind === 'lambda') returns = callbackType.returns
      else report('TYPE_MISMATCH', 'Higher-order operations require a Bonsai lambda', callback)
    }
    if (rule === 'map') return t.array(callback === undefined ? element : returns)
    if (rule === 'filter') return t.array(element)
    if (rule === 'find') return t.optional(element)
    return t.boolean()
  }

  const inferMethodCall = (
    call: ASTNode & { args: readonly ASTNode[] },
    callee: MemberNode,
    optional: boolean,
    lambdaElement?: BonsaiType,
  ): BonsaiType => {
    const rawReceiver = asValue(infer(callee.object, lambdaElement))
    const name = memberName(callee.property, callee.computed)
    if (name === undefined) {
      report('METHOD_NOT_ALLOWED', 'Method name must be statically known', callee.property)
      for (const arg of call.args) infer(arg, lambdaElement)
      return t.unknown()
    }
    checkPropertyPolicy(name, callee.property)
    // Calling a method on null/undefined throws at runtime unless `?.` is used.
    if (!optional && containsNullish(rawReceiver)) {
      report(
        'NULLABLE_ACCESS',
        `Use optional chaining (?.${name}()) before calling a method on a nullable value`,
        callee.object,
      )
    }
    const receiver = nonNullable(rawReceiver)
    const receiverKinds = new Set<MethodReceiverType>()
    let hasUnknownReceiver = false
    let hasUnsupportedReceiver = false
    const collect = (type: BonsaiType): void => {
      if (type.kind === 'union') for (const member of type.members) collect(member)
      else {
        const kind = baseKind(type)
        if (kind === 'string' || kind === 'number' || kind === 'array') receiverKinds.add(kind)
        else if (kind === 'unknown') hasUnknownReceiver = true
        else hasUnsupportedReceiver = true
      }
    }
    collect(receiver)
    const withOptional = (type: BonsaiType): BonsaiType =>
      optional && containsNullish(rawReceiver) ? unionOf([type, t.undefined()]) : type
    if (
      hasUnsupportedReceiver ||
      (receiverKinds.size === 0 && !hasUnknownReceiver) ||
      [...receiverKinds].some((kind) => !methodsForReceiverType(kind).includes(name))
    ) {
      report(
        'METHOD_NOT_ALLOWED',
        `Method "${name}" is not available on ${formatType(receiver)}`,
        callee,
      )
      for (const arg of call.args) infer(arg, lambdaElement)
      return t.unknown()
    }
    if (receiverKinds.size === 0) {
      for (const arg of call.args) infer(arg, lambdaElement)
      return t.unknown()
    }

    let arrayReceiver: Extract<BonsaiType, { kind: 'array' }> | undefined
    if (receiver.kind === 'array') arrayReceiver = receiver
    else if (anyMember(receiver, (type) => type.kind === 'array')) {
      arrayReceiver = t.array(t.unknown())
    }

    // Arity and parameter types from the built-in signature table.
    const signatures = [...receiverKinds]
      .map((kind) => METHOD_SIGNATURES[`${kind}.${name}`])
      .filter((signature): signature is MethodSignature => signature !== undefined)
    const signature =
      signatures.length > 0 && signatures.every((entry) => entry === signatures[0])
        ? signatures[0]
        : undefined
    const checkMethodArity = (): void => {
      if (signature === undefined) return
      checkArity(
        call.args.length,
        signature.required,
        signature.rest === true ? Infinity : signature.params.length,
        call,
      )
    }

    if (arrayReceiver !== undefined && HOF_METHODS.has(name)) {
      checkMethodArity()
      const hof = inferHof(name, arrayReceiver, call.args)
      for (let index = 1; index < call.args.length; index++) infer(call.args[index], lambdaElement)
      if (hof !== undefined) return withOptional(hof)
    }

    const argTypes = call.args.map((arg) => infer(arg, lambdaElement))
    const callbackIndex = argTypes.findIndex((argType) => argType.kind === 'lambda')
    if (callbackIndex !== -1) {
      // A lambda is never meaningful outside a higher-order method; report it
      // once and skip arity/parameter checks that would only add noise.
      report(
        'TYPE_MISMATCH',
        `Method "${name}" does not accept a callback argument`,
        call.args[callbackIndex],
      )
    } else if (signature !== undefined) {
      checkMethodArity()
      for (let index = 0; index < argTypes.length; index++) {
        let parameter =
          signature.params[index] ?? (signature.rest === true ? signature.params.at(-1) : undefined)
        // Element-typed positions: the value written by `with` and the items
        // inserted by `toSpliced` must fit the receiver's element type.
        if (receiver.kind === 'array') {
          if (name === 'with' && index === 1) parameter = receiver.element
          if (name === 'toSpliced' && index >= 2) parameter = receiver.element
        }
        if (parameter !== undefined) {
          checkExpected(asValue(argTypes[index]), parameter, call.args[index])
        }
      }
    }

    if (arrayReceiver !== undefined && (name === 'join' || name === 'toSorted')) {
      if (!isAssignable(arrayReceiver.element, STRING_PRIMITIVE_ELEMENT)) {
        report(
          'TYPE_MISMATCH',
          `Method "${name}" requires elements with primitive string representations, received ${formatType(arrayReceiver.element)}`,
          callee.object,
        )
      }
    }

    if (receiver.kind === 'array') {
      if (name === 'at' || name === 'find') return withOptional(t.optional(receiver.element))
      if (ELEMENT_PRESERVING.has(name)) {
        if (name === 'flat') {
          const element = receiver.element
          return withOptional(t.array(element.kind === 'array' ? element.element : element))
        }
        if (name === 'concat') {
          const extra = argTypes.map(asValue)
          const members = extra.map((type) => (type.kind === 'array' ? type.element : type))
          return withOptional(t.array(unionOf([receiver.element, ...members])))
        }
        return withOptional(receiver)
      }
    }
    const results = [...receiverKinds].map(
      (kind) => METHOD_SIGNATURES[`${kind}.${name}`]?.returns ?? t.unknown(),
    )
    return withOptional(unionOf(results))
  }

  const inferCall = (
    node: ASTNode & { callee: ASTNode; args: readonly ASTNode[] },
    lambdaElement?: BonsaiType,
  ): BonsaiType => {
    if (node.callee.type === 'Identifier') {
      const metadata = instance.getFunctionMetadata(node.callee.name)
      if (!instance.hasFunction(node.callee.name)) {
        report('UNKNOWN_FUNCTION', `Unknown function "${node.callee.name}"`, node.callee)
      }
      checkParameters(node.args, metadata?.parameters, node, lambdaElement)
      return fromMetadata(metadata)
    }
    if (node.callee.type === 'MemberExpression') {
      return inferMethodCall(node, node.callee, false, lambdaElement)
    }
    if (node.callee.type === 'OptionalMemberExpression') {
      return inferMethodCall(node, node.callee, true, lambdaElement)
    }
    report(
      'UNKNOWN_FUNCTION',
      'Only named functions and allow-listed methods are callable',
      node.callee,
    )
    for (const arg of node.args) infer(arg, lambdaElement)
    return t.unknown()
  }

  const inferPipe = (
    node: ASTNode & { input: ASTNode; transform: ASTNode },
    lambdaElement?: BonsaiType,
  ): BonsaiType => {
    const input = asValue(infer(node.input, lambdaElement))
    const transformNode = node.transform
    let name: string | undefined
    if (transformNode.type === 'Identifier') name = transformNode.name
    else if (
      transformNode.type === 'CallExpression' &&
      transformNode.callee.type === 'Identifier'
    ) {
      name = transformNode.callee.name
    }
    const args = transformNode.type === 'CallExpression' ? transformNode.args : []
    if (name === undefined) {
      report('UNKNOWN_TRANSFORM', 'Pipe stages must name a transform', transformNode)
      return t.unknown()
    }
    const metadata = instance.getTransformMetadata(name)
    if (!instance.hasTransform(name))
      report('UNKNOWN_TRANSFORM', `Unknown transform "${name}"`, transformNode)
    const expectedInput = metadata?.inputType
    if (expectedInput !== undefined) checkExpected(input, expectedInput, node.input)
    const arrayResult = inferArrayTransform(metadata?.arrayTypeRule, input, args)
    const hasArrayCallback =
      metadata?.arrayTypeRule === 'map' ||
      metadata?.arrayTypeRule === 'filter' ||
      metadata?.arrayTypeRule === 'find' ||
      metadata?.arrayTypeRule === 'some' ||
      metadata?.arrayTypeRule === 'every'
    // inferArrayTransform already inferred the callback (args[0]); check the rest once.
    checkParameters(
      args,
      metadata?.parameters,
      transformNode,
      input.kind === 'array' ? input.element : undefined,
      hasArrayCallback ? 1 : 0,
    )
    return arrayResult ?? fromMetadata(metadata)
  }

  function infer(node: ASTNode, lambdaElement?: BonsaiType): CheckedType {
    switch (node.type) {
      case 'NumberLiteral':
        return t.literal(node.value)
      case 'StringLiteral':
        return t.literal(node.value)
      case 'BooleanLiteral':
        return t.literal(node.value)
      case 'NullLiteral':
        return t.null()
      case 'UndefinedLiteral':
        return t.undefined()
      case 'Identifier':
        return rootType(node.name, node)
      case 'LambdaIdentity':
        return lambdaBodyDepth === 0
          ? { kind: 'lambda', returns: lambdaElement ?? t.unknown() }
          : (lambdaElement ?? t.unknown())
      case 'LambdaAccessor': {
        const element = lambdaElement ?? t.unknown()
        const propertyNode: ASTNode = {
          type: 'Identifier',
          name: node.property,
          start: node.start,
          end: node.end,
        }
        checkPropertyPolicy(node.property, propertyNode)
        const result = resolveMemberType(element, node.property, false, node, propertyNode)
        return lambdaBodyDepth === 0 ? { kind: 'lambda', returns: result } : result
      }
      case 'LambdaExpression': {
        lambdaBodyDepth++
        try {
          return { kind: 'lambda', returns: asValue(infer(node.body, lambdaElement)) }
        } finally {
          lambdaBodyDepth--
        }
      }
      case 'UnaryExpression': {
        const operand = asValue(infer(node.operand, lambdaElement))
        if (node.operator === '!') return t.boolean()
        // Unary + converts primitives; unary - requires a number.
        checkExpected(operand, node.operator === '+' ? PRIMITIVE : t.number(), node.operand)
        return t.number()
      }
      case 'BinaryExpression': {
        const left = asValue(infer(node.left, lambdaElement))
        const right = asValue(infer(node.right, lambdaElement))
        if (node.operator === '&&' || node.operator === '||') return unionOf([left, right])
        if (node.operator === '??') return unionOf([nonNullable(left), right])
        if (node.operator === '==' || node.operator === '!=') {
          // Equality is strict, so two types with no overlapping member can
          // never compare equal: `plan == "prem"` against an enum schema, or
          // `age == "18"` against a number, is a typo rather than a comparison.
          const overlap = anyMember(left, (l) =>
            anyMember(right, (r) => isAssignable(l, r) || isAssignable(r, l)),
          )
          if (!overlap) {
            report(
              'TYPE_MISMATCH',
              `Comparison is always ${node.operator === '==' ? 'false' : 'true'}: ${formatType(left)} and ${formatType(right)} never overlap`,
              node,
            )
          }
          return t.boolean()
        }
        if (node.operator === 'in' || node.operator === 'not in') {
          if (baseKind(right) === 'string') checkExpected(left, t.string(), node.left)
          else if (right.kind !== 'array' && right.kind !== 'unknown')
            report(
              'TYPE_MISMATCH',
              'Membership requires a string or array on the right',
              node.right,
            )
          return t.boolean()
        }
        if (node.operator === '+') {
          const bothStrings = allOfKind(left, 'string') && allOfKind(right, 'string')
          const bothNumbers = allOfKind(left, 'number') && allOfKind(right, 'number')
          if (bothStrings) return t.string()
          if (bothNumbers) return t.number()
          if (left.kind === 'unknown' || right.kind === 'unknown') {
            const known = left.kind === 'unknown' ? right : left
            if (allOfKind(known, 'string')) return t.string()
            if (allOfKind(known, 'number')) return t.number()
            return t.unknown()
          }
          report(
            'TYPE_MISMATCH',
            'Operator + requires two numbers or two strings (use a template literal to build text)',
            node,
          )
          return t.unknown()
        }
        if (['<', '>', '<=', '>='].includes(node.operator)) {
          const valid =
            (allOfKind(left, 'number') && allOfKind(right, 'number')) ||
            (allOfKind(left, 'string') && allOfKind(right, 'string')) ||
            left.kind === 'unknown' ||
            right.kind === 'unknown'
          if (!valid)
            report('TYPE_MISMATCH', 'Ordered comparison requires two numbers or two strings', node)
          return t.boolean()
        }
        checkExpected(left, t.number(), node.left)
        checkExpected(right, t.number(), node.right)
        return t.number()
      }
      case 'ConditionalExpression':
        infer(node.test, lambdaElement)
        return unionOf([
          asValue(infer(node.consequent, lambdaElement)),
          asValue(infer(node.alternate, lambdaElement)),
        ])
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return inferMember(node, lambdaElement)
      case 'CallExpression':
        return inferCall(node, lambdaElement)
      case 'PipeExpression':
        return inferPipe(node, lambdaElement)
      case 'ArrayLiteral': {
        const elements: BonsaiType[] = []
        for (const element of node.elements) {
          if (element.type === 'SpreadElement') {
            const spread = asValue(infer(element.argument, lambdaElement))
            if (spread.kind === 'array') elements.push(spread.element)
            else if (spread.kind !== 'unknown')
              report('TYPE_MISMATCH', 'Spread requires an array', element)
          } else elements.push(asValue(infer(element, lambdaElement)))
        }
        return t.array(widenLiterals(unionOf(elements)))
      }
      case 'ObjectLiteral': {
        const properties: Record<string, BonsaiType> = Object.create(null)
        for (const property of node.properties) {
          const value = asValue(infer(property.value, lambdaElement))
          const name = property.computed ? undefined : memberName(property.key)
          if (property.computed) infer(property.key, lambdaElement)
          if (name !== undefined) properties[name] = value
        }
        return t.object(properties)
      }
      case 'TemplateLiteral':
        for (const part of node.parts) {
          if (part.type === 'StringLiteral') continue
          const type = asValue(infer(part, lambdaElement))
          if (!everyMember(type, isPrimitiveKind)) {
            report('TYPE_MISMATCH', 'Template interpolation must be primitive', part)
          }
        }
        return t.string()
      case 'SpreadElement':
        return infer(node.argument, lambdaElement)
      default:
        return t.unknown()
    }
  }

  const type = widenLiterals(asValue(infer(ast)))
  if (options.expectedType !== undefined && !isAssignable(type, options.expectedType)) {
    report(
      'EXPECTED_RESULT',
      `Expected expression result ${formatType(options.expectedType)}, inferred ${formatType(type)}`,
      ast,
    )
  }
  if (diagnostics.length === 0) return { valid: true, type, diagnostics: [], ast }
  return { valid: false, type, diagnostics: Object.freeze(diagnostics), ast }
}

/**
 * Literal types are precise while inferring (so `plan == "pro"` can be checked
 * against an enum schema) but the reported result type of a whole expression
 * or an array literal is widened to its base kinds: `[1, 2]` is `number[]`,
 * not `(1 | 2)[]`.
 */
function widenLiterals(type: BonsaiType): BonsaiType {
  if (type.kind === 'literal') return fromInferredTypeName(literalBaseKind(type.value))
  if (type.kind === 'union') return unionOf(type.members.map(widenLiterals))
  if (type.kind === 'array') return t.array(widenLiterals(type.element))
  if (type.kind === 'object') {
    const properties: Record<string, BonsaiType> = Object.create(null)
    for (const [name, property] of Object.entries(type.properties)) {
      properties[name] = widenLiterals(property)
    }
    const additional = type.additionalProperties
    return t.object(properties, {
      ...(additional === undefined
        ? {}
        : { additionalProperties: additional === false ? false : widenLiterals(additional) }),
    })
  }
  return type
}
