// Syntax colours for a Bonsai expression, from the real lexer: a class per
// character. Shared by the live editors (highlight.ts) and the static code on
// the home page (Code.vue), so both colour expressions the same way. No
// CodeMirror imports, so it is safe to use while the page renders on the server.
import { tokenize, type Token } from 'bonsai-lexer'

/** Tokens of `source`, or none while it is too broken to lex (an unclosed string, say). */
function tokens(source: string): Token[] {
  try {
    return tokenize(source, { maxSourceLength: 10_000, maxTokens: 10_000 })
  } catch {
    return []
  }
}

/** Marks each character of `source` (which starts at `offset`) with a token class; template interpolations recurse. */
export function classify(source: string, marks: string[], offset = 0): string[] {
  const list = tokens(source)
  list.forEach((tk, i) => {
    let cls = ''
    if (tk.kind === 'string' || tk.kind === 'template') cls = 'tk-str'
    else if (tk.kind === 'number' || tk.kind === 'keyword') cls = 'tk-lit'
    else if (tk.kind === 'punct') cls = 'tk-punct'
    else if (tk.kind === 'name') {
      const next = list[i + 1]
      const prev = list[i - 1]
      if (next?.kind === 'punct' && next.value === '(') cls = 'tk-fn'
      else if (prev?.kind === 'punct' && (prev.value === '.' || prev.value === '?.')) cls = 'tk-prop'
      else cls = 'tk-name'
    }
    for (let c = tk.start + offset; c < tk.end + offset; c++) marks[c] = cls
    if (tk.kind === 'template') {
      for (const part of tk.template ?? []) {
        if (part.kind !== 'expr') continue
        for (let c = part.start + offset - 2; c < part.end + offset + 1; c++) marks[c] = 'tk-punct'
        classify(source.slice(part.start, part.end), marks, part.start + offset)
      }
    }
  })
  return marks
}

export interface Segment {
  text: string
  cls: string
}

/** `source` as runs of equally-classed text; characters in `[mark.start, mark.end)` also get `mark.cls`. */
export function segments(source: string, mark?: { start: number; end: number; cls: string }): Segment[] {
  const marks = classify(source, new Array<string>(source.length).fill(''))
  if (mark) for (let c = mark.start; c < Math.min(mark.end, source.length); c++) marks[c] = `${marks[c]} ${mark.cls}`.trim()
  const out: Segment[] = []
  for (let i = 0; i < source.length; ) {
    let j = i + 1
    while (j < source.length && marks[j] === marks[i]) j++
    out.push({ text: source.slice(i, j), cls: marks[i] })
    i = j
  }
  return out
}
