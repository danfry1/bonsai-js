import { signatureText, type Analysis, type CallPlan } from '../check/checker.js'
import { BonsaiError, BonsaiLimitError, BonsaiRuntimeError, type Span } from '../errors.js'
import {
  conforms,
  matchesKind,
  type CallSite,
  type FunctionDef,
  type Overload,
} from '../functions/define.js'
import type { State } from '../runtime/state.js'
import { errorInfo, type Tracer } from '../runtime/trace.js'
import {
  BLOCKED_KEYS,
  add,
  contains,
  describeKind,
  divide,
  equals,
  hasKey,
  isMap,
  mapKey,
  multiply,
  negate,
  order,
  power,
  readIndex,
  readMember,
  remainder,
  subtract,
  toText,
  truth,
} from '../runtime/values.js'
import {
  forEachChild,
  type BinaryNode,
  type CallNode,
  type LambdaNode,
  type Node,
  type SpreadNode,
} from '../syntax/ast.js'
import { formatType } from '../types.js'

/** A compiled node: a closure over the per-run state. Async closures return promises. */
interface Code {
  readonly fn: (s: State) => unknown
  readonly async: boolean
}

export interface CompiledProgram {
  readonly run: (s: State) => unknown
  readonly async: boolean
  readonly localCount: number
}

interface Scope {
  readonly locals: ReadonlyMap<string, number>
  readonly it: number | undefined
}

const hasOwn = Object.hasOwn

/** Template rendering charges one extra step per 2^8 = 256 characters. */
const TEXT_COST_SHIFT = 8
/** Built-ins charge one extra step per 2^5 = 32 characters of string arguments. */
const ARGUMENT_COST_SHIFT = 5

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Compiles an analyzed tree. In `sync` mode every closure is synchronous. In
 * `async` mode only the nodes on a path to an async host call become async.
 */
export interface CompileOptions {
  /**
   * Instrument every node to record its value on `state.tracer` (for
   * explain()). Traced programs are compiled separately, so ordinary
   * evaluation pays nothing for tracing.
   */
  readonly trace?: boolean
}

