import { describe, it, expect } from 'vitest'
import {
  bonsai,
  ExpressionError,
  BonsaiTypeError,
  BonsaiSecurityError,
  BonsaiReferenceError,
  isBonsaiError,
  isBonsaiRuntimeError,
  type BonsaiError,
  type BonsaiSecurityCode,
} from '../src/index.js'

describe('isBonsaiError / isBonsaiRuntimeError', () => {
  it('narrows unknown to a Bonsai error and excludes everything else', () => {
    const ref: unknown = new BonsaiReferenceError('function', 'foo')
    expect(isBonsaiError(ref)).toBe(true)
    expect(isBonsaiRuntimeError(ref)).toBe(true)

    const parse: unknown = new ExpressionError('bad', { source: 'x', start: 0, end: 1 })
    expect(isBonsaiError(parse)).toBe(true)
    expect(isBonsaiRuntimeError(parse)).toBe(false) // parse errors are not runtime errors

    expect(isBonsaiError(new Error('plain'))).toBe(false)
    expect(isBonsaiError('nope')).toBe(false)
    expect(isBonsaiError(null)).toBe(false)
  })

  it('catches real thrown errors and classifies them', () => {
    const expr = bonsai()
    let caught: unknown
    try {
      expr.evaluateSync('user.constructor', { user: {} })
    } catch (error) {
      caught = error
    }
    expect(isBonsaiError(caught)).toBe(true)
    if (!isBonsaiError(caught)) throw new Error('expected a Bonsai error')
    // narrowed to BonsaiError here
    expect(classify(caught)).toBe('security:BLOCKED_PROPERTY')
  })
})

describe('error name discriminant', () => {
  it('exposes a literal name usable for exhaustive switching', () => {
    expect(new ExpressionError('x', { source: 'x', start: 0, end: 1 }).name).toBe('ExpressionError')
    expect(new BonsaiTypeError('count', 'an array', 5).name).toBe('BonsaiTypeError')
    expect(new BonsaiSecurityError('TIMEOUT', 'too slow').name).toBe('BonsaiSecurityError')
    expect(new BonsaiReferenceError('transform', 'uppr').name).toBe('BonsaiReferenceError')
  })
})

describe('BonsaiSecurityError.code', () => {
  it('is a known security code on a real violation', () => {
    const bounded = bonsai({ maxArrayLength: 2 })
    let code: BonsaiSecurityCode | undefined
    try {
      bounded.evaluateSync('[1, 2, 3]')
    } catch (error) {
      if (error instanceof BonsaiSecurityError) code = error.code
    }
    expect(code).toBe('MAX_ARRAY_LENGTH')
  })
})

describe('validate() error shape', () => {
  it('always provides a formatted, caret-annotated message', () => {
    const result = bonsai().validate('1 + * 2')
    if (result.valid) throw new Error('expected an invalid result')
    // `formatted` is required (not optional), so no fallback needed.
    const formatted: string = result.errors[0].formatted
    expect(formatted).toContain('^')
    expect(formatted).toContain('1 + * 2')
    expect(result.errors[0].position.column).toBeGreaterThan(0)
  })
})

// --- compile-time assertions (validated by tsc) ---

/** If any case is missing below, `value` is no longer `never` and this errors. */
function assertNever(value: never): never {
  throw new Error(`unexpected: ${String(value)}`)
}

/** Exhaustive over the `name` discriminant; also proves each case narrows to its class. */
function classify(err: BonsaiError): string {
  switch (err.name) {
    case 'ExpressionError':
      return `parse:${err.rawMessage}`
    case 'BonsaiTypeError':
      return `type:${err.transform}`
    case 'BonsaiSecurityError':
      return `security:${err.code}`
    case 'BonsaiReferenceError':
      return `reference:${err.identifier}`
    default:
      return assertNever(err)
  }
}

/** Exhaustive over the closed set of security codes. */
function explainCode(code: BonsaiSecurityCode): string {
  switch (code) {
    case 'BLOCKED_PROPERTY':
    case 'PROPERTY_NOT_ALLOWED':
    case 'PROPERTY_DENIED':
    case 'METHOD_NOT_ALLOWED':
      return 'access'
    case 'MAX_DEPTH':
    case 'MAX_ARRAY_LENGTH':
    case 'MAX_STRING_LENGTH':
    case 'MAX_STEPS':
      return 'limit'
    case 'TIMEOUT':
      return 'timeout'
    default:
      return assertNever(code)
  }
}

it('compile-time helpers are exhaustive', () => {
  expect(classify(new BonsaiReferenceError('function', 'x'))).toBe('reference:x')
  expect(explainCode('TIMEOUT')).toBe('timeout')
})
