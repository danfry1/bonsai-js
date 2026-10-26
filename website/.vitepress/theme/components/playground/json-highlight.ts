// A CodeMirror extension that colours JSON with the classes the Bonsai
// editor uses (tk-prop for keys, tk-str, tk-lit, tk-punct), as decorations.
// A tokenizer, not a parser: text that isn't JSON yet still colours sensibly.
import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

const TOKEN = /("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b|([{}[\],:])/gu

const marks = {
  key: Decoration.mark({ class: 'tk-prop' }),
  str: Decoration.mark({ class: 'tk-str' }),
  lit: Decoration.mark({ class: 'tk-lit' }),
  punct: Decoration.mark({ class: 'tk-punct' }),
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index
    const [, string, colon, literal, punct] = match
    if (string !== undefined) {
      builder.add(at, at + string.length, colon ? marks.key : marks.str)
      if (colon) builder.add(at + match[0].length - 1, at + match[0].length, marks.punct)
    } else if (literal !== undefined) builder.add(at, at + literal.length, marks.lit)
    else if (punct !== undefined) builder.add(at, at + 1, marks.punct)
  }
  return builder.finish()
}

export const jsonHighlight = ViewPlugin.fromClass(
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
