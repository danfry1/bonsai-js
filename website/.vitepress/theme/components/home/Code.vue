<script setup lang="ts">
import { computed } from 'vue'
import { segments } from './tokens'

// A Bonsai expression with the same syntax colours as the live editors, and
// optionally one range underlined (where the checker points). `tone` picks
// colours for a light or a dark background. Text is rendered with
// interpolation, never HTML.

const props = withDefaults(
  defineProps<{
    code: string
    mark?: { start: number; end: number; severity: 'error' | 'warning' }
    tone?: 'light' | 'dark'
    /** False keeps the code on one line: no break hints after `.` and `(` (browsers honour those even under nowrap). */
    wrap?: boolean
  }>(),
  { tone: 'light', wrap: true },
)

/** Coloured runs of `text`, each split after `.` and `(` so long code wraps between names, not inside one. */
const coloured = (text: string, offset: number) => {
  const all = segments(props.code)
  const out: { text: string; cls: string; pieces: string[] }[] = []
  let at = 0
  for (const s of all) {
    const start = Math.max(at, offset)
    const end = Math.min(at + s.text.length, offset + text.length)
    if (start < end) {
      const piece = props.code.slice(start, end)
      out.push({ text: piece, cls: s.cls, pieces: props.wrap ? piece.split(/(?<=[.(])/u) : [piece] })
    }
    at += s.text.length
  }
  return out
}

// The code in up to three parts, so the marked range gets one unbroken underline across its tokens.
const parts = computed(() => {
  const m = props.mark
  const end = m ? Math.min(Math.max(m.end, m.start + 1), props.code.length) : 0
  const ranges = m
    ? [
        { from: 0, to: m.start, marked: false },
        { from: m.start, to: end, marked: true },
        { from: end, to: props.code.length, marked: false },
      ]
    : [{ from: 0, to: props.code.length, marked: false }]
  return ranges
    .filter((r) => r.to > r.from)
    .map((r) => ({ marked: r.marked, runs: coloured(props.code.slice(r.from, r.to), r.from) }))
})
</script>

<template>
  <code class="bx" :class="`bx-${tone}`"><span
      v-for="(part, i) in parts"
      :key="i"
      :class="part.marked && mark ? `tk-mark-${mark.severity}` : undefined"
    ><span v-for="(run, j) in part.runs" :key="j" :class="run.cls"><template v-for="(piece, k) in run.pieces" :key="k">{{ piece }}<wbr v-if="wrap" /></template></span></span></code>
</template>

<style scoped>
.bx {
  font-family: var(--vp-font-family-mono);
  white-space: pre-wrap;
  /* Break between tokens, never inside a name. */
  overflow-wrap: normal;
  word-break: normal;
}

.bx-light {
  color: var(--vp-c-text-1);
}
.bx-light .tk-prop {
  color: var(--bonsai-syn-prop);
}
.bx-light .tk-fn {
  color: var(--vp-c-brand-1);
}
.bx-light .tk-str {
  color: var(--bonsai-syn-string);
}
.bx-light .tk-lit {
  color: var(--bonsai-syn-literal);
}
.bx-light .tk-punct {
  color: var(--vp-c-text-3);
}

.bx-dark {
  color: #eef4ec;
}
.bx-dark .tk-prop {
  color: #cfe0d3;
}
.bx-dark .tk-fn {
  color: #9fdcb4;
}
.bx-dark .tk-str {
  color: #e3b98f;
}
.bx-dark .tk-lit {
  color: #d9c46e;
}
.bx-dark .tk-punct {
  color: #8ea595;
}

/* Only the part the checker points at, like an editor's squiggle: one line under the whole range. */
.tk-mark-error,
.tk-mark-warning {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-thickness: 1.5px;
  text-underline-offset: 4px;
  text-decoration-skip-ink: none;
}
.tk-mark-error {
  text-decoration-color: var(--bonsai-error);
}
.tk-mark-warning {
  text-decoration-color: var(--bonsai-warning);
}
</style>
