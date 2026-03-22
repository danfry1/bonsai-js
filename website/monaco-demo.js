import { bonsai } from './bonsai.bundle.js'
import { strings, arrays, math } from './stdlib.bundle.js'
import { createAutocomplete } from './autocomplete.bundle.js'

// ── Bonsai setup ───────────────────────────────────────────

const expr = bonsai().use(strings).use(arrays).use(math)

const defaultContext = {
  user: { name: 'Alice', age: 25, plan: 'pro', email: 'alice@example.com' },
  items: [
    { title: 'Widget', price: 9.99, inStock: true },
    { title: 'Gadget', price: 24.50, inStock: false },
  ],
  threshold: 100,
}

let context = { ...defaultContext }
const ac = createAutocomplete(expr, { context })

// ── Monaco loader (CDN) ────────────────────────────────────

const MONACO_VERSION = '0.52.2'
const MONACO_CDN = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`

function loadMonaco() {
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = `${MONACO_CDN}/vs/loader.js`
    script.onload = () => {
      window.require.config({ paths: { vs: `${MONACO_CDN}/vs` } })
      window.require(['vs/editor/editor.main'], resolve)
    }
    document.head.appendChild(script)
  })
}

// ── Boot ────────────────────────────────────────────────────

loadMonaco().then((monaco) => {
  // Register language
  monaco.languages.register({ id: 'bonsai' })

  monaco.languages.setMonarchTokensProvider('bonsai', {
    tokenizer: {
      root: [
        [/\|>/, 'operator.pipe'],
        [/[=><!]+/, 'operator'],
        [/[&|]{2}/, 'operator'],
        [/\?\?/, 'operator'],
        [/\?\./, 'operator'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/`[^`]*`/, 'string'],
        [/\b(true|false|null|undefined)\b/, 'keyword'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[a-zA-Z_]\w*/, 'identifier'],
        [/\./, 'delimiter'],
      ],
    },
  })

  // Dark theme
  monaco.editor.defineTheme('bonsai-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'operator.pipe', foreground: '10b981', fontStyle: 'bold' },
      { token: 'operator', foreground: '10b981' },
      { token: 'string', foreground: '34d399' },
      { token: 'keyword', foreground: 'c084fc' },
      { token: 'number', foreground: '60a5fa' },
      { token: 'identifier', foreground: 'e8e4df' },
      { token: 'delimiter', foreground: '888888' },
    ],
    colors: {
      'editor.background': '#0e0e16',
      'editor.foreground': '#e8e4df',
      'editorCursor.foreground': '#10b981',
      'editor.lineHighlightBackground': '#14141f',
      'editor.selectionBackground': '#1a3a2a',
      'editorSuggestWidget.background': '#14141f',
      'editorSuggestWidget.border': '#1e1e2e',
      'editorSuggestWidget.foreground': '#e8e4df',
      'editorSuggestWidget.selectedBackground': '#1a3a2a',
      'editorSuggestWidget.highlightForeground': '#10b981',
      'editorSuggestWidget.focusHighlightForeground': '#34d399',
      'editorSuggestWidget.selectedForeground': '#ffffff',
    },
  })

  // Light theme
  monaco.editor.defineTheme('bonsai-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'operator.pipe', foreground: '059669', fontStyle: 'bold' },
      { token: 'operator', foreground: '059669' },
      { token: 'string', foreground: '059669' },
      { token: 'keyword', foreground: '7c3aed' },
      { token: 'number', foreground: '2563eb' },
      { token: 'identifier', foreground: '1a1a2e' },
      { token: 'delimiter', foreground: '888888' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1a1a2e',
      'editorCursor.foreground': '#059669',
      'editor.lineHighlightBackground': '#f5f5f8',
      'editor.selectionBackground': '#d1fae5',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#e0e0e0',
      'editorSuggestWidget.foreground': '#1a1a2e',
      'editorSuggestWidget.selectedBackground': '#d1fae5',
      'editorSuggestWidget.highlightForeground': '#059669',
      'editorSuggestWidget.focusHighlightForeground': '#047857',
      'editorSuggestWidget.selectedForeground': '#000000',
    },
  })

  // Kind mapping
  const kindMap = {
    property: monaco.languages.CompletionItemKind.Field,
    method: monaco.languages.CompletionItemKind.Method,
    transform: monaco.languages.CompletionItemKind.Function,
    function: monaco.languages.CompletionItemKind.Function,
    variable: monaco.languages.CompletionItemKind.Variable,
    keyword: monaco.languages.CompletionItemKind.Keyword,
  }

  // Register completion provider
  monaco.languages.registerCompletionItemProvider('bonsai', {
    triggerCharacters: ['.', '|', ' '],
    provideCompletionItems(model, position) {
      const text = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      const items = ac.complete(text, text.length)
      const word = model.getWordUntilPosition(position)

      return {
        suggestions: items.map((c) => ({
          label: c.label,
          kind: kindMap[c.kind] || monaco.languages.CompletionItemKind.Text,
          detail: c.detail,
          insertText: c.insertText || c.label,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          sortText: String(c.sortPriority + 10000).padStart(8, '0'),
        })),
      }
    },
  })

  // Detect initial theme
  function getTheme() {
    const ds = document.documentElement.dataset.theme
    if (ds) return ds === 'light' ? 'bonsai-light' : 'bonsai-dark'
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'bonsai-light' : 'bonsai-dark'
  }

  // Create editor
  const editor = monaco.editor.create(document.getElementById('monaco-editor'), {
    value: 'user.',
    language: 'bonsai',
    theme: getTheme(),
    minimap: { enabled: false },
    lineNumbers: 'off',
    glyphMargin: false,
    folding: false,
    fontSize: 15,
    fontFamily: "'JetBrains Mono', monospace",
    padding: { top: 16, bottom: 16 },
    scrollBeyondLastLine: false,
    overviewRulerLanes: 0,
    renderLineHighlight: 'none',
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    wordBasedSuggestions: 'off',
    acceptSuggestionOnEnter: 'on',
    tabCompletion: 'on',
    automaticLayout: true,
  })

  // Theme switching
  const observer = new MutationObserver(() => {
    monaco.editor.setTheme(getTheme())
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) {
      monaco.editor.setTheme(getTheme())
    }
  })

  // ── Live evaluation ────────────────────────────────────────

  const resultEl = document.getElementById('result')

  function evaluate() {
    const value = editor.getValue().trim()
    if (!value) {
      resultEl.textContent = ''
      resultEl.className = 'md-result-value'
      return
    }
    try {
      const result = expr.evaluateSync(value, context)
      resultEl.textContent = JSON.stringify(result)
      resultEl.className = 'md-result-value'
    } catch (e) {
      resultEl.textContent = e.message
      resultEl.className = 'md-result-error'
    }
  }

  editor.onDidChangeModelContent(() => evaluate())
  evaluate()

  // ── Context editing ──────────────────────────────────────

  const contextEditor = document.getElementById('context-editor')
  const contextError = document.getElementById('context-error')

  contextEditor.addEventListener('input', () => {
    try {
      context = JSON.parse(contextEditor.value)
      ac.setContext(context)
      contextError.classList.remove('visible')
      contextError.textContent = ''
      evaluate()
    } catch (e) {
      contextError.textContent = e.message
      contextError.classList.add('visible')
    }
  })

  // ── Hint clicks ──────────────────────────────────────────

  document.querySelectorAll('.md-hint[data-expr]').forEach((hint) => {
    hint.addEventListener('click', () => {
      const value = hint.dataset.expr
      editor.setValue(value)
      editor.setPosition({ lineNumber: 1, column: value.length + 1 })
      editor.focus()
      setTimeout(() => {
        editor.trigger('hint', 'editor.action.triggerSuggest', {})
      }, 100)
    })
  })

  // Focus and trigger initial completions
  editor.focus()
  setTimeout(() => {
    editor.setPosition({ lineNumber: 1, column: 6 })
    editor.trigger('init', 'editor.action.triggerSuggest', {})
  }, 300)
})
