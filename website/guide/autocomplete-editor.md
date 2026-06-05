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

> **Tip:** `cursorOffset` is set on completions like `filter(.)` so the cursor lands between the parentheses, ready for the user to type a lambda predicate.

## Monaco Editor

For Monaco, register a completion provider that maps Bonsai completions to Monaco's `CompletionItem` format.

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
