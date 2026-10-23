import { isItemLambdaPosition, isLambdaPosition, type FunctionDef } from '../functions/define.js'
import {
  forEachChild,
  mapChildren,
  type CallNode,
  type LambdaNode,
  type Node,
  type SpreadNode,
} from '../syntax/ast.js'

/** A `.` that binds to no lambda, or to the wrong parameter: an INVALID_LAMBDA diagnostic. */
export interface BindProblem {
  readonly message: string
  readonly at: { readonly start: number; readonly end: number }
}

export interface Bound {
  /** The tree with implicit lambdas made explicit. */
  readonly root: Node
  /** In the order the checker reports them. */
  readonly problems: readonly BindProblem[]
}

/**
 * Binds the implicit parameter: an argument in a lambda position of the called
 * function (per its overloads, see isLambdaPosition) that contains a free `.`
 * becomes an implicit Lambda. Depends only on the tree and the signatures of
 * the functions it calls, so the checker and code that compiles without it
 * bind every source the same way.
 */
export function bindImplicit(root: Node, lookup: (name: string) => FunctionDef | undefined): Bound {
  const problems: BindProblem[] = []
  // Binding only rewrites the tree around `.`; most expressions have none.
  if (!containsIt(root)) return { root, problems }

  /** Rewrites implicit lambdas as explicit ones; `free` when a `.` is left unbound. */
  function bind(node: Node): { node: Node; free: boolean } {
    if (node.type === 'It') return { node, free: true }
    if (node.type === 'Call') return bindCall(node)
    let free = false
    const out = mapChildren(node, (child) => {
      const r = bind(child)
      free ||= r.free
      return r.node
    })
    // A lambda outside a call argument position (the parser only allows
    // arguments, so this is a lambda in a non-function parameter).
    return { node: out, free: node.type === 'Lambda' ? false : free }
  }

  function bindCall(node: CallNode): { node: Node; free: boolean } {
    const def = lookup(node.name)
    let free = false
    let sawSpread = false
    const args = node.args.map((arg, index): Node | SpreadNode => {
      if (arg.type === 'Spread') {
        sawSpread = true
        const r = bind(arg.argument)
        free ||= r.free
        return { ...arg, argument: r.node }
      }
      // An unknown function reports itself; treat its arguments as lambdas so a
      // misspelled filter(.x) does not also report a stray `.`.
      const lambdaPosition = !sawSpread && (def === undefined || isLambdaPosition(def, index))
      if (arg.type === 'Lambda') {
        const body = bind(arg.body)
        if (body.free) {
          problems.push({
            message: 'Use the lambda parameter instead of "." inside an explicit lambda',
            at: findIt(body.node) ?? arg,
          })
        }
        return { ...arg, body: body.node }
      }
      const r = bind(arg)
      if (lambdaPosition && r.free) {
        if (def !== undefined && !isItemLambdaPosition(def, index)) {
          problems.push({
            message: `"." is the current item, but the first parameter of ${def.name}'s lambda is not; write the parameters, e.g. (acc, x) => acc + x`,
            at: findIt(r.node) ?? arg,
          })
        }
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

  const bound = bind(root)
  if (bound.free) {
    problems.push({
      message:
        '"." (the current item) must be inside an argument of a function that takes a lambda, e.g. items.filter(.active)',
      at: findIt(bound.node) ?? bound.node,
    })
  }
  return { root: bound.node, problems }
}

function containsIt(node: Node): boolean {
  if (node.type === 'It') return true
  let found = false
  forEachChild(node, (child) => {
    if (!found && containsIt(child)) found = true
  })
  return found
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