export function compileProgram(
  analysis: Analysis,
  mode: 'sync' | 'async',
  options: CompileOptions = {},
): CompiledProgram {
  let slots = 0
  const allowAsync = mode === 'async'
  const tracing = options.trace === true

  const sync = (fn: (s: State) => unknown): Code => ({ fn, async: false })
  const asyncCode = (fn: (s: State) => Promise<unknown>): Code => ({ fn, async: true })

  function compile(node: Node, scope: Scope): Code {
    const code = compileNode(node, scope)
    return tracing ? instrument(node, code) : code
  }

  function instrument(node: Node, code: Code): Code {
    const fn = code.fn
    if (!code.async) {
      return sync((s) => {
        const tracer = s.tracer as Tracer
        const trace = tracer.enter(node)
        if (trace === undefined) return fn(s)
        try {
          const value = fn(s)
          trace.value = value
          return value
        } catch (error) {
          trace.error = errorInfo(error)
          throw error
        } finally {
          tracer.exit()
        }
      })
    }
    return asyncCode(async (s) => {
      const tracer = s.tracer as Tracer
      const trace = tracer.enter(node)
      if (trace === undefined) return fn(s)
      try {
        const value = await fn(s)
        trace.value = value
        return value
      } catch (error) {
        trace.error = errorInfo(error)
        throw error
      } finally {
        tracer.exit()
      }
    })
  }

  function compileNode(node: Node, scope: Scope): Code {
    switch (node.type) {
      case 'Literal': {
        const value = node.value
        return sync(() => value)
      }
      case 'Variable': {
        const name = node.name
        return sync((s) => {
          const ctx = s.ctx
          if (!hasOwn(ctx, name)) return null
          const value = ctx[name]
          return value === undefined ? null : value
        })
      }
      case 'Local': {
        const slot = scope.locals.get(node.name) as number
        return sync((s) => s.locals[slot])
      }
      case 'It': {
        const slot = scope.it as number
        return sync((s) => s.locals[slot])
      }
      case 'Member':
        return compileMember(node, scope)
      case 'Index': {
        const object = compile(node.object, scope)
        const index = compile(node.index, scope)
        return strict2(object, index, (s, o, k) => readIndex(o, k, s, node))
      }
      case 'Template':
        return compileTemplate(node, scope)
      case 'Unary': {
        const operand = compile(node.operand, scope)
        if (node.operator === '!')
          return strict1(operand, (s, v) => !truth(v, s, node.operand, '"!"'))
        return strict1(operand, (s, v) => {
          if (typeof v !== 'number') return negate(v, s, node)
          return v === 0 ? 0 : -v
        })
      }
      case 'Binary':
        return compileBinary(node, scope)
      case 'Conditional': {
        const test = compile(node.test, scope)
        const then = compile(node.then, scope)
        const otherwise = compile(node.otherwise, scope)
        const at = node.test
        if (!test.async && !then.async && !otherwise.async) {
          const [t, a, b] = [test.fn, then.fn, otherwise.fn]
          return sync((s) => (truth(t(s), s, at, 'A condition') ? a(s) : b(s)))
        }
        return asyncCode(async (s) =>
          truth(await test.fn(s), s, at, 'A condition') ? then.fn(s) : otherwise.fn(s),
        )
      }
      case 'List':
        return compileList(node.items, scope, node)
      case 'Map':
        return compileMap(node, scope)
      case 'Call':
        return compileCall(node, scope)
      case 'Lambda':
        throw new BonsaiRuntimeError(
          'TYPE_ERROR',
          'A lambda can only be passed to a function that takes one',
          {
            span: node,
          },
        )
      case 'Let': {
        const value = compile(node.value, scope)
        const slot = slots++
        const locals = new Map(scope.locals)
        locals.set(node.name, slot)
        const body = compile(node.body, { ...scope, locals })
        if (!value.async && !body.async) {
          const [v, b] = [value.fn, body.fn]
          return sync((s) => {
            s.locals[slot] = v(s)
            return b(s)
          })
        }
        return asyncCode(async (s) => {
          s.locals[slot] = await value.fn(s)
          return body.fn(s)
        })
      }
      case 'Has': {
        const target = node.target
        const object = compile(target.object, scope)
        if (target.type === 'Member') {
          const name = target.name
          return strict1(object, (_, o) => hasKey(o, name))
        }
        const key = compile(target.index, scope)
        return strict2(object, key, (_, o, k) => hasKey(o, k))
      }
      case 'Try': {
        const body = compile(node.body, scope)
        const fallback = compile(node.fallback, scope)
        if (!body.async && !fallback.async) {
          const [b, f] = [body.fn, fallback.fn]
          return sync((s) => {
            try {
              return b(s)
            } catch (error) {
              if (recoverable(error)) return f(s)
              throw error
            }
          })
        }
        return asyncCode(async (s) => {
          try {
            return await body.fn(s)
          } catch (error) {
            if (recoverable(error)) return fallback.fn(s)
            throw error
          }
        })
      }
    }
    throw new Error('unreachable')
  }

  // Strict nodes evaluate every child left to right, then combine. One
  // semantic function serves both the sync and the async closure.
  function strict1(a: Code, combine: (s: State, x: unknown) => unknown): Code {
    const fa = a.fn
    if (!a.async) return sync((s) => combine(s, fa(s)))
    return asyncCode(async (s) => combine(s, await fa(s)))
  }

  function strict2(a: Code, b: Code, combine: (s: State, x: unknown, y: unknown) => unknown): Code {
    const fa = a.fn
    const fb = b.fn
    if (!a.async && !b.async) return sync((s) => combine(s, fa(s), fb(s)))
    return asyncCode(async (s) => {
      const x = await fa(s)
      return combine(s, x, await fb(s))
    })
  }

  function compileMember(node: Extract<Node, { type: 'Member' }>, scope: Scope): Code {
    if (tracing) {
      // Every step of a.b.c is its own traced node.
      const object = compile(node.object, scope)
      const name = node.name
      return strict1(object, (s, o) => readMember(o, name, s, node))
    }
    // Fuse a chain of static member reads: a.b.c reads in one closure.
    const names: string[] = []
    const spans: Span[] = []
    let base: Node = node
    while (base.type === 'Member') {
      names.unshift(base.name)
      spans.unshift(base)
      base = base.object
    }
    if (names.length === 1 && (base.type === 'It' || base.type === 'Local')) {
      const slot = (base.type === 'It' ? scope.it : scope.locals.get(base.name)) as number
      const name = names[0]
      return sync((s) => {
        const o = s.locals[slot]
        if (o !== null && typeof o === 'object' && isMap(o)) {
          if (!hasOwn(o, name)) return null
          const value = o[name]
          return value === undefined ? null : value
        }
        return readMember(o, name, s, node)
      })
    }
    const object = compile(base, scope)
    if (names.length === 1) {
      const name = names[0]
      return strict1(object, (s, o) => {
        if (o !== null && typeof o === 'object' && !Array.isArray(o) && isMap(o)) {
          if (!hasOwn(o, name)) return null
          const value = o[name]
          return value === undefined ? null : value
        }
        return readMember(o, name, s, node)
      })
    }
    return strict1(object, (s, o) => {
      let value = o
      for (let i = 0; i < names.length; i++) {
        if (value === null || value === undefined) return null
        value = readMember(value, names[i], s, spans[i])
      }
      return value
    })
  }

  function compileTemplate(node: Extract<Node, { type: 'Template' }>, scope: Scope): Code {
    const parts = node.parts.map((part) => (typeof part === 'string' ? part : compile(part, scope)))
    const spans = node.parts.map((part) => (typeof part === 'string' ? node : part))
    const build = (s: State, values: unknown[]): string => {
      let out = ''
      for (let i = 0; i < values.length; i++) {
        const value = values[i]
        const piece = typeof value === 'string' ? value : toText(value, s, spans[i])
        s.stringLimit(out.length + piece.length, node)
        out += piece
      }
      s.charge(1 + (out.length >>> TEXT_COST_SHIFT))
      return out
    }
    if (parts.every((part) => typeof part === 'string' || !part.async)) {
      return sync((s) =>
        build(
          s,
          parts.map((part) => (typeof part === 'string' ? part : part.fn(s))),
        ),
      )
    }
    return asyncCode(async (s) => {
      const values: unknown[] = []
      for (const part of parts) values.push(typeof part === 'string' ? part : await part.fn(s))
      return build(s, values)
    })
  }

  function compileBinary(node: BinaryNode, scope: Scope): Code {
    const left = compile(node.left, scope)
    const right = compile(node.right, scope)
    const op = node.operator
    const at: Span = node
    const l = left.fn
    const r = right.fn
    const anyAsync = left.async || right.async

    if (tracing && (op === '&&' || op === '||')) return compileExplainedLogic(node, left, right)

    switch (op) {
      case '&&':
        if (!anyAsync)
          return sync(
            (s) => truth(l(s), s, node.left, '"&&"') && truth(r(s), s, node.right, '"&&"'),
          )
        return asyncCode(
          async (s) =>
            truth(await l(s), s, node.left, '"&&"') && truth(await r(s), s, node.right, '"&&"'),
        )
      case '||':
        if (!anyAsync)
          return sync(
            (s) => truth(l(s), s, node.left, '"||"') || truth(r(s), s, node.right, '"||"'),
          )
        return asyncCode(
          async (s) =>
            truth(await l(s), s, node.left, '"||"') || truth(await r(s), s, node.right, '"||"'),
        )
      case '??':
        if (!anyAsync) return sync((s) => l(s) ?? r(s))
        return asyncCode(async (s) => (await l(s)) ?? r(s))
      case '!=':
      case '%':
      case '*':
      case '**':
      case '+':
      case '-':
      case '/':
      case '<':
      case '<=':
      case '==':
      case '>':
      case '>=':
      case 'in':
      case 'not in':
      default:
        break
    }

    if (!anyAsync) {
      const fast = binaryFast(op, l, r, at)
      if (fast !== undefined) return sync(fast)
    }
    const combine = binaryCombiner(op, at)
    return strict2(left, right, combine)
  }

  /**
   * && and || when explaining. With `exhaustive`, the side that
   * short-circuiting would skip is still evaluated (and traced) so every
   * deciding condition is recorded; its evaluation errors are ignored and the
   * result is the ordinary one.
   */
  function compileExplainedLogic(node: BinaryNode, left: Code, right: Code): Code {
    const isAnd = node.operator === '&&'
    const what = `"${node.operator}"`
    const extraSync = (s: State, r: (s: State) => unknown): void => {
      const tracer = s.tracer as Tracer
      tracer.extraDepth++
      try {
        r(s)
      } catch (error) {
        if (!(error instanceof BonsaiRuntimeError)) throw error
      } finally {
        tracer.extraDepth--
      }
    }
    if (!left.async && !right.async) {
      const [l, r] = [left.fn, right.fn]
      return sync((s) => {
        const a = truth(l(s), s, node.left, what)
        if (a !== isAnd) {
          if ((s.tracer as Tracer).exhaustive) extraSync(s, r)
          return a
        }
        return truth(r(s), s, node.right, what)
      })
    }
    return asyncCode(async (s) => {
      const a = truth(await left.fn(s), s, node.left, what)
      if (a !== isAnd) {
        const tracer = s.tracer as Tracer
        if (tracer.exhaustive) {
          tracer.extraDepth++
          try {
            await right.fn(s)
          } catch (error) {
            if (!(error instanceof BonsaiRuntimeError)) throw error
          } finally {
            tracer.extraDepth--
          }
        }
        return a
      }
      return truth(await right.fn(s), s, node.right, what)
    })
  }

  function compileList(items: readonly (Node | SpreadNode)[], scope: Scope, at: Span): Code {
    const codes = items.map((item) =>
      item.type === 'Spread' ? compile(item.argument, scope) : compile(item, scope),
    )
    const spreads = items.map((item) => item.type === 'Spread')
    const build = (s: State, values: unknown[]): unknown[] => {
      let length = 0
      for (let i = 0; i < values.length; i++) {
        if (!spreads[i]) length++
        else {
          const value = values[i]
          if (value === null || value === undefined) continue
          if (!Array.isArray(value)) {
            throw s.error(
              'TYPE_ERROR',
              `Only a list can be spread into a list, not ${describeKind(value)}`,
              items[i],
            )
          }
          length += value.length
        }
      }
      s.listLimit(length, at)
      s.charge(1 + length)
      const out = new Array<unknown>(length)
      let k = 0
      for (let i = 0; i < values.length; i++) {
        const value = values[i]
        if (!spreads[i]) out[k++] = value
        else if (Array.isArray(value))
          // oxlint-disable-next-line typescript/prefer-for-of -- indexing never invokes a host array's own Symbol.iterator
          for (let j = 0; j < value.length; j++) out[k++] = value[j] === undefined ? null : value[j]
      }
      return out
    }
    if (codes.every((code) => !code.async)) {
      const fns = codes.map((code) => code.fn)
      if (!spreads.includes(true)) {
        const n = fns.length
        return sync((s) => {
          s.listLimit(n, at)
          s.charge(1 + n)
          const out = new Array<unknown>(n)
          for (let i = 0; i < n; i++) out[i] = fns[i](s)
          return out
        })
      }
      return sync((s) =>
        build(
          s,
          fns.map((fn) => fn(s)),
        ),
      )
    }
    return asyncCode(async (s) => {
      const values: unknown[] = []
      for (const code of codes) values.push(await code.fn(s))
      return build(s, values)
    })
  }

  function compileMap(node: Extract<Node, { type: 'Map' }>, scope: Scope): Code {
    type Step =
      | { kind: 'static'; key: string; value: Code }
      | { kind: 'computed'; key: Code; value: Code; at: Span }
      | { kind: 'spread'; value: Code; at: Span }
    const steps: Step[] = node.entries.map((entry): Step => {
      if (entry.type === 'Spread')
        return { kind: 'spread', value: compile(entry.argument, scope), at: entry }
      if (typeof entry.key === 'string')
        return { kind: 'static', key: entry.key, value: compile(entry.value, scope) }
      return {
        kind: 'computed',
        key: compile(entry.key, scope),
        value: compile(entry.value, scope),
        at: entry.key,
      }
    })
    const assign = (
      s: State,
      out: Record<string, unknown>,
      step: Step,
      key: unknown,
      value: unknown,
    ): void => {
      if (step.kind === 'static') out[step.key] = value
      else if (step.kind === 'computed') out[mapKey(key, s, step.at)] = value
      else {
        if (value === null || value === undefined) return
        if (!isMap(value))
          throw s.error(
            'TYPE_ERROR',
            `Only a map can be spread into a map, not ${describeKind(value)}`,
            step.at,
          )
        const keys = Object.keys(value)
        s.charge(keys.length)
        for (const k of keys)
          if (!BLOCKED_KEYS.has(k)) out[k] = value[k] === undefined ? null : value[k]
      }
    }
    const isAsync = steps.some(
      (step) => step.value.async || (step.kind === 'computed' && step.key.async),
    )
    if (!isAsync) {
      return sync((s) => {
        const out = {}
        s.charge(1)
        for (const step of steps)
          assign(
            s,
            out,
            step,
            step.kind === 'computed' ? step.key.fn(s) : undefined,
            step.value.fn(s),
          )
        return out
      })
    }
    return asyncCode(async (s) => {
      const out = {}
      s.charge(1)
      for (const step of steps) {
        const key = step.kind === 'computed' ? await step.key.fn(s) : undefined
        assign(s, out, step, key, await step.value.fn(s))
      }
      return out
    })
  }

  // === calls ===

  function compileLambda(node: LambdaNode, scope: Scope): Code {
    // Produces a closure that, given the run state, returns the JS function the
    // built-in will invoke. Parameters live in dedicated local slots.
    let inner: Scope
    let first: number
    let second = -1
    if (node.implicit) {
      first = slots++
      inner = { locals: scope.locals, it: first }
    } else {
      const locals = new Map(scope.locals)
      first = slots++
      locals.set(node.params[0] ?? '\0', first)
      if (node.params.length > 1) {
        second = slots++
        locals.set(node.params[1], second)
      }
      inner = { locals, it: undefined }
    }
    const body = compile(node.body, inner)
    const b = body.fn
    // Each invocation costs the static size of the body, so a large body run
    // over many items is bounded like the equivalent amount of written code.
    const cost = sizeOf(node.body)
    const make = (s: State) => {
      const locals = s.locals
      const run =
        second === -1
          ? (item: unknown) => {
              if ((s.steps += cost) >= s.nextSample) s.sample()
              locals[first] = item === undefined ? null : item
              return b(s)
            }
          : (item: unknown, index: unknown) => {
              if ((s.steps += cost) >= s.nextSample) s.sample()
              locals[first] = item === undefined ? null : item
              locals[second] = index === undefined ? null : index
              return b(s)
            }
      // Name the failing item: "... (at item 3)". Only the innermost lambda annotates.
      // Built-ins call lambdas as (item, index); reduce calls (acc, item, index).
      const annotated = (argA: unknown, argB: unknown, position?: number): unknown => {
        const index = position ?? argB
        try {
          const result = run(argA, argB)
          return body.async ? annotateAsync(result as Promise<unknown>, index) : result
        } catch (error) {
          throw annotate(error, index)
        }
      }
      if (!tracing) return annotated
      // Record each run as an iteration of the enclosing call.
      return (argA: unknown, argB: unknown, position?: number) => {
        const tracer = s.tracer as Tracer
        const recorded =
          position === undefined
            ? tracer.enterIteration(node, typeof argB === 'number' ? argB : 0, argA)
            : tracer.enterIteration(node, position, argB, argA)
        if (!body.async) {
          try {
            return annotated(argA, argB, position)
          } finally {
            tracer.exitIteration(recorded)
          }
        }
        return (async () => {
          try {
            return await annotated(argA, argB, position)
          } finally {
            tracer.exitIteration(recorded)
          }
        })()
      }
    }
    return { fn: make, async: body.async }
  }

  function compileCall(node: CallNode, scope: Scope): Code {
    const plan = analysis.calls.get(node)
    if (plan === undefined) {
      throw new BonsaiRuntimeError('NO_OVERLOAD', `Unknown function "${node.name}"`, { span: node })
    }
    const def = plan.def
    const argCodes: Code[] = []
    const kinds: ('value' | 'spread' | 'lambda')[] = []
    for (const arg of node.args) {
      if (arg.type === 'Spread') {
        argCodes.push(compile(arg.argument, scope))
        kinds.push('spread')
      } else if (arg.type === 'Lambda') {
        argCodes.push(compileLambda(arg, scope))
        kinds.push('lambda')
      } else {
        argCodes.push(compile(arg, scope))
        kinds.push('value')
      }
    }
    const invoke = makeInvoker(node, plan)
    const lambdaAsync = argCodes.some((code, i) => kinds[i] === 'lambda' && code.async)
    const valuesAsync = argCodes.some((code, i) => kinds[i] !== 'lambda' && code.async)
    const hostAsync = def.async === true && allowAsync
    const hasSpread = kinds.includes('spread')
    const optional = node.optional

    const collect = (s: State, values: unknown[]): unknown[] => {
      if (!hasSpread) return values
      const out: unknown[] = []
      for (let i = 0; i < values.length; i++) {
        const value = values[i]
        if (kinds[i] !== 'spread') out.push(value)
        else if (Array.isArray(value)) {
          s.charge(value.length)
          for (const item of value) out.push(item === undefined ? null : item)
        } else if (value !== null && value !== undefined) {
          throw s.error(
            'TYPE_ERROR',
            `Only a list can be spread into arguments, not ${describeKind(value)}`,
            node.args[i],
          )
        }
      }
      return out
    }

    if (!lambdaAsync && !valuesAsync && !hostAsync) {
      const fns = argCodes.map((code) => code.fn)
      const n = fns.length
      return sync((s) => {
        const values = new Array<unknown>(n)
        for (let i = 0; i < n; i++) {
          values[i] = fns[i](s)
          if (i === 0 && optional && (values[0] === null || values[0] === undefined)) return null
        }
        return invoke(s, collect(s, values), false)
      })
    }
    return asyncCode(async (s) => {
      const values = new Array<unknown>(argCodes.length)
      for (let i = 0; i < argCodes.length; i++) {
        values[i] = await argCodes[i].fn(s)
        if (i === 0 && optional && (values[0] === null || values[0] === undefined)) return null
      }
      const result = invoke(s, collect(s, values), lambdaAsync)
      return isThenable(result) ? awaitHost(s, result, node, def) : result
    })
  }

  function makeInvoker(
    node: CallNode,
    plan: CallPlan,
  ): (s: State, args: unknown[], asyncLambdas: boolean) => unknown {
    const def = plan.def
    const overloads = plan.candidates.map((index) => def.overloads[index])
    const host = def.host === true
    const span: Span = node

    const callOverload = (
      s: State,
      overload: Overload,
      args: unknown[],
      asyncLambdas: boolean,
    ): unknown => {
      const site: CallSite = { state: s, span }
      if (!host) {
        chargeArguments(s, args)
        if (asyncLambdas) {
          if (overload.runAsync === undefined)
            throw s.error('ASYNC_IN_SYNC', `${def.name}() cannot run an async lambda`, span)
          return overload.runAsync(args, site).then((result) => checkProduced(s, result, span))
        }
        return checkProduced(s, overload.run(args, site), span)
      }
      s.charge(1)
      let result: unknown
      try {
        result =
          def.context === true ? overload.run([s.ctx, ...args], site) : overload.run(args, site)
      } catch (error) {
        throw hostError(s, def, error, span)
      }
      if (isThenable(result)) {
        if (!allowAsync || def.async !== true) {
          // Swallow the rejection of the orphaned promise; the call already failed.
          Promise.resolve(result).then(undefined, () => undefined)
          throw s.error(
            'ASYNC_IN_SYNC',
            def.async === true
              ? `${def.name}() is async; use evaluate() instead of evaluateSync()`
              : `${def.name}() returned a promise but is not declared async`,
            span,
          )
        }
        return result
      }
      s.checkTime()
      return checkHostResult(s, def, overload, result, span)
    }

    // Static types describe declared data, but the context is not validated
    // against them, so argument kinds are always checked before a call.
    if (overloads.length === 1) {
      const overload = overloads[0]
      return (s, args, asyncLambdas) => {
        if (!matches(s, overload, args, host)) throw noOverload(s, def, node, args)
        return callOverload(s, overload, args, asyncLambdas)
      }
    }
    return (s, args, asyncLambdas) => {
      for (const overload of overloads) {
        if (matches(s, overload, args, host)) return callOverload(s, overload, args, asyncLambdas)
      }
      throw noOverload(s, def, node, args)
    }
  }

  const root = compile(analysis.root, { locals: new Map(), it: undefined })
  return { run: root.fn, async: root.async, localCount: slots }
}

