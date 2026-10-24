import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bonsai, fn, t } from '../src/index.js'
import { BUILTINS } from '../src/functions/builtins.js'

// Descriptions are kept by position, apart from the definitions, so a function
// added to builtins.ts must be added at the same place in descriptions.ts.
describe('built-in descriptions', () => {
  it('are listed in BUILTINS order, one per built-in', () => {
    const source = readFileSync(
      new URL('../src/functions/descriptions.ts', import.meta.url),
      'utf8',
    )
    const names = [...source.matchAll(/^ {2}\/\/ (?<name>\w+)$/gmu)].map(
      (match) => match.groups?.name,
    )
    expect(names).toEqual([...BUILTINS.keys()])
  })

  it('describe every built-in, and a host function by its own description', () => {
    const env = bonsai({
      functions: {
        trim: fn({ params: [], returns: t.string(), run: () => '' }),
        mine: fn({ description: 'Mine.', params: [], returns: t.number(), run: () => 1 }),
      },
    })
    for (const name of BUILTINS.keys()) {
      if (name === 'trim') continue
      expect(env.describeFunction(name)?.description, name).toMatch(/\S/u)
    }
    expect(env.describeFunction('round')?.description).toBe(
      'Rounds half away from zero, optionally to a number of decimal digits.',
    )
    expect(env.describeFunction('trim')?.description).toBe('')
    expect(env.describeFunction('mine')?.description).toBe('Mine.')
  })
})
