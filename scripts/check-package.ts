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
    'package/dist/service/index.mjs',
    'package/dist/service/index.d.mts',
    'package/dist/query/index.mjs',
    'package/dist/query/index.d.mts',
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
  if (packedPkg.exports?.['./service']?.import !== './dist/service/index.mjs') {
    throw new Error('Packed service export does not point to ./dist/service/index.mjs')
  }
  if (packedPkg.exports?.['./query']?.import !== './dist/query/index.mjs') {
    throw new Error('Packed query export does not point to ./dist/query/index.mjs')
  }
  const exportKeys = [...Object.keys(packedPkg.exports ?? {})].sort()
  if (exportKeys.join(',') !== '.,./query,./service') {
    throw new Error(`Packed package exports unexpected subpaths: ${exportKeys.join(', ')}`)
  }

  mkdirSync(join(smokeDir, 'node_modules', 'bonsai-js'), { recursive: true })
  cpSync(join(extractDir, 'package'), join(smokeDir, 'node_modules', 'bonsai-js'), {
    recursive: true,
  })

  writeFileSync(join(smokeDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(smokeDir, 'smoke.mjs'),
    [
      "import { bonsai, fn, t, BonsaiCheckError, BonsaiRuntimeError, isBonsaiError } from 'bonsai-js'",
      "import { createLanguageService } from 'bonsai-js/service'",
      "import { toMongo, toSQL } from 'bonsai-js/query'",
      '',
      'const env = bonsai({',
      '  variables: { user: t.object({ name: t.string(), age: t.number() }), items: t.list(t.number()) },',
      '  functions: { double: fn({ params: [t.number()], returns: t.number(), run: (n) => n * 2 }) },',
      '})',
      "const ctx = { user: { name: 'Ada', age: 36 }, items: [1, 2, 3] }",
      '',
      "if (env.evaluateSync('1 + 2') !== 3) throw new Error('Root export smoke test failed')",
      "if (env.evaluateSync('double(user.age)', ctx) !== 72) throw new Error('Host function call failed')",
      "if (env.evaluateSync('items.map(. * 2).sum()', ctx) !== 12) throw new Error('Built-in method chain failed')",
      "if ((await env.evaluate('user.name.toUpperCase()', ctx)) !== 'ADA') throw new Error('Async evaluate failed')",
      '',
      "const adult = env.compile('user.age >= 18', { expect: t.boolean() })",
      "if (adult.evaluateSync(ctx) !== true) throw new Error('Compiled program failed')",
      '',
      "if (env.check('user.nope').ok) throw new Error('Checker accepted an unknown property')",
      'let rejected = false',
      'try { env.compile(\'user.age + "x"\') } catch (error) { rejected = error instanceof BonsaiCheckError && isBonsaiError(error) }',
      "if (!rejected) throw new Error('Compile did not throw BonsaiCheckError')",
      "if (typeof BonsaiRuntimeError !== 'function') throw new Error('Error classes missing from package root')",
      '',
      'const service = createLanguageService(env)',
      "const labels = service.complete('user.', 5).items.map((item) => item.label)",
      "if (!labels.includes('age') || !labels.includes('name')) throw new Error('Service subpath completions failed')",
      "if (service.hover('user.age', 6)?.detail !== 'number') throw new Error('Service subpath hover failed')",
      "if (service.diagnostics('user.nope').length === 0) throw new Error('Service subpath diagnostics failed')",
      '',
      'const filter = env.compile(\'order.total > limit && order.status == "paid"\')',
      "const query = toSQL(filter, { row: 'order', columns: { total: 'number', status: 'text' }, dialect: 'postgres', known: { limit: 5 } })",
      "if (query.params.length !== 2 || !query.sql.includes('$1::float8')) throw new Error('Query subpath toSQL failed')",
      "const mongo = toMongo(filter, { row: 'order', fields: { total: 'number', status: 'text' }, known: { limit: 5 } })",
      "if (JSON.stringify(mongo.filter) !== JSON.stringify({ $and: [{ total: { $gt: 5 } }, { status: { $eq: 'paid' } }] })) throw new Error('Query subpath toMongo failed')",
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
