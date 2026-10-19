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
