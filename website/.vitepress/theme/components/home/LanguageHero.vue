<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import type { Compartment, Extension } from '@codemirror/state'
import { bonsai, formatType, type Diagnostic } from 'bonsai-src'
import { display } from '../../../../scripts/format'
import Code from './Code.vue'
import DataView from './DataView.vue'
import { reasonsOf, useLinks, usesOf, type Range, type Reason, type Use } from './links'
import { tabs } from './tabs-data'

// The hero: one live Bonsai editor (CodeMirror running the bonsai-js language
// service), with a tab for each place an expression typically lives. Each tab
// has its own declared types and sample data; the panel beside the editor shows
// what Bonsai makes of the expression: the problems it finds, or the result and
// the conditions that decided it. Hovering a condition, a field in the editor,
// or a value in the data lights up what it is linked to. All text is rendered
// with interpolation, never HTML.

const active = ref(0)
const tab = computed(() => tabs[active.value])
const envs = tabs.map((t) => bonsai({ variables: t.variables, limits: { timeout: 50 } }))
const env = computed(() => envs[active.value])
const source = ref(tabs[0].expression)
/**
 * The text the panel reports on: `source` once typing pauses, so the panel
 * doesn't flip between errors and results on every keystroke. Tab switches
 * and fixes apply at once.
 */
const settled = ref(source.value)
let settleTimer: ReturnType<typeof setTimeout> | undefined
watch(source, (next) => {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => (settled.value = next), 450)
})
function settleNow() {
  clearTimeout(settleTimer)
  settled.value = source.value
}
const typing = computed(() => source.value !== settled.value)

const check = computed(() => env.value.check(settled.value, { expect: tab.value.expect }))

const outcome = computed(() => {
  if (!check.value.ok) return undefined
  try {
    const explanation = env.value.compile(settled.value, { expect: tab.value.expect }).explainSync(tab.value.data, { exhaustive: true })
    if (!explanation.ok) return { error: explanation.error.message }
    const reasons = typeof explanation.value === 'boolean' ? reasonsOf(explanation.trace, explanation.reasons()) : []
    return {
      said: tab.value.outcome?.(explanation.value),
      value: display(explanation.value),
      type: formatType(check.value.type!),
      reasons,
      uses: usesOf(explanation.trace),
    }
  } catch (error) {
    return { error: (error as Error).message }
  }
})

// ── Hover links ──────────────────────────────────────────────────
const reasons = computed<Reason[]>(() => (outcome.value && 'reasons' in outcome.value ? outcome.value.reasons : []))
const uses = computed<Use[]>(() => (outcome.value && 'uses' in outcome.value ? outcome.value.uses : []))
const { reason: hoveredReason, path: hoveredPath, lit, at, clear } = useLinks(reasons, uses)
watch([active, typing], clear)

function hoverPath(path: string | undefined) {
  if (typing.value) return
  hoveredReason.value = undefined
  hoveredPath.value = path
}

/** Each variable's declared type, shown when hovering its line of data. */
const types = computed(() =>
  Object.fromEntries(Object.entries(tab.value.variables).map(([name, type]) => [name, `${name}: ${formatType(type)}`])),
)

// ── The editor ───────────────────────────────────────────────────
const host = ref<HTMLElement>()
const view = shallowRef<EditorView>()
let language: Compartment | undefined
let languageFor: ((index: number) => Extension) | undefined
let quotes: Compartment | undefined
let quotesFor: ((index: number) => Extension) | undefined
let marks: Compartment | undefined
let marksFor: ((ranges: readonly Range[]) => Extension) | undefined

