<template>
  <div ref="root" class="pg-layout">
    <!-- Sidebar: examples (rendered from playground/examples.ts) -->
    <aside class="pg-sidebar">
      <div class="pg-sidebar-header">Examples</div>
      <div class="pg-example-list">
        <template v-for="group in groups" :key="group.name">
          <div class="pg-group-label">{{ group.name }}</div>
          <button
            v-for="example in group.examples"
            :key="example.id"
            class="pg-example"
            :class="{ active: example.id === activeId }"
            :data-example="example.id"
          >
            <span class="pg-example-title">{{ example.title }}</span>
            <span class="pg-example-code">{{ firstLine(example.expression) }}</span>
          </button>
        </template>
      </div>
    </aside>

    <!-- Main playground area -->
    <main class="pg-main">
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

      <div class="pg-editor-grid">
        <div class="pg-editor-left">
          <div class="pg-pane pg-expr-pane">
            <div class="pg-pane-header">
              <span class="pg-pane-label">Expression</span>
              <span class="pg-pane-hint">type-checked and evaluated as you type</span>
            </div>
            <div class="pg-expr-editor">
              <div class="pg-expr-highlight" id="expr-highlight" aria-hidden="true"></div>
              <textarea class="pg-expr-input" id="expr-input" spellcheck="false" placeholder="Type an expression..."></textarea>
            </div>
          </div>

          <div class="pg-pane pg-ctx-pane" id="ctx-pane">
            <div class="pg-pane-header">
              <span class="pg-pane-label">Context</span>
              <span class="pg-pane-hint">JSON values; ISO date-times become timestamps</span>
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

        <div class="pg-editor-right">
          <div class="pg-pane pg-result-pane">
            <div class="pg-pane-header">
              <div class="pg-result-tabs">
                <button class="pg-result-tab active" data-mode="result">Result</button>
                <button class="pg-result-tab" data-mode="ast">Syntax tree</button>
              </div>
              <span class="pg-result-type" id="result-type" title="Static type"></span>
            </div>
            <div class="pg-result-body" id="result-output"></div>
            <div class="pg-error" id="error-output"></div>
            <div class="pg-error pg-warning" id="warning-output"></div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { bonsai, formatType, isBonsaiError, Duration, type Diagnostic, type Environment } from 'bonsai-src'
import { createLanguageService, type Completion, type LanguageService } from 'bonsai-service'
import { examples, defaultExample, type Example } from './playground/examples'
import { buildContext, type ContextRow } from './playground/schema'
import './playground/playground.css'

// All rendering in this component builds DOM nodes and sets textContent.
// Expression text, context values, results, types, and messages are never
// inserted as HTML.

const root = ref<HTMLElement>()
const activeId = ref<string>(defaultExample.id)

const groups = (() => {
  const out: { name: string; examples: Example[] }[] = []
  for (const example of examples) {
    let group = out.find((g) => g.name === example.group)
    if (!group) out.push((group = { name: example.group, examples: [] }))
    group.examples.push(example)
  }
  return out
})()

function firstLine(text: string): string {
  const line = text.split('\n')[0]
  return line.length > 44 ? `${line.slice(0, 43)}…` : line
}

interface ContextVar extends ContextRow {
  id: number
}

const cleanups: (() => void)[] = []
onBeforeUnmount(() => {
  for (const cleanup of cleanups) cleanup()
})