function matches(s: State, overload: Overload, args: unknown[], host: boolean): boolean {
  const required = overload.required ?? overload.params.length
  if (args.length < required) return false
  if (args.length > overload.params.length && overload.rest === undefined) return false
  for (let i = 0; i < args.length; i++) {
    const param = overload.params[i] ?? overload.rest
    if (param === undefined) return false
    const arg = args[i]
    if (
      i >= required &&
      i < overload.params.length &&
      (arg === null || arg === undefined) &&
      param.kind !== 'function'
    ) {
      // An omitted-or-null optional argument uses the default.
      continue
    }
    if (host ? !conforms(arg, param, s) : !matchesKind(arg, param)) return false
  }
  return true
}

/**
 * Built-ins pay for the text they are given (string operations are linear in
 * their input). Work over list elements is charged by each built-in, since
 * many list operations (at, first, slice) touch only part of the list.
 */
function chargeArguments(s: State, args: unknown[]): void {
  let cost = 1
  for (const arg of args) if (typeof arg === 'string') cost += arg.length >>> ARGUMENT_COST_SHIFT
  s.charge(cost)
}

/** Every string or list a built-in returns is a produced value subject to the size limits. */
function checkProduced(s: State, result: unknown, span: Span): unknown {
  if (typeof result === 'string') {
    if (result.length > s.limits.maxStringLength) s.stringLimit(result.length, span)
  } else if (Array.isArray(result)) {
    if (result.length > s.limits.maxListLength) s.listLimit(result.length, span)
  }
  return result
}