onMounted(async () => {
  const [
    { EditorState, Compartment },
    { EditorView, Decoration, WidgetType },
    { createLanguageService },
    { bonsaiLanguage },
    { bonsaiHighlight },
  ] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('bonsai-service'),
    import('../codemirror/bonsai-language'),
    import('./highlight'),
  ])
  if (!host.value) return
  language = new Compartment()
  languageFor = (index) => bonsaiLanguage(createLanguageService(envs[index], { expect: tabs[index].expect }))
  // A JSON value's quotes, drawn at either end of the text: not part of the expression, never editable.
  class Quote extends WidgetType {
    toDOM() {
      const span = document.createElement('span')
      span.className = 'cm-json-quote'
      span.textContent = '"'
      return span
    }
    eq() {
      return true
    }
  }
  const open = Decoration.widget({ widget: new Quote(), side: -1 })
  const close = Decoration.widget({ widget: new Quote(), side: 1 })
  quotes = new Compartment()
  quotesFor = (index) =>
    tabs[index].json
      ? EditorView.decorations.of((v) => Decoration.set([open.range(0), close.range(v.state.doc.length)]))
      : []
  marks = new Compartment()
  const lit = Decoration.mark({ class: 'cm-lit' })
  marksFor = (ranges) =>
    EditorView.decorations.of(
      Decoration.set(
        ranges.filter((r) => r.start < r.end && r.end <= source.value.length).map((r) => lit.range(r.start, r.end)),
        true,
      ),
    )
  view.value = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: source.value,
      extensions: [
        language.of(languageFor(active.value)),
        quotes.of(quotesFor(active.value)),
        marks.of([]),
        bonsaiHighlight,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Bonsai expression', spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) source.value = u.state.doc.toString()
        }),
        // Hovering the text lights up the condition or field under the pointer, once the panel matches the text.
        EditorView.domEventHandlers({
          mousemove(event, target) {
            if (!typing.value) at(target.posAtCoords({ x: event.clientX, y: event.clientY }, false) ?? undefined)
          },
          mouseleave: () => clear(),
        }),
      ],
    }),
  })
  host.value.dataset.ready = ''
})

watch(
  () => lit.value.ranges,
  (ranges) => {
    if (view.value && marks && marksFor) view.value.dispatch({ effects: marks.reconfigure(marksFor(ranges)) })
  },
)

onBeforeUnmount(() => {
  clearTimeout(settleTimer)
  view.value?.destroy()
})

function choose(index: number) {
  active.value = index
  const target = view.value
  if (!target || !language || !languageFor || !quotes || !quotesFor) {
    source.value = tabs[index].expression
  } else {
    target.dispatch({
      changes: { from: 0, to: target.state.doc.length, insert: tabs[index].expression },
      effects: [language.reconfigure(languageFor(index)), quotes.reconfigure(quotesFor(index))],
    })
  }
  settleNow()
}

function applyFix(d: Diagnostic) {
  const target = view.value
  if (!target || d.suggestion === undefined) return
  target.dispatch({ changes: { from: d.start, to: d.end, insert: d.suggestion } })
  settleNow()
  target.focus()
}

function reset() {
  choose(active.value)
}
</script>

