<script setup lang="ts">
import Code from '../home/Code.vue'
import Runs from './Runs.vue'
import { oneLine } from './pretty'
import type { Step } from './explain'

// Every step of the evaluation, outermost first, each with its value. A lambda's
// runs sit under its call, one per item; opening one lists that run's steps.
// Hovering a step lights up its text in the editor (and the editor lights up
// the step under the pointer).

defineProps<{ rows: readonly Step[]; lit?: string }>()
const emit = defineEmits<{ hover: [step: Step | undefined]; toggle: [key: string] }>()

const note: Record<Step['state'], string> = {
  value: '',
  skipped: 'skipped',
  extra: 'not needed',
  error: 'failed',
}
</script>

<template>
  <p v-if="rows.length === 0" class="empty">A fixed value: there is nothing to work out.</p>
  <ol v-else class="steps" @mouseleave="emit('hover', undefined)">
    <li
      v-for="row in rows"
      :key="row.key"
      :class="[`is-${row.state}`, { lit: row.key === lit, run: row.item, more: row.more !== undefined }]"
      :style="{ '--depth': row.depth }"
      @mouseenter="emit('hover', row.more === undefined ? row : undefined)"
    >
      <template v-if="row.more !== undefined">
        <span class="what">and {{ row.more }} more</span>
      </template>
      <template v-else-if="row.item">
        <button
          type="button"
          class="what toggle"
          :aria-expanded="row.item.open"
          :disabled="row.item.steps === 0"
          @click="emit('toggle', row.key)"
        >
          <span class="caret" aria-hidden="true">{{ row.item.open ? '▾' : '▸' }}</span>
          <span class="item">item {{ row.item.index + 1 }}</span>
          <code class="bx"><Runs :runs="oneLine(row.item.value)" /></code>
        </button>
        <code class="value bx"><Runs v-if="row.state !== 'error'" :runs="oneLine(row.value)" /></code>
      </template>
      <template v-else>
        <span class="what"><Code :code="row.text" :wrap="false" /></span>
        <code class="value bx">
          <Runs v-if="row.state === 'value' || row.state === 'extra'" :runs="oneLine(row.value)" />
        </code>
      </template>
      <span v-if="note[row.state]" class="note">{{ note[row.state] }}</span>
      <p v-if="row.error" class="error">{{ row.error }}</p>
    </li>
  </ol>
</template>

<style scoped>
.empty {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13.5px;
}

/* Each step indented by its depth, with a guide line per level. */
.steps li {
  --indent: calc(var(--depth) * 18px);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, max-content) auto;
  align-items: baseline;
  gap: 4px 14px;
  margin: 0 -10px;
  padding: 5px 10px 5px calc(10px + var(--indent));
  border-radius: 6px;
  background-image: repeating-linear-gradient(
    to right,
    var(--vp-c-divider) 0 1px,
    transparent 1px 18px
  );
  background-size: var(--indent) 100%;
  background-position: 14px 0;
  background-repeat: no-repeat;
  transition: background-color 0.12s;
}

.steps li.lit {
  background-color: var(--bonsai-lit);
}

.what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.what :deep(.bx) {
  font-size: 13.5px;
  white-space: pre;
}

.value {
  max-width: 22em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
  text-align: right;
}

.bx {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--vp-c-text-1);
}

/* Values never needed (the other side of a decided && or ||), or never reached. */
.is-extra,
.is-skipped {
  opacity: 0.55;
}

.note {
  color: var(--vp-c-text-3);
  font-size: 12px;
}

.toggle {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  color: var(--vp-c-text-2);
}

.toggle:disabled {
  cursor: default;
}

.toggle:disabled .caret {
  visibility: hidden;
}

.caret {
  width: 0.8em;
  color: var(--vp-c-text-3);
}

.item {
  flex: none;
  color: var(--vp-c-text-2);
  font-size: 12.5px;
}

.toggle .bx {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--vp-c-text-2);
}

.more .what {
  padding-left: calc(0.8em + 8px);
  color: var(--vp-c-text-3);
}

.error {
  grid-column: 1 / -1;
  margin: 2px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bonsai-error);
  color: var(--vp-c-text-1);
}
</style>
