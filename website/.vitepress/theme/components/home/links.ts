import { computed, ref, type Ref } from 'vue'
import type { Trace } from 'bonsai-src'
import { display } from '../../../../scripts/format'

// What links the home page's explained expressions to their data: each
// condition that decided a result and each field the expression read, where
// it sits in the source and which data path it is (`order.total`), so
// hovering either side lights up the other.

export interface Range {
  start: number
  end: number
}

/** A field the expression read: `order.total` at 0..11. */
export interface Use extends Range {
  path: string
}

/** A condition of a boolean result, its value, the fields it read, and whether it decided the result. */
export interface Reason extends Range {
  text: string
  value: string
  reads: string[]
  decided: boolean
}

/** Whether a trace is a chain of fields on a variable (`order.total`), as opposed to on a lambda's item (`.status`). */
function isField(node: Trace): boolean {
  if (node.kind === 'Variable') return true
  return node.kind === 'Member' && node.children[0] !== undefined && isField(node.children[0])
}

/** Every field read, outermost first: `order.total`, not also `order`. */
export function usesOf(node: Trace): Use[] {
  if (node.evaluated && isField(node)) {
    return [{ path: node.text.replaceAll('?.', '.'), start: node.start, end: node.end }]
  }
  return node.children.flatMap(usesOf)
}

/** The operands of a chain of `&&` and `||`: `a && (b || c)` has conditions a, b and c. */
function conditions(node: Trace): Trace[] {
  if (node.kind === 'Binary' && (node.operator === '&&' || node.operator === '||')) {
    return node.children.flatMap(conditions)
  }
  return [node]
}

/**
 * Every condition of a boolean result, in source order, each marked by
 * whether it is one of the explanation's `reasons()`. Explain with
 * `exhaustive: true` so the conditions short-circuiting skips have values too.
 */
export function reasonsOf(root: Trace, deciding: readonly Trace[]): Reason[] {
  const decided = new Set(deciding.map((r) => r.id))
  return conditions(root).map((c) => ({
    text: c.text,
    start: c.start,
    end: c.end,
    value: c.evaluated ? display(c.value) : 'skipped',
    reads: [...new Set(usesOf(c).map((u) => u.path))],
    decided: decided.has(c.id),
  }))
}

/** Whether `path` is `parent` or inside it: `order.total` is inside `order`, `orders[0].id` inside `orders`. */
export const within = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`)

const related = (a: string, b: string) => within(a, b) || within(b, a)

/** The hovered condition or data path, and everything it lights up: conditions, data paths, and source ranges. */
export function useLinks(reasons: Ref<readonly Reason[]>, uses: Ref<readonly Use[]>) {
  const reason = ref<number>()
  const path = ref<string>()
  const lit = computed(() => {
    const r = reason.value === undefined ? undefined : reasons.value[reason.value]
    if (r) return { reasons: new Set([reason.value]), paths: r.reads, ranges: [r as Range] }
    const p = path.value
    if (p !== undefined) {
      return {
        reasons: new Set(reasons.value.flatMap((x, i) => (x.reads.some((q) => related(q, p)) ? [i] : []))),
        paths: [p],
        ranges: uses.value.filter((u) => related(u.path, p)) as Range[],
      }
    }
    return { reasons: new Set<number>(), paths: [] as string[], ranges: [] as Range[] }
  })
  /** Hover at a source offset: the condition there, else the field there. */
  function at(offset: number | undefined) {
    const inside = (x: Range) => offset !== undefined && x.start <= offset && offset < x.end
    const i = reasons.value.findIndex(inside)
    reason.value = i === -1 ? undefined : i
    path.value = i === -1 ? uses.value.find(inside)?.path : undefined
  }
  function clear() {
    reason.value = undefined
    path.value = undefined
  }
  return { reason, path, lit, at, clear }
}
