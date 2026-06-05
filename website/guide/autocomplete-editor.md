# Editor Integration

The autocomplete API returns plain data objects with no DOM or framework dependency. Here is how to wire it into a real editor.

## Basic input with dropdown

The simplest integration: listen for input events, call `complete()`, and render results into a list.

```ts
const input = document.querySelector('input')
const dropdown = document.querySelector('.dropdown')

input.addEventListener('input', () => {
  const items = ac.complete(input.value, input.selectionStart)

  if (items.length === 0) {
    dropdown.hidden = true
    return
  }

  dropdown.replaceChildren()
  for (const c of items) {
    const li = document.createElement('li')
    li.dataset.insert = c.insertText ?? c.label

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = c.label

    const detail = document.createElement('span')
    detail.className = 'detail'
    detail.textContent = c.detail ?? ''

    li.append(label, detail)
    dropdown.appendChild(li)
  }
  dropdown.hidden = false
})
```

## Handling insertText and cursorOffset

When a user picks a completion, use `insertText` (falling back to `label`) and position the cursor using `cursorOffset` if present:

```ts
function applyCompletion(input, completion, replaceFrom) {
  const text = completion.insertText ?? completion.label
  const before = input.value.slice(0, replaceFrom)
  const after = input.value.slice(input.selectionStart)
  input.value = before + text + after

  // Position cursor: use cursorOffset if provided, otherwise end of insert
  const cursorPos = completion.cursorOffset != null
    ? replaceFrom + completion.cursorOffset
    : replaceFrom + text.length
  input.setSelectionRange(cursorPos, cursorPos)
}
```

::: tip cursorOffset places the cursor inside argument placeholders
`cursorOffset` is set on completions like `filter(.)` so the cursor lands between the parentheses, ready for the user to type a lambda predicate.
:::

## Monaco Editor

Monaco (the editor that powers VS Code) gives you a full code-editing surface with
a suggestion widget, theming, and syntax highlighting. Bonsai plugs into it with a
Monarch grammar for highlighting and a completion provider backed by the same
[`createAutocomplete`](/guide/autocomplete-setup) instance you use everywhere else.

You need a `monaco` instance first. Either bundle the
[`monaco-editor`](https://www.npmjs.com/package/monaco-editor) package with your app
(recommended: self-hosted and version-locked) or load it from a CDN. The integration
code below is identical either way; it assumes `monaco` and an autocomplete instance
`ac` are in scope:

```ts
import { bonsai } from 'bonsai-js'
import { strings, arrays, math } from 'bonsai-js/stdlib'
import { createAutocomplete } from 'bonsai-js/autocomplete'

const expr = bonsai().use(strings).use(arrays).use(math)

let context = { user: { name: 'Alice', age: 25 } }
const ac = createAutocomplete(expr, { context })
```

### 1. Register the language and syntax highlighting

Register a `bonsai` language and give it a Monarch tokenizer so expressions are
colored:

```ts
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
```

### 2. Wire autocomplete into a completion provider

This is the key step: map each Bonsai completion to Monaco's `CompletionItem`
format. `sortText` preserves Bonsai's ranking, and the `range` replaces the current
word so accepting a suggestion does the right thing.

```ts
const kindMap = {
  property: monaco.languages.CompletionItemKind.Field,
  method:   monaco.languages.CompletionItemKind.Method,
  transform: monaco.languages.CompletionItemKind.Function,
  function: monaco.languages.CompletionItemKind.Function,
  variable: monaco.languages.CompletionItemKind.Variable,
  keyword:  monaco.languages.CompletionItemKind.Keyword,
}

monaco.languages.registerCompletionItemProvider('bonsai', {
  triggerCharacters: ['.', '|', ' '],
  provideCompletionItems(model, position) {
    const text = model.getValueInRange({
      startLineNumber: 1, startColumn: 1,
      endLineNumber: position.lineNumber, endColumn: position.column,
    })
    const items = ac.complete(text, text.length)
    const word = model.getWordUntilPosition(position)

    return {
      suggestions: items.map(c => ({
        label: c.label,
        kind: kindMap[c.kind] || monaco.languages.CompletionItemKind.Text,
        detail: c.detail,
        insertText: c.insertText ?? c.label,
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
```

### 3. Create the editor

Create the editor on the `bonsai` language. The options below strip Monaco down to a
single expression line and let suggestions trigger as you type:

```ts
const editor = monaco.editor.create(document.getElementById('editor'), {
  value: 'user.',
  language: 'bonsai',
  minimap: { enabled: false },
  lineNumbers: 'off',
  folding: false,
  fontSize: 15,
  scrollBeyondLastLine: false,
  suggestOnTriggerCharacters: true,
  quickSuggestions: true,
  wordBasedSuggestions: 'off',
  acceptSuggestionOnEnter: 'on',
  automaticLayout: true,
})

// Evaluate on every change
editor.onDidChangeModelContent(() => {
  try {
    const result = expr.evaluateSync(editor.getValue().trim(), context)
    console.log(result)
  } catch (e) {
    console.error((e as Error).message)
  }
})
```

### 4. Optional: matching themes

Define dark and light themes so the editor matches your brand, and call
`monaco.editor.setTheme(...)` when your app's color scheme changes:

```ts
monaco.editor.defineTheme('bonsai-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'operator.pipe', foreground: '10b981', fontStyle: 'bold' },
    { token: 'operator', foreground: '10b981' },
    { token: 'string', foreground: '34d399' },
    { token: 'keyword', foreground: 'c084fc' },
    { token: 'number', foreground: '60a5fa' },
  ],
  colors: { 'editor.background': '#0e0e16' },
})

monaco.editor.setTheme('bonsai-dark')
```

When the context changes, keep autocomplete in sync with `ac.setContext(context)` so
completions reflect the available variables.
