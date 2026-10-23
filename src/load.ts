import {
  ARTIFACT_FORMAT,
  MAX_EXPECT_NODES,
  artifactDigest,
  treeNames,
  type Artifact,
  type Plan,
} from './artifact.js'
import { bindImplicit } from './check/bind.js'
import type { CallPlan } from './check/checker.js'
import { encodeType, lengthPrefixed } from './digest.js'
import type { Settings } from './environment.js'
import { BonsaiArtifactError, BonsaiError, isBonsaiError, type ArtifactProblem } from './errors.js'
import { BUILTINS } from './functions/builtins.js'
import { assertType, type FunctionDef } from './functions/define.js'
import { programRunner, warmZones, type ProgramAnalysis } from './program.js'
import { forEachChild, type CallNode, type Node } from './syntax/ast.js'
import { parse } from './syntax/parser.js'
import type { Type } from './types.js'

const ARTIFACT_KEYS: ReadonlySet<string> = new Set([
  'bonsai',
  'by',
  'source',
  'plans',
  'expect',
  'guard',
  'async',
  'digest',
])

/** The nesting assertType accepts. */
const MAX_TYPE_DEPTH = 64

/** A type object holds its kind and at most two other fields (`fields` and `rest`). */
const MAX_TYPE_KEYS = 3

/**
 * A plan holds a name position, a name, and fewer overload indices than the
 * function has overloads (built-ins have at most five, host functions one);
 * this bounds how much of a hostile entry is read.
 */
const MAX_PLAN_LENGTH = 34

const fail = (reason: ArtifactProblem, message: string, cause?: unknown): never => {
  throw new BonsaiArtifactError(reason, message, cause === undefined ? {} : { cause })
}

/** The TypeErrors readArtifact throws itself, as opposed to ones host objects throw. */
const own = new WeakSet()

function notArtifact(): never {
  const error = new TypeError('An artifact must be an object made by toArtifact()')
  own.add(error)
  throw error
}

/**
 * Reads the own properties of an object exactly once each, through their
 * descriptors, so no getter runs (a Proxy's traps run once per property).
 * More than `maxKeys` keys, accessors, and symbol keys are refused.
 */
function ownData(value: object, what: string, maxKeys: number): Map<string, unknown> {
  const keys = Reflect.ownKeys(value)
  if (keys.length > maxKeys) fail('limit', `${what} has more than ${maxKeys} keys`)
  const out = new Map<string, unknown>()
  for (const key of keys) {
    if (typeof key !== 'string') fail('shape', `${what} has a symbol key`)
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) continue
    if (!('value' in descriptor)) fail('shape', `${what}.${String(key)} is an accessor`)
    out.set(key as string, descriptor.value)
  }
  return out
}

/** The elements of an array, read once each, its length checked against `max` before any element is read. */
function arrayData(value: unknown, max: number, what: string, tooLong: ArtifactProblem): unknown[] {
  if (!Array.isArray(value)) return fail('shape', `${what} must be an array`)
  const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value as unknown
  if (typeof length !== 'number') return fail('shape', `${what} has no length`)
  if (length > max) return fail(tooLong, `${what} has more than ${max} entries`)
  const out: unknown[] = []
  for (let i = 0; i < length; i++) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(i))
    if (descriptor !== undefined && !('value' in descriptor))
      fail('shape', `${what}[${i}] is an accessor`)
    out.push(descriptor?.value)
  }
  return out
}

/**
 * A copy of an expected type, read by its kind so only a type's own fields are
 * read, with field records as null-prototype objects (so a `__proto__` key
 * stays a field). Type nodes are counted along every path, as toArtifact
 * counts them, so shared subtrees cannot hide its size.
 */
