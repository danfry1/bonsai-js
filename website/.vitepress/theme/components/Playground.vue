<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import type { Compartment, Extension } from '@codemirror/state'
import { bonsai, formatType, isBonsaiError, type Diagnostic, type Environment, type Type } from 'bonsai-src'
import Code from './home/Code.vue'
import { reasonsOf, type Range } from './home/links'
import ExplainView from './playground/ExplainView.vue'
import QueryView from './playground/QueryView.vue'
import Runs from './playground/Runs.vue'
import { examples, defaultExample, type Example } from './playground/examples'
import { stepAt, steps, type Step } from './playground/explain'
import { runs } from './playground/pretty'
import { fromRows, parseData } from './playground/schema'

// The playground: an expression and the data it runs on, both editable, and
// what Bonsai makes of them: the result, every step that produced it, the rule
// as a database query, and the syntax tree. The data's types are inferred from
// its values, so the editor checks, completes and hovers against them. All
// text is rendered with interpolation, never HTML.

const groups = (() => {
  const out: { name: string; examples: Example[] }[] = []
  for (const example of examples) {
    let group = out.find((g) => g.name === example.group)
    if (!group) out.push((group = { name: example.group, examples: [] }))
    group.examples.push(example)
  }
  return out
})()

const activeId = ref<string>(defaultExample.id)
const source = ref(defaultExample.expression)
const dataText = ref(defaultExample.data)

/**
 * What the output reports on: the text once typing pauses, so the output
 * doesn't flicker between errors on every keystroke. Loading an example or
 * applying a fix settles at once.
 */
const settled = ref({ source: source.value, data: dataText.value })
let settleTimer: ReturnType<typeof setTimeout> | undefined
watch([source, dataText], () => {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(settleNow, 220)
})
function settleNow() {
  clearTimeout(settleTimer)
  settled.value = { source: source.value, data: dataText.value }
}
const typing = computed(() => source.value !== settled.value.source || dataText.value !== settled.value.data)

// ── The environment, from the data's inferred types ──────────────
const data = computed(() => parseData(settled.value.data))
/** The last data that parsed, so a half-typed edit keeps the editor's types. */
const good = shallowRef<{ context: Record<string, unknown>; variables: Record<string, Type> }>({ context: {}, variables: {} })
watch(
  data,
  (next) => {
    if (next.ok) good.value = { context: next.context, variables: next.variables }
  },
  { immediate: true },
)
const env = computed(() => bonsai({ variables: good.value.variables, limits: { timeout: 250 } }) as Environment<never>)

// ── What Bonsai makes of it ──────────────────────────────────────
const check = computed(() => env.value.check(settled.value.source))
const errors = computed(() => check.value.diagnostics.filter((d) => d.severity === 'error'))
const warnings = computed(() => check.value.diagnostics.filter((d) => d.severity === 'warning'))

const run = computed(() => {
  if (settled.value.source.trim() === '' || errors.value.length > 0 || !data.value.ok) return undefined
  try {
    const program = env.value.compile(settled.value.source)
    // Explained, so a failure still has the steps that led to it; timed as a plain evaluation.
    const explanation = program.explainSync(good.value.context as never, { exhaustive: true })
    if (!explanation.ok) return { program, failure: explanation.error, trace: explanation.trace }
    const started = performance.now()
    program.evaluateSync(good.value.context as never)
    const ms = performance.now() - started
    return { program, ms, value: explanation.value, explanation, trace: explanation.trace }
  } catch (error) {
    return { failure: isBonsaiError(error) ? error : { code: 'ERROR', message: String(error) } }
  }
})

const type = computed(() => (check.value.type ? formatType(check.value.type) : ''))
const isRule = computed(() => check.value.type?.kind === 'boolean')

const reasons = computed(() =>
  run.value && 'explanation' in run.value && typeof run.value.value === 'boolean'
    ? reasonsOf(run.value.trace, run.value.explanation.reasons())
    : [],
)

