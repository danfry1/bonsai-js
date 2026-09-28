// Verifies the code examples in the documentation site, the README, and
// docs/*.md (the language reference and policies).
//
//   bun website/scripts/check-examples.ts
//
// ```bonsai blocks: every expression must end with a result marker.
//   expr            // => expected      (compared with display(result))
//   expr            // error: CODE      (error code, or a diagnostic code)
// An expression may span several lines; it ends at the line with the marker.
// The evaluation context comes from the nearest preceding
//   <!-- context: { ...JavaScript object literal... } -->
// and environment options from the nearest preceding
//   <!-- env: { ...bonsai() options, with t and fn in scope... } -->
// Both reset at the next such comment. The clock is fixed at CLOCK.
//
// ```ts blocks run as ES modules (imports of bonsai-js are pointed at src/).
// A line `code // => expected` asserts display(code) and
// `code // throws: CODE` asserts the error code. A block preceded by
// <!-- continue --> runs after the previous ts block on the page.
// <!-- no-run --> skips the next block (use sparingly: fragments only).
// <!-- no-run: reason --> skips it too and lists it with its reason, for
// examples of behavior that is documented ahead of the code.
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bonsai, fn, t, type EnvironmentOptions } from '../../src/index.ts'
import { CLOCK, display, normalize } from './format.ts'



const websiteDir = fileURLToPath(new URL('..', import.meta.url))
const repoDir = fileURLToPath(new URL('../../', import.meta.url))
const srcDir = fileURLToPath(new URL('../../src/', import.meta.url))
const formatModule = fileURLToPath(new URL('./format.ts', import.meta.url))

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'public') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(path))
    else if (entry.name.endsWith('.md')) out.push(path)
  }
  return out
}

interface Block {
  lang: string
  code: string
  line: number
  context: string | undefined
  env: string | undefined
  noRun: boolean
  /** Why the block is skipped, for `<!-- no-run: reason -->`. */
  pending: string | undefined
  continues: boolean
}