function copyType(value: unknown): Type {
  let nodes = 0
  const copy = (node: unknown, depth: number): unknown => {
    if (typeof node !== 'object' || node === null || Array.isArray(node))
      return fail('shape', "The artifact's expected type must be a type built with t")
    if (++nodes > MAX_EXPECT_NODES)
      fail('limit', `The artifact's expected type has more than ${MAX_EXPECT_NODES} type nodes`)
    if (depth > MAX_TYPE_DEPTH)
      fail('shape', `The artifact's expected type nests deeper than ${MAX_TYPE_DEPTH}`)
    const data = ownData(node, 'expect', MAX_TYPE_KEYS)
    const kind = data.get('kind')
    switch (kind) {
      case 'list':
        return Object.freeze({ kind, element: copy(data.get('element'), depth + 1) })
      case 'union': {
        const members = arrayData(data.get('types'), MAX_EXPECT_NODES, 'expect.types', 'limit')
        return Object.freeze({ kind, types: Object.freeze(members.map((m) => copy(m, depth + 1))) })
      }
      case 'map': {
        const record = data.get('fields')
        if (typeof record !== 'object' || record === null)
          return fail('shape', "The artifact's expected type has map fields that are not an object")
        const fields = Object.create(null) as Record<string, unknown>
        for (const [key, field] of ownData(record, 'expect.fields', MAX_EXPECT_NODES))
          Object.defineProperty(fields, key, { value: copy(field, depth + 1), enumerable: true })
        const rest = data.get('rest')
        return Object.freeze({
          kind,
          fields: Object.freeze(fields),
          ...(rest === undefined ? {} : { rest: copy(rest, depth + 1) }),
        })
      }
      case 'literal':
        return Object.freeze({ kind, value: data.get('value') })
      case 'opaque':
        return Object.freeze({ kind, name: data.get('name') })
      default:
        return Object.freeze({ kind })
    }
  }
  const type = copy(value, 0)
  try {
    assertType(type, "The artifact's expected type")
  } catch (error) {
    return fail('shape', (error as Error).message, error)
  }
  return type
}

/**
 * An artifact's fields, copied once and checked for shape and size before
 * anything is parsed. A value that is not an artifact is a TypeError, and so
 * is anything thrown while reading it (a Proxy trap), with the thrown value as
 * its cause.
 */
export function readArtifact(value: unknown, settings: Settings): Artifact {
  try {
    return read(value, settings)
  } catch (error) {
    if (isBonsaiError(error) || (typeof error === 'object' && error !== null && own.has(error)))
      throw error
    throw new TypeError('The artifact could not be read', { cause: error })
  }
}

function read(value: unknown, settings: Settings): Artifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) notArtifact()
  const data = ownData(value, 'The artifact', ARTIFACT_KEYS.size * 2)
  // Only the format is required to say which format it is: a later one may rename the rest.
  if (!data.has('bonsai')) notArtifact()
  const format = data.get('bonsai')
  if (typeof format !== 'number' || !Number.isSafeInteger(format) || format < 1)
    fail('shape', 'The artifact format must be a positive integer')
  if (format !== ARTIFACT_FORMAT)
    fail(
      'version',
      `Artifact format ${String(format)} is not supported (this runtime reads format ${ARTIFACT_FORMAT})`,
    )
  for (const key of data.keys()) {
    if (!ARTIFACT_KEYS.has(key))
      fail('version', `The artifact has a field "${key}" this runtime does not know`)
  }
  const string = (key: string): string => {
    const field = data.get(key)
    return typeof field === 'string'
      ? field
      : fail('shape', `The artifact's ${key} must be a string`)
  }
  const flag = (key: string): boolean => {
    const field = data.get(key)
    return typeof field === 'boolean'
      ? field
      : fail('shape', `The artifact's ${key} must be true or false`)
  }
  const source = string('source')
  if (source.length > settings.parseLimits.maxSourceLength)
    fail(
      'limit',
      `The artifact's source is longer than ${settings.parseLimits.maxSourceLength} characters`,
    )
  const plans = arrayData(data.get('plans'), settings.parseLimits.maxNodes, 'plans', 'limit').map(
    (entry, i): Plan => {
      const items = arrayData(entry, MAX_PLAN_LENGTH, `plans[${i}]`, 'plan')
      const [start, name, ...candidates] = items
      if (
        typeof start !== 'number' ||
        typeof name !== 'string' ||
        !candidates.every((c) => typeof c === 'number')
      )
        fail('shape', `plans[${i}] must be [nameStart, name, ...overload indices]`)
      return [start as number, name as string, ...(candidates as number[])]
    },
  )
  const expect = data.has('expect') ? copyType(data.get('expect')) : undefined
  return {
    bonsai: ARTIFACT_FORMAT,
    by: string('by'),
    source,
    plans,
    ...(expect === undefined ? {} : { expect }),
    guard: flag('guard'),
    async: flag('async'),
    digest: string('digest'),
  }
}

