import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/service/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
})
