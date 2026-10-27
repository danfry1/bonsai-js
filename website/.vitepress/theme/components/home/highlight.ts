// A CodeMirror extension that colours a Bonsai expression with the classes
// from tokens.ts (the real lexer), as decorations.
import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { classify } from './tokens'

function decorate(view: EditorView): DecorationSet {
  const text = view.state.doc.toString()
  const marks = classify(text, new Array<string>(text.length).fill(''))
  const builder = new RangeSetBuilder<Decoration>()
  for (let i = 0; i < text.length; ) {
    let j = i + 1
    while (j < text.length && marks[j] === marks[i]) j++
    if (marks[i]) builder.add(i, j, Decoration.mark({ class: marks[i] }))
    i = j
  }
  return builder.finish()
}

export const bonsaiHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorate(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = decorate(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