/** The calls of a bound tree by where their names start. */
function callsByStart(root: Node): Map<number, CallNode> {
  const calls = new Map<number, CallNode>()
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Node
    if (node.type === 'Call' && node.nameStart !== undefined) calls.set(node.nameStart, node)
    forEachChild(node, (child) => {
      stack.push(child)
    })
  }
  return calls
}

/** What a loaded artifact runs with: its analysis, result guard, and source. */
export interface Loaded {
  readonly source: string
  readonly analysis: ProgramAnalysis
  readonly guard: Type | undefined
}

/**
 * Loads an artifact against a runtime's definitions, refusing it with a
 * BonsaiArtifactError when it does not reproduce the checked program exactly:
 * a different format, source, plan, function, or declared variable type.
 */
export function loadArtifact(
  artifact: Artifact,
  settings: Settings,
  expect: Type | undefined,
): Loaded {
  const { source } = artifact
  let parsed: Node
  try {
    parsed = parse(source, settings.parseLimits)
  } catch (error) {
    if (!(error instanceof BonsaiError)) throw error
    return fail(
      error.code === 'SYNTAX' ? 'syntax' : 'limit',
      `The artifact's source cannot be parsed: ${error.message}`,
      error,
    )
  }
  const lookup = (name: string): FunctionDef | undefined =>
    settings.host.get(name) ?? BUILTINS.get(name)
  // Binding adds lambdas around arguments but no calls or variables, so the
  // digest is computed from the parsed tree as it is from the checked one:
  // different definitions are reported as such, before binding with them.
  for (const name of treeNames(parsed).functions) {
    if (lookup(name) === undefined)
      fail('function', `The artifact calls ${name}(), which this runtime does not define`)
  }
  const { digest, ...fields } = artifact
  if (artifactDigest(fields, parsed, lookup, settings.variables) !== digest)
    fail(
      'digest',
      'The artifact was made for different definitions than this runtime has; make it again from its source',
    )
  const bound = bindImplicit(parsed, lookup)
  if (bound.problems.length > 0) fail('binding', bound.problems[0].message)
  const root = bound.root

  const calls = new Map<CallNode, CallPlan>()
  const byStart = callsByStart(root)
  for (const call of byStart.values()) {
    const def = lookup(call.name) as FunctionDef
    calls.set(call, { def, candidates: def.overloads.map((_, i) => i) })
  }
  let previous = -1
  for (const [start, name, ...candidates] of artifact.plans) {
    const call = byStart.get(start)
    if (start <= previous || call === undefined || call.name !== name)
      fail('plan', `The artifact's plan for ${name}() at ${start} matches no call`)
    previous = start
    const def = lookup(name) as FunctionDef
    const count = def.overloads.length
    if (
      candidates.length === 0 ||
      candidates.length >= count ||
      !candidates.every(
        (c, i) =>
          Number.isSafeInteger(c) && c >= 0 && c < count && (i === 0 || c > candidates[i - 1]),
      )
    )
      fail(
        'plan',
        `The artifact's plan for ${name}() at ${start} is not a narrower set of its overloads`,
      )
    calls.set(call as CallNode, { def, candidates })
  }

  if (
    expect !== undefined &&
    (artifact.expect === undefined || encodeType(artifact.expect) !== encodeType(expect))
  )
    fail('expect', 'The artifact was not compiled for the expected type passed to load()')
  const analysis: ProgramAnalysis = { root, calls, async: artifact.async }
  warmZones(analysis)
  return {
    source,
    analysis,
    // The host's own expected type is always checked; the artifact's only where the checker asked.
    guard: expect ?? (artifact.guard ? artifact.expect : undefined),
  }
}

/** A key equal for two artifacts exactly when every field is (read with readArtifact). */
export function artifactKey(artifact: Artifact): string {
  return [
    lengthPrefixed(artifact.digest),
    lengthPrefixed(artifact.by),
    lengthPrefixed(artifact.source),
    lengthPrefixed(JSON.stringify(artifact.plans)),
    artifact.expect === undefined ? '-' : lengthPrefixed(encodeType(artifact.expect)),
    artifact.guard ? 'g' : '-',
    artifact.async ? 'a' : '-',
  ].join('')
}

/** Runs a loaded artifact as a program does. */
export function loadedRunner<R>(loaded: Loaded, settings: Settings) {
  return programRunner<R>({ ...loaded, settings })
}
