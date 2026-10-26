<script setup lang="ts">
import { computed } from 'vue'
import { Duration } from 'bonsai-src'
import { display } from '../../../../scripts/format'
import { within } from './links'

// Sample data, one line per variable, in the docs' display format, with every
// field tagged by its path (`order.total`) so hovering it can light up the
// conditions that read it, and a lit path highlights here.

const props = defineProps<{
  data: Record<string, unknown>
  /** Paths to highlight, with everything inside them. */
  lit: readonly string[]
  /** Each variable's declared type, shown as its tooltip. */
  types?: Record<string, string>
}>()

const emit = defineEmits<{ hover: [path: string | undefined] }>()

interface Piece {
  text: string
  path?: string
  kind: 'key' | 'value' | 'punct' | 'break'
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

function pieces(value: unknown, path: string): Piece[] {
  const punct = (text: string): Piece => ({ text, kind: 'punct' })
  if (Array.isArray(value)) {
    return [
      punct('['),
      ...value.flatMap((v, i) => [...(i ? [punct(', ')] : []), ...pieces(v, `${path}[${i}]`)]),
      punct(']'),
    ]
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Duration)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return [punct('{}')]
    return [
      punct('{ '),
      ...entries.flatMap(([k, v], i) => [
        ...(i ? [punct(', ')] : []),
        { text: IDENT.test(k) ? k : JSON.stringify(k), path: `${path}.${k}`, kind: 'key' as const },
        // A no-break space, so a line wraps between fields, never between a field and its value.
        punct(': '),
        ...pieces(v, `${path}.${k}`),
      ]),
      punct(' }'),
    ]
  }
  return [{ text: display(value), path, kind: 'value' }]
}

/** A variable's pieces; a list of records gets one record per line, so it reads like rows. */
function top(value: unknown, name: string): Piece[] {
  const records = Array.isArray(value) && value.length > 1 && value.every((v) => v !== null && typeof v === 'object')
  if (!records) return pieces(value, name)
  return [
    { text: '[', kind: 'punct' },
    ...value.flatMap((v, i) => [
      // After the break, a no-break space lines each record up under the first one's `{`.
      ...(i
        ? [
            { text: ',', kind: 'punct' as const },
            { text: '', kind: 'break' as const },
            { text: ' ', kind: 'punct' as const },
          ]
        : []),
      ...pieces(v, `${name}[${i}]`),
    ]),
    { text: ']', kind: 'punct' },
  ]
}

const rows = computed(() => Object.entries(props.data).map(([name, value]) => ({ name, pieces: top(value, name) })))

const isLit = (path: string | undefined) => path !== undefined && props.lit.some((p) => within(path, p))
</script>

<template>
  <ul class="dv" @mouseleave="emit('hover', undefined)">
    <li v-for="row in rows" :key="row.name" :title="types?.[row.name]">
      <code class="dv-name" :class="{ lit: isLit(row.name) }" @mouseenter="emit('hover', row.name)">{{ row.name }}</code>
      <code class="dv-value"
        ><template v-for="(p, i) in row.pieces" :key="i"
          ><br v-if="p.kind === 'break'" /><span
            v-else
            :class="[p.kind, { lit: isLit(p.path) }]"
            @mouseenter="p.path && emit('hover', p.path)"
            >{{ p.text }}</span
          ></template
        ></code
      >
    </li>
  </ul>
</template>

<style scoped>
.dv {
  margin: 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  list-style: none;
}

.dv li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 13.5px;
  line-height: 1.75;
}

code {
  font-family: var(--vp-font-family-mono);
}

.dv-name {
  flex: none;
  min-width: 5.5em;
  color: var(--vp-c-text-1);
  font-weight: 600;
  cursor: default;
}

.dv-value {
  min-width: 0;
  color: var(--vp-c-text-3);
}

.key {
  color: var(--vp-c-text-2);
  white-space: nowrap;
}

.value {
  color: var(--vp-c-text-1);
  white-space: nowrap;
}

.key,
.value,
.dv-name {
  border-radius: 4px;
  transition: background-color 0.12s, color 0.12s;
}

.lit {
  background: var(--bonsai-lit);
  color: var(--vp-c-text-1);
}
</style>
