import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'

describe('ordering against null', () => {
  const env = bonsai()

  // The spec: if either side of <, <=, >, >= is null the result is false.
  it.each(['true < null', '{} < null', '[1] <= null', 'null < null', '1 >= null', 'null > "a"'])(
    '%s checks with a warning and evaluates to false',
    (source) => {
      const checked = env.check(source)
      expect(checked.ok).toBe(true)
      expect(checked.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ['ALWAYS_FALSE', 'warning'],
      ])
      expect(env.evaluateSync(source)).toBe(false)
    },
  )

  it('still rejects other mixes of kinds', () => {
    expect(env.check('true < 1').diagnostics.map((d) => d.code)).toEqual(['TYPE_ERROR'])
  })
})
