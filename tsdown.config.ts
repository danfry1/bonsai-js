import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

const DECLARATION_MAP_COMMENT = /\n\/\/# sourceMappingURL=\S+\.d\.mts\.map\s*$/u

export default defineConfig({
  entry: ['src/index.ts', 'src/service/index.ts'],
  format: 'esm',
  // Declaration maps are off (tsconfig): they would point at src/, which is not published.
  dts: true,
  sourcemap: true,
  clean: true,
  hooks: {
    // Rolldown still links each declaration file to the map that is not emitted.
    'build:done': ({ chunks, options }) => {
      for (const chunk of chunks) {
        if (!chunk.fileName.endsWith('.d.mts')) continue
        const path = join(options.outDir, chunk.fileName)
        writeFileSync(path, `${readFileSync(path, 'utf8').replace(DECLARATION_MAP_COMMENT, '')}\n`)
      }
    },
  },
})
