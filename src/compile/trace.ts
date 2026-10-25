import { BonsaiLimitError, type BonsaiError } from '../errors.js'
import { Out } from '../functions/define.js'
import type { State } from '../runtime/state.js'
import type { TraceRecord, Tracer } from '../runtime/trace.js'
import { truth } from '../runtime/values.js'
import type { BinaryNode, LambdaNode, Node } from '../syntax/ast.js'
import { boxed, hostDataError, type Code } from './compiler.js'

/** A compiled lambda, as built-ins call it: (item, index) or (acc, item, index). */
type LambdaRun = (argA: unknown, argB: unknown, position?: number) => unknown

/**
 * How a traced program records what explain() reports. Only explain imports
 * this module, so ordinary evaluation bundles do not carry it.
 */
export interface TraceHooks {
  /** Wraps a node's code to record its value or failure. */
  node: (node: Node, code: Code) => Code
  /** && and ||, which exhaustive explaining evaluates on both sides. */
  logic: (node: BinaryNode, left: Code, right: Code) => Code
  /** Wraps a lambda so each run is recorded as an iteration of its call. */
  lambda: (node: LambdaNode, run: LambdaRun, async: boolean, s: State) => LambdaRun
}

/**
 * Records a node's failure on its trace, as the error evaluation reports: host
 * data's failure is a HOST_ERROR here too, not the code of an error it threw.
 */
function failed(trace: TraceRecord, error: unknown, s: State): unknown {
  const failure = hostDataError(error, s) as BonsaiError
  trace.error = { code: failure.code, message: failure.message }
  return failure
}

/** Rethrows a failure of exhaustive explain's extra work only if it is a limit. */
function extraFailure(error: unknown, s: State): void {
  const failure = hostDataError(error, s)
  if (failure instanceof BonsaiLimitError) throw failure
}

export const tracing: TraceHooks = {
  node(node, code) {
    const fn = code.fn
    if (!code.async) {
      return {
        async: false,
        fn: (s) => {
          const tracer = s.tracer as Tracer
          const trace = tracer.enter(node)
          if (trace === undefined) return fn(s)
          try {
            const value = fn(s)
            trace.value = value
            return value
          } catch (error) {
            throw failed(trace, error, s)
          } finally {
            tracer.exit()
          }
        },
      }
    }
    return {
      async: true,
      fn: async (s) => {
        const tracer = s.tracer as Tracer
        const trace = tracer.enter(node)
        if (trace === undefined) return fn(s)
        try {
          const out = (await fn(s)) as Out
          trace.value = out.v
          return out
        } catch (error) {
          throw failed(trace, error, s)
        } finally {
          tracer.exit()
        }
      },
    }
  },

  /**
   * With `exhaustive`, the side that short-circuiting would skip is still
   * evaluated (and traced) so every deciding condition is recorded; its
   * evaluation errors are ignored and the result is the ordinary one.
   */
  logic(node, left, right) {
    const isAnd = node.operator === '&&'
    const what = `"${node.operator}"`
    const extraSync = (s: State, r: (s: State) => unknown): void => {
      const tracer = s.tracer as Tracer
      tracer.extraDepth++
      try {
        r(s)
      } catch (error) {
        // Only limits stop the extra work; its failures (host data included) are ignored.
        extraFailure(error, s)
      } finally {
        tracer.extraDepth--
      }
    }
    if (!left.async && !right.async) {
      const [l, r] = [left.fn, right.fn]
      return {
        async: false,
        fn: (s) => {
          const a = truth(l(s), s, node.left, what)
          if (a !== isAnd) {
            if ((s.tracer as Tracer).exhaustive) extraSync(s, r)
            return a
          }
          return truth(r(s), s, node.right, what)
        },
      }
    }
    const [bl, br] = [boxed(left), boxed(right)]
    return {
      async: true,
      fn: async (s) => {
        const a = truth((await bl(s)).v, s, node.left, what)
        if (a !== isAnd) {
          const tracer = s.tracer as Tracer
          if (tracer.exhaustive) {
            tracer.extraDepth++
            try {
              await br(s)
            } catch (error) {
              extraFailure(error, s)
            } finally {
              tracer.extraDepth--
            }
          }
          return new Out(a)
        }
        return new Out(truth((await br(s)).v, s, node.right, what))
      },
    }
  },

  lambda(node, run, async, s) {
    return (argA, argB, position) => {
      const tracer = s.tracer as Tracer
      const recorded =
        position === undefined
          ? tracer.enterIteration(node, typeof argB === 'number' ? argB : 0, argA)
          : tracer.enterIteration(node, position, argB, argA)
      if (!async) {
        try {
          return run(argA, argB, position)
        } finally {
          tracer.exitIteration(recorded)
        }
      }
      return (async () => {
        try {
          return await run(argA, argB, position)
        } finally {
          tracer.exitIteration(recorded)
        }
      })()
    }
  },
}
