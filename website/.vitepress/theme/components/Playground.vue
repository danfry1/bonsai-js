<template>
  <div ref="root" class="pg-layout">
    <!-- Sidebar: examples -->
    <aside class="pg-sidebar">
      <div class="pg-sidebar-header">Examples</div>
      <div class="pg-example-list" id="example-list">
        <div class="pg-group-label">Basics</div>
        <button class="pg-example active" data-example="hello">
          <span class="pg-example-title">Hello World</span>
          <span class="pg-example-code">"hello" |&gt; upper</span>
        </button>
        <button class="pg-example" data-example="templates">
          <span class="pg-example-title">Template Literals</span>
          <span class="pg-example-code">`Hello ${name}!`</span>
        </button>
        <button class="pg-example" data-example="ternary">
          <span class="pg-example-title">Conditionals</span>
          <span class="pg-example-code">age &gt;= 18 ? "adult" : "minor"</span>
        </button>
        <button class="pg-example" data-example="in-operator">
          <span class="pg-example-title">In Operator</span>
          <span class="pg-example-code">role in ["admin", "editor"]</span>
        </button>

        <div class="pg-group-label">Strings</div>
        <button class="pg-example" data-example="methods">
          <span class="pg-example-title">Method Calls</span>
          <span class="pg-example-code">"hello world".slice(0, 5)</span>
        </button>
        <button class="pg-example" data-example="string-format">
          <span class="pg-example-title">String Formatting</span>
          <span class="pg-example-code">`${name |&gt; upper} scored…`</span>
        </button>

        <div class="pg-group-label">Arrays</div>
        <button class="pg-example" data-example="filtering">
          <span class="pg-example-title">Filtering</span>
          <span class="pg-example-code">users |&gt; filter(.age &gt;= 18)</span>
        </button>
        <button class="pg-example" data-example="chaining">
          <span class="pg-example-title">Chained Pipes</span>
          <span class="pg-example-code">scores |&gt; sort |&gt; reverse |&gt; first</span>
        </button>
        <button class="pg-example" data-example="unique-tags">
          <span class="pg-example-title">Flatten &amp; Unique</span>
          <span class="pg-example-code">posts |&gt; map(.tags) |&gt; flatten</span>
        </button>
        <button class="pg-example" data-example="search">
          <span class="pg-example-title">Search &amp; Filter</span>
          <span class="pg-example-code">items |&gt; filter(.name.includes(…))</span>
        </button>

        <div class="pg-group-label">Math</div>
        <button class="pg-example" data-example="math">
          <span class="pg-example-title">Sum Pipeline</span>
          <span class="pg-example-code">[10, 20, 30] |&gt; sum</span>
        </button>
        <button class="pg-example" data-example="grade-calc">
          <span class="pg-example-title">Grade Calculator</span>
          <span class="pg-example-code">scores |&gt; avg |&gt; clamp |&gt; round</span>
        </button>

        <div class="pg-group-label">Objects</div>
        <button class="pg-example" data-example="null-safety">
          <span class="pg-example-title">Null Safety</span>
          <span class="pg-example-code">user?.profile?.avatar ?? …</span>
        </button>
        <button class="pg-example" data-example="nested-data">
          <span class="pg-example-title">Nested Access</span>
          <span class="pg-example-code">company.departments |&gt; map |&gt; join</span>
        </button>
        <button class="pg-example" data-example="data-transform">
          <span class="pg-example-title">Data Pipeline</span>
          <span class="pg-example-code">orders |&gt; filter |&gt; avg |&gt; round</span>
        </button>
      </div>
    </aside>

    <!-- Main playground area -->
    <main class="pg-main">
      <!-- Top bar -->
      <div class="pg-topbar">
        <div class="pg-topbar-left">
          <span class="pg-live-badge" id="live-badge">
            <span class="pg-live-dot"></span>
            Live
          </span>
          <span class="pg-eval-time" id="eval-time"></span>
        </div>
        <div class="pg-topbar-right">
          <button class="pg-topbar-btn" id="share-btn" title="Copy shareable link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span class="pg-btn-label">Share</span>
          </button>
          <button class="pg-topbar-btn" id="reset-btn" title="Reset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Reset
          </button>
        </div>
      </div>

      <!-- Editor grid -->
      <div class="pg-editor-grid">
        <!-- Left: expression + context -->
        <div class="pg-editor-left">
          <div class="pg-pane pg-expr-pane">
            <div class="pg-pane-header">
              <span class="pg-pane-label">Expression</span>
              <span class="pg-pane-hint" id="expr-hint">auto-evaluates as you type</span>
            </div>
            <div class="pg-expr-editor">
              <div class="pg-expr-highlight" id="expr-highlight" aria-hidden="true"></div>
              <textarea class="pg-expr-input" id="expr-input" spellcheck="false" placeholder="Type an expression...">"hello" |> upper</textarea>
            </div>
          </div>

          <div class="pg-pane pg-ctx-pane" id="ctx-pane">
            <div class="pg-pane-header">
              <span class="pg-pane-label">Context</span>
              <button class="pg-ctx-add" id="ctx-add" title="Add variable">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add
              </button>
            </div>
            <div class="pg-ctx-vars" id="ctx-vars"></div>
            <div class="pg-ctx-empty" id="ctx-empty">
              No context variables. <button class="pg-ctx-empty-add" id="ctx-empty-add">Add one</button>
            </div>
          </div>
        </div>

        <!-- Right: result -->
        <div class="pg-editor-right">
          <div class="pg-pane pg-result-pane">
            <div class="pg-pane-header">
              <div class="pg-result-tabs">
                <button class="pg-result-tab active" data-mode="result">Result</button>
                <button class="pg-result-tab" data-mode="ast">AST</button>
              </div>
              <span class="pg-result-type" id="result-type"></span>
            </div>
            <div class="pg-result-body" id="result-output"></div>
            <div class="pg-error" id="error-output"></div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { bonsai } from 'bonsai-src'
