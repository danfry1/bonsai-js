# CodeMirror

[CodeMirror 6](https://codemirror.net/) is a common choice for an expression editor in a web app. This page gives a complete extension that connects it to the [language service](/guide/editor-support): completions as you type, errors and warnings underlined with a quick-fix for "did you mean", and types on hover. Copy it into your project; it is about 120 lines and has no dependencies beyond CodeMirror and Bonsai.

<ClientOnly>
  <CodeMirrorDemo />
</ClientOnly>

The editor above runs exactly the code on this page, against an environment that declares `user` and `orders`. Type `user.` or `orders.filter(.` to see completions, misspell a field to see the quick-fix, and hover a name to see its type.

## Install

```bash
npm install bonsai-js @codemirror/state @codemirror/view @codemirror/autocomplete @codemirror/lint
```

## The extension

Save this as `bonsai-language.ts`. Positions map directly: the language service and CodeMirror both count UTF-16 code units.

<!-- codemirror-extension -->
```ts
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view'
import type { LanguageService } from 'bonsai-js/service'

// CodeMirror's icon for each kind of completion item.
const TYPES: Record<string, string> = {
  value: 'constant',
  variable: 'variable',
  local: 'variable',
  property: 'property',
  function: 'function',
  method: 'method',
  keyword: 'keyword',
}

/** Completions at the cursor, from the language service. */
export function bonsaiCompletions(service: LanguageService) {
  return (context: CompletionContext): CompletionResult | null => {
    const source = context.state.doc.toString()
    const result = service.complete(source, context.pos)
    const typed = source.slice(result.start, context.pos)
    const before = source.slice(0, result.start)
    const afterDot = /\??\.\s*$/u.test(before) && !/\.\.\.\s*$/u.test(before)
    // While typing, open only after `.` or once a name is started; Ctrl-Space always opens.
    if (!context.explicit && typed === '' && !afterDot) return null
    const options = result.items
      .filter((item) => item.label !== '.')
      .map((item): Completion => ({
        label: item.label,
        type: TYPES[item.kind],
        detail: item.detail,
        info: item.documentation,
        // An item with its own range (a field inserted as ["first-name"]) replaces that range.
        apply: (view, _completion, from, to) => {
          const start = item.range?.start ?? from
          const end = item.range?.end ?? to
          view.dispatch({
            changes: { from: start, to: end, insert: item.insertText },
            selection: { anchor: start + item.insertText.length },
          })
        },
      }))
    if (options.length === 0) return null
    return { from: result.start, to: result.end, options, validFor: /^[\w$]*$/u }
  }
}

/** Every syntax and check finding, as CodeMirror diagnostics with a quick-fix for a suggestion. */
export function bonsaiDiagnostics(service: LanguageService, state: EditorState): Diagnostic[] {
  const length = state.doc.length
  return service.diagnostics(state.doc.toString()).map((d) => {
    const from = Math.min(d.start, length)
    const suggestion = d.suggestion
    return {
      from,
      to: Math.min(Math.max(d.end, from), length),
      severity: d.severity,
      message: d.message,
      actions:
        suggestion === undefined
          ? []
          : [
              {
                name: `Use "${suggestion}"`,
                apply: (view, start, end) => view.dispatch({ changes: { from: start, to: end, insert: suggestion } }),
              },
            ],
    }
  })
}

/** The type or signature under the pointer. Text is set with textContent, never as HTML. */
export function bonsaiHover(service: LanguageService, state: EditorState, pos: number): Tooltip | null {
  const info = service.hover(state.doc.toString(), pos)
  if (info === undefined) return null
  return {
    pos: info.start,
    end: info.end,
    above: true,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'cm-bonsai-hover'
      const detail = document.createElement('code')
      detail.textContent = info.detail
      dom.append(detail)
      if (info.documentation !== undefined) {
        const doc = document.createElement('div')
        doc.className = 'cm-bonsai-doc'
        doc.textContent = info.documentation
        dom.append(doc)
      }
      return { dom }
    },
  }
}

/** Completions, diagnostics, and hover types for a Bonsai expression editor. */
export function bonsaiLanguage(service: LanguageService): Extension {
  return [
    autocompletion({ override: [bonsaiCompletions(service)] }),
    linter((view) => bonsaiDiagnostics(service, view.state), { delay: 200 }),
    hoverTooltip((view, pos) => bonsaiHover(service, view.state, pos)),
    EditorView.baseTheme({
      '.cm-bonsai-hover': { padding: '4px 8px', maxWidth: '40em' },
      '.cm-bonsai-doc': { marginTop: '4px', opacity: '0.8' },
    }),
  ]
}
```

Diagnostic messages and completion details quote the expression, which the user controls, so the hover is built with `textContent`. CodeMirror renders completion labels, details, and diagnostic messages as text.

## Create an editor

Create the language service once per environment and pass it to the extension. Check the text again when the rule is saved: the editor helps the person writing it, and `check()` is the gate.

```ts
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { bonsai, t } from 'bonsai-js'
import { createLanguageService } from 'bonsai-js/service'
import { bonsaiLanguage } from './bonsai-language'

const env = bonsai({
  variables: {
    user: t.object({ name: t.string(), age: t.number(), plan: t.enum('free', 'pro') }),
    orders: t.list(t.object({ total: t.number(), paid: t.boolean() })),
  },
})
// expect: every rule must be a yes or no, so a non-boolean rule is underlined too.
const service = createLanguageService(env, { expect: t.boolean() })

function createEditor(parent: HTMLElement, doc: string): EditorView {
  return new EditorView({ parent, state: EditorState.create({ doc, extensions: [bonsaiLanguage(service)] }) })
}

function save(view: EditorView): string | undefined {
  const source = view.state.doc.toString()
  return env.check(source, { expect: t.boolean() }).ok ? source : undefined
}
```

`bonsaiLanguage` adds only what Bonsai provides. For undo history, key bindings, line numbers, and the rest of a full editor, add CodeMirror's `basicSetup` from the `codemirror` package, or your own selection of extensions, to `extensions`.

## What it produces

The pieces work on an `EditorState`, so they can be tested without a browser:

<!-- continue -->
```ts
import { CompletionContext } from '@codemirror/autocomplete'
import { bonsaiCompletions, bonsaiDiagnostics, bonsaiHover } from './bonsai-language'

const typing = EditorState.create({ doc: 'user.' })
const completions = bonsaiCompletions(service)(new CompletionContext(typing, 5, false))
completions?.options.map((option) => option.label).slice(0, 3) // => ["age", "name", "plan"]
completions?.options[0].type // => "property"

const misspelled = EditorState.create({ doc: 'user.agee >= 18' })
const [problem] = bonsaiDiagnostics(service, misspelled)
problem.from // => 5
problem.to // => 9
problem.severity // => "error"
problem.message // => "Property \"agee\" does not exist on user; did you mean \"age\"?"
problem.actions?.map((action) => action.name) // => ["Use \"age\""]

bonsaiDiagnostics(service, EditorState.create({ doc: 'user.age' }))[0].message // => "Expected the expression to produce boolean but it produces number"
bonsaiHover(service, misspelled, 1)?.pos // => 0
```

## When the environment changes

When the variables or functions change (a tenant's schema loads, a user adds a custom field), create a new language service and swap it in with a [`Compartment`](https://codemirror.net/docs/ref/#state.Compartment), which keeps the text, selection, and history:

<!-- continue -->
```ts
import { Compartment } from '@codemirror/state'

const language = new Compartment()

function createReconfigurableEditor(parent: HTMLElement, doc: string): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [language.of(bonsaiLanguage(service))] }),
  })
}

function useEnvironment(view: EditorView, next: typeof env): void {
  view.dispatch({ effects: language.reconfigure(bonsaiLanguage(createLanguageService(next))) })
}
```

## Notes

- Completions open after `.` and once a name is started, as in the [Playground](/playground); Ctrl-Space opens them anywhere. `validFor` lets CodeMirror filter the list as the user keeps typing a name, without asking the service again.
- Diagnostics run 200 ms after the user stops typing. The service never evaluates an expression or calls a host function, so it is safe on every keystroke.
- For a filter or a rule that must have one type, create the service with `expect` (as above), so `EXPECTED_TYPE` is underlined while typing.
- Everything here also works with [`bonsai-js/lite`](/api/environment#the-lite-entry-point) environments.

See [Editor Support](/guide/editor-support) for the language service itself and the [Language Service API](/api/service) for its types.