function noOverload(
  s: State,
  def: FunctionDef,
  node: CallNode,
  args: unknown[],
): BonsaiRuntimeError {
  if (args.length > 0 && (args[0] === null || args[0] === undefined)) {
    return s.error(
      'NULL_RECEIVER',
      node.style === 'method'
        ? `Cannot call .${def.name}() on null; use ?.${def.name}() or ?? to supply a default`
        : `${def.name}() cannot take null as its first argument; use ?? to supply a default`,
      node,
    )
  }
  const shown = args
    .map((arg) => (typeof arg === 'function' ? 'a lambda' : describeKind(arg)))
    .join(', ')
  const signatures = def.overloads.map((overload) => signatureText(def.name, overload)).join('; ')
  return s.error(
    'NO_OVERLOAD',
    `${def.name}() cannot take (${shown}); expected ${signatures}`,
    node,
  )
}

function hostError(s: State, def: FunctionDef, error: unknown, span: Span): BonsaiError {
  if (error instanceof BonsaiError) return error
  const message = error instanceof Error ? error.message : String(error)
  return s.error('HOST_ERROR', `${def.name}() failed: ${message}`, span, error)
}

/** Host results must match the declared result kind; undefined reads as null. */
function checkHostResult(
  s: State,
  def: FunctionDef,
  overload: Overload,
  result: unknown,
  span: Span,
): unknown {
  const value = result === undefined ? null : result
  if (!matchesKind(value, overload.result)) {
    throw s.error(
      'HOST_ERROR',
      `${def.name}() returned ${describeKind(value)}, but declares ${formatType(overload.result)}`,
      span,
    )
  }
  return value
}