import { strings, arrays, math, types, dates } from 'bonsai-stdlib'
import { createAutocomplete } from 'bonsai-autocomplete'
import './playground/playground.css'

const root = ref<HTMLElement>()

interface TransformInfo {
  desc: string
  module: string
  accepts: string[] | null
}

interface ContextVar {
  id: number
  name: string
  value: string
}

interface ExampleVar {
  name: string
  value: string
}

interface Example {
  expression: string
  vars: ExampleVar[]
}

interface AcItem {
  name: string
  desc: string
  module: string
  accepts: string[] | null
}

onMounted(() => {
  const rootEl = root.value
  if (!rootEl) return

  // Scoped DOM lookups (never reach outside the component).
  const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
    rootEl.querySelector<T>(sel)
  const $all = <T extends Element = HTMLElement>(sel: string): T[] =>
    Array.from(rootEl.querySelectorAll<T>(sel))

  const expr = bonsai()
  expr.use(strings)
  expr.use(arrays)
  expr.use(math)
  expr.use(types)
  expr.use(dates)

  // ── Stdlib transform catalog ────────────────────────────────
  const transforms: Record<string, TransformInfo> = {
    // strings
    upper: { desc: 'Convert string to UPPERCASE', module: 'strings', accepts: ['string'] },
    lower: { desc: 'Convert string to lowercase', module: 'strings', accepts: ['string'] },
    trim: { desc: 'Remove leading/trailing whitespace', module: 'strings', accepts: ['string'] },
    split: { desc: 'Split string by separator', module: 'strings', accepts: ['string'] },
    replace: { desc: 'Replace first occurrence in string', module: 'strings', accepts: ['string'] },
    replaceAll: { desc: 'Replace all occurrences in string', module: 'strings', accepts: ['string'] },
    startsWith: { desc: 'Check if string starts with value', module: 'strings', accepts: ['string'] },
    endsWith: { desc: 'Check if string ends with value', module: 'strings', accepts: ['string'] },
    includes: { desc: 'Check if string contains value', module: 'strings', accepts: ['string'] },
    padStart: { desc: 'Pad string start to target length', module: 'strings', accepts: ['string'] },
    padEnd: { desc: 'Pad string end to target length', module: 'strings', accepts: ['string'] },
    // arrays
    count: { desc: 'Count items in array', module: 'arrays', accepts: ['array'] },
    first: { desc: 'Get first element', module: 'arrays', accepts: ['array'] },
    last: { desc: 'Get last element', module: 'arrays', accepts: ['array'] },
    reverse: { desc: 'Reverse array order', module: 'arrays', accepts: ['array'] },
    flatten: { desc: 'Flatten nested arrays', module: 'arrays', accepts: ['array'] },
    unique: { desc: 'Remove duplicate values', module: 'arrays', accepts: ['array'] },
    join: { desc: 'Join array into string', module: 'arrays', accepts: ['array'] },
    sort: { desc: 'Sort array elements', module: 'arrays', accepts: ['array'] },
    filter: { desc: 'Keep elements matching predicate', module: 'arrays', accepts: ['array'] },
    map: { desc: 'Transform each element', module: 'arrays', accepts: ['array'] },
    find: { desc: 'Find first matching element', module: 'arrays', accepts: ['array'] },
    some: { desc: 'Check if any element matches', module: 'arrays', accepts: ['array'] },
    every: { desc: 'Check if all elements match', module: 'arrays', accepts: ['array'] },
    // math
    round: { desc: 'Round to nearest integer', module: 'math', accepts: ['number'] },
    floor: { desc: 'Round down to integer', module: 'math', accepts: ['number'] },
    ceil: { desc: 'Round up to integer', module: 'math', accepts: ['number'] },
    abs: { desc: 'Absolute value', module: 'math', accepts: ['number'] },
    sum: { desc: 'Sum all numbers in array', module: 'math', accepts: ['array'] },
    avg: { desc: 'Average of numbers in array', module: 'math', accepts: ['array'] },
    clamp: { desc: 'Clamp value between min and max', module: 'math', accepts: ['number'] },
    min: { desc: 'Minimum value', module: 'math', accepts: ['array'] },
    max: { desc: 'Maximum value', module: 'math', accepts: ['array'] },
    // types (work on any value)
    isString: { desc: 'Check if value is a string', module: 'types', accepts: null },
    isNumber: { desc: 'Check if value is a number', module: 'types', accepts: null },
    isArray: { desc: 'Check if value is an array', module: 'types', accepts: null },
    isNull: { desc: 'Check if value is null', module: 'types', accepts: null },
    toBool: { desc: 'Convert to boolean', module: 'types', accepts: null },
    toNumber: { desc: 'Convert to number', module: 'types', accepts: null },
    toString: { desc: 'Convert to string', module: 'types', accepts: null },
    // dates
    now: { desc: 'Current timestamp (ms)', module: 'dates', accepts: null },
    formatDate: { desc: 'Format date to string', module: 'dates', accepts: ['number', 'string'] },
    diffDays: { desc: 'Difference in days between dates', module: 'dates', accepts: ['number', 'string'] },
  }

  // Autocomplete auto-discovers transform type compatibility via probing — no config needed
  const ac = createAutocomplete(expr, {})

  // ── Examples ─────────────────────────────────────────────────
  const examples: Record<string, Example> = {
    hello: {
      expression: '"hello" |> upper',
      vars: [],
    },
    filtering: {
      expression: 'users |> filter(.age >= 18) |> map(.name)',
      vars: [
        { name: 'users', value: '[\n  { "name": "Alice", "age": 25 },\n  { "name": "Bob", "age": 15 }\n]' },
      ],
    },
    'null-safety': {
      expression: 'user?.profile?.avatar ?? "default.png"',
      vars: [{ name: 'user', value: 'null' }],
    },
    math: {
      expression: '[10, 20, 30] |> sum',
      vars: [],
    },
    templates: {
      expression: '`Hello ${name}!`',
      vars: [{ name: 'name', value: '"world"' }],
    },
    methods: {
      expression: '"hello world".slice(0, 5) |> upper',
      vars: [],
    },
    chaining: {
      expression: 'scores |> sort |> reverse |> first',
      vars: [{ name: 'scores', value: '[42, 87, 15, 93, 61]' }],
    },
    ternary: {
      expression: 'age >= 18 ? "adult" : "minor"',
      vars: [{ name: 'age', value: '21' }],
    },
    'data-transform': {
      expression: 'orders |> filter(.total > 50) |> map(.total) |> avg |> round',
      vars: [
        { name: 'orders', value: '[\n  { "item": "Book", "total": 29.99 },\n  { "item": "Laptop", "total": 899 },\n  { "item": "Pen", "total": 3.50 },\n  { "item": "Monitor", "total": 349 }\n]' },
      ],
    },
    'string-format': {
      expression: '`${name |> upper} scored ${score}% - ${score >= 90 ? "Excellent!" : score >= 70 ? "Good" : "Needs work"}`',
      vars: [
        { name: 'name', value: '"alice"' },
        { name: 'score', value: '85' },
      ],
    },
    'in-operator': {
      expression: 'role in ["admin", "editor"] ? "Can edit" : "Read only"',
      vars: [{ name: 'role', value: '"editor"' }],
    },
    'nested-data': {
      expression: 'company.departments |> map(.name) |> join(", ") |> upper',
      vars: [
        { name: 'company', value: '{\n  "name": "Acme",\n  "departments": [\n    { "name": "Engineering" },\n    { "name": "Sales" },\n    { "name": "Design" }\n  ]\n}' },
      ],
    },
    'unique-tags': {
      expression: 'posts |> map(.tags) |> flatten |> unique |> sort',
      vars: [
        { name: 'posts', value: '[\n  { "title": "Intro", "tags": ["js", "tutorial"] },\n  { "title": "Advanced", "tags": ["js", "deep-dive"] },\n  { "title": "Guide", "tags": ["tutorial", "guide"] }\n]' },
      ],
    },
    'grade-calc': {
      expression: 'scores |> avg |> clamp(0, 100) |> round',
      vars: [{ name: 'scores', value: '[88, 92, 76, 95, 81]' }],
    },
    search: {
      expression: 'items |> filter(.name.includes("Pro")) |> map(.name)',
      vars: [
        { name: 'items', value: '[\n  { "name": "MacBook Pro" },\n  { "name": "iPad Air" },\n  { "name": "AirPods Pro" }\n]' },
      ],
    },
  }

  // ── DOM ──────────────────────────────────────────────────────
  const exprInput = $<HTMLTextAreaElement>('#expr-input')!
  const exprHighlight = $('#expr-highlight')!
  const ctxVarsEl = $('#ctx-vars')!
  const ctxEmptyEl = $('#ctx-empty')!
  const resultOutput = $('#result-output')!
  const errorOutput = $('#error-output')!
  const resultType = $('#result-type')!
  const evalTimeEl = $('#eval-time')!
  const exampleBtns = $all<HTMLButtonElement>('.pg-example')
  const resultTabs = $all<HTMLButtonElement>('.pg-result-tab')
  const shareBtn = $<HTMLButtonElement>('#share-btn')!
  const resetBtn = $<HTMLButtonElement>('#reset-btn')!
  const liveBadge = $('#live-badge')!
  const ctxAddBtn = $<HTMLButtonElement>('#ctx-add')!
  const ctxEmptyAdd = $<HTMLButtonElement>('#ctx-empty-add')!

  let currentMode = 'result'

  // ── Context state ────────────────────────────────────────────
  let ctxVars: ContextVar[] = []
  let nextVarId = 1

  function addVar(name = '', value = '', focus = false) {
    const v: ContextVar = { id: nextVarId++, name, value }
    ctxVars.push(v)
    renderVars()
    if (focus) {
      const row = ctxVarsEl.querySelector(`[data-id="${v.id}"]`)
      if (row) row.querySelector<HTMLInputElement>('.pg-ctx-row-name')?.focus()
    }
  }

  function removeVar(id: number) {
    ctxVars = ctxVars.filter((v) => v.id !== id)
    renderVars()
    scheduleEvaluate()
  }

  function detectType(raw: string): string {
    const s = raw.trim()
    if (s === '' || s === 'undefined' || s === 'null') return 'null'
    if (s === 'true' || s === 'false') return 'boolean'
    if (/^-?\d+(\.\d+)?$/.test(s)) return 'number'
    if (s.startsWith('"') || s.startsWith("'")) return 'string'
    if (s.startsWith('[')) return 'array'
    if (s.startsWith('{')) return 'object'
    return 'string'
  }

  function renderVars() {
    ctxVarsEl.textContent = ''
    const empty = ctxVars.length === 0
    ;(ctxEmptyEl as HTMLElement).style.display = empty ? '' : 'none'

    for (const v of ctxVars) {
      const row = document.createElement('div')
      row.className = 'pg-ctx-row'
      row.dataset.id = String(v.id)

      // Left: name + separator
      const left = document.createElement('div')
      left.className = 'pg-ctx-row-left'

      const nameInput = document.createElement('input')
      nameInput.className = 'pg-ctx-row-name'
      nameInput.type = 'text'
      nameInput.placeholder = 'name'
      nameInput.value = v.name
      nameInput.spellcheck = false

      const sep = document.createElement('span')
      sep.className = 'pg-ctx-row-sep'
      sep.textContent = '='

      left.append(nameInput, sep)

      // Value: textarea for multi-line
      const valueInput = document.createElement('textarea')
      valueInput.className = 'pg-ctx-row-value'
      valueInput.placeholder = '"hello", 42, [1,2], { "a": 1 }'
      valueInput.value = v.value
      valueInput.spellcheck = false
      valueInput.rows = 1

      // Meta: type badge + delete
      const meta = document.createElement('div')
      meta.className = 'pg-ctx-row-meta'

      const typeBadge = document.createElement('span')
      const t = detectType(v.value)
      typeBadge.className = `pg-ctx-row-type ctx-type-${t}`
      typeBadge.textContent = t

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'pg-ctx-row-delete'
      deleteBtn.title = 'Remove'
      deleteBtn.textContent = '×'

      meta.append(typeBadge, deleteBtn)

      nameInput.addEventListener('input', () => {
        v.name = nameInput.value
        markStale()
        scheduleEvaluate()
        updateHighlight()
      })

      valueInput.addEventListener('input', () => {
        v.value = valueInput.value
        const nt = detectType(v.value)
        typeBadge.className = `pg-ctx-row-type ctx-type-${nt}`
        typeBadge.textContent = nt
        markStale()
        scheduleEvaluate()
      })

      deleteBtn.addEventListener('click', () => removeVar(v.id))

      row.append(left, valueInput, meta)
      ctxVarsEl.appendChild(row)
    }
  }

  function relaxedJsonParse(raw: string): unknown {
    const s = raw.trim()
    if (!s) return undefined
    // Try strict JSON first
    try {
      return JSON.parse(s)
    } catch {
      /* fall through */
    }
    // Normalize JS-style objects: unquoted keys → quoted, single quotes → double
    try {
      const normalized = s
        // Replace single-quoted strings with double-quoted
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
        // Quote unquoted keys (word chars before colon)
        .replace(/(?<=[{,]\s*)(\w+)\s*:/g, '"$1":')
      return JSON.parse(normalized)
    } catch {
      /* fall through */
    }
    // Fallback: treat as raw string
    return raw
  }

  function buildContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {}
    for (const v of ctxVars) {
      const name = v.name.trim()
      if (!name) continue
      ctx[name] = relaxedJsonParse(v.value)
    }
    return ctx
  }

  // ── Highlighting ─────────────────────────────────────────────
  // NOTE: The highlight overlay only marks context variable positions with
  // transparent-colored spans that add a background tint. The expression text
  // itself is rendered by the textarea on top, so there is no risk of script
  // injection - the highlight div has pointer-events:none, aria-hidden, and the
  // content is built via DOM text nodes (no innerHTML).
  function updateHighlight() {
    const text = exprInput.value
    const varNames = ctxVars.map((v) => v.name.trim()).filter(Boolean)

    // Build combined regex for context vars and transforms
    const parts: string[] = []
    const escapedVars = varNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (escapedVars.length > 0) parts.push(...escapedVars)

    const transformNames = Object.keys(transforms)
    const escapedTransforms = transformNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    parts.push(...escapedTransforms)

    if (parts.length === 0) {
      exprHighlight.textContent = text
      return
    }

    const re = new RegExp(`\\b(${parts.join('|')})\\b`, 'g')
    const varSet = new Set(varNames)

    // Build DOM nodes instead of setting raw HTML
    const frag = document.createDocumentFragment()
    let last = 0
    for (const match of text.matchAll(re)) {
      const index = match.index ?? 0
      if (index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, index)))
      }
      const word = match[0]
      const span = document.createElement('span')

      // Skip transform highlighting if preceded by `.` (property access, not a transform)
      const charBefore = index > 0 ? text[index - 1] : ''
      const isPropertyAccess = charBefore === '.'

      if (varSet.has(word)) {
        span.className = 'hl-var'
        span.textContent = word
        frag.appendChild(span)
      } else if (transforms[word] && !isPropertyAccess) {
        const t = transforms[word]
        span.className = 'hl-transform'
        span.textContent = word
        span.dataset.desc = t.desc
        span.dataset.module = t.module
        frag.appendChild(span)
      } else {
        frag.appendChild(document.createTextNode(word))
      }
      last = index + match[0].length
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)))
    }
    exprHighlight.textContent = ''
    exprHighlight.appendChild(frag)
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  exprInput.addEventListener('scroll', () => {
    exprHighlight.scrollTop = exprInput.scrollTop
    exprHighlight.scrollLeft = exprInput.scrollLeft
  })

  // ── Transform tooltip ───────────────────────────────────────
  // The textarea sits on top of the highlight overlay, so pointer events
  // don't reach .hl-transform spans. Instead, we listen on the textarea
  // and extract the word under the mouse from the text content, then
  // position the tooltip using the matching highlight span's bounds.
  const tooltip = document.createElement('div')
  tooltip.className = 'pg-transform-tooltip'
  tooltip.style.display = 'none'
  document.body.appendChild(tooltip)

  let tooltipTimer: ReturnType<typeof setTimeout> | undefined
  let activeTransform = ''

  function getWordAtMouse(e: MouseEvent): string | null {
    // Extract word at approximate character offset from mouse position
    const text = exprInput.value
    const rect = exprInput.getBoundingClientRect()
    const style = getComputedStyle(exprInput)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6
    const charWidth = parseFloat(style.fontSize) * 0.6 // monospace approximation
    const padLeft = parseFloat(style.paddingLeft)
    const padTop = parseFloat(style.paddingTop)

    const x = e.clientX - rect.left - padLeft + exprInput.scrollLeft
    const y = e.clientY - rect.top - padTop + exprInput.scrollTop

    const row = Math.floor(y / lineHeight)
    const col = Math.floor(x / charWidth)

    // Find the line
    const lines = text.split('\n')
    if (row < 0 || row >= lines.length) return null
    const line = lines[row]
    if (col < 0 || col >= line.length) return null

    // Extract word at position
    const wordRe = /\w+/g
    for (const m of line.matchAll(wordRe)) {
      const mIndex = m.index ?? 0
      if (col >= mIndex && col <= mIndex + m[0].length) {
        return m[0]
      }
    }
    return null
  }

  exprInput.addEventListener('mousemove', (e) => {
    const word = getWordAtMouse(e)
    if (!word) {
      if (activeTransform) {
        activeTransform = ''
        hideTooltip()
      }
      return
    }

    // Find the closest matching span to the mouse position
    function closestSpan(selector: string, textContent: string, mouseX: number): HTMLElement | null {
      const spans = exprHighlight.querySelectorAll<HTMLElement>(selector)
      let best: HTMLElement | null = null
      let bestDist = Infinity
      for (const s of spans) {
        if (s.textContent !== textContent) continue
        const rect = s.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const dist = Math.abs(mouseX - cx)
        if (dist < bestDist) {
          bestDist = dist
          best = s
        }
      }
      return best
    }

    // Check if it's a transform
    if (transforms[word]) {
      if (word === activeTransform) return
      activeTransform = word
      clearTimeout(tooltipTimer)
      const target = closestSpan('.hl-transform', word, e.clientX)
      if (target) showTransformTooltip(word, target)
      return
    }

    // Check if it's a context variable
    const ctxVar = ctxVars.find((v) => v.name.trim() === word)
    if (ctxVar) {
      if (word === activeTransform) return
      activeTransform = word
      clearTimeout(tooltipTimer)
      const target = closestSpan('.hl-var', word, e.clientX)
      if (target) showVarTooltip(ctxVar, target)
      return
    }

    if (activeTransform) {
      activeTransform = ''
      hideTooltip()
    }
  })

  exprInput.addEventListener('mouseleave', () => {
    activeTransform = ''
    hideTooltip()
  })

  function showTransformTooltip(word: string, el: HTMLElement) {
    const t = transforms[word]
    if (!t) return
    tooltip.textContent = ''
    tooltip.className = 'pg-transform-tooltip'

    const name = document.createElement('span')
    name.className = 'pg-tt-name'
    name.textContent = word

    const mod = document.createElement('span')
    mod.className = 'pg-tt-module'
    mod.textContent = t.module

    const desc = document.createElement('span')
    desc.className = 'pg-tt-desc'
    desc.textContent = t.desc

    tooltip.append(name, mod, desc)
    positionTooltip(el)
  }

  function showVarTooltip(v: ContextVar, el: HTMLElement) {
    tooltip.textContent = ''
    tooltip.className = 'pg-transform-tooltip pg-var-tooltip'

    const name = document.createElement('span')
    name.className = 'pg-tt-name pg-tt-var-name'
    name.textContent = v.name

    const type = document.createElement('span')
    type.className = 'pg-tt-module pg-tt-var-type'
    type.textContent = detectType(v.value)

    // Show a compact preview of the value
    let preview = v.value.trim()
    if (preview.length > 60) preview = preview.slice(0, 57) + '...'
    const val = document.createElement('span')
    val.className = 'pg-tt-desc pg-tt-var-val'
    val.textContent = preview

    tooltip.append(name, type, val)
    positionTooltip(el)
  }

  function positionTooltip(el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    tooltip.style.display = ''
    tooltip.style.left = `${rect.left + rect.width / 2}px`
    tooltip.style.top = `${rect.top - 4}px`
  }

  function hideTooltip() {
    tooltipTimer = setTimeout(() => {
      tooltip.style.display = 'none'
    }, 150)
  }

  // ── Autocomplete ────────────────────────────────────────────
  const acPanel = document.createElement('div')
  acPanel.className = 'pg-autocomplete'
  acPanel.style.display = 'none'
  document.body.appendChild(acPanel)

  let acItems: AcItem[] = []
  let acIndex = -1
  let acPrefix = ''
  let acStart = -1 // cursor position where the prefix starts

  function updateAutocomplete() {
    const pos = exprInput.selectionStart
    const text = exprInput.value

    // Update autocomplete context with current variables
    ac.setContext(buildContext())

    const completions = ac.complete(text, pos)

    if (
      completions.length === 0 ||
      (completions.length === 1 &&
        completions[0].label === text.slice(pos - completions[0].label.length, pos))
    ) {
      closeAutocomplete()
      return
    }

    // Find prefix start position for insertion
    const before = text.slice(0, pos)
    const prefixMatch = before.match(/[\w$]*$/)
    acPrefix = prefixMatch ? prefixMatch[0] : ''
    acStart = pos - acPrefix.length

    acItems = completions.slice(0, 12).map((c) => {
      // Enrich with module info from the playground's transform catalog
      const catalogEntry = transforms[c.label]
      return {
        name: c.label,
        desc: catalogEntry ? catalogEntry.desc : (c.detail || c.kind),
        module: catalogEntry ? catalogEntry.module : c.kind,
        accepts: null,
      }
    })

    acIndex = 0
    renderAutocomplete()
  }

  function renderAutocomplete() {
    acPanel.textContent = ''

    for (let i = 0; i < acItems.length; i++) {
      const item = acItems[i]
      const row = document.createElement('div')
      row.className = 'pg-ac-item' + (i === acIndex ? ' active' : '')

      const name = document.createElement('span')
      name.className = 'pg-ac-name'
      // Highlight matching prefix
      if (acPrefix.length > 0) {
        const bold = document.createElement('strong')
        bold.textContent = item.name.slice(0, acPrefix.length)
        const rest = document.createTextNode(item.name.slice(acPrefix.length))
        name.append(bold, rest)
      } else {
        name.textContent = item.name
      }

      const mod = document.createElement('span')
      mod.className = 'pg-ac-module'
      mod.textContent = item.module

      const desc = document.createElement('span')
      desc.className = 'pg-ac-desc'
      desc.textContent = item.desc

      row.append(name, mod, desc)
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        acIndex = i
        acceptAutocomplete()
      })
      acPanel.appendChild(row)
    }

    positionAutocomplete()
    acPanel.style.display = ''

    // Scroll active item into view
    const activeRow = acPanel.children[acIndex] as HTMLElement | undefined
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' })
  }

  function positionAutocomplete() {
    // Position below the cursor using a mirror element approach
    const style = getComputedStyle(exprInput)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6
    const charWidth = parseFloat(style.fontSize) * 0.6
    const padLeft = parseFloat(style.paddingLeft)
    const padTop = parseFloat(style.paddingTop)

    // Count line and column of acStart
    const textBefore = exprInput.value.slice(0, acStart)
    const lines = textBefore.split('\n')
    const row = lines.length - 1
    const col = lines[row].length

    const inputRect = exprInput.getBoundingClientRect()
    const left = inputRect.left + padLeft + col * charWidth - exprInput.scrollLeft
    const top = inputRect.top + padTop + (row + 1) * lineHeight - exprInput.scrollTop

    acPanel.style.left = `${left}px`
    acPanel.style.top = `${top + 4}px`
  }

  function acceptAutocomplete() {
    if (acIndex < 0 || acIndex >= acItems.length) return
    const item = acItems[acIndex]
    const before = exprInput.value.slice(0, acStart)
    const after = exprInput.value.slice(acStart + acPrefix.length)
    exprInput.value = before + item.name + after
    const newPos = acStart + item.name.length
    exprInput.setSelectionRange(newPos, newPos)
    closeAutocomplete()
    updateHighlight()
    markStale()
    scheduleEvaluate()
  }

  function closeAutocomplete() {
    acPanel.style.display = 'none'
    acItems = []
    acIndex = -1
  }

  function isAutocompleteOpen() {
    return acPanel.style.display !== 'none'
  }

  // ── Evaluate ─────────────────────────────────────────────────
  // Result rendering: we build color-coded output from evaluator results.
  // All values come from the sandboxed Bonsai evaluator (no user HTML),
  // and all string content is escaped via escapeHtml before insertion.
  let errorTimer: ReturnType<typeof setTimeout> | undefined

  function markStale() {
    liveBadge.classList.add('is-stale')
    resultOutput.classList.add('is-stale')
  }

  function markLive() {
    liveBadge.classList.remove('is-stale')
    resultOutput.classList.remove('is-stale')
  }

  function evaluate() {
    const expression = exprInput.value.trim()

    clearTimeout(errorTimer)
    ;(errorOutput as HTMLElement).style.display = 'none'
    markLive()

    if (!expression) {
      resultOutput.textContent = ''
      resultType.textContent = ''
      evalTimeEl.textContent = ''
      return
    }

    const context = buildContext()
    const start = performance.now()

    if (currentMode === 'ast') {
      try {
        const compiled = expr.compile(expression)
        const elapsed = performance.now() - start
        setResultHtml(highlightJson(JSON.stringify(compiled.ast, null, 2)))
        resultType.textContent = 'AST'
        evalTimeEl.textContent = `${elapsed.toFixed(1)}ms`
      } catch (e) {
        // Delay error display to avoid flashing during typing
        errorTimer = setTimeout(() => {
          errorOutput.textContent = (e as Error).message
          ;(errorOutput as HTMLElement).style.display = 'block'
        }, 500)
        resultOutput.textContent = ''
      }
      return
    }

    try {
      const result = expr.evaluateSync(expression, context)
      const elapsed = performance.now() - start
      const type = getType(result)
      resultType.textContent = type
      setResultHtml(colorize(result, 0))
      evalTimeEl.textContent = `${elapsed.toFixed(1)}ms`
    } catch (e) {
      // Delay error display to avoid flashing during typing
      errorTimer = setTimeout(() => {
        errorOutput.textContent = (e as Error).message
        ;(errorOutput as HTMLElement).style.display = 'block'
      }, 500)
      resultOutput.textContent = ''
      resultType.textContent = ''
    }
  }

  // Safe HTML setter for result output - content is fully escaped evaluator output
  function setResultHtml(html: string) {
    // Using a dedicated setter to make the innerHTML usage auditable.
    // All interpolated strings pass through escapeHtml first.
    resultOutput.innerHTML = html
  }

  function getType(value: unknown): string {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (Array.isArray(value)) return 'array'
    return typeof value
  }

  function colorize(value: unknown, depth: number): string {
    if (value === null) return '<span class="r-null">null</span>'
    if (value === undefined) return '<span class="r-null">undefined</span>'
    if (typeof value === 'string') return `<span class="r-string">"${escapeHtml(value)}"</span>`
    if (typeof value === 'number') return `<span class="r-number">${value}</span>`
    if (typeof value === 'boolean') return `<span class="r-boolean">${value}</span>`

    if (Array.isArray(value)) {
      if (value.length === 0) return '<span class="r-bracket">[]</span>'
      const indent = '  '.repeat(depth + 1)
      const close = '  '.repeat(depth)
      const items = value.map((item) => `${indent}${colorize(item, depth + 1)}`)
      return `<span class="r-bracket">[</span>\n${items.join('<span class="r-punct">,</span>\n')}\n${close}<span class="r-bracket">]</span>`
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
      if (keys.length === 0) return '<span class="r-bracket">{}</span>'
      const indent = '  '.repeat(depth + 1)
      const close = '  '.repeat(depth)
      const entries = keys.map(
        (k) =>
          `${indent}<span class="r-key">"${escapeHtml(k)}"</span><span class="r-punct">:</span> ${colorize(obj[k], depth + 1)}`,
      )
      return `<span class="r-bracket">{</span>\n${entries.join('<span class="r-punct">,</span>\n')}\n${close}<span class="r-bracket">}</span>`
    }

    return escapeHtml(String(value))
  }

  function highlightJson(json: string): string {
    // Input is from JSON.stringify (safe structure), escape any HTML entities first
    const safe = escapeHtml(json)
    return safe
      .replace(/&quot;([^&]+)&quot;(?=\s*:)/g, '<span class="r-key">"$1"</span>')
      .replace(/&quot;([^&]*)&quot;/g, '<span class="r-string">"$1"</span>')
      .replace(/\b(\d+)\b/g, '<span class="r-number">$1</span>')
      .replace(/\b(true|false)\b/g, '<span class="r-boolean">$1</span>')
      .replace(/\bnull\b/g, '<span class="r-null">null</span>')
  }

  // ── Debounce ─────────────────────────────────────────────────
  let timer: ReturnType<typeof setTimeout> | undefined
  function scheduleEvaluate() {
    clearTimeout(timer)
    timer = setTimeout(evaluate, 150)
  }

  // ── Events ───────────────────────────────────────────────────
  exprInput.addEventListener('input', () => {
    updateHighlight()
    markStale()
    scheduleEvaluate()
    updateAutocomplete()
  })

  exprInput.addEventListener('keydown', (e) => {
    // Autocomplete keyboard navigation
    if (isAutocompleteOpen()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        acIndex = (acIndex + 1) % acItems.length
        renderAutocomplete()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        acIndex = (acIndex - 1 + acItems.length) % acItems.length
        renderAutocomplete()
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        acceptAutocomplete()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeAutocomplete()
        return
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      clearTimeout(timer)
      evaluate()
    }
  })

  // Close autocomplete when clicking elsewhere
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node
    if (!acPanel.contains(target) && target !== exprInput) {
      closeAutocomplete()
    }
  })

  ctxAddBtn.addEventListener('click', () => addVar('', '', true))
  ctxEmptyAdd.addEventListener('click', () => addVar('', '', true))

  for (const btn of exampleBtns) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.example
      const example = key ? examples[key] : undefined
      if (!example) return

      for (const b of exampleBtns) b.classList.remove('active')
      btn.classList.add('active')

      exprInput.value = example.expression
      ctxVars = []
      nextVarId = 1
      for (const v of example.vars) {
        ctxVars.push({ id: nextVarId++, name: v.name, value: v.value })
      }
      renderVars()
      updateHighlight()
      evaluate()
    })
  }

  for (const tab of resultTabs) {
    tab.addEventListener('click', () => {
      currentMode = tab.dataset.mode ?? 'result'
      for (const t of resultTabs) t.classList.remove('active')
      tab.classList.add('active')
      evaluate()
    })
  }

  shareBtn.addEventListener('click', () => {
    const expression = encodeURIComponent(exprInput.value)
    const ctx = encodeURIComponent(JSON.stringify(buildContext()))
    const url = `${location.origin}${location.pathname}?expr=${expression}&ctx=${ctx}`
    navigator.clipboard.writeText(url).then(() => {
      shareBtn.classList.add('copied')
      const span = shareBtn.querySelector<HTMLElement>('.pg-btn-label')
      if (span) span.textContent = 'Copied!'
      setTimeout(() => {
        shareBtn.classList.remove('copied')
        const s = shareBtn.querySelector<HTMLElement>('.pg-btn-label')
        if (s) s.textContent = 'Share'
      }, 2000)
    })
  })

  resetBtn.addEventListener('click', () => {
    exprInput.value = '"hello" |> upper'
    ctxVars = []
    nextVarId = 1
    renderVars()
    updateHighlight()
    evaluate()
    for (const b of exampleBtns) b.classList.remove('active')
    exampleBtns[0]?.classList.add('active')
  })

  // ── Load from URL params ─────────────────────────────────────
  function loadFromUrl(): boolean {
    const params = new URLSearchParams(location.search)
    const paramExpr = params.get('expr')
    const paramCtx = params.get('ctx')

    if (!paramExpr) return false

    exprInput.value = paramExpr
    ctxVars = []
    nextVarId = 1

    if (paramCtx) {
      try {
        const parsed = JSON.parse(paramCtx)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            ctxVars.push({ id: nextVarId++, name: k, value: JSON.stringify(v) })
          }
        }
      } catch {
        /* ignore */
      }
    }

    renderVars()
    for (const b of exampleBtns) b.classList.remove('active')
    return true
  }

  // ── Init ─────────────────────────────────────────────────────
  if (!loadFromUrl()) {
    renderVars()
  }
  updateHighlight()
  evaluate()
})
</script>