const open = ref(new Set<string>())
const rows = computed<Step[]>(() => (run.value?.trace ? steps(run.value.trace, open.value) : []))
function toggle(key: string) {
  const next = new Set(open.value)
  if (!next.delete(key)) next.add(key)
  open.value = next
}

const tree = computed(() => {
  try {
    return runs(env.value.parse(settled.value.source), { width: 64 })
  } catch {
    return undefined
  }
})

type View = 'result' | 'steps' | 'query' | 'tree'
const views: { id: View; label: string }[] = [
  { id: 'result', label: 'Result' },
  { id: 'steps', label: 'Steps' },
  { id: 'query', label: 'Query' },
  { id: 'tree', label: 'Syntax tree' },
]
const view = ref<View>('result')

/** Line and column of a diagnostic, counted from 1. */
function where(d: Diagnostic): string {
  const before = settled.value.source.slice(0, d.start).split('\n')
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`
}

// ── Hover links: a condition or step and its text in the editor ──
const hovered = ref<{ key: string; range: Range }>()
function hover(key: string | undefined, range?: Range) {
  hovered.value = key === undefined || range === undefined || typing.value ? undefined : { key, range }
}
watch([typing, view], () => (hovered.value = undefined))

// ── The editors ──────────────────────────────────────────────────
const exprHost = ref<HTMLElement>()
const dataHost = ref<HTMLElement>()
const exprView = shallowRef<EditorView>()
const dataView = shallowRef<EditorView>()
let language: Compartment | undefined
let languageFor: ((env: Environment<never>) => Extension) | undefined
let marks: Compartment | undefined
let marksFor: ((range: Range | undefined) => Extension) | undefined

onMounted(async () => {
  const [
    { EditorState, Compartment },
    { EditorView, Decoration, keymap, placeholder },
    { defaultKeymap, history, historyKeymap },
    { createLanguageService },
    { bonsaiLanguage },
    { bonsaiHighlight },
    { jsonHighlight },
  ] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('bonsai-service'),
    import('./codemirror/bonsai-language'),
    import('./home/highlight'),
    import('./playground/json-highlight'),
  ])
  if (!exprHost.value || !dataHost.value) return
  loadFromUrl()

  const common = [history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping]
  language = new Compartment()
  languageFor = (e) => bonsaiLanguage(createLanguageService(e))
  marks = new Compartment()
  const lit = Decoration.mark({ class: 'cm-lit' })
  marksFor = (range) =>
    EditorView.decorations.of((v) =>
      range && range.start < range.end && range.end <= v.state.doc.length
        ? Decoration.set([lit.range(range.start, range.end)])
        : Decoration.none,
    )

  exprView.value = new EditorView({
    parent: exprHost.value,
    state: EditorState.create({
      doc: source.value,
      extensions: [
        ...common,
        language.of(languageFor(env.value)),
        marks.of([]),
        bonsaiHighlight,
        placeholder('Write an expression, like order.total >= 50'),
        EditorView.contentAttributes.of({ 'aria-label': 'Expression', spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) source.value = u.state.doc.toString()
        }),
        // Hovering the text lights up the condition or step under the pointer.
        EditorView.domEventHandlers({
          mousemove(event, target) {
            const at = target.posAtCoords({ x: event.clientX, y: event.clientY }, false)
            hoverAt(at ?? undefined)
          },
          mouseleave: () => hover(undefined),
        }),
      ],
    }),
  })
  dataView.value = new EditorView({
    parent: dataHost.value,
    state: EditorState.create({
      doc: dataText.value,
      extensions: [
        ...common,
        jsonHighlight,
        EditorView.contentAttributes.of({ 'aria-label': 'Data, as JSON', spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) dataText.value = u.state.doc.toString()
        }),
      ],
    }),
  })
  exprHost.value.dataset.ready = ''
  dataHost.value.dataset.ready = ''
})

// The editor checks against the latest good data's types.
watch(env, (next) => {
  if (exprView.value && language && languageFor) exprView.value.dispatch({ effects: language.reconfigure(languageFor(next)) })
})
watch(hovered, (next) => {
  if (exprView.value && marks && marksFor) exprView.value.dispatch({ effects: marks.reconfigure(marksFor(next?.range)) })
})

function hoverAt(offset: number | undefined) {
  if (offset === undefined) return hover(undefined)
  if (view.value === 'steps') {
    const step = stepAt(rows.value, offset)
    return hover(step?.key, step)
  }
  if (view.value === 'result') {
    const i = reasons.value.findIndex((r) => r.start <= offset && offset < r.end)
    return hover(i === -1 ? undefined : `reason${i}`, reasons.value[i])
  }
  hover(undefined)
}

onBeforeUnmount(() => {
  clearTimeout(settleTimer)
  exprView.value?.destroy()
  dataView.value?.destroy()
})

function replace(target: EditorView | undefined, text: string) {
  target?.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: text } })
}

function load(example: Example) {
  activeId.value = example.id
  source.value = example.expression
  dataText.value = example.data
  replace(exprView.value, example.expression)
  replace(dataView.value, example.data)
  open.value = new Set()
  settleNow()
}

function pick(id: string) {
  const example = examples.find((e) => e.id === id)
  if (example) load(example)
}

function applyFix(d: Diagnostic) {
  const target = exprView.value
  if (!target || d.suggestion === undefined) return
  target.dispatch({ changes: { from: d.start, to: d.end, insert: d.suggestion } })
  settleNow()
  target.focus()
}

const active = computed(() => examples.find((e) => e.id === activeId.value))
const edited = computed(() => !active.value || source.value !== active.value.expression || dataText.value !== active.value.data)

// ── Share links: ?expr=…&data=… (older links have ?ctx= with one value per variable) ──
function loadFromUrl() {
  const params = new URLSearchParams(location.search)
  const expr = params.get('expr')
  if (expr === null) return
  let text = params.get('data')
  if (text === null) {
    try {
      const rows: unknown = JSON.parse(params.get('ctx') ?? '{}')
      const valid = rows !== null && typeof rows === 'object' && !Array.isArray(rows)
      text = valid
        ? fromRows(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])))
        : '{}'
    } catch {
      text = '{}'
    }
  }
  activeId.value = ''
  source.value = expr
  dataText.value = text
  settleNow()
}

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function share() {
  const params = new URLSearchParams({ expr: source.value, data: dataText.value })
  const url = `${location.origin}${location.pathname}?${params}`
  window.history.replaceState(null, '', url)
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1800)
  } catch {
    // The address bar has the link.
  }
}
</script>

<template>
  <div class="pg">
    <aside class="examples" aria-label="Examples">
      <template v-for="group in groups" :key="group.name">
        <p class="group">{{ group.name }}</p>
        <button
          v-for="example in group.examples"
          :key="example.id"
          type="button"
          class="example"
          :aria-current="example.id === activeId ? 'true' : undefined"
          @click="load(example)"
        >
          {{ example.title }}
        </button>
      </template>
    </aside>

    <div class="work">
      <header class="bar">
        <h1>Playground</h1>
        <label class="picker">
          <span class="sr">Example</span>
          <select :value="activeId" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-if="!active" value="">Your own</option>
            <optgroup v-for="group in groups" :key="group.name" :label="group.name">
              <option v-for="example in group.examples" :key="example.id" :value="example.id">{{ example.title }}</option>
            </optgroup>
          </select>
        </label>
        <div class="actions">
          <button v-if="active && edited" type="button" class="btn" @click="load(active)">Reset</button>
          <button type="button" class="btn primary" @click="share">{{ copied ? 'Link copied' : 'Share' }}</button>
        </div>
      </header>

      <div class="grid">
        <section class="pane input">
          <div class="head">
            <h2>Expression</h2>
            <!-- What the checker says, kept beside the text it is about. -->
            <p v-if="settled.source.trim() !== ''" class="status" :class="{ bad: errors.length, stale: typing }">
              <template v-if="errors.length">
                {{ errors.length === 1 ? '1 problem' : `${errors.length} problems` }}
              </template>
              <template v-else-if="type">
                <span class="tick" aria-hidden="true">✓</span> gives <code>{{ type }}</code>
              </template>
            </p>
          </div>
          <div ref="exprHost" class="editor expr">
            <pre class="fallback">{{ source }}</pre>
          </div>
          <p class="hint">Ctrl Space suggests names and values. Hover a name to see its type.</p>

          <div class="head data-head">
            <h2>Data</h2>
            <p class="aside">JSON. Each key is a variable; its type comes from its value.</p>
          </div>
          <div ref="dataHost" class="editor data">
            <pre class="fallback">{{ dataText }}</pre>
          </div>
          <p v-if="!data.ok" class="data-error" role="alert">{{ data.message }}</p>
        </section>

        <section class="pane output" :class="{ stale: typing }" aria-live="polite">
          <div class="tabs" role="tablist" aria-label="Output">
            <button
              v-for="v in views"
              :key="v.id"
              type="button"
              role="tab"
              class="tab"
              :aria-selected="view === v.id"
              @click="view = v.id"
            >
              {{ v.label }}
            </button>
            <span class="meta">
              <span v-if="run && 'ms' in run && run.ms !== undefined">{{ run.ms < 0.1 ? '<0.1' : run.ms.toFixed(1) }} ms</span>
            </span>
          </div>

          <div class="body">
            <!-- What stops a result: no expression, bad data, or a check error. -->
            <p v-if="settled.source.trim() === ''" class="quiet">Write an expression to see what it gives.</p>
            <div v-else-if="!data.ok && view !== 'tree'" class="state">
              <p class="caught">The data isn't valid JSON</p>
              <p class="diag">{{ data.message }}</p>
            </div>
            <div v-else-if="errors.length && view !== 'tree'" class="state">
              <p class="caught">Caught before it runs</p>
              <div v-for="d in errors" :key="d.code + d.start" class="diag">
                <p class="code-line"><Code :code="settled.source" :mark="d" :wrap="false" /></p>
                <p>{{ d.message }} <span class="at">{{ where(d) }}</span></p>
                <button v-if="d.suggestion" type="button" class="fix" @click="applyFix(d)">
                  Use <code>{{ d.suggestion }}</code>
                </button>
              </div>
            </div>

            <template v-else-if="view === 'result'">
              <div v-if="run && 'failure' in run && run.failure" class="state">
                <p class="caught">Stopped safely</p>
                <p class="diag">{{ run.failure.message }} <span class="at">{{ run.failure.code }}</span></p>
              </div>
              <template v-else-if="run && 'value' in run">
                <pre class="value" :class="{ big: typeof run.value !== 'object' || run.value === null }"><Runs :runs="runs(run.value)" /></pre>
                <template v-if="reasons.length > 1">
                  <h3 class="sub">Why</h3>
                  <ul class="parts" @mouseleave="hover(undefined)">
                    <li
                      v-for="(r, i) in reasons"
                      :key="r.start"
                      :class="{ lit: hovered?.key === `reason${i}`, aside: !r.decided }"
                      @mouseenter="hover(`reason${i}`, r)"
                    >
                      <Code :code="r.text" />
                      <span class="chip" :class="r.value">{{ r.value }}</span>
                    </li>
                  </ul>
                </template>
              </template>
              <p v-for="d in warnings" :key="d.code + d.start" class="warn">{{ d.message }}</p>
            </template>

            <template v-else-if="view === 'steps'">
              <ExplainView
                v-if="run?.trace"
                :rows="rows"
                :lit="hovered?.key"
                @hover="(s) => hover(s?.key, s)"
                @toggle="toggle"
              />
              <div v-else-if="run && 'failure' in run && run.failure" class="state">
                <p class="caught">Stopped safely</p>
                <p class="diag">{{ run.failure.message }}</p>
              </div>
            </template>

            <template v-else-if="view === 'query'">
              <p v-if="!isRule" class="quiet">
                A query needs a rule: an expression that gives true or false. This one gives <code>{{ type }}</code>.
              </p>
              <QueryView
                v-else-if="run?.program"
                :program="run.program"
                :variables="good.variables"
                :context="good.context"
              />
            </template>

            <template v-else-if="view === 'tree'">
              <pre v-if="tree" class="value small"><Runs :runs="tree" /></pre>
              <p v-else class="quiet">The expression doesn't parse yet.</p>
            </template>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The page: examples down the left, the work beside them, on the site's band colour. */
.pg {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  gap: 28px;
  min-height: calc(100vh - var(--vp-nav-height));
  padding: 24px 32px 48px;
  background: var(--bonsai-band);
}

.examples {
  position: sticky;
  top: calc(var(--vp-nav-height) + 24px);
  align-self: start;
  max-height: calc(100vh - var(--vp-nav-height) - 48px);
  overflow-y: auto;
  padding-right: 4px;
}

.group {
  margin: 18px 0 4px;
  padding: 0 10px;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
  font-weight: 600;
}

.group:first-child {
  margin-top: 6px;
}

.example {
  display: block;
  width: 100%;
  padding: 5px 10px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
  font-size: 14px;
  text-align: left;
  transition: background-color 0.12s, color 0.12s;
}

.example:hover {
  color: var(--vp-c-text-1);
}

.example[aria-current='true'] {
  background: var(--bonsai-card);
  color: var(--vp-c-text-1);
  font-weight: 600;
  box-shadow: var(--bonsai-card-shadow);
}

.work {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* A workspace that fills the window: the data editor and the output take the height left. */
  height: max(620px, calc(100vh - var(--vp-nav-height) - 72px));
}

.bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}

.bar h1 {
  margin: 0;
  font-family: var(--bonsai-font-display);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.025em;
  color: var(--vp-c-text-1);
}

/* The examples as a menu, for screens without room for the list. */
.picker {
  display: none;
}

.picker select {
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--bonsai-card);
  color: var(--vp-c-text-1);
  font-size: 14px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.btn {
  padding: 6px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--bonsai-card);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 500;
  transition: border-color 0.15s;
}

.btn:hover {
  border-color: var(--vp-c-brand-1);
}

.btn.primary {
  min-width: 7.5em;
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-1);
  color: var(--bonsai-on-brand);
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.grid {
  flex: 1;
  display: grid;
  /* The input gets the larger share, so expressions wrap less. */
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: 20px;
  min-height: 0;
}

.pane {
  min-width: 0;
  border-radius: 14px;
  background: var(--bonsai-card);
  box-shadow: var(--bonsai-card-shadow);
}

.input {
  display: flex;
  flex-direction: column;
  padding: 18px 20px 20px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}

.data-head {
  margin-top: 22px;
}

.head h2 {
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0;
}

.aside {
  margin: 0;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
}

/* Both editors: a framed, monospaced field that grows with its text. */
.editor {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.editor:focus-within {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px var(--vp-c-brand-soft);
}

/* The expression is what the page is about: on the card's own white, sized to its text. */
.editor.expr {
  border-color: var(--vp-c-border);
  background: var(--bonsai-card);
}

.editor.data {
  flex: 1;
  min-height: 180px;
  overflow: auto;
}

.fallback,
.editor :deep(.cm-content) {
  margin: 0;
  padding: 12px 10px;
  font-family: var(--vp-font-family-mono);
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--vp-c-text-1);
  caret-color: var(--vp-c-text-1);
}

.editor.expr .fallback,
.editor.expr :deep(.cm-content) {
  padding: 16px 12px;
  font-size: 17px;
  line-height: 1.6;
}

.editor.expr .fallback {
  padding: 16px 18px;
}

/* A line too long for the box continues indented, so the wrap reads as a continuation. */
.editor.expr :deep(.cm-line) {
  padding-left: calc(6px + 2ch);
  text-indent: -2ch;
}

.hint {
  margin: 8px 2px 0;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
}

/* ✓ gives string[], or how many problems the checker found. */
.status {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin: 0 0 0 auto;
  color: var(--vp-c-text-2);
  font-size: 13px;
  transition: opacity 0.15s;
}

.status code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
}

.status .tick {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.status.bad {
  color: var(--bonsai-error);
  font-weight: 600;
}

.status.stale {
  opacity: 0.5;
}

.fallback {
  padding: 12px 16px;
  white-space: pre-wrap;
}

.editor[data-ready] .fallback {
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

.editor :deep(.cm-placeholder) {
  color: var(--vp-c-text-3);
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

.editor :deep(.cm-lit) {
  background: var(--bonsai-lit);
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

.data-error {
  margin: 10px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bonsai-error);
  color: var(--vp-c-text-1);
  font-size: 13.5px;
}

.output {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 14px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  overflow-x: auto;
}

.tab {
  flex: none;
  padding: 8px 12px 10px;
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

.meta {
  display: flex;
  flex: none;
  gap: 12px;
  margin-left: auto;
  padding: 0 4px 2px 12px;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
}

.meta code {
  max-width: 22em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
}

.body {
  flex: 1;
  padding: 20px 22px 24px;
  overflow: auto;
  transition: opacity 0.15s;
}

.stale .body {
  opacity: 0.5;
}

.quiet {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.quiet code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
  color: var(--vp-c-text-1);
}

.value {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.value.big {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.3;
}

.value.small {
  font-size: 13px;
}

.sub {
  margin: 26px 0 8px;
  padding: 0;
  border: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}

/* The conditions that decided a true or false result; hovering one lights up its text in the editor. */
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

.caught {
  margin: 0;
  color: var(--bonsai-error);
  font-weight: 600;
}

.diag {
  margin: 10px 0 0;
  padding-left: 12px;
  border-left: 2px solid var(--bonsai-error);
  color: var(--vp-c-text-1);
  font-size: 14px;
  line-height: 1.55;
}

.diag p {
  margin: 0;
}

.code-line {
  margin-bottom: 4px !important;
  overflow-x: auto;
  white-space: pre;
}

.at {
  margin-left: 6px;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
  white-space: nowrap;
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
  font-family: var(--vp-font-family-mono);
  color: inherit;
}

.warn {
  margin: 16px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bonsai-warning);
  color: var(--vp-c-text-2);
  font-size: 13.5px;
}

/* Narrower: the examples become a menu. */
@media (max-width: 1100px) {
  .pg {
    grid-template-columns: minmax(0, 1fr);
    padding: 20px 24px 40px;
  }

  .examples {
    display: none;
  }

  .picker {
    display: block;
    min-width: 0;
  }
}

/* Narrow: input above output. */
@media (max-width: 860px) {
  .work {
    height: auto;
  }

  .grid {
    flex: none;
    grid-template-columns: minmax(0, 1fr);
  }

  .editor.data {
    flex: none;
    max-height: 60vh;
  }

  .output {
    min-height: 280px;
  }
}

@media (max-width: 640px) {
  .pg {
    padding: 16px 16px 32px;
  }

  .bar {
    flex-wrap: wrap;
    gap: 10px 12px;
  }

  .bar h1 {
    font-size: 24px;
  }

  .picker {
    order: 3;
    flex-basis: 100%;
  }

  .picker select {
    width: 100%;
  }

  .input {
    padding: 14px 14px 16px;
  }

  .meta {
    display: none;
  }

  .editor.data .fallback,
  .editor.data :deep(.cm-content) {
    font-size: 13px;
  }

  .body {
    padding: 16px;
  }
}
</style>