async function awaitHost(
  s: State,
  promise: PromiseLike<unknown>,
  node: CallNode,
  def: FunctionDef,
): Promise<unknown> {
  let result: unknown
  try {
    result = await raceLimits(s, promise)
  } catch (error) {
    if (error instanceof BonsaiError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw s.error('HOST_ERROR', `${node.name}() failed: ${message}`, node, error)
  }
  s.checkTime()
  return checkHostResult(s, def, def.overloads[0], result, node)
}

/** Waits for a host promise, rejecting early on timeout or abort. */
function raceLimits(s: State, promise: PromiseLike<unknown>): Promise<unknown> {
  const signal = s.signal
  const deadline = s.deadline
  if (signal === undefined && deadline === 0) return Promise.resolve(promise)
  // Rejection reasons are passed through unchanged; they are Bonsai errors or
  // whatever the host promise rejected with.
  return new Promise((resolve, reject: (reason: Error) => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      try {
        s.checkTime()
      } catch (error) {
        reject(error as Error)
      }
    }
    if (deadline !== 0) {
      timer = setTimeout(
        () => {
          cleanup()
          // The timer is set for the deadline, so it has passed even if the
          // clock reads a hair earlier (timers and performance.now() differ).
          reject(new BonsaiLimitError('TIMEOUT', 'Evaluation timed out', { source: s.source }))
        },
        Math.max(0, deadline - performance.now()) + 1,
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error as Error)
      },
    )
  })
}

