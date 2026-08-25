import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`)
}

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      npm_config_cache: join(tempRoot, '.npm-cache'),
    },
  })
}

const tempRoot = mkdtempSync(join(tmpdir(), 'bonsai-package-check-'))
const packDir = join(tempRoot, 'pack')
const extractDir = join(tempRoot, 'extract')
const smokeDir = join(tempRoot, 'smoke')

try {
  mkdirSync(packDir, { recursive: true })
  mkdirSync(extractDir, { recursive: true })
  mkdirSync(smokeDir, { recursive: true })
  const packOutput = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir]),
  )
  const filename = packOutput[0]?.filename as string | undefined
  if (filename === undefined || filename === '') {
    throw new Error('npm pack did not return a tarball filename')
  }

  const tarballPath = join(packDir, filename)
  const tarEntries = run('tar', ['-tf', tarballPath]).trim().split('\n')

  const requiredEntries = [
    'package/package.json',
    'package/dist/index.mjs',
    'package/dist/index.d.mts',
    'package/dist/stdlib/index.mjs',
    'package/dist/stdlib/index.d.mts',
    'package/dist/autocomplete/index.mjs',
    'package/dist/autocomplete/index.d.mts',
    'package/dist/checker/index.mjs',
    'package/dist/checker/index.d.mts',
    'package/README.md',
    'package/LICENSE',
    'package/CHANGELOG.md',
  ]

  for (const entry of requiredEntries) {
    if (!tarEntries.includes(entry)) {
      throw new Error(`Packed tarball is missing required entry: ${entry}`)
    }
  }

  const forbiddenPrefixes = ['package/src/', 'package/tests/', 'package/benchmarks/']
  for (const prefix of forbiddenPrefixes) {
    if (tarEntries.some((entry) => entry.startsWith(prefix))) {
      throw new Error(`Packed tarball should not include ${prefix}`)
    }
  }

  run('tar', ['-xzf', tarballPath, '-C', extractDir])

  const packedPkg = JSON.parse(readFileSync(join(extractDir, 'package', 'package.json'), 'utf8'))
  if (packedPkg.sideEffects !== false) {
    throw new Error('Packed package.json must preserve sideEffects: false')
  }
  if (packedPkg.engines?.node !== '>=24') {
    throw new Error('Packed package.json must require Node.js 24 or newer')
  }
  if (packedPkg.dependencies !== undefined && Object.keys(packedPkg.dependencies).length > 0) {
    throw new Error('Packed package.json must not have runtime dependencies')
  }
  if (packedPkg.exports?.['.']?.import !== './dist/index.mjs') {
    throw new Error('Packed package root export does not point to ./dist/index.mjs')
  }
  if (packedPkg.exports?.['./stdlib']?.import !== './dist/stdlib/index.mjs') {
    throw new Error('Packed stdlib export does not point to ./dist/stdlib/index.mjs')
  }
  if (packedPkg.exports?.['./autocomplete']?.import !== './dist/autocomplete/index.mjs') {
    throw new Error('Packed autocomplete export does not point to ./dist/autocomplete/index.mjs')
  }
  if (packedPkg.exports?.['./checker']?.import !== './dist/checker/index.mjs') {
    throw new Error('Packed checker export does not point to ./dist/checker/index.mjs')
  }

  mkdirSync(join(smokeDir, 'node_modules', 'bonsai-js'), { recursive: true })
  cpSync(join(extractDir, 'package'), join(smokeDir, 'node_modules', 'bonsai-js'), {
    recursive: true,
  })

  writeFileSync(join(smokeDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(smokeDir, 'smoke.mjs'),
    [
      "import { bonsai, evaluateExpression, ExpressionError } from 'bonsai-js'",
      "import { all, strings } from 'bonsai-js/stdlib'",
      "import { createAutocomplete } from 'bonsai-js/autocomplete'",
      "import { createChecker, t } from 'bonsai-js/checker'",
      '',
      "if (evaluateExpression('1 + 2') !== 3) throw new Error('Root export smoke test failed')",
      "if (typeof ExpressionError !== 'function') throw new Error('Error export missing from package root')",
      '',
      'const expr = bonsai()',
      'expr.use(strings)',
      "if (expr.evaluateSync('\"hi\" |> upper') !== 'HI') throw new Error('Stdlib subpath import failed')",
      '',
      'const full = bonsai()',
      'full.use(all)',
      "if (full.evaluateSync('items |> sum', { items: [1, 2, 3] }) !== 6) throw new Error('Combined stdlib import failed')",
      '',
      'const versioned = bonsai()',
      "versioned.addFunction('answer', () => 1)",
      "const compiled = versioned.compile('answer()')",
      "versioned.replaceFunction('answer', () => 2)",
      "if (compiled.evaluateSync() !== 1 || versioned.evaluateSync('answer()') !== 2) throw new Error('Compiled registry snapshot failed')",
      '',
      'const authoring = bonsai()',
      "authoring.defineTransform({ name: 'length', inputType: t.string(), returnType: t.number(), evaluate: (value) => String(value).length })",
      'authoring.seal()',
      "if (!authoring.isSealed()) throw new Error('Registry seal failed')",
      "const completions = createAutocomplete(authoring, { context: { name: 'Ada' } }).complete('name |> ', 8)",
      "if (!completions.some((item) => item.label === 'length')) throw new Error('Autocomplete subpath or metadata integration failed')",
      '',
      "const checked = createChecker(authoring, { schema: t.object({ name: t.string() }) }).check('name |> length', { expectedType: t.number() })",
      "if (!checked.valid || checked.type.kind !== 'number') throw new Error('Checker subpath failed')",
      '',
      "console.log('packed package smoke test passed')",
      '',
    ].join('\n'),
  )

  run('node', ['smoke.mjs'], smokeDir)
  writeLine(`Package validation passed: ${filename}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
