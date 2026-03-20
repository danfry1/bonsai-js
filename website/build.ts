const root = import.meta.dir.replace('/website', '')

const results = await Promise.all([
  Bun.build({
    entrypoints: [`${root}/src/index.ts`],
    outdir: `${root}/website`,
    format: 'esm',
    naming: 'bonsai.bundle.js',
    target: 'browser',
    minify: true,
  }),
  Bun.build({
    entrypoints: [`${root}/src/stdlib/index.ts`],
    outdir: `${root}/website`,
    format: 'esm',
    naming: 'stdlib.bundle.js',
    target: 'browser',
    minify: true,
  }),
  Bun.build({
    entrypoints: [`${root}/src/autocomplete/index.ts`],
    outdir: `${root}/website`,
    format: 'esm',
    naming: 'autocomplete.bundle.js',
    target: 'browser',
    minify: true,
  }),
])

let failed = false
for (const result of results) {
  if (!result.success) {
    failed = true
    console.error('Build failed:')
    for (const log of result.logs) {
      console.error(log)
    }
  }
}

if (failed) process.exit(1)

console.log('Bundle built successfully')
for (const result of results) {
  for (const output of result.outputs) {
    console.log(`  ${output.path} (${(output.size / 1024).toFixed(1)} KB)`)
  }
}