type Fn = (s: State) => unknown

/**
 * What try() recovers from: evaluation errors, including failures in host
 * code such as a context getter. Limit errors (steps, size, time, abort) and
 * syntax/check errors are never recovered.
 */
function recoverable(error: unknown): boolean {
  return error instanceof BonsaiRuntimeError || !(error instanceof BonsaiError)
}

const annotated = new WeakSet()

function annotate(error: unknown, index: unknown): unknown {
  if (error instanceof BonsaiRuntimeError && typeof index === 'number' && !annotated.has(error)) {
    annotated.add(error)
    error.message = `${error.message} (at item ${index})`
  }
  return error
}

async function annotateAsync(result: Promise<unknown>, index: unknown): Promise<unknown> {
  try {
    return await result
  } catch (error) {
    throw annotate(error, index)
  }
}

function sizeOf(node: Node): number {
  let size = 1
  forEachChild(node, (child) => {
    size += sizeOf(child)
  })
  return size
}

/** Single-closure versions of the hottest operators (sync only). */
function binaryFast(op: BinaryNode['operator'], l: Fn, r: Fn, at: Span): Fn | undefined {
  switch (op) {
    case '==':
      return (s) => {
        const a = l(s)
        const b = r(s)
        return a === b || equals(a, b, s)
      }
    case '!=':
      return (s) => {
        const a = l(s)
        const b = r(s)
        return !(a === b || equals(a, b, s))
      }
    case '<':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') return a < b
        const o = order(a, b, s, at)
        return o !== undefined && o < 0
      }
    case '<=':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') return a <= b
        const o = order(a, b, s, at)
        return o !== undefined && o <= 0
      }
    case '>':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') return a > b
        const o = order(a, b, s, at)
        return o !== undefined && o > 0
      }
    case '>=':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') return a >= b
        const o = order(a, b, s, at)
        return o !== undefined && o >= 0
      }
    case '+':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') {
          const x = a + b
          if (Number.isFinite(x)) return x
        }
        return add(a, b, s, at)
      }
    case '-':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') {
          const x = a - b
          if (Number.isFinite(x)) return x
        }
        return subtract(a, b, s, at)
      }
    case '*':
      return (s) => {
        const a = l(s)
        const b = r(s)
        if (typeof a === 'number' && typeof b === 'number') {
          const x = a * b
          if (Number.isFinite(x)) return x
        }
        return multiply(a, b, s, at)
      }
    case '%':
    case '&&':
    case '**':
    case '/':
    case '??':
    case 'in':
    case 'not in':
    case '||':
    default:
      return undefined
  }
}

