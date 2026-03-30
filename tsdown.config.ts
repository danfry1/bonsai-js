import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/stdlib/index.ts', 'src/autocomplete/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  unused: true,
})