function blocksOf(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let context: string | undefined
  let env: string | undefined
  let noRun = false
  let pending: string | undefined
  let continues = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const directive = /^<!--\s*(context|env):([\s\S]*?)-->\s*$/u.exec(line)
    if (directive) {
      if (directive[1] === 'context') context = directive[2].trim()
      else env = directive[2].trim()
      continue
    }
    const skip = /^<!--\s*no-run\s*(?::\s*(?<reason>.*?))?\s*-->/u.exec(line)
    if (skip) {
      noRun = true
      pending = skip.groups?.reason
    }
    if (/^<!--\s*continue\s*-->/u.test(line)) continues = true
    const fence = /^```(\w+)/u.exec(line)
    if (!fence) continue
    const start = i + 1
    const body: string[] = []
    for (i = i + 1; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
    blocks.push({ lang: fence[1], code: body.join('\n'), line: start, context, env, noRun, pending, continues })
    noRun = false
    pending = undefined
    continues = false
  }
  return blocks
}

let failures = 0
let checkedExpressions = 0
let checkedTs = 0
let skipped = 0
const pendingBlocks: string[] = []

function fail(where: string, message: string): void {
  failures++
  console.error(`FAIL ${where}\n  ${message.replaceAll('\n', '\n  ')}`)
}

function codesOf(error: unknown): string[] {
  const e = error as { code?: string; diagnostics?: { code: string }[] }
  return [e.code ?? String(error), ...(e.diagnostics ?? []).map((d) => d.code)]
}

function evalJs(text: string): unknown {
  return new Function('t', 'fn', `return (${text})`)(t, fn)
}

function checkBonsai(file: string, block: Block): void {
  const options = (block.env === undefined ? {} : evalJs(block.env)) as EnvironmentOptions<never>
  const env = bonsai({ ...options, clock: () => new Date(CLOCK) })
  const context = block.context === undefined ? {} : (evalJs(block.context) as Record<string, unknown>)
  let pending: string[] = []
  let pendingLine = block.line
  const lines = block.code.split('\n')
  lines.forEach((line, index) => {
    const lineNo = block.line + index + 1
    const marker = /^(.*?)\/\/\s*(=>|error:)\s*(.*)$/u.exec(line)
    if (pending.length === 0) pendingLine = lineNo
    if (!marker) {
      pending.push(line)
      return
    }
    const source = [...pending, marker[1]].join('\n').trim()
    pending = []
    const where = `${file}:${pendingLine}`
    checkedExpressions++
    const expected = marker[3].trim()
    let result: unknown
    try {
      result = env.evaluateSync(source, context)
    } catch (error) {
      if (marker[2] === 'error:') {
        if (!codesOf(error).includes(expected))
          fail(where, `${source}\n  expected error ${expected}, got ${codesOf(error).join(', ')}: ${(error as Error).message}`)
      } else {
        fail(where, `${source}\n  expected ${expected}, threw ${codesOf(error)[0]}: ${(error as Error).message}`)
      }
      return
    }
    if (marker[2] === 'error:') {
      fail(where, `${source}\n  expected error ${expected}, got ${display(result)}`)
    } else if (normalize(display(result)) !== normalize(expected)) {
      fail(where, `${source}\n  expected ${expected}\n  actual   ${display(result)}`)
    }
  })
  const rest = pending.join('\n').replace(/\/\/.*$/gmu, '').trim()
  if (rest !== '') fail(`${file}:${pendingLine}`, `expression without a result marker:\n${rest}`)
}

const PRELUDE = `
import { display as __display, normalize as __normalize } from ${JSON.stringify(formatModule)}
let __failed = 0
function __expect(actual, expected, line) {
  const shown = __display(actual)
  const ok = expected.startsWith("'") && expected.endsWith("'")
    ? typeof actual === 'string' && "'" + actual + "'" === expected
    : __normalize(shown) === __normalize(expected)
  if (!ok) { __failed++; console.error('line ' + line + ': expected ' + expected + '\\n  actual   ' + shown) }
}
async function __throws(run, code, line) {
  try { await run() } catch (e) {
    const codes = [e?.code, ...(e?.diagnostics ?? []).map((d) => d.code)]
    if (!codes.includes(code)) { __failed++; console.error('line ' + line + ': expected ' + code + ', got ' + codes.join(', ') + ': ' + e?.message) }
    return
  }
  __failed++; console.error('line ' + line + ': expected ' + code + ', nothing was thrown')
}
`

function balance(text: string): number {
  let depth = 0
  for (const ch of text.replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, '')) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
  }
  return depth
}

function transformTs(block: Block): string {
  const lines = block.code.split('\n')
  const out: string[] = []
  lines.forEach((line, index) => {
    const lineNo = block.line + index + 1
    const marker = /^(\s*)(.+?)\s*\/\/\s*(=>|throws:)\s*(.+)$/u.exec(line)
    if (!marker) {
      out.push(line)
      return
    }
    // A multi-line statement: pull earlier lines back in until brackets balance.
    const taken = [marker[2]]
    let indent = marker[1]
    while (balance(taken.join('\n')) < 0 && out.length > 0) {
      const previous = out.pop() as string
      indent = /^\s*/u.exec(previous)?.[0] ?? ''
      taken.unshift(previous.trim())
    }
    const code = taken.join('\n')
    const expected = JSON.stringify(marker[4].trim())
    out.push(
      marker[3] === '=>'
        ? `${indent}__expect(${code}, ${expected}, ${lineNo})`
        : `${indent}await __throws(async () => { return ${code} }, ${expected}, ${lineNo})`,
    )
  })
  return out
    .join('\n')
    .replaceAll("from 'bonsai-js/service'", `from ${JSON.stringify(join(srcDir, 'service/index.ts'))}`)
    .replaceAll("from 'bonsai-js'", `from ${JSON.stringify(join(srcDir, 'index.ts'))}`)
}

function checkTs(file: string, blocks: Block[], tmp: string): void {
  const parts = blocks.map((b) => transformTs(b))
  const program = `${PRELUDE}\n${parts.join('\n;\n')}\nif (__failed > 0) process.exit(1)\n`
  const path = join(tmp, `example-${checkedTs}.ts`)
  writeFileSync(path, program)
  checkedTs++
  const run = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 30_000 })
  if (run.status !== 0) {
    fail(`${file}:${blocks[blocks.length - 1].line}`, `${run.stderr}${run.stdout}`.trim())
  }
}

const documents = [
  ...markdownFiles(websiteDir).map((path) => ({ path, file: relative(websiteDir, path) })),
  ...[join(repoDir, 'README.md'), ...markdownFiles(join(repoDir, 'docs'))].map((path) => ({
    path,
    file: relative(repoDir, path),
  })),
]

const tmp = mkdtempSync(join(tmpdir(), 'bonsai-examples-'))
try {
  for (const { path, file } of documents) {
    const blocks = blocksOf(readFileSync(path, 'utf8'))
    let chain: Block[] = []
    for (const block of blocks) {
      if (block.noRun) {
        skipped++
        if (block.pending !== undefined) pendingBlocks.push(`${file}:${block.line} (${block.pending})`)
        continue
      }
      if (block.lang === 'bonsai') checkBonsai(file, block)
      else if (block.lang === 'ts') {
        chain = block.continues ? [...chain, block] : [block]
        checkTs(file, chain, tmp)
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (pendingBlocks.length > 0) console.log(`Not run, pending:\n  ${pendingBlocks.join('\n  ')}`)
console.log(
  `${checkedExpressions} expressions and ${checkedTs} TypeScript blocks checked, ${skipped} blocks marked no-run, ${failures} failures`,
)
if (failures > 0) process.exit(1)