function binaryCombiner(
  op: BinaryNode['operator'],
  at: Span,
): (s: State, a: unknown, b: unknown) => unknown {
  switch (op) {
    case '==':
      return (s, a, b) => a === b || equals(a, b, s)
    case '!=':
      return (s, a, b) => !(a === b || equals(a, b, s))
    case '<':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a < b
        const r = order(a, b, s, at)
        return r !== undefined && r < 0
      }
    case '<=':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a <= b
        const r = order(a, b, s, at)
        return r !== undefined && r <= 0
      }
    case '>':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a > b
        const r = order(a, b, s, at)
        return r !== undefined && r > 0
      }
    case '>=':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a >= b
        const r = order(a, b, s, at)
        return r !== undefined && r >= 0
      }
    case 'in':
      return (s, a, b) => contains(b, a, s, at)
    case 'not in':
      return (s, a, b) => !contains(b, a, s, at)
    case '+':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') {
          const r = a + b
          if (Number.isFinite(r)) return r
        }
        return add(a, b, s, at)
      }
    case '-':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') {
          const r = a - b
          if (Number.isFinite(r)) return r
        }
        return subtract(a, b, s, at)
      }
    case '*':
      return (s, a, b) => {
        if (typeof a === 'number' && typeof b === 'number') {
          const r = a * b
          if (Number.isFinite(r)) return r
        }
        return multiply(a, b, s, at)
      }
    case '/':
      return (s, a, b) => divide(a, b, s, at)
    case '%':
      return (s, a, b) => remainder(a, b, s, at)
    case '**':
      return (s, a, b) => power(a, b, s, at)
    case '&&':
    case '||':
    case '??':
    default:
      throw new Error('unreachable')
  }
}