<template>
  <div class="lh">
    <div class="tabs" role="tablist" aria-label="Where the expression lives">
      <button
        v-for="(t, i) in tabs"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="i === active"
        class="tab"
        @click="choose(i)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- The same three rows on every tab, read top to bottom: the expression, the data it runs on, what it gives. -->
    <div class="body">
      <h3 class="title">{{ tab.title }}</h3>

      <div class="row">
        <p class="label">Expression</p>
        <div class="cell">
          <!--
            In JSON, the editor is the value of its key, on its own indented line (still valid JSON), and
            draws the string's quotes itself so the closing one follows the text however it wraps.
          -->
          <div class="frame" :class="{ json: tab.json }">
            <template v-if="tab.json">
              <code v-for="line in tab.json.before" :key="line" class="json-line">{{ line }}</code>
              <code class="json-line">{{ `  "${tab.json.key}":` }}</code>
            </template>
            <div ref="host" class="editor">
              <pre class="editor-fallback">{{ tab.json ? `"${source}"` : source }}</pre>
            </div>
            <code v-for="line in tab.json?.after ?? []" :key="line" class="json-line">{{ line }}</code>
          </div>
          <p class="hint">
            Edit it, or hover any part.
            <button type="button" class="reset" :class="{ hidden: source === tab.expression }" @click="reset">
              Reset
            </button>
          </p>
        </div>
      </div>

      <div class="row">
        <p class="label">Data</p>
        <div class="cell">
          <DataView :data="tab.data" :lit="lit.paths" :types="types" @hover="hoverPath" />
        </div>
      </div>

      <div class="row result" :class="{ stale: typing }" aria-live="polite">
        <p class="label">Result</p>
        <div v-if="check.diagnostics.some((d) => d.severity === 'error')" class="cell">
          <p class="caught">Caught before it runs</p>
          <div v-for="d in check.diagnostics" :key="d.code + d.start" class="diag">
            <p>{{ d.message }}</p>
            <button v-if="d.suggestion" type="button" class="fix" @click="applyFix(d)">
              Use <code>{{ d.suggestion }}</code>
            </button>
          </div>
        </div>
        <div v-else-if="outcome && 'value' in outcome" class="cell outcome">
          <div>
            <p v-if="outcome.said" class="said">{{ outcome.said }}</p>
            <p class="value" :class="{ small: outcome.said }">
              {{ outcome.value }} <span class="type">{{ outcome.type }}</span>
            </p>
            <p v-for="d in check.diagnostics" :key="d.code + d.start" class="warn">{{ d.message }}</p>
          </div>
          <ul v-if="outcome.reasons.length" class="parts" @mouseleave="clear()">
            <li
              v-for="(r, i) in outcome.reasons"
              :key="r.start"
              :class="{ lit: lit.reasons.has(i), aside: !r.decided }"
              @mouseenter="at(r.start)"
            >
              <Code :code="r.text" />
              <span class="chip" :class="r.value">{{ r.value }}</span>
            </li>
          </ul>
        </div>
        <div v-else-if="outcome && 'error' in outcome" class="cell">
          <p class="caught">Stopped safely</p>
          <p class="diag">{{ outcome.error }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lh {
  border-radius: 16px;
  overflow: hidden;
  background: var(--bonsai-card);
  box-shadow:
    var(--bonsai-card-shadow),
    0 40px 80px -40px rgba(10, 30, 18, 0.35);
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 10px 14px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.tab {
  padding: 8px 14px 10px;
  border-bottom: 2px solid transparent;
  color: var(--vp-c-text-2);
  font-size: 14px;
  font-weight: 500;
}

.tab:hover {
  color: var(--vp-c-text-1);
}

.tab[aria-selected='true'] {
  color: var(--vp-c-text-1);
  border-bottom-color: var(--vp-c-brand-1);
}

/*
 * Every tab gets the height of the tallest (the config file; the saved filter
 * on a phone), and the result row takes the spare, so switching tabs or
 * typing never moves the page.
 */
.body {
  display: flex;
  flex-direction: column;
  min-height: 460px;
  padding: 22px 28px 8px;
}

.title {
  margin: 0 0 6px;
  padding: 0;
  border: 0;
  font-family: var(--bonsai-font-display);
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--vp-c-text-1);
}

/* A labelled row: the label in a narrow column, aligned to the first line of its content. */
.row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 6px 20px;
  align-items: baseline;
  padding: 16px 0;
  border-top: 1px solid var(--vp-c-divider);
}

.row > .label {
  padding-top: 2px;
}

.cell {
  min-width: 0;
}

.result {
  flex: 1;
  transition: opacity 0.15s;
}

.result.stale {
  opacity: 0.45;
}

.outcome {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px 32px;
}

.caught {
  margin: 0;
  color: var(--bonsai-error);
  font-weight: 600;
}

.reset.hidden {
  visibility: hidden;
}

.frame {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.frame:focus-within {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px var(--vp-c-brand-soft);
}

/* The JSON around the editor, in the same font and size so it reads as one document. */
.frame.json {
  padding: 12px 0;
}

.json-line {
  display: block;
  padding: 0 16px;
  font-family: var(--vp-font-family-mono);
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--vp-c-text-3);
  white-space: pre;
}

/* The value, indented one level under its key: 16px gutter plus four spaces. */
.frame.json .editor-fallback,
.frame.json .editor :deep(.cm-content) {
  padding: 0 16px 0 calc(16px + 4ch);
}

.editor :deep(.cm-json-quote) {
  color: var(--bonsai-syn-string);
}

.frame.json .editor :deep(.cm-line) {
  padding: 0;
}

