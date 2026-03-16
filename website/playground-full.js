import { bonsai } from './bonsai.bundle.js'
import { strings, arrays, math, types, dates } from './stdlib.bundle.js'

const expr = bonsai()
expr.use(strings)
expr.use(arrays)
expr.use(math)
expr.use(types)
expr.use(dates)

// ── Stdlib transform catalog ────────────────────────────────
const transforms = {
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

// ── Examples ─────────────────────────────────────────────────
const examples = {
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
  'search': {
    expression: 'items |> filter(.name.includes("Pro")) |> map(.name)',
    vars: [
      { name: 'items', value: '[\n  { "name": "MacBook Pro" },\n  { "name": "iPad Air" },\n  { "name": "AirPods Pro" }\n]' },
    ],
  },
}

// ── DOM ──────────────────────────────────────────────────────
const exprInput = document.getElementById('expr-input')
const exprHighlight = document.getElementById('expr-highlight')
const ctxVarsEl = document.getElementById('ctx-vars')
const ctxEmptyEl = document.getElementById('ctx-empty')
const resultOutput = document.getElementById('result-output')
const errorOutput = document.getElementById('error-output')
const resultType = document.getElementById('result-type')
const evalTimeEl = document.getElementById('eval-time')
const exampleBtns = document.querySelectorAll('.pg-example')
const resultTabs = document.querySelectorAll('.pg-result-tab')
const shareBtn = document.getElementById('share-btn')
const resetBtn = document.getElementById('reset-btn')
const liveBadge = document.getElementById('live-badge')
const ctxAddBtn = document.getElementById('ctx-add')
const ctxEmptyAdd = document.getElementById('ctx-empty-add')

let currentMode = 'result'

// ── Context state ────────────────────────────────────────────
let ctxVars = []
let nextVarId = 1

function addVar(name = '', value = '', focus = false) {
  const v = { id: nextVarId++, name, value }
  ctxVars.push(v)
  renderVars()
  if (focus) {
    const row = ctxVarsEl.querySelector(`[data-id="${v.id}"]`)
    if (row) row.querySelector('.pg-ctx-row-name').focus()
  }
}

function removeVar(id) {
  ctxVars = ctxVars.filter((v) => v.id !== id)
  renderVars()
  scheduleEvaluate()
}

function detectType(raw) {
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
  ctxEmptyEl.style.display = empty ? '' : 'none'

  for (const v of ctxVars) {
    const row = document.createElement('div')
    row.className = 'pg-ctx-row'
    row.dataset.id = v.id

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
    deleteBtn.textContent = '\u00d7'

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

function relaxedJsonParse(raw) {
  const s = raw.trim()
  if (!s) return undefined
  // Try strict JSON first
  try { return JSON.parse(s) } catch { /* fall through */ }
  // Normalize JS-style objects: unquoted keys → quoted, single quotes → double
  try {
    const normalized = s
      // Replace single-quoted strings with double-quoted
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
      // Quote unquoted keys (word chars before colon)
      .replace(/(?<=[\{,]\s*)(\w+)\s*:/g, '"$1":')
    return JSON.parse(normalized)
  } catch { /* fall through */ }
  // Fallback: treat as raw string
  return raw
}

function buildContext() {
  const ctx = {}
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
// content is escaped via escapeHtml before insertion.
function updateHighlight() {
  const text = exprInput.value
  const varNames = ctxVars.map((v) => v.name.trim()).filter(Boolean)

  // Build combined regex for context vars and transforms
  const parts = []
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
    if (match.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, match.index)))
    }
    const word = match[0]
    const span = document.createElement('span')

    // Skip transform highlighting if preceded by `.` (property access, not a transform)
    const charBefore = match.index > 0 ? text[match.index - 1] : ''
    const isPropertyAccess = charBefore === '.'

    if (varSet.has(word)) {
      span.className = 'hl-var'
      span.textContent = word
    } else if (transforms[word] && !isPropertyAccess) {
      const t = transforms[word]
      span.className = 'hl-transform'
      span.textContent = word
      span.dataset.desc = t.desc
      span.dataset.module = t.module
    }

    frag.appendChild(span)
    last = match.index + match[0].length
  }
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)))
  }
  exprHighlight.textContent = ''
  exprHighlight.appendChild(frag)
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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

let tooltipTimer
let activeTransform = ''

function getWordAtMouse(e) {
  // Use a hidden range/caret approach: create a temporary element at cursor pos
  // Simpler: extract word at approximate character offset from mouse position
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
    if (col >= m.index && col <= m.index + m[0].length) {
      return m[0]
    }
  }
  return null
}