onMounted(() => {
  const rootEl = root.value
  if (!rootEl) return

  const $ = <T extends Element = HTMLElement>(sel: string): T => rootEl.querySelector<T>(sel) as T
  const $all = <T extends Element = HTMLElement>(sel: string): T[] =>
    Array.from(rootEl.querySelectorAll<T>(sel))

  const exprInput = $<HTMLTextAreaElement>('#expr-input')
  const exprHighlight = $('#expr-highlight')
  const ctxVarsEl = $('#ctx-vars')
  const ctxEmptyEl = $('#ctx-empty')
  const resultOutput = $('#result-output')
  const errorOutput = $('#error-output')
  const warningOutput = $('#warning-output')
  const resultType = $('#result-type')
  const evalTimeEl = $('#eval-time')
  const exampleBtns = $all<HTMLButtonElement>('.pg-example')
  const resultTabs = $all<HTMLButtonElement>('.pg-result-tab')
  const shareBtn = $<HTMLButtonElement>('#share-btn')
  const resetBtn = $<HTMLButtonElement>('#reset-btn')
  const liveBadge = $('#live-badge')

  let currentMode = 'result'

  // ── Environment ─────────────────────────────────────────────
  // The environment is rebuilt from the context rows: each variable is
  // declared with a type inferred from its value, so the checker, completions,
  // and hover know the data's shape.
  let ctxVars: ContextVar[] = []
  let nextVarId = 1
  let context: Record<string, unknown> = {}
  let env: Environment<never> = bonsai() as Environment<never>
  let service: LanguageService = createLanguageService(env)
  let diagnostics: readonly Diagnostic[] = []

  function rebuildEnvironment() {
    const built = buildContext(ctxVars)
    context = built.context
    env = bonsai({ variables: built.variables, limits: { timeout: 250 } }) as Environment<never>
    service = createLanguageService(env)
  }

  // ── Context rows ────────────────────────────────────────────
  function detectType(raw: string): string {
    const s = raw.trim()
    if (s === '' || s === 'null') return 'null'
    if (s === 'true' || s === 'false') return 'boolean'
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return 'number'
    if (/^["']\d{4}-\d{2}-\d{2}T/.test(s)) return 'timestamp'
    if (s.startsWith('"') || s.startsWith("'")) return 'string'
    if (s.startsWith('[')) return 'list'
    if (s.startsWith('{')) return 'map'
    return 'string'
  }

  const typeClass: Record<string, string> = {
    null: 'null',
    boolean: 'boolean',
    number: 'number',
    timestamp: 'string',
    string: 'string',
    list: 'array',
    map: 'object',
  }

  function setBadge(badge: HTMLElement, raw: string) {
    const kind = detectType(raw)
    badge.className = `pg-ctx-row-type ctx-type-${typeClass[kind]}`
    badge.textContent = kind
  }

  function onContextChanged() {
    rebuildEnvironment()
    markStale()
    scheduleEvaluate()
  }

  function addVar(name = '', value = '', focus = false) {
    const v: ContextVar = { id: nextVarId++, name, value }
    ctxVars.push(v)
    renderVars()
    if (focus) {
      ctxVarsEl.querySelector<HTMLInputElement>(`[data-id="${v.id}"] .pg-ctx-row-name`)?.focus()
    }
  }

  function removeVar(id: number) {
    ctxVars = ctxVars.filter((v) => v.id !== id)
    renderVars()
    onContextChanged()
  }

  function renderVars() {
    ctxVarsEl.textContent = ''
    ctxEmptyEl.style.display = ctxVars.length === 0 ? '' : 'none'

    for (const v of ctxVars) {
      const row = document.createElement('div')
      row.className = 'pg-ctx-row'
      row.dataset.id = String(v.id)

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

      const valueInput = document.createElement('textarea')
      valueInput.className = 'pg-ctx-row-value'
      valueInput.placeholder = '"hello", 42, [1, 2], { "a": 1 }'
      valueInput.value = v.value
      valueInput.spellcheck = false
      valueInput.rows = 1

      const meta = document.createElement('div')
      meta.className = 'pg-ctx-row-meta'
      const typeBadge = document.createElement('span')
      setBadge(typeBadge, v.value)
      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'pg-ctx-row-delete'
      deleteBtn.title = 'Remove'
      deleteBtn.textContent = '×'
      meta.append(typeBadge, deleteBtn)

      nameInput.addEventListener('input', () => {
        v.name = nameInput.value
        onContextChanged()
      })
      valueInput.addEventListener('input', () => {
        v.value = valueInput.value
        setBadge(typeBadge, v.value)
        onContextChanged()
      })
      deleteBtn.addEventListener('click', () => removeVar(v.id))

      row.append(left, valueInput, meta)
      ctxVarsEl.appendChild(row)
    }
  }

  // ── Highlight overlay ───────────────────────────────────────
  // The overlay sits behind the transparent-background textarea and only
  // tints ranges: declared variables, function names, and diagnostic ranges.
  function updateHighlight() {
    const text = exprInput.value
    const marks: string[] = new Array(text.length).fill('')

    const names = new Set(Object.keys(env.variables ?? {}))
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const start = match.index ?? 0
      const word = match[0]
      const before = text.slice(0, start).trimEnd()
      const afterMember = before.endsWith('.') && !before.endsWith('...')
      const isCall = /^\s*\(/.test(text.slice(start + word.length))
      let cls = ''
      if (isCall && env.describeFunction(word)) cls = 'hl-transform'
      else if (!afterMember && names.has(word)) cls = 'hl-var'
      if (cls) for (let i = start; i < start + word.length; i++) marks[i] = cls
    }
    for (const d of diagnostics) {
      const cls = d.severity === 'error' ? 'hl-error' : 'hl-warn'
      const end = Math.max(d.end, d.start + 1)
      for (let i = d.start; i < Math.min(end, text.length); i++) marks[i] = `${marks[i]} ${cls}`.trim()
    }

    const frag = document.createDocumentFragment()
    let i = 0
    while (i < text.length) {
      const cls = marks[i]
      let j = i + 1
      while (j < text.length && marks[j] === cls) j++
      const chunk = text.slice(i, j)
      if (cls) {
        const span = document.createElement('span')
        span.className = cls
        span.textContent = chunk
        frag.appendChild(span)
      } else {
        frag.appendChild(document.createTextNode(chunk))
      }
      i = j
    }
    // A trailing newline needs a character after it to take up a line.
    frag.appendChild(document.createTextNode('​'))
    exprHighlight.textContent = ''
    exprHighlight.appendChild(frag)
  }

  exprInput.addEventListener('scroll', () => {
    exprHighlight.scrollTop = exprInput.scrollTop
    exprHighlight.scrollLeft = exprInput.scrollLeft
  })

  // ── Geometry helpers (monospace textarea) ───────────────────
  function metrics() {
    const style = getComputedStyle(exprInput)
    return {
      lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6,
      charWidth: parseFloat(style.fontSize) * 0.6,
      padLeft: parseFloat(style.paddingLeft),
      padTop: parseFloat(style.paddingTop),
    }
  }

  function offsetAtPoint(clientX: number, clientY: number): number | null {
    const { lineHeight, charWidth, padLeft, padTop } = metrics()
    const rect = exprInput.getBoundingClientRect()
    const x = clientX - rect.left - padLeft + exprInput.scrollLeft
    const y = clientY - rect.top - padTop + exprInput.scrollTop
    const row = Math.floor(y / lineHeight)
    const col = Math.floor(x / charWidth)
    const lines = exprInput.value.split('\n')
    if (row < 0 || row >= lines.length || col < 0 || col >= lines[row].length) return null
    let offset = col
    for (let r = 0; r < row; r++) offset += lines[r].length + 1
    return offset
  }

  function pointAtOffset(offset: number): { left: number; top: number } {
    const { lineHeight, charWidth, padLeft, padTop } = metrics()
    const lines = exprInput.value.slice(0, offset).split('\n')
    const row = lines.length - 1
    const col = lines[row].length
    const rect = exprInput.getBoundingClientRect()
    return {
      left: rect.left + padLeft + col * charWidth - exprInput.scrollLeft,
      top: rect.top + padTop + row * lineHeight - exprInput.scrollTop,
    }
  }

  // ── Hover tooltip (types and signatures from the language service) ──
  const tooltip = document.createElement('div')
  tooltip.className = 'pg-transform-tooltip'
  tooltip.style.display = 'none'
  document.body.appendChild(tooltip)
  cleanups.push(() => tooltip.remove())

  let hoverKey = ''
  let tooltipTimer: ReturnType<typeof setTimeout> | undefined

  exprInput.addEventListener('mousemove', (e) => {
    const offset = offsetAtPoint(e.clientX, e.clientY)
    const info = offset === null ? undefined : service.hover(exprInput.value, offset)
    if (!info) {
      hoverKey = ''
      hideTooltip()
      return
    }
    const key = `${info.start}:${info.end}:${info.detail}`
    if (key === hoverKey) return
    hoverKey = key
    clearTimeout(tooltipTimer)

    tooltip.textContent = ''
    const name = document.createElement('span')
    name.className = 'pg-tt-name'
    name.textContent = exprInput.value.slice(info.start, info.end)
    const detail = document.createElement('span')
    detail.className = 'pg-tt-module'
    detail.textContent = info.detail
    tooltip.append(name, detail)
    if (info.documentation) {
      const doc = document.createElement('span')
      doc.className = 'pg-tt-desc'
      doc.textContent = info.documentation
      tooltip.append(doc)
    }
    const point = pointAtOffset(info.start)
    tooltip.style.display = ''
    tooltip.style.left = `${point.left + ((info.end - info.start) * metrics().charWidth) / 2}px`
    tooltip.style.top = `${point.top - 4}px`
  })

  exprInput.addEventListener('mouseleave', () => {
    hoverKey = ''
    hideTooltip()
  })

  function hideTooltip() {
    clearTimeout(tooltipTimer)
    tooltipTimer = setTimeout(() => {
      tooltip.style.display = 'none'
    }, 150)
  }

  // ── Completions (from the language service) ─────────────────
  const acPanel = document.createElement('div')
  acPanel.className = 'pg-autocomplete'
  acPanel.style.display = 'none'
  document.body.appendChild(acPanel)
  cleanups.push(() => acPanel.remove())

  let acItems: Completion[] = []
  let acIndex = -1
  let acFrom = 0
  let acTo = 0

  function updateAutocomplete() {
    const pos = exprInput.selectionStart
    const text = exprInput.value
    const result = service.complete(text, pos)
    const typed = text.slice(result.from, pos)
    // Only offer completions while a name or member is being typed.
    const afterDot = /\??\.\s*$/.test(text.slice(0, result.from)) && !/\.\.\.\s*$/.test(text.slice(0, result.from))
    const items = result.items.filter((item) => item.label !== '.')
    if (
      items.length === 0 ||
      (typed === '' && !afterDot) ||
      (items.length === 1 && items[0].label === typed)
    ) {
      closeAutocomplete()
      return
    }
    acItems = items.slice(0, 12)
    acFrom = result.from
    acTo = result.to
    acIndex = 0
    renderAutocomplete(typed)
  }

  function renderAutocomplete(typed = exprInput.value.slice(acFrom, exprInput.selectionStart)) {
    acPanel.textContent = ''
    acItems.forEach((item, i) => {
      const row = document.createElement('div')
      row.className = 'pg-ac-item' + (i === acIndex ? ' active' : '')

      const name = document.createElement('span')
      name.className = 'pg-ac-name'
      if (typed && item.label.toLowerCase().startsWith(typed.toLowerCase())) {
        const bold = document.createElement('strong')
        bold.textContent = item.label.slice(0, typed.length)
        name.append(bold, document.createTextNode(item.label.slice(typed.length)))
      } else {
        name.textContent = item.label
      }

      const kind = document.createElement('span')
      kind.className = 'pg-ac-module'
      kind.textContent = item.kind

      const desc = document.createElement('span')
      desc.className = 'pg-ac-desc'
      desc.textContent = item.documentation || item.detail.split('\n')[0]

      row.append(name, kind, desc)
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        acIndex = i
        acceptAutocomplete()
      })
      acPanel.appendChild(row)
    })

    const point = pointAtOffset(acFrom)
    acPanel.style.left = `${point.left}px`
    acPanel.style.top = `${point.top + metrics().lineHeight + 4}px`
    acPanel.style.display = ''
    ;(acPanel.children[acIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }

  function acceptAutocomplete() {
    const item = acItems[acIndex]
    if (!item) return
    const text = exprInput.value
    exprInput.value = text.slice(0, acFrom) + item.insertText + text.slice(acTo)
    const caret = acFrom + item.insertText.length
    exprInput.setSelectionRange(caret, caret)
    closeAutocomplete()
    onExpressionChanged()
  }

  function closeAutocomplete() {
    acPanel.style.display = 'none'
    acItems = []
    acIndex = -1
  }

  const isAutocompleteOpen = () => acPanel.style.display !== 'none'

  // ── Result rendering (DOM nodes only) ───────────────────────
  function span(cls: string, text: string): HTMLSpanElement {
    const el = document.createElement('span')
    el.className = cls
    el.textContent = text
    return el
  }

  function renderValue(value: unknown, depth: number, seen: Set<object> = new Set()): Node {
    if (value === null || value === undefined) return span('r-null', 'null')
    if (typeof value === 'string') return span('r-string', JSON.stringify(value))
    if (typeof value === 'number') return span('r-number', String(value))
    if (typeof value === 'boolean') return span('r-boolean', String(value))
    if (value instanceof Date) return span('r-number', value.toISOString())
    if (value instanceof Duration) return span('r-number', value.toString())
    if (typeof value !== 'object') return document.createTextNode(String(value))
    if (seen.has(value) || depth > 20) return span('r-punct', '…')
    seen.add(value)

    const frag = document.createDocumentFragment()
    const indent = '  '.repeat(depth + 1)
    const close = '  '.repeat(depth)
    const entries: [string | null, unknown][] = Array.isArray(value)
      ? value.map((item) => [null, item])
      : Object.entries(value as Record<string, unknown>)
    const [open, shut] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
    if (entries.length === 0) {
      frag.appendChild(span('r-bracket', open + shut))
      return frag
    }
    frag.appendChild(span('r-bracket', open))
    entries.forEach(([key, item], index) => {
      frag.appendChild(document.createTextNode(`\n${indent}`))
      if (key !== null) {
        frag.appendChild(span('r-key', JSON.stringify(key)))
        frag.appendChild(span('r-punct', ': '))
      }
      frag.appendChild(renderValue(item, depth + 1, seen))
      if (index < entries.length - 1) frag.appendChild(span('r-punct', ','))
    })
    frag.appendChild(document.createTextNode(`\n${close}`))
    frag.appendChild(span('r-bracket', shut))
    return frag
  }

  function setResult(node: Node | null) {
    resultOutput.textContent = ''
    if (node) resultOutput.appendChild(node)
  }

  function showMessages(el: HTMLElement, lines: string[]) {
    el.textContent = lines.join('\n\n')
    el.style.display = lines.length > 0 ? 'block' : 'none'
  }

  function describe(d: Diagnostic, source: string): string {
    const before = source.slice(0, d.start).split('\n')
    return `${d.code} (line ${before.length}, column ${before[before.length - 1].length + 1})\n${d.message}`
  }

  // ── Evaluate ────────────────────────────────────────────────
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
    const source = exprInput.value
    clearTimeout(errorTimer)
    showMessages(errorOutput, [])
    showMessages(warningOutput, [])
    markLive()

    if (source.trim() === '') {
      diagnostics = []
      updateHighlight()
      setResult(null)
      resultType.textContent = ''
      evalTimeEl.textContent = ''
      return
    }

    const check = env.check(source)
    diagnostics = check.diagnostics
    updateHighlight()
    resultType.textContent = check.type ? formatType(check.type) : ''
    const errors = check.diagnostics.filter((d) => d.severity === 'error')
    const warnings = check.diagnostics.filter((d) => d.severity === 'warning')
    showMessages(warningOutput, warnings.map((d) => `warning: ${describe(d, source)}`))

    if (currentMode === 'ast') {
      try {
        setResult(renderValue(env.parse(source), 0))
      } catch {
        setResult(null)
      }
    }

    if (errors.length > 0) {
      if (currentMode === 'result') setResult(null)
      evalTimeEl.textContent = ''
      // Delay errors slightly so they do not flash while typing.
      errorTimer = setTimeout(() => showMessages(errorOutput, errors.map((d) => describe(d, source))), 400)
      return
    }
    if (currentMode === 'ast') return

    const start = performance.now()
    try {
      const result = env.evaluateSync(source, context as never)
      evalTimeEl.textContent = `${(performance.now() - start).toFixed(2)}ms`
      setResult(renderValue(result, 0))
    } catch (error) {
      setResult(null)
      evalTimeEl.textContent = ''
      const text = isBonsaiError(error) ? `${error.code}\n${error.formatted}` : String(error)
      errorTimer = setTimeout(() => showMessages(errorOutput, [text]), 400)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  function scheduleEvaluate() {
    clearTimeout(timer)
    timer = setTimeout(evaluate, 150)
  }

  function onExpressionChanged() {
    updateHighlight()
    markStale()
    scheduleEvaluate()
  }

  // ── Events ──────────────────────────────────────────────────
  exprInput.addEventListener('input', () => {
    onExpressionChanged()
    updateAutocomplete()
  })

  exprInput.addEventListener('keydown', (e) => {
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
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault()
      updateAutocomplete()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      clearTimeout(timer)
      evaluate()
    }
  })

  exprInput.addEventListener('blur', () => closeAutocomplete())

  const onDocumentPointerDown = (e: PointerEvent) => {
    const target = e.target as Node
    if (!acPanel.contains(target) && target !== exprInput) closeAutocomplete()
  }
  document.addEventListener('pointerdown', onDocumentPointerDown)
  cleanups.push(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

  $<HTMLButtonElement>('#ctx-add').addEventListener('click', () => addVar('', '', true))
  $<HTMLButtonElement>('#ctx-empty-add').addEventListener('click', () => addVar('', '', true))

  function loadExample(example: Example) {
    activeId.value = example.id
    exprInput.value = example.expression
    ctxVars = example.vars.map((v) => ({ id: nextVarId++, name: v.name, value: v.value }))
    renderVars()
    rebuildEnvironment()
    evaluate()
  }

  for (const btn of exampleBtns) {
    btn.addEventListener('click', () => {
      const example = examples.find((e) => e.id === btn.dataset.example)
      if (example) loadExample(example)
    })
  }

  for (const tab of resultTabs) {
    tab.addEventListener('click', () => {
      currentMode = tab.dataset.mode ?? 'result'
      for (const other of resultTabs) other.classList.toggle('active', other === tab)
      evaluate()
    })
  }

  shareBtn.addEventListener('click', () => {
    const vars: Record<string, string> = {}
    for (const v of ctxVars) if (v.name.trim()) vars[v.name.trim()] = v.value
    const params = new URLSearchParams({ expr: exprInput.value, ctx: JSON.stringify(vars) })
    const url = `${location.origin}${location.pathname}?${params}`
    void navigator.clipboard.writeText(url).then(() => {
      shareBtn.classList.add('copied')
      const label = shareBtn.querySelector<HTMLElement>('.pg-btn-label')
      if (label) label.textContent = 'Copied!'
      setTimeout(() => {
        shareBtn.classList.remove('copied')
        if (label) label.textContent = 'Share'
      }, 2000)
    })
  })

  resetBtn.addEventListener('click', () => loadExample(defaultExample))

  // ── Load from URL parameters ────────────────────────────────
  function loadFromUrl(): boolean {
    const params = new URLSearchParams(location.search)
    const expr = params.get('expr')
    if (expr === null) return false
    exprInput.value = expr
    ctxVars = []
    try {
      const parsed: unknown = JSON.parse(params.get('ctx') ?? '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) {
          // Current links store the raw text of each value; older links stored JSON values.
          ctxVars.push({ id: nextVarId++, name, value: typeof value === 'string' ? value : JSON.stringify(value) })
        }
      }
    } catch {
      // ignore a malformed context
    }
    activeId.value = ''
    renderVars()
    rebuildEnvironment()
    evaluate()
    return true
  }

  if (!loadFromUrl()) loadExample(defaultExample)
})
</script>
