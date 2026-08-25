import { describe, it, expect } from 'vitest'
import { METHODS_BY_TYPE } from '../../src/autocomplete/catalog.js'
import {
  isMethodAllowedOn,
  methodSignatureArgument,
  methodSignatureCode,
  methodSignatureHasRest,
  methodSignatureParamCount,
  methodSignatureRequired,
  methodsForReceiverType,
  type MethodReceiverType,
} from '../../src/safe-methods.js'

const SAMPLES: Record<MethodReceiverType, unknown> = {
  string: 'test',
  array: [1, 2, 3],
  number: 42,
}

describe('autocomplete catalog matches runtime enforcement', () => {
  it('every catalogued method is permitted by the runtime allowlist (no suggest-then-reject)', () => {
    for (const type of Object.keys(METHODS_BY_TYPE) as MethodReceiverType[]) {
      for (const method of METHODS_BY_TYPE[type]) {
        expect(isMethodAllowedOn(SAMPLES[type], method), `${type}.${method}`).toBe(true)
      }
    }
  })

  it('every catalogued method is a real method on its receiver type', () => {
    for (const type of Object.keys(METHODS_BY_TYPE) as MethodReceiverType[]) {
      for (const method of METHODS_BY_TYPE[type]) {
        expect(typeof (SAMPLES[type] as Record<string, unknown>)[method], `${type}.${method}`).toBe(
          'function',
        )
      }
    }
  })

  it('the catalog and the runtime allowlist derive from a single source (no drift either direction)', () => {
    for (const type of ['string', 'array', 'number'] as const) {
      expect([...METHODS_BY_TYPE[type]].sort()).toEqual(methodsForReceiverType(type).sort())
    }
  })

  it('every allowed receiver/method pair has a well-formed shared signature', () => {
    for (const type of ['string', 'array', 'number'] as const) {
      for (const method of methodsForReceiverType(type)) {
        const code = methodSignatureCode(type, method)
        expect(code, `${type}.${method}`).toBeDefined()
        if (code === undefined) continue
        const parameterCount = methodSignatureParamCount(code)
        expect(methodSignatureRequired(code)).toBeLessThanOrEqual(parameterCount)
        if (methodSignatureHasRest(code)) expect(parameterCount).toBeGreaterThan(0)
        for (let index = 0; index < parameterCount; index++) {
          expect(methodSignatureArgument(code, index)).toMatch(/^[snpual]$/u)
        }
      }
    }
  })

  it('does not list array.toString, which the evaluator rejects', () => {
    expect(METHODS_BY_TYPE.array).not.toContain('toString')
    expect(isMethodAllowedOn([1, 2], 'toString')).toBe(false)
    expect(isMethodAllowedOn('x', 'toString')).toBe(true)
    expect(isMethodAllowedOn(42, 'toString')).toBe(true)
  })
})
