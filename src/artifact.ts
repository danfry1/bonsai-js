import { compiledFacts, type CompiledFacts } from './declared.js'
import { encodeFunction, encodeType, hash64 } from './digest.js'
import type { FunctionDef } from './functions/define.js'
import { forEachChild, type Node } from './syntax/ast.js'
import type { Type } from './types.js'
import { VERSION } from './version.js'

/** The artifact format this release writes and reads. */
const ARTIFACT_FORMAT = 1

/**
 * The most type nodes an artifact's `expect` may hold, counted along every
 * path (shared subtrees count each time they are reached), so a type that
 * repeats one subtree cannot hide its size. Its own constant rather than
 * maxNodes: a large `t.enum` compiles on a default environment and must load
 * on a default runtime.
 */
const MAX_EXPECT_NODES = 100_000

/**
 * A call whose checked candidates are narrower than its function's overloads:
 * `[nameStart, name, ...candidate overload indices]`.
 */
export type Plan = readonly [nameStart: number, name: string, ...candidates: number[]]

/**
 * A checked, compiled expression as plain JSON data, for `bonsai-js/runtime`
 * to load where the checker is not bundled. The source stays the record: a
 * full environment can always compile it again.
 */
export interface Artifact {
  /** Format version. */
  readonly bonsai: typeof ARTIFACT_FORMAT
  /** The bonsai-js version that produced it (informational). */
  readonly by: string
  readonly source: string
  /** The checker's overload choices where they are narrower than all overloads, by call. */
  readonly plans: readonly Plan[]
  /** The type the program was compiled to produce, if any. */
  readonly expect?: Type
  /** Whether the result must be checked against `expect` at run time. */
  readonly guard: boolean
  /** Whether evaluation may call an async host function. */
  readonly async: boolean
  /** Binds the artifact to the definitions the checker saw; see artifactDigest. */
  readonly digest: string
}

/** Throws RangeError when a type holds more than MAX_EXPECT_NODES nodes along all its paths. */
function assertExpectSize(type: Type, what: string): void {
  let count = 0
  const stack: Type[] = [type]
  while (stack.length > 0) {
    const next = stack.pop() as Type
    if (++count > MAX_EXPECT_NODES)
      throw new RangeError(`${what} has more than ${MAX_EXPECT_NODES} type nodes`)
    if (next.kind === 'list') stack.push(next.element)
    else if (next.kind === 'union') stack.push(...next.types)
    else if (next.kind === 'map') {
      stack.push(...Object.values(next.fields))
      if (next.rest !== undefined) stack.push(next.rest)
    }
  }
}

/** Names of the functions a bound tree calls and the context variables it reads. */
function treeNames(root: Node): { functions: string[]; variables: string[] } {
  const functions = new Set<string>()
  const variables = new Set<string>()
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Node
    if (node.type === 'Call') functions.add(node.name)
    else if (node.type === 'Variable') variables.add(node.name)
    forEachChild(node, (child) => {
      stack.push(child)
    })
  }
  return { functions: [...functions].sort(), variables: [...variables].sort() }
}

const section = (value: string): string => `${value.length}:${value}`

/**
 * The digest of an artifact: its fields (all but `digest`), every function the
 * bound tree calls, and the declared type of every variable it reads, since
 * the checker's overload choices and result guard depend on all of them. The
 * producer and the runtime compute it the same way, so a stale or edited
 * artifact fails to load instead of running with choices made for something
 * else.
 */
function artifactDigest(
  fields: Omit<Artifact, 'digest'>,
  root: Node,
  lookup: (name: string) => FunctionDef | undefined,
  variables: Readonly<Record<string, Type>> | undefined,
): string {
  const names = treeNames(root)
  const plans = fields.plans.map(([start, name, ...candidates]) =>
    section(`${start}:${section(name)}${candidates.join(',')}`),
  )
  const functions = names.functions.map((name) => {
    const def = lookup(name)
    return def === undefined ? section(`?${name}`) : section(encodeFunction(def))
  })
  const declared = names.variables.map((name) => {
    const type =
      variables !== undefined && Object.hasOwn(variables, name) ? variables[name] : undefined
    return section(`${section(name)}${type === undefined ? '?' : encodeType(type)}`)
  })
  return hash64(
    [
      `bonsai${fields.bonsai}`,
      section(fields.by),
      section(fields.source),
      section(plans.join('')),
      fields.expect === undefined ? '-' : section(encodeType(fields.expect)),
      fields.guard ? 'g' : '-',
      fields.async ? 'a' : '-',
      section(functions.join('')),
      section(declared.join('')),
    ].join(''),
  )
}

const artifacts = new WeakMap<object, Artifact>()

/**
 * A compiled program as plain JSON data, for `bonsai-js/runtime` to load and
 * evaluate without the checker. It records the source, the checker's overload
 * choices, the expected type, and a digest of the definitions they depend on,
 * so a runtime with different definitions refuses it instead of running it
 * differently. Throws TypeError for anything that is not a program compiled
 * by an environment, and RangeError when the expected type is too large for a
 * runtime to load (more than 100,000 type nodes).
 *
 * ```ts
 * const rule = env.compile('user.age >= 18', { expect: t.boolean() })
 * const artifact = toArtifact(rule) // store it, or send it to the browser
 * ```
 */
export function toArtifact(program: object): Artifact {
  const known = artifacts.get(program)
  if (known !== undefined) return known
  const facts = compiledFacts(program)
  if (facts === undefined) throw new TypeError('Not a program compiled by a Bonsai environment')
  const artifact = makeArtifact(facts)
  artifacts.set(program, artifact)
  return artifact
}

function makeArtifact({ source, analysis, expect, lookup, variables }: CompiledFacts): Artifact {
  if (expect !== undefined) assertExpectSize(expect, 'The expected type')
  const plans: Plan[] = []
  for (const [call, plan] of analysis.calls) {
    if (plan.candidates.length === plan.def.overloads.length) continue
    // The parser always sets nameStart; a call without one could not be matched on load.
    if (call.nameStart === undefined)
      throw new TypeError(`The call to ${call.name}() has no name position`)
    plans.push([call.nameStart, call.name, ...plan.candidates])
  }
  plans.sort((a, b) => a[0] - b[0])
  const fields: Omit<Artifact, 'digest'> = {
    bonsai: ARTIFACT_FORMAT,
    by: VERSION,
    source,
    plans,
    ...(expect === undefined ? {} : { expect }),
    guard: expect !== undefined && analysis.checkResult,
    async: analysis.async,
  }
  const digest = artifactDigest(fields, analysis.root, lookup, variables)
  return deepFreeze({ ...fields, digest })
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
