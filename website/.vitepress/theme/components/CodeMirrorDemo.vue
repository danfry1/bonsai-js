<template>
  <div class="cm-demo">
    <div ref="host" class="cm-demo-editor"></div>
    <div class="cm-demo-status" :class="status.kind">
      <span class="cm-demo-label">{{ status.label }}</span>
      <code class="cm-demo-text">{{ status.text }}</code>
    </div>
    <div class="cm-demo-context">
      Evaluated against <code>{{ contextText }}</code>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { bonsai, isBonsaiError, t } from 'bonsai-src'
import { createLanguageService } from 'bonsai-service'
// The same module the CodeMirror guide shows (check-components keeps them identical).
import { bonsaiLanguage } from './codemirror/bonsai-language'

// Rendered with text interpolation only: expression text and messages are never HTML.

const env = bonsai({
  variables: {
    user: t.object({
      name: t.string(),
      age: t.number(),
      plan: t.enum('free', 'pro'),
      email: t.optional(t.string()),
    }),
    orders: t.list(t.object({ total: t.number(), paid: t.boolean() })),
  },
  limits: { timeout: 250 },
})
const service = createLanguageService(env, { expect: t.boolean() })

const context = {
  user: { name: 'Ada', age: 36, plan: 'pro' as const, email: null },
  orders: [
    { total: 80, paid: true },
    { total: 45, paid: true },
    { total: 20, paid: false },
  ],
}
const contextText = JSON.stringify(context)

interface Status {
  kind: 'ok' | 'error' | 'warning'
  label: string
  text: string
}

const host = ref<HTMLElement>()
const status = ref<Status>({ kind: 'ok', label: '', text: '' })
let view: EditorView | undefined

function update(source: string): void {
  const check = env.check(source, { expect: t.boolean() })
  const first = check.diagnostics.find((d) => d.severity === 'error') ?? check.diagnostics[0]
  if (!check.ok) {
    status.value = { kind: 'error', label: first?.code ?? 'ERROR', text: first?.message ?? '' }
    return
  }
  try {
    const value = env.evaluateSync(source, context)
    status.value = first
      ? { kind: 'warning', label: `${String(value)}, ${first.code}`, text: first.message }
      : { kind: 'ok', label: 'Result', text: String(value) }
  } catch (error) {
    status.value = {
      kind: 'error',
      label: isBonsaiError(error) ? error.code : 'Error',
      text: error instanceof Error ? error.message : String(error),
    }
  }
}

const theme = EditorView.theme({
  '&': {
    fontSize: '14px',
    backgroundColor: 'var(--vp-c-bg-soft)',
    color: 'var(--vp-c-text-1)',
    borderRadius: '8px',
    border: '1px solid var(--vp-c-divider)',
  },
  '&.cm-focused': { outline: '2px solid var(--vp-c-brand-1)' },
  '.cm-content': { fontFamily: 'var(--vp-font-family-mono)', padding: '12px 4px', caretColor: 'var(--vp-c-text-1)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vp-c-bg)',
    color: 'var(--vp-c-text-1)',
    border: '1px solid var(--vp-c-divider)',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vp-c-brand-soft)',
    color: 'var(--vp-c-text-1)',
  },
  '.cm-completionDetail': { opacity: '0.7', marginLeft: '1em' },
})

onMounted(() => {
  if (!host.value) return
  const doc = 'user.plan == "pro" && orders.filter(.paid).map(.total).sum() > 100'
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc,
      extensions: [
        bonsaiLanguage(service),
        theme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Bonsai expression' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) update(u.state.doc.toString())
        }),
      ],
    }),
  })
  update(doc)
})

onBeforeUnmount(() => view?.destroy())
</script>

<style scoped>
.cm-demo {
  margin: 16px 0 24px;
}
.cm-demo-status {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 8px;
  font-size: 14px;
}
.cm-demo-label {
  font-weight: 600;
}
.cm-demo-status.ok .cm-demo-label {
  color: var(--vp-c-green-1);
}
.cm-demo-status.warning .cm-demo-label {
  color: var(--vp-c-yellow-1);
}
.cm-demo-status.error .cm-demo-label {
  color: var(--vp-c-red-1);
}
.cm-demo-text {
  white-space: pre-wrap;
  word-break: break-word;
}
.cm-demo-context {
  margin-top: 4px;
  font-size: 12px;
  color: var(--vp-c-text-2);
  word-break: break-all;
}
</style>
