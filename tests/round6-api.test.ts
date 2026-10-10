import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BonsaiCheckError,
  type BonsaiError,
  BonsaiLimitError,
  BonsaiRuntimeError,
  BonsaiSyntaxError,
  bonsai,
  parse,
  type BonsaiErrorJSON,
  type ExplanationJSON,
  type Limits,
} from '../src/index.js'
import { BonsaiTranslationError, toSQL, type SQLParam } from '../src/query/index.js'
import { tooDeep } from '../src/runtime/overflow.js'

const outcome = (run: () => unknown): unknown => {
  try {
    return run()
  } catch (error) {
    return error
  }
}

describe('error names', () => {
  it('names each class with a literal, as its JSON does', () => {
    const cases: [unknown, string][] = [
      [outcome(() => bonsai().evaluateSync('1 +')), 'BonsaiSyntaxError'],
      [outcome(() => bonsai().evaluateSync('1 / 0')), 'BonsaiRuntimeError'],
      [
        outcome(() => bonsai({ limits: { maxSteps: 1 } }).evaluateSync('[1, 2, 3].map(. * 2)')),
        'BonsaiLimitError',
      ],
      [outcome(() => bonsai().compile('1 + "a"')), 'BonsaiCheckError'],
      [
        outcome(() =>
          toSQL(bonsai().compile('order.x.matches("a")'), {
            row: 'order',
            dialect: 'sqlite',
            columns: { x: 'text' },
          }),
        ),
        'BonsaiTranslationError',
      ],
    ]
    const classes = [
      BonsaiSyntaxError,
      BonsaiRuntimeError,
      BonsaiLimitError,
      BonsaiCheckError,
      BonsaiTranslationError,
    ]
    cases.forEach(([error, name], i) => {
      expect(error).toBeInstanceOf(classes[i])
      expect((error as BonsaiError).name).toBe(name)
      expect((JSON.parse(JSON.stringify(error)) as BonsaiErrorJSON).name).toBe(name)
    })
  })

  it('keeps the names in a minified bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bonsai-names-'))
    try {
      const entry = join(dir, 'entry.mjs')
      const out = join(dir, 'out.mjs')
      const index = JSON.stringify(resolve('src/index.ts'))
      writeFileSync(
        entry,
        `import { bonsai } from ${index}
const names = []
for (const source of ['1 +', '1 / 0']) {
  try { bonsai().evaluateSync(source) } catch (e) { names.push(e.name, JSON.parse(JSON.stringify(e)).name) }
}
console.log(names.join(','))`,
      )
      execFileSync('bun', ['build', entry, '--minify', '--target', 'node', '--outfile', out], {
        stdio: 'ignore',
      })
      const printed = execFileSync(process.execPath, [out], { encoding: 'utf8' }).trim()
      expect(printed).toBe(
        'BonsaiSyntaxError,BonsaiSyntaxError,BonsaiRuntimeError,BonsaiRuntimeError',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('a stack overflow', () => {
  it('names no option, since none raises the call stack', () => {
    const error = tooDeep('x == y')
    expect(error.code).toBe('TOO_DEEP')
    expect(error.limit).toBeUndefined()
    expect(error.toJSON()).not.toHaveProperty('limit')
    expect(error.message).toMatch(/call stack/u)
  })

  it('keeps maxDepth on a syntax depth limit', () => {
    expect(outcome(() => parse('((1))', { maxDepth: 2 }))).toMatchObject({
      code: 'TOO_DEEP',
      limit: 'maxDepth',
    })
  })
})

describe('standalone parse()', () => {
  it('takes a whole limits object and ignores the limits parsing does not use', () => {
    const limits: Limits = { maxSteps: 10, timeout: 5, maxStringLength: 9, maxDepth: 2 }
    expect(outcome(() => parse('((1))', limits))).toMatchObject({ code: 'TOO_DEEP' })
    expect(parse('1 + 2', limits)).toMatchObject({ type: 'Binary' })
  })

  it('still rejects a key that is not a limit', () => {
    expect(() => parse('1', { maxDept: 1 } as never)).toThrow(TypeError)
  })
})

describe('typed outputs', () => {
  it('types an explanation as JSON', () => {
    const json: ExplanationJSON = bonsai().explainSync('1 + 2').toJSON()
    expect(json.ok).toBe(true)
    if (json.ok) expect(json.value).toBe(3)
    expect(json.trace.children).toHaveLength(2)
    const failed = bonsai().explainSync('1 / 0').toJSON()
    expect(failed.ok ? null : failed.error.code).toBe('DIVISION_BY_ZERO')
  })

  it('lists functions read-only and names the SQL parameter type', () => {
    const list = bonsai().listFunctions()
    // @ts-expect-error: the list is read-only
    list.push(list[0])
    const query = toSQL(bonsai().compile('order.total > 1'), {
      row: 'order',
      dialect: 'sqlite',
      columns: { total: 'number' },
    })
    const params: SQLParam[] = query.params
    expect(params).toEqual([1])
  })
})
