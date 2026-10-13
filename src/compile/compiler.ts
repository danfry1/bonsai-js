import { BLOCKED_NAMES } from '../syntax/lexer.js'
import { signatureText, type Analysis, type CallPlan } from '../check/checker.js'
import { BonsaiLimitError, BonsaiRuntimeError, type BonsaiError, type Span } from '../errors.js'
import { guardDepth, isStackOverflow, tooDeep } from '../runtime/overflow.js'
import {
  conforms,
  matchesKind,
  Out,
  type CallSite,
  type FunctionDef,
  type Overload,
} from '../functions/define.js'
import { forHost, isOwn, raised } from '../runtime/attribution.js'
import type { State } from '../runtime/state.js'
import type { TraceRecord, Tracer } from '../runtime/trace.js'
import {
  add,
  chargeKey,
  contains,
  describeKind,
  divide,
  errorText,
  hasKey,
  isEqual,
  isMap,
  keyListCost,
  mapBuildCost,
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

/**
 * A compiled node: a closure over the per-run state. Async closures resolve to
 * an {@link Out}, so no value from the host is ever awaited.
 */
interface Code {
  readonly fn: (s: State) => unknown
  readonly async: boolean
}

/** A child run from an async closure: `(await boxed(code)(s)).v`, a sync child never awaited. */
function boxed(code: Code): (s: State) => Out | Promise<Out> {
  const fn = code.fn
  return code.async ? (fn as (s: State) => Promise<Out>) : (s) => new Out(fn(s))
}

export interface CompiledProgram {
  /** Runs the program; an async one resolves to an {@link Out}. */
  readonly run: (s: State) => unknown
  readonly async: boolean
  readonly localCount: number
}

interface Scope {
  readonly locals: ReadonlyMap<string, number>
  readonly it: number | undefined
}

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
 * JavaScript error. Only the errors this evaluation raised pass through: any
 * other Bonsai error a getter threw (from another evaluation, from parsing,
 * checking, or translating, or built by the host) is the host data's failure.
 */
function hostDataError(error: unknown, s: State): unknown {
  if (isOwn(error)) return error
  // Out of stack, in the engine's recursion or a getter it called (telling them
  // apart would mean wrapping every read): a limit, which try() lets through.
  if (isStackOverflow(error)) return raised(tooDeep(s.source, error))
  return s.error('HOST_ERROR', `Reading host data failed: ${errorText(error)}`, undefined, error)
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

/** Whether `try()` recovers from an error: runtime failures, not limits or host contract violations. */
function recoverable(error: unknown): boolean {
  return error instanceof BonsaiRuntimeError && error.code !== 'HOST_CONTRACT'
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
  /**
   * Free local names the compiled tree may read (for compiling a sub-tree
   * on its own). They occupy slots 0..n-1 in order; the caller stores their
   * values in `state.locals` before running.
   */
  readonly locals?: readonly string[]
  /**
   * Variables with fixed values (a partial-evaluation residual's bindings).
   * Reading one returns its value without looking in the context.
   */
  readonly constants?: ReadonlyMap<string, unknown>
  /**
   * The recorded size and depth of constants an evaluation built (partial
   * evaluation's folded lists and maps), so a residual nests them as the
   * original expression would, not as host data.
   */
  readonly shapes?: WeakMap<object, number> | undefined
}

export function compileProgram(
  analysis: Analysis,
  mode: 'sync' | 'async',
  options: CompileOptions = {},
): CompiledProgram {
  return guardDepth(undefined, () => compileTree(analysis, mode, options))
}

function compileTree(
  analysis: Analysis,
  mode: 'sync' | 'async',
  options: CompileOptions,
): CompiledProgram {
  let slots = 0
  const allowAsync = mode === 'async'
  const tracing = options.trace === true

  const sync = (fn: (s: State) => unknown): Code => ({ fn, async: false })
  const asyncCode = (fn: (s: State) => Promise<Out>): Code => ({ fn, async: true })

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
          throw failed(trace, error, s)
        } finally {
          tracer.exit()
        }
      })
    }
    return asyncCode(async (s) => {
      const tracer = s.tracer as Tracer
      const trace = tracer.enter(node)
      if (trace === undefined) return fn(s) as Promise<Out>
      try {
        const out = (await fn(s)) as Out
        trace.value = out.v
        return out
      } catch (error) {
        throw failed(trace, error, s)
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
        if (options.constants?.has(name) === true) {
          const value = options.constants.get(name)
          const shape =
            typeof value === 'object' && value !== null ? options.shapes?.get(value) : undefined
          if (shape === undefined) return sync(() => value)
          return sync((s) => {
            ;(s.shapes ??= new WeakMap()).set(value as object, shape)
            return value
          })
        }
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
        const [t, a, b] = [boxed(test), boxed(then), boxed(otherwise)]
        return asyncCode(async (s) => (truth((await t(s)).v, s, at, 'A condition') ? a(s) : b(s)))
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
        const [v, b] = [boxed(value), boxed(body)]
        return asyncCode(async (s) => {
          s.locals[slot] = (await v(s)).v
          return b(s)
        })
      }
      case 'Has': {
        const target = node.target
        const object = compile(target.object, scope)
        if (target.type === 'Member') {
          const name = target.name
          return strict1(object, (s, o) => hasKey(o, name, s, node))
        }
        const key = compile(target.index, scope)
        return strict2(object, key, (s, o, k) => hasKey(o, k, s, node))
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
              const failure = hostDataError(error, s)
              if (recoverable(failure)) return f(s)
              throw failure
            }
          })
        }
        const [b, f] = [boxed(body), boxed(fallback)]
        return asyncCode(async (s) => {
          try {
            return await b(s)
          } catch (error) {
            const failure = hostDataError(error, s)
            if (recoverable(failure)) return f(s)
            throw failure
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
    return asyncCode(async (s) => new Out(combine(s, ((await fa(s)) as Out).v)))
  }

  function strict2(a: Code, b: Code, combine: (s: State, x: unknown, y: unknown) => unknown): Code {
    const fa = a.fn
    const fb = b.fn
    if (!a.async && !b.async) return sync((s) => combine(s, fa(s), fb(s)))
    const [ba, bb] = [boxed(a), boxed(b)]
    return asyncCode(async (s) => {
      const x = (await ba(s)).v
      return new Out(combine(s, x, (await bb(s)).v))
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
    const runs = parts.map((part) => (typeof part === 'string' ? part : boxed(part)))
    return asyncCode(async (s) => {
      const values: unknown[] = []
      for (const run of runs) values.push(typeof run === 'string' ? run : (await run(s)).v)
      return new Out(build(s, values))
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
    const [bl, br] = [boxed(left), boxed(right)]

    if (tracing && (op === '&&' || op === '||')) return compileExplainedLogic(node, left, right)

    switch (op) {
      case '&&':
        if (!anyAsync)
          return sync(
            (s) => truth(l(s), s, node.left, '"&&"') && truth(r(s), s, node.right, '"&&"'),
          )
        return asyncCode(
          async (s) =>
            new Out(
              truth((await bl(s)).v, s, node.left, '"&&"') &&
                truth((await br(s)).v, s, node.right, '"&&"'),
            ),
        )
      case '||':
        if (!anyAsync)
          return sync(
            (s) => truth(l(s), s, node.left, '"||"') || truth(r(s), s, node.right, '"||"'),
          )
        return asyncCode(
          async (s) =>
            new Out(
              truth((await bl(s)).v, s, node.left, '"||"') ||
                truth((await br(s)).v, s, node.right, '"||"'),
            ),
        )
      case '??':
        if (!anyAsync) return sync((s) => l(s) ?? r(s))
        return asyncCode(async (s) => {
          const a = await bl(s)
          return a.v === null || a.v === undefined ? br(s) : a
        })
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

    if (!anyAsync) return sync(binaryOp(op, l, r, at))
    // Rare: the operands are awaited, then combined by the same closure.
    return asyncCode(async (s) => {
      const a = (await bl(s)).v
      const b = (await br(s)).v
      return new Out(
        binaryOp(
          op,
          () => a,
          () => b,
          at,
        )(s),
      )
    })
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
        // Only limits stop the extra work; its failures (host data included) are ignored.
        extraFailure(error, s)
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
    const [bl, br] = [boxed(left), boxed(right)]
    return asyncCode(async (s) => {
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
    const runs = codes.map(boxed)
    return asyncCode(async (s) => {
      const values: unknown[] = []
      for (const run of runs) values.push((await run(s)).v)
      return new Out(build(s, values))
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
        s.charge(keyListCost(keys.length) + mapBuildCost(keys.length))
        for (const k of keys) {
          chargeKey(s, k)
          // A key holding undefined is absent (see holdsKey), so it is not copied.
          if (BLOCKED_NAMES.has(k)) continue
          const v = value[k]
          if (v !== undefined) out[k] = v
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
    const runs = steps.map((step) => ({
      key: step.kind === 'computed' ? boxed(step.key) : undefined,
      value: boxed(step.value),
    }))
    return asyncCode(async (s) => {
      const out = {}
      s.charge(1 + steps.length)
      let nested = large
      for (let i = 0; i < steps.length; i++) {
        const { key, value } = runs[i]
        const k = key === undefined ? undefined : (await key(s)).v
        if (assign(s, out, steps[i], k, (await value(s)).v)) nested = true
      }
      if (nested) track(out, s, node)
      return new Out(out)
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
    // A lambda argument is the function built-ins call, never awaited.
    const runs = argCodes.map((code, i) =>
      kinds[i] === 'lambda' ? (s: State) => new Out(code.fn(s)) : boxed(code),
    )
    // Running async lambdas, a built-in resolves to an Out; so does an async host call.
    const settles = (lambdaAsync && def.host !== true) || hostAsync
    return asyncCode(async (s) => {
      const values = new Array<unknown>(runs.length)
      for (let i = 0; i < runs.length; i++) {
        values[i] = (await runs[i](s)).v
        if (i === 0 && optional && (values[0] === null || values[0] === undefined))
          return new Out(null)
      }
      const result = invoke(s, collect(s, values), lambdaAsync)
      return settles ? (result as Out | Promise<Out>) : new Out(result)
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
          return overload.runAsync(args, site).then((out) => new Out(checkProduced(s, out.v, span)))
        }
        return checkProduced(s, overload.run(args, site), span)
      }
      s.charge(hostCost)
      let result: unknown
      let thenable: boolean
      let controller: AbortController | undefined
      try {
        if (def.call === true) {
          controller = new AbortController()
          const call = Object.freeze({ context: s.hostCtx, signal: controller.signal })
          result = overload.run([call, ...args], site)
        } else {
          result = overload.run(args, site)
        }
        thenable = isThenable(result)
      } catch (error) {
        throw hostError(s, def.name, error, span)
      }
      if (thenable && controller !== undefined) callControllers.set(result as object, controller)
      if (thenable) {
        if (!allowAsync || def.async !== true) {
          // Swallow the rejection of the orphaned promise; the call already failed.
          try {
            // Only a native promise: calling a thenable's `then` would run host code.
            if (result instanceof Promise)
              void Promise.prototype.then.call(result, undefined, () => undefined)
          } catch {
            // A hostile thenable; nothing more to clean up.
          }
          const error =
            def.async === true
              ? s.error(
                  'ASYNC_IN_SYNC',
                  `${def.name}() is async; use evaluate() instead of evaluateSync()`,
                  span,
                )
              : s.error(
                  'HOST_CONTRACT',
                  `${def.name}() returned a promise but is not declared async`,
                  span,
                )
          // Nothing waits on that promise: tell the host function to stop its work.
          controller?.abort(forHost(error))
          throw error
        }
        return awaitHost(s, result as PromiseLike<unknown>, node, def)
      }
      s.checkTime()
      const checked = checkHostResult(s, def, overload, result, span)
      // An async call's closure expects an Out (see compileCall).
      return allowAsync && def.async === true ? new Out(checked) : checked
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

  const freeLocals = new Map<string, number>()
  for (const name of options.locals ?? []) freeLocals.set(name, slots++)
  const root = compile(analysis.root, { locals: freeLocals, it: undefined })
  const fn = root.fn
  const run = root.async
    ? (s: State): unknown =>
        (fn(s) as Promise<Out>).catch((error: unknown) => {
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
  for (const arg of args) if (typeof arg === 'string') cost += arg.length >>> TEXT_SHIFT
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
 * itself) or a stack overflow: it failed in host code, not in this expression,
 * and the depth limits leave host code most of the stack.
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
      `${def.name}() returned ${result === undefined ? 'undefined' : describeKind(value)}, which does not match its declared type ${formatType(overload.result)}`,
      span,
    )
  }
  return value
}

/**
 * The controller behind the `call.signal` a host function received, by the
 * promise it returned, so ending the wait early also aborts the host's work.
 */
const callControllers = new WeakMap<object, AbortController>()

async function awaitHost(
  s: State,
  promise: PromiseLike<unknown>,
  node: CallNode,
  def: FunctionDef,
): Promise<Out> {
  const controller = callControllers.get(promise)
  // A rejection from the host is a HOST_ERROR; the limit errors racing it are not.
  // The value is boxed, so a thenable it holds is never adopted in turn.
  const settled = Promise.resolve(promise).then(
    (value) => new Out(value),
    (error: unknown) => {
      throw hostError(s, node.name, error, node)
    },
  )
  const result = ((await raceLimits(s, settled, controller)) as Out).v
  s.checkTime()
  return new Out(checkHostResult(s, def, def.overloads[0], result, node))
}

/** The longest delay a timer accepts (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMER_DELAY = 2_147_483_647

/**
 * Waits for a host promise, rejecting early on timeout or abort. The signal is
 * host code: a listener method that throws counts as an abort, a cleanup that
 * throws is ignored, and the promise always settles exactly once. Ending the
 * wait early also aborts `controller`, the host call's own signal.
 */
function raceLimits(
  s: State,
  promise: PromiseLike<unknown>,
  controller?: AbortController,
): Promise<unknown> {
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
    // A limit ended the wait: reject, and tell the host function to stop.
    const fail = (error: Error): void => {
      reject(error)
      controller?.abort(forHost(error))
    }
    // An abort event (or a signal that fails) ends the wait even if the signal
    // does not read as aborted afterwards.
    const abort = (): void => {
      finish(() => {
        try {
          s.checkTime()
          fail(
            raised(
              new BonsaiLimitError('ABORTED', 'Evaluation was aborted', {
                source: s.source,
                cause: s.signalError,
              }),
            ),
          )
        } catch (error) {
          fail(error as Error)
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
            fail(s.limit('TIMEOUT', 'Evaluation timed out'))
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
    // A signal aborted (or a deadline passed) before the wait began.
    try {
      s.checkTime()
    } catch (error) {
      finish(() => {
        fail(error as Error)
      })
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

/**
 * One closure per strict operator, reading both operands itself: a shared
 * combinator would be a megamorphic call site (about 2x slower arithmetic).
 */
function binaryOp(op: BinaryNode['operator'], l: Fn, r: Fn, at: Span): Fn {
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
    case '/':
      return (s) => divide(l(s), r(s), s, at)
    case '%':
      return (s) => remainder(l(s), r(s), s, at)
    case '**':
      return (s) => power(l(s), r(s), s, at)
    case 'in':
      return (s) => {
        const a = l(s)
        return contains(r(s), a, s, at)
      }
    case 'not in':
      return (s) => {
        const a = l(s)
        return !contains(r(s), a, s, at)
      }
    case '&&':
    case '||':
    case '??':
    default:
      throw new Error('unreachable')
  }
}
