<script setup lang="ts">
import type { Run } from './pretty'

// Coloured runs of text (a value laid out by pretty.ts). Rendered with interpolation, never HTML.
defineProps<{ runs: readonly Run[] }>()
</script>

<template>
  <span v-for="(run, i) in runs" :key="i" :class="run.cls || undefined">{{ run.text }}</span>
</template>

<style scoped>
.tk-prop {
  color: var(--bonsai-syn-prop);
}
.tk-str {
  color: var(--bonsai-syn-string);
}
.tk-lit {
  color: var(--bonsai-syn-literal);
}
.tk-punct {
  color: var(--vp-c-text-3);
  font-weight: 400;
}
</style>
