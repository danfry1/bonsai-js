import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BonsaiCheckError,
  BonsaiError,
  bonsai,
  isBonsaiError,
  t,
  type BonsaiErrorJSON,
  type DiagnosticJSON,
  type Type,
} from '../src/index.js'

describe('the JSON form of a check error', () => {
  it('types its diagnostics without the formatted accessor JSON leaves out', () => {
    let error: unknown
    try {
      bonsai({ variables: { user: t.object({ age: t.number() }) } }).compile('user.agee')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(BonsaiCheckError)
    const parsed = JSON.parse(JSON.stringify(error)) as BonsaiErrorJSON
    const first = parsed.diagnostics?.[0]
    expect(first).toMatchObject({ code: 'UNKNOWN_PROPERTY', suggestion: 'age' })
    expect(first && 'formatted' in first).toBe(false)
    expectTypeOf<
      NonNullable<BonsaiErrorJSON['diagnostics']>[number]
    >().toEqualTypeOf<DiagnosticJSON>()
    // @ts-expect-error: the JSON form has no formatted code frame
    expect(first?.formatted).toBeUndefined()
  })
})

describe('extend() replaces a variable declared again', () => {
  it('types the new declaration, as evaluation reads it', () => {
    const base = bonsai({ variables: { a: t.number(), keep: t.boolean() } })
    const redeclared = base.extend({ variables: { a: t.string() } })
    expect(redeclared.evaluateSync('a', { a: 'x', keep: true })).toBe('x')
    expectTypeOf<Parameters<typeof redeclared.evaluateSync>[1]>().toMatchObjectType<{
      readonly a: string
      readonly keep: boolean
    }>()
    // @ts-expect-error: a is now a string
    redeclared.evaluateSync('a', { a: 1, keep: true })
    // @ts-expect-error: keep is still declared
    redeclared.evaluateSync('a', { a: 'x' })
  })

  it('replaces a variable with one from a library given to extend()', () => {
    const geo = { name: 'geo', variables: { region: t.string() } } as const
    const env = bonsai({ variables: { region: t.number() } }).extend({ libraries: [geo] })
    expect(env.evaluateSync('region', { region: 'eu' })).toBe('eu')
    // @ts-expect-error: region is now the library's string
    env.evaluateSync('region', { region: 1 })
  })

  it('keeps the declared keys of a strict: false base when extending', () => {
    const loose = bonsai({ variables: { a: t.number() }, strict: false })
    const more = loose.extend({ variables: { b: t.string() } })
    expect(more.evaluateSync('a + 1', { a: 1, b: 'x', extra: true })).toBe(2)
    // @ts-expect-error: a is still a number
    more.evaluateSync('a', { a: 'x', b: 'y' })
  })
})

describe('a schema known only at run time', () => {
  interface Row {
    total: number
    status: string
  }
  class Order {
    total = 5
    status = 'paid'
  }
  // As loaded from storage: the variable names are not known statically.
  const schema: Record<string, Type> = { total: t.number(), status: t.string() }

  it('accepts interface-typed and class contexts', () => {
    const env = bonsai({ variables: schema })
    const row: Row = { total: 2, status: 'paid' }
    expect(env.evaluateSync('total > 1', row)).toBe(true)
    expect(env.evaluateSync('total > 1', new Order())).toBe(true)
    expect(env.compile('total > 1').partial(row).status).toBe('value')
  })
})

describe('isBonsaiError', () => {
  it('recognizes an error from another copy of the package', () => {
    // A copy of the package defines its own BonsaiError class; instanceof fails across copies.
    const foreign = new Error('Division by zero') as Error & Record<symbol, unknown>
    Object.defineProperty(foreign, Symbol.for('bonsai-js.error'), { value: true })
    expect(foreign instanceof BonsaiError).toBe(false)
    expect(isBonsaiError(foreign)).toBe(true)
    expect(isBonsaiError(new Error('plain'))).toBe(false)
    expect(isBonsaiError(null)).toBe(false)
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('trap')
        },
      },
    )
    expect(isBonsaiError(hostile)).toBe(false)
  })
})

describe('the llms.txt summaries', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

  it.each(['website/public/llms.txt', 'website/public/llms-full.txt'])(
    '%s has no 0.x context option',
    (path) => {
      // Host functions opt into the context with call: true; context: true was the 0.x spelling.
      expect(read(path)).not.toMatch(/\bcontext\??: (?:true|boolean)\b|fn\(\{[^\n]*\bcontext\?/u)
    },
  )

  it('names the current host function and evaluation options', () => {
    const text = read('website/public/llms.txt')
    expect(text).toMatch(/fn\(\{[^\n]*\bcall\?/u)
    expect(text).toMatch(/\{ timeout, maxSteps, signal, now, validateContext \}/u)
  })
})