exprInput.addEventListener('mousemove', (e) => {
  const word = getWordAtMouse(e)
  if (!word) {
    if (activeTransform) { activeTransform = ''; hideTooltip() }
    return
  }

  // Find the closest matching span to the mouse position
  function closestSpan(selector, text, mouseX) {
    const spans = exprHighlight.querySelectorAll(selector)
    let best = null
    let bestDist = Infinity
    for (const s of spans) {
      if (s.textContent !== text) continue
      const rect = s.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const dist = Math.abs(mouseX - cx)
      if (dist < bestDist) { bestDist = dist; best = s }
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

function showTransformTooltip(word, el) {
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

function showVarTooltip(v, el) {
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

function positionTooltip(el) {
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

const transformList = Object.entries(transforms).map(([name, t]) => ({
  name,
  desc: t.desc,
  module: t.module,
  accepts: t.accepts,
}))

let acItems = []
let acIndex = -1
let acPrefix = ''
let acStart = -1 // cursor position where the prefix starts

function getAutocompleteContext() {
  const pos = exprInput.selectionStart
  const text = exprInput.value.slice(0, pos)

  // Match: |> optional-whitespace then optional-partial-word at cursor
  const m = text.match(/\|>\s*(\w*)$/)
  if (m) {
    // Extract the expression before this |> to determine input type
    const beforePipe = text.slice(0, m.index).trim()
    return { prefix: m[1].toLowerCase(), start: pos - m[1].length, beforePipe }
  }
  return null
}

function inferPipeInputType(exprBefore) {
  if (!exprBefore) return null
  try {
    const context = buildContext()
    const result = expr.evaluateSync(exprBefore, context)
    if (result === null || result === undefined) return null
    if (Array.isArray(result)) return 'array'
    return typeof result
  } catch {
    return null
  }
}

function updateAutocomplete() {
  const ctx = getAutocompleteContext()
  if (!ctx) {
    closeAutocomplete()
    return
  }

  acPrefix = ctx.prefix
  acStart = ctx.start

  const inputType = inferPipeInputType(ctx.beforePipe)

  // Filter by prefix match, then by type compatibility
  acItems = transformList
    .filter((t) => {
      if (!t.name.toLowerCase().startsWith(acPrefix)) return false
      // If we can't determine the type, show all
      if (!inputType) return true
      // null accepts = works on any type
      if (!t.accepts) return true
      return t.accepts.includes(inputType)
    })
    .slice(0, 12)

  if (acItems.length === 0 || (acItems.length === 1 && acItems[0].name.toLowerCase() === acPrefix)) {
    closeAutocomplete()
    return
  }

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
  const activeRow = acPanel.children[acIndex]
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
let errorTimer

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
  errorOutput.style.display = 'none'
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
        errorOutput.textContent = e.message
        errorOutput.style.display = 'block'
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
      errorOutput.textContent = e.message
      errorOutput.style.display = 'block'
    }, 500)
    resultOutput.textContent = ''
    resultType.textContent = ''
  }
}

// Safe HTML setter for result output - content is fully escaped evaluator output
function setResultHtml(html) {
  // Using a dedicated setter to make the innerHTML usage auditable.
  // All interpolated strings pass through escapeHtml first.
  resultOutput.innerHTML = html
}

function getType(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function colorize(value, depth) {
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
    const keys = Object.keys(value)
    if (keys.length === 0) return '<span class="r-bracket">{}</span>'
    const indent = '  '.repeat(depth + 1)
    const close = '  '.repeat(depth)
    const entries = keys.map(
      (k) => `${indent}<span class="r-key">"${escapeHtml(k)}"</span><span class="r-punct">:</span> ${colorize(value[k], depth + 1)}`,
    )
    return `<span class="r-bracket">{</span>\n${entries.join('<span class="r-punct">,</span>\n')}\n${close}<span class="r-bracket">}</span>`
  }

  return escapeHtml(String(value))
}

function highlightJson(json) {
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
let timer
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
  if (!acPanel.contains(e.target) && e.target !== exprInput) {
    closeAutocomplete()
  }
})

ctxAddBtn.addEventListener('click', () => addVar('', '', true))
ctxEmptyAdd.addEventListener('click', () => addVar('', '', true))

for (const btn of exampleBtns) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.example
    const example = examples[key]
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
    currentMode = tab.dataset.mode
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
    const span = shareBtn.querySelector('.pg-btn-label')
    if (span) span.textContent = 'Copied!'
    setTimeout(() => {
      shareBtn.classList.remove('copied')
      const s = shareBtn.querySelector('.pg-btn-label')
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
function loadFromUrl() {
  const params = new URLSearchParams(location.search)
  const paramExpr = params.get('expr')
  const paramCtx = params.get('ctx')

  if (!paramExpr) return false

  exprInput.value = decodeURIComponent(paramExpr)
  ctxVars = []
  nextVarId = 1

  if (paramCtx) {
    try {
      const parsed = JSON.parse(decodeURIComponent(paramCtx))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          ctxVars.push({ id: nextVarId++, name: k, value: JSON.stringify(v) })
        }
      }
    } catch { /* ignore */ }
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
