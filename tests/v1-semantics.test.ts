import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'

interface FixtureError {
  name: string
  code?: string
}

interface FixtureCase {
  id: string
  expression: string
  context: Record<string, unknown>
  value?: unknown
  undefined?: true
  error?: FixtureError
}

interface FixtureFile {
  version: number
  cases: FixtureCase[]
}

const fixturePath = fileURLToPath(new URL('./fixtures/v1-semantics.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureFile

function capture(thunk: () => unknown): { value: unknown } | { error: unknown } {
  try {
    return { value: thunk() }
  } catch (error: unknown) {
    return { error }
  }
}

async function captureAsync(
  thunk: () => Promise<unknown>,
): Promise<{ value: unknown } | { error: unknown }> {
  try {
    return { value: await thunk() }
  } catch (error: unknown) {
    return { error }
  }
}

function assertOutcome(
  outcome: { value: unknown } | { error: unknown },
  fixtureCase: FixtureCase,
): void {
  if (fixtureCase.error) {
    expect(outcome).toHaveProperty('error')
    const error = (outcome as { error: { name?: unknown; code?: unknown } }).error
    expect(error).toMatchObject(fixtureCase.error)
    return
  }
  expect(outcome).toHaveProperty('value')
  const value = (outcome as { value: unknown }).value
  if (fixtureCase.undefined) expect(value).toBeUndefined()
  else expect(value).toEqual(fixtureCase.value)
}

describe(`v${String(fixture.version)} executable language semantics`, () => {
  for (const fixtureCase of fixture.cases) {
    it(fixtureCase.id, async () => {
      const expr = bonsai().seal()
      const compiled = expr.compile(fixtureCase.expression)

      assertOutcome(
        capture(() => expr.evaluateSync(fixtureCase.expression, fixtureCase.context)),
        fixtureCase,
      )
      assertOutcome(
        await captureAsync(() => expr.evaluate(fixtureCase.expression, fixtureCase.context)),
        fixtureCase,
      )
      assertOutcome(
        capture(() => compiled.evaluateSync(fixtureCase.context)),
        fixtureCase,
      )
      assertOutcome(await captureAsync(() => compiled.evaluate(fixtureCase.context)), fixtureCase)
    })
  }
})
