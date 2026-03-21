import { describe, it, expect } from 'vitest'
import { METHODS_BY_TYPE } from '../../src/autocomplete/catalog.js'

describe('METHODS_BY_TYPE stays in sync with isAllowedReceiver', () => {
  const testValues: Record<string, unknown> = {
    string: 'test',
    array: [1, 2, 3],
    number: 42,
  }

  for (const [type, methods] of Object.entries(METHODS_BY_TYPE)) {
    for (const method of methods) {
      it(`${type}.${method} is a real method on ${type}`, () => {
        const value = testValues[type]
        expect(typeof (value as Record<string, unknown>)[method]).toBe('function')
      })
    }
  }
})
