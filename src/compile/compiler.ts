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
import {
  BLOCKED_KEYS,
  add,
  chargeKey,
  contains,
  describeKind,
  divide,
  errorText,
  hasKey,
  isEqual,
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
  TEXT_SHIFT,
  toText,
  track,
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

/** Built-ins charge one extra step per 2^5 = 32 characters of string arguments. */
const ARGUMENT_COST_SHIFT = 5
/**
 * Steps charged per host function call unless the function declares its own
 * `cost`. Host calls often do real I/O, so one evaluation cannot make more
 * than maxSteps / cost of them.
 */
const DEFAULT_HOST_CALL_COST = 32
/** Map literals with at most this many entries and no nested values skip value tracking. */
const SMALL_MAP_ENTRIES = 8

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Host data (getters, Proxy traps, species or `then` hooks) can throw while
 * the engine reads it. Such failures surface as HOST_ERROR, never as a raw
 * JavaScript error.
 */
function hostDataError(error: unknown, s: State): unknown {
  if (error instanceof BonsaiError) return error
  return s.error('HOST_ERROR', `Reading host data failed: ${errorText(error)}`, undefined, error)
}

/** Whether `try()` recovers from an error: runtime failures, not limits or host contract violations. */
function recoverable(error: unknown): boolean {
  return error instanceof BonsaiRuntimeError && error.code !== 'HOST_CONTRACT'
}

/**
 * Compiles an analyzed tree. In `sync` mode every closure is synchronous. In
 * `async` mode only the nodes on a path to an async host call become async.
 */
export function compileProgram(analysis: Analysis, mode: 'sync' | 'async'): CompiledProgram {
  let slots = 0
  const allowAsync = mode === 'async'

  const sync = (fn: (s: State) => unknown): Code => ({ fn, async: false })
  const asyncCode = (fn: (s: State) => Promise<unknown>): Code => ({ fn, async: true })

  function compile(node: Node, scope: Scope): Code {
    switch (node.type) {
      case 'Literal': {
        const value = node.value
        return sync(() => value)
      }
      case 'Variable': {
        const name = node.name
        return sync((s) => {
          const ctx = s.ctx
          if (!Object.hasOwn(ctx, name)) return null
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
          if (typeof v !== 'number' || !Number.isFinite(v)) return negate(v, s, node)
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
          return strict1(object, (s, o) => hasKey(o, name, s))
        }
        const key = compile(target.index, scope)
        return strict2(object, key, (s, o, k) => hasKey(o, k, s))
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
              if (recoverable(hostDataError(error, s))) return f(s)
              throw hostDataError(error, s)
            }
          })
        }
        return asyncCode(async (s) => {
          try {
            return await body.fn(s)
          } catch (error) {
            if (recoverable(hostDataError(error, s))) return fallback.fn(s)
            throw hostDataError(error, s)
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
      // `.field` in a lambda over a list of plain objects: read inline.
      return sync((s) => {
        const o = s.locals[slot] as { constructor?: unknown } | null | undefined
        if (o?.constructor === Object)
          return Object.hasOwn(o, name) ? ((o as Record<string, unknown>)[name] ?? null) : null
        return readMember(o, name, s, node)
      })
    }
    const object = compile(base, scope)
    if (names.length === 1) {
      const name = names[0]
      return strict1(object, (s, o) => readMember(o, name, s, node))
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
      s.charge(1 + (out.length >>> TEXT_SHIFT))
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
      track(out, s, at)
      return out
    }
    if (codes.every((code) => !code.async)) {
      const fns = codes.map((code) => code.fn)
      if (!spreads.includes(true)) {
        const n = fns.length
        return sync((s) => {
          s.listLimit(n, at)
          const out = new Array<unknown>(n)
          for (let i = 0; i < n; i++) out[i] = fns[i](s)
          // Charged after the items, as the general (spread and async) path does.
          s.charge(1 + n)
          track(out, s, at)
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
    ): boolean => {
      // Returns whether the map may now need tracking (a nested value, or copied keys).
      if (step.kind === 'static') out[step.key] = value
      else if (step.kind === 'computed') out[mapKey(key, s, step.at)] = value
      else {
        if (value === null || value === undefined) return false
        if (!isMap(value))
          throw s.error(
            'TYPE_ERROR',
            `Only a map can be spread into a map, not ${describeKind(value)}`,
            step.at,
          )
        const keys = Object.keys(value)
        // Two per key: integer-like keys make the engine sort and stringify them.
        s.charge(2 * keys.length)
        for (const k of keys) {
          chargeKey(s, k)
          if (!BLOCKED_KEYS.has(k)) out[k] = value[k] === undefined ? null : value[k]
        }
        return true
      }
      return value !== null && typeof value === 'object'
    }
    // Small flat maps need no record (see `track`).
    const large = steps.length > SMALL_MAP_ENTRIES
    const isAsync = steps.some(
      (step) => step.value.async || (step.kind === 'computed' && step.key.async),
    )
    if (!isAsync) {
      const entryCost = 1 + steps.length
      return sync((s) => {
        const out = {}
        s.charge(entryCost)
        let nested = large
        for (const step of steps)
          if (
            assign(
              s,
              out,
              step,
              step.kind === 'computed' ? step.key.fn(s) : undefined,
              step.value.fn(s),
            )
          )
            nested = true
        if (nested) track(out, s, node)
        return out
      })
    }
    return asyncCode(async (s) => {
      const out = {}
      s.charge(1 + steps.length)
      let nested = large
      for (const step of steps) {
        const key = step.kind === 'computed' ? await step.key.fn(s) : undefined
        if (assign(s, out, step, key, await step.value.fn(s))) nested = true
      }
      if (nested) track(out, s, node)
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
      return (item: unknown, index: unknown) => {
        try {
          const result = run(item, index)
          return body.async ? annotateAsync(result as Promise<unknown>, index) : result
        } catch (error) {
          throw annotate(error, index)
        }
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
          // oxlint-disable-next-line typescript/prefer-for-of -- indexing never invokes a host array's own Symbol.iterator
          for (let j = 0; j < value.length; j++) out.push(value[j] === undefined ? null : value[j])
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
      // A built-in running async lambdas returns its own promise; only host promises are raced and checked.
      return isThenable(result) && def.host === true ? awaitHost(s, result, node, def) : result
    })
  }

  function makeInvoker(
    node: CallNode,
    plan: CallPlan,
  ): (s: State, args: unknown[], asyncLambdas: boolean) => unknown {
    const def = plan.def
    const overloads = plan.candidates.map((index) => def.overloads[index])
    const host = def.host === true
    const hostCost = def.cost ?? DEFAULT_HOST_CALL_COST
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
      s.charge(hostCost)
      let result: unknown
      let thenable: boolean
      try {
        result =
          def.context === true ? overload.run([s.ctx, ...args], site) : overload.run(args, site)
        thenable = isThenable(result)
      } catch (error) {
        throw hostError(s, def.name, error, span)
      }
      if (thenable) {
        if (!allowAsync || def.async !== true) {
          // Swallow the rejection of the orphaned promise; the call already failed.
          try {
            Promise.resolve(result).then(undefined, () => undefined)
          } catch {
            // A hostile thenable; nothing more to clean up.
          }
          if (def.async === true) {
            throw s.error(
              'ASYNC_IN_SYNC',
              `${def.name}() is async; use evaluate() instead of evaluateSync()`,
              span,
            )
          }
          throw s.error(
            'HOST_CONTRACT',
            `${def.name}() returned a promise but is not declared async`,
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
  const fn = root.fn
  const run = root.async
    ? (s: State): unknown =>
        (fn(s) as Promise<unknown>).catch((error: unknown) => {
          throw hostDataError(error, s)
        })
    : (s: State): unknown => {
        try {
          return fn(s)
        } catch (error) {
          throw hostDataError(error, s)
        }
      }
  return { run, async: root.async, localCount: slots }
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

/**
 * Every string or list a built-in returns is a produced value subject to the
 * size limits, and text it produces is charged by length (see TEXT_SHIFT).
 */
function checkProduced(s: State, result: unknown, span: Span): unknown {
  if (typeof result === 'string') {
    if (result.length > s.limits.maxStringLength) s.stringLimit(result.length, span)
    s.charge(result.length >>> TEXT_SHIFT)
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

/**
 * Whatever a host function throws is a HOST_ERROR with the original as its
 * cause, even a Bonsai error (say, a limit hit by an evaluation the host ran
 * itself): it failed in host code, not in this expression.
 */
function hostError(s: State, name: string, error: unknown, span: Span): BonsaiError {
  return s.error('HOST_ERROR', `${name}() failed: ${errorText(error)}`, span, error)
}

/**
 * Host results must conform, deeply, to the declared result type (checked
 * against the step budget); undefined reads as null. A mismatch is a broken
 * host contract, which `try()` does not recover from.
 */
function checkHostResult(
  s: State,
  def: FunctionDef,
  overload: Overload,
  result: unknown,
  span: Span,
): unknown {
  const value = result === undefined ? null : result
  if (!conforms(value, overload.result, s)) {
    throw s.error(
      'HOST_CONTRACT',
      `${def.name}() returned ${describeKind(value)}, which does not match its declared type ${formatType(overload.result)}`,
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
  // A rejection from the host is a HOST_ERROR; the limit errors racing it are not.
  const settled = Promise.resolve(promise).then(undefined, (error: unknown) => {
    throw hostError(s, node.name, error, node)
  })
  const result = await raceLimits(s, settled)
  s.checkTime()
  return checkHostResult(s, def, def.overloads[0], result, node)
}

/** The longest delay a timer accepts (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMER_DELAY = 2_147_483_647

/**
 * Waits for a host promise, rejecting early on timeout or abort. The signal is
 * host code: a listener method that throws counts as an abort, a cleanup that
 * throws is ignored, and the promise always settles exactly once.
 */
function raceLimits(s: State, promise: PromiseLike<unknown>): Promise<unknown> {
  const signal = s.signal
  const deadline = s.deadline
  if (signal === undefined && deadline === 0) return Promise.resolve(promise)
  // Rejection reasons are passed through unchanged; they are Bonsai errors or
  // whatever the host promise rejected with.
  return new Promise((resolve, reject: (reason: Error) => void) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      try {
        signal?.removeEventListener('abort', onAbort)
      } catch {
        // A broken signal cannot keep the evaluation from settling.
      }
    }
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    // An abort event (or a signal that fails) ends the wait even if the signal
    // does not read as aborted afterwards.
    const abort = (): void => {
      finish(() => {
        try {
          s.checkTime()
          reject(
            new BonsaiLimitError('ABORTED', 'Evaluation was aborted', {
              source: s.source,
              cause: s.signalError,
            }),
          )
        } catch (error) {
          reject(error as Error)
        }
      })
    }
    function onAbort(): void {
      abort()
    }
    const arm = (): void => {
      const wait = deadline - performance.now()
      timer = setTimeout(
        () => {
          // A deadline beyond the longest timer delay is reached in steps.
          if (wait > MAX_TIMER_DELAY) {
            arm()
            return
          }
          // The timer is set for the deadline, so it has passed even if the
          // clock reads a hair earlier (timers and performance.now() differ).
          finish(() => {
            reject(new BonsaiLimitError('TIMEOUT', 'Evaluation timed out', { source: s.source }))
          })
        },
        Math.min(MAX_TIMER_DELAY, Math.max(0, wait) + 1),
      )
    }
    if (deadline !== 0) arm()
    if (signal !== undefined) {
      try {
        signal.addEventListener('abort', onAbort, { once: true })
      } catch (error) {
        s.signalError = error
        abort()
      }
    }
    Promise.resolve(promise).then(
      (value) => {
        finish(() => {
          resolve(value)
        })
      },
      (error: unknown) => {
        finish(() => {
          reject(error as Error)
        })
      },
    )
  })
}

type Fn = (s: State) => unknown

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
        return isEqual(a, b, s)
      }
    case '!=':
      return (s) => {
        const a = l(s)
        const b = r(s)
        return !isEqual(a, b, s)
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
      return (s, a, b) => isEqual(a, b, s)
    case '!=':
      return (s, a, b) => !isEqual(a, b, s)
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
