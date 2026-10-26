// Code block colours for the docs, from the same palette as the live editors
// (custom.css): names in ink, fields in pine, functions in brand green,
// strings in clay, numbers and literals in olive, operators and punctuation
// muted. One theme per colour scheme; VitePress switches between them.
import type { ThemeRegistrationRaw } from 'shiki'

interface Palette {
  fg: string
  muted: string
  comment: string
  prop: string
  fn: string
  keyword: string
  string: string
  literal: string
  type: string
}

function theme(name: string, type: 'light' | 'dark', p: Palette): ThemeRegistrationRaw {
  return {
    name,
    type,
    colors: { 'editor.foreground': p.fg, 'editor.background': '#00000000' },
    settings: [
      { settings: { foreground: p.fg } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: p.comment } },
      {
        scope: ['string', 'string.template', 'punctuation.definition.string', 'string.quoted'],
        settings: { foreground: p.string },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'],
        settings: { foreground: p.literal },
      },
      {
        scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'variable.language'],
        settings: { foreground: p.keyword },
      },
      {
        scope: [
          'keyword.operator',
          'punctuation',
          'meta.brace',
          'punctuation.definition.template-expression',
          'meta.embedded punctuation',
        ],
        settings: { foreground: p.muted },
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'],
        settings: { foreground: p.fn },
      },
      {
        scope: [
          'variable.other.property',
          'variable.other.object.property',
          'support.variable.property',
          'meta.object-literal.key',
          'entity.name.tag',
          'support.type.property-name',
        ],
        settings: { foreground: p.prop },
      },
      {
        scope: ['entity.name.type', 'support.type', 'entity.other.inherited-class', 'entity.name.class'],
        settings: { foreground: p.type },
      },
      { scope: ['variable', 'variable.other.readwrite', 'meta.definition.variable'], settings: { foreground: p.fg } },
      { scope: ['markup.inserted'], settings: { foreground: p.fn } },
      { scope: ['markup.deleted'], settings: { foreground: p.string } },
    ],
  }
}

export const bonsaiLight = theme('bonsai-light', 'light', {
  fg: '#15241b',
  muted: '#6c7b70',
  comment: '#6c7b70',
  prop: '#2f4a3a',
  fn: '#2b6743',
  keyword: '#235a39',
  string: '#8a5530',
  literal: '#6a5a12',
  type: '#3d5a6c',
})

export const bonsaiDark = theme('bonsai-dark', 'dark', {
  fg: '#dde7db',
  muted: '#8a9a8d',
  comment: '#7f9083',
  prop: '#bccdbf',
  fn: '#8acfa2',
  keyword: '#a3dbb6',
  string: '#d6a77c',
  literal: '#d9c46e',
  type: '#9cc3d6',
})
