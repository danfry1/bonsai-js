<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Type } from 'bonsai-src'
import type { Translatable } from '../../../../../src/query/index.ts'
import Runs from './Runs.vue'
import { oneLine } from './pretty'
import { recordsOf, translate, type Dialect } from './query'

// The rule as a database query: pick the variable that is the record being
// filtered; its fields are the columns, and the other variables' values fold
// into the query.

const props = defineProps<{
  program: Translatable
  variables: Readonly<Record<string, Type>>
  context: Readonly<Record<string, unknown>>
}>()

const dialects: { id: Dialect; label: string }[] = [
  { id: 'sqlite', label: 'SQLite' },
  { id: 'postgres', label: 'Postgres' },
  { id: 'mongodb', label: 'MongoDB' },
]
const dialect = ref<Dialect>('sqlite')

const records = computed(() => recordsOf(props.program, props.variables))
const row = ref<string>()
watch(
  records,
  (next) => {
    if (row.value === undefined || !next.includes(row.value)) row.value = next[0]
  },
  { immediate: true },
)

const query = computed(() =>
  row.value === undefined
    ? undefined
    : translate(props.program, row.value, dialect.value, props.variables, props.context, new Date()),
)

/** The other variables the rule reads: their values are worked into the query. */
const known = computed(() => props.program.references.variables.filter((name) => name !== row.value && name in props.context))

/** `?1`, `$1`: how the dialect writes its placeholders. */
const placeholder = (i: number) => (dialect.value === 'postgres' ? `$${i + 1}` : `?${i + 1}`)
</script>

<template>
  <p v-if="records.length === 0" class="empty">
    A query filters records. Put a record's fields in an object, like <code>order</code> with
    <code>total</code>, and write the rule over <code>order.total</code>.
  </p>
  <div v-else class="query">
    <div class="controls">
      <div class="seg" role="radiogroup" aria-label="Database">
        <button
          v-for="d in dialects"
          :key="d.id"
          type="button"
          role="radio"
          :aria-checked="dialect === d.id"
          @click="dialect = d.id"
        >
          {{ d.label }}
        </button>
      </div>
      <label v-if="records.length > 1" class="record">
        Record
        <select v-model="row">
          <option v-for="name in records" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
    </div>

    <template v-if="query?.ok">
      <dl class="lines">
        <dt>{{ dialect === 'mongodb' ? 'Filter' : 'Where' }}</dt>
        <dd><pre>{{ query.text }}</pre></dd>
        <template v-if="query.values.length">
          <dt>Values</dt>
          <dd>
            <p v-for="(v, i) in query.values" :key="i" class="param">
              <span class="ph">{{ placeholder(i) }}</span>
              <code><Runs :runs="oneLine(v)" /></code>
            </p>
          </dd>
        </template>
        <dt>Columns</dt>
        <dd class="columns">
          <span v-for="(type, name) in query.columns" :key="name"><code>{{ name }}</code> {{ type }}</span>
        </dd>
      </dl>
      <p v-if="known.length" class="hint">
        <template v-for="(name, i) in known" :key="name"><template v-if="i">, </template><code>{{ name }}</code></template>
        {{ known.length === 1 ? 'is' : 'are' }} known, so {{ known.length === 1 ? 'its value is' : 'their values are' }} filled in.
      </p>
    </template>
    <div v-else-if="query" class="cannot">
      <p class="head">Can't become a query</p>
      <p class="msg">{{ query.message }}</p>
    </div>
  </div>
</template>

<style scoped>
.empty,
.hint {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.6;
}

.hint {
  margin-top: 14px;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

.empty code,
.columns code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
  color: var(--vp-c-text-1);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 16px;
}

.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.seg button {
  padding: 4px 12px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 500;
}

.seg button[aria-checked='true'] {
  background: var(--bonsai-card);
  color: var(--vp-c-text-1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.record {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.record select {
  padding: 3px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

.lines {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px 16px;
  margin: 0;
}

.lines dt {
  padding-top: 2px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 600;
}

.lines dd {
  min-width: 0;
  margin: 0;
}

.lines pre {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.param {
  display: flex;
  gap: 12px;
  margin: 0 0 2px;
  font-family: var(--vp-font-family-mono);
  font-size: 13.5px;
}

.ph {
  min-width: 2.5em;
  color: var(--vp-c-text-3);
}

.columns {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--vp-c-text-3);
  font-size: 13px;
}

.cannot .head {
  margin: 0;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.cannot .msg {
  margin: 6px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bonsai-warning);
  color: var(--vp-c-text-2);
  font-size: 14px;
}
</style>
