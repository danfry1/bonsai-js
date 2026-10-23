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
import { encodeType } from './digest.js'
import type { Settings } from './environment.js'
import { BonsaiArtifactError, BonsaiError, type ArtifactProblem } from './errors.js'
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

/** Deeper than any type assertType accepts, counting the arrays that hold union members. */
const MAX_COPY_DEPTH = 256

/** Plans list overload indices, at most one fewer than a function's overloads. */
const MAX_PLAN_LENGTH = 66

const fail = (reason: ArtifactProblem, message: string, cause?: unknown): never => {
  throw new BonsaiArtifactError(reason, message, cause === undefined ? {} : { cause })
}

/**
 * Reads every own property of an object exactly once, through its descriptor,
 * so no getter runs and a Proxy's traps run once per property. Accessors and
 * symbol keys are malformed artifacts.
 */
function ownData(value: object, what: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('shape', `${what} has a symbol key`)
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) continue
    if (!('value' in descriptor)) fail('shape', `${what}.${String(key)} is an accessor`)
    out.set(key as string, descriptor.value)
  }
  return out
}

/** The elements of an array, read once each; `max` bounds the length before anything else is read. */
function arrayData(value: unknown, max: number, what: string, tooLong: ArtifactProblem): unknown[] {
  if (!Array.isArray(value)) return fail('shape', `${what} must be an array`)
  const data = ownData(value, what)
  const length = data.get('length')
  if (typeof length !== 'number') return fail('shape', `${what} has no length`)
  if (length > max) return fail(tooLong, `${what} has more than ${max} entries`)
  const out: unknown[] = []
  for (let i = 0; i < length; i++) out.push(data.get(String(i)))
  return out
}

/**
 * A copy of an expected type as plain data: objects become null-prototype
 * objects (so a `__proto__` key stays a field), every property is read once,
 * and the copy is bounded by MAX_EXPECT_NODES along every path, so shared
 * subtrees cannot hide its size.
 */
function copyType(value: unknown): Type {
  let nodes = 0
  const copy = (node: unknown, depth: number): unknown => {
    if (typeof node !== 'object' || node === null) return node
    if (++nodes > MAX_EXPECT_NODES)
      fail('limit', `The artifact's expected type has more than ${MAX_EXPECT_NODES} parts`)
    // assertType rejects types nested deeper than 64; this only bounds the copy's recursion
    // (a union's members sit one level further down, inside its array).
    if (depth > MAX_COPY_DEPTH) fail('shape', "The artifact's expected type nests too deeply")
    if (Array.isArray(node))
      return arrayData(node, MAX_EXPECT_NODES, 'expect', 'limit').map((item) =>
        copy(item, depth + 1),
      )
    const out = Object.create(null) as Record<string, unknown>
    for (const [key, field] of ownData(node, 'expect')) {
      Object.defineProperty(out, key, {
        value: copy(field, depth + 1),
        enumerable: true,
        writable: false,
      })
    }
    return out
  }
  const type = copy(value, 0)
  try {
    assertType(type, "The artifact's expected type")
  } catch (error) {
    return fail('shape', (error as Error).message, error)
  }
  return type
}

/** An artifact's fields, copied once and checked for shape and size. */
export function readArtifact(value: unknown, settings: Settings): Artifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('An artifact must be an object made by toArtifact()')
  const data = ownData(value, 'The artifact')
  if (!data.has('bonsai') || !data.has('source') || !data.has('digest'))
    throw new TypeError('An artifact must be an object made by toArtifact()')
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
  const bound = bindImplicit(parsed, lookup)
  if (bound.problems.length > 0) fail('binding', bound.problems[0].message)
  const root = bound.root
  for (const name of treeNames(root).functions) {
    if (lookup(name) === undefined)
      fail('function', `The artifact calls ${name}(), which this runtime does not define`)
  }
  const { digest, ...fields } = artifact
  if (artifactDigest(fields, root, lookup, settings.variables) !== digest)
    fail(
      'digest',
      'The artifact was made for different definitions than this runtime has; make it again from its source',
    )

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

const section = (value: string): string => `${value.length}:${value}`

/** A key equal for two artifacts exactly when every field is (read with readArtifact). */
export function artifactKey(artifact: Artifact): string {
  return [
    section(artifact.digest),
    section(artifact.by),
    section(artifact.source),
    section(JSON.stringify(artifact.plans)),
    artifact.expect === undefined ? '-' : section(encodeType(artifact.expect)),
    artifact.guard ? 'g' : '-',
    artifact.async ? 'a' : '-',
  ].join('')
}

/** Runs a loaded artifact as a program does. */
export function loadedRunner<R>(loaded: Loaded, settings: Settings) {
  return programRunner<R>({ ...loaded, settings })
}