.editor-fallback,
.editor :deep(.cm-content) {
  margin: 0;
  padding: 14px 10px;
  font-family: var(--vp-font-family-mono);
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
  caret-color: var(--vp-c-text-1);
}

.editor-fallback {
  padding: 14px 16px;
  white-space: pre-wrap;
}

.editor[data-ready] .editor-fallback {
  display: none;
}

.editor :deep(.cm-editor) {
  background: transparent;
}

.editor :deep(.cm-editor.cm-focused) {
  outline: none;
}

.editor :deep(.cm-line) {
  padding: 0 6px;
}

.editor :deep(.tk-prop) {
  color: var(--bonsai-syn-prop);
}
.editor :deep(.tk-name) {
  color: var(--vp-c-text-1);
}
.editor :deep(.tk-fn) {
  color: var(--vp-c-brand-1);
}
.editor :deep(.tk-str) {
  color: var(--bonsai-syn-string);
}
.editor :deep(.tk-lit) {
  color: var(--bonsai-syn-literal);
}
.editor :deep(.tk-punct) {
  color: var(--vp-c-text-3);
}

.editor :deep(.cm-tooltip) {
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  box-shadow: 0 12px 30px -12px rgba(0, 0, 0, 0.3);
  font-size: 13.5px;
  overflow: hidden;
}

.editor :deep(.cm-tooltip-autocomplete > ul) {
  font-family: var(--vp-font-family-mono);
  max-width: min(440px, 80vw);
}

.editor :deep(.cm-tooltip-autocomplete > ul > li[aria-selected]) {
  background: var(--vp-c-brand-1);
  color: var(--bonsai-on-brand);
}

.editor :deep(.cm-completionDetail) {
  margin-left: 1em;
  opacity: 0.75;
  font-style: normal;
}

.hint {
  margin: 10px 2px 0;
  color: var(--vp-c-text-3);
  font-size: 13px;
}

.reset {
  margin-left: 6px;
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

/* The sample data the expression runs against, always visible; each line's declared type is its tooltip. */
.label {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 600;
}

.bad-label {
  color: var(--bonsai-error);
}

.value {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 20px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  overflow-wrap: anywhere;
}

/* What the app does with the result, in words; the value it came from sits under it. */
.said {
  margin: 0;
  font-family: var(--bonsai-font-display);
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.value.small {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.type {
  margin-left: 6px;
  color: var(--vp-c-text-3);
  font-size: 13px;
  font-weight: 400;
}

/* The conditions that decided the result, each with its value; hovering one lights up what it read. */
.parts {
  margin: 0;
  padding: 0;
  list-style: none;
}

.parts li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin: 0 -8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 14px;
  cursor: default;
  transition: background-color 0.12s;
}

.parts li.lit {
  background: var(--bonsai-lit);
}

/* A condition that held but didn't decide the result (the true side of a false &&). */
.parts li.aside {
  opacity: 0.6;
}

.chip {
  flex: none;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.chip.true {
  color: var(--vp-c-brand-1);
}

.chip.false {
  color: var(--bonsai-error);
}

/* No radius: the mark is split at every token, and the pieces should read as one band. */
.editor :deep(.cm-lit) {
  background: var(--bonsai-lit);
}

.diag code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
  color: var(--vp-c-text-1);
}

.diag {
  margin: 8px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bonsai-error);
  color: var(--vp-c-text-1);
  font-size: 14px;
  line-height: 1.5;
}

.diag p {
  margin: 0;
}

.warn {
  margin: 12px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bonsai-warning);
  color: var(--vp-c-text-2);
  font-size: 13.5px;
}

.fix {
  margin-top: 8px;
  padding: 3px 12px;
  border-radius: 6px;
  background: var(--vp-c-brand-1);
  color: var(--bonsai-on-brand);
  font-size: 13.5px;
  font-weight: 500;
}

.fix code {
  color: inherit;
}

/* Narrow: each label sits above its content, and the result's conditions go under it. */
@media (max-width: 640px) {
  .body {
    min-height: 722px;
    padding: 18px 18px 4px;
  }

  .row {
    grid-template-columns: minmax(0, 1fr);
  }

  .outcome {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
