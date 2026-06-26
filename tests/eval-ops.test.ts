import { describe, it, expect } from 'vitest'
import {
  applyBinaryOp,
  applyUnaryOp,
  validateMethodCall,
  validateMethodArgs,
  resolveTransform,
  resolveCallable,
  getIdentifierName,
  getObjectLiteralKeyName,
  expandSpreadValue,
  checkResultArrayLength,
  checkResultStringLength,
  accessMember,
} from '../src/eval-ops.js'
import { parse } from '../src/parser.js'
import { SecurityPolicy, ExecutionContext } from '../src/execution-context.js'
import { BonsaiTypeError, BonsaiSecurityError, BonsaiReferenceError } from '../src/errors.js'
import type { BonsaiOptions } from '../src/types.js'

// Direct unit tests on the evaluation primitives. These pure functions sit on
// the hot path of both evaluator walks, so they are pinned operator-by-operator
// and boundary-by-boundary rather than only through end-to-end expressions.

const guard = (opts: BonsaiOptions = {}): ExecutionContext =>
  new ExecutionContext(new SecurityPolicy(opts))

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw')
}

// validateMethodArgs returns void; wrap it in a thunk with a block body so the
// assertions stay readable without tripping no-confusing-void-expression.
const argsThunk =
  (receiver: unknown, name: string, args: unknown[], opts: BonsaiOptions = {}) =>
  (): void => {
    validateMethodArgs(receiver, name, args, guard(opts))
  }

describe('applyBinaryOp - arithmetic', () => {
  it.each([
    ['+', 7, 2, 9],
    ['-', 7, 2, 5],
    ['*', 7, 2, 14],
    ['/', 7, 2, 3.5],
    ['%', 7, 2, 1],
    ['**', 7, 2, 49],
  ] as const)('%s', (op, l, r, expected) => {
    expect(applyBinaryOp(op, l, r)).toBe(expected)
  })
})

describe('applyBinaryOp - equality (strict)', () => {
  it('== is true only for strictly equal operands', () => {
    expect(applyBinaryOp('==', 1, 1)).toBe(true)
    expect(applyBinaryOp('==', 1, 2)).toBe(false)
    expect(applyBinaryOp('==', '1', 1)).toBe(false)
  })

  it('!= is false only for strictly equal operands', () => {
    expect(applyBinaryOp('!=', 1, 1)).toBe(false) // pins the equal case (kills `return true`)
    expect(applyBinaryOp('!=', 1, 2)).toBe(true)
  })
})

describe('applyBinaryOp - relational with equal-operand boundaries', () => {
  // Each operator is checked at less-than, equal, and greater-than so a mutant
  // swapping it for a neighbour (e.g. < for <=) cannot agree on every case.
  it.each([
    ['<', [2, 3, true], [3, 3, false], [4, 3, false]],
    ['>', [2, 3, false], [3, 3, false], [4, 3, true]],
    ['<=', [2, 3, true], [3, 3, true], [4, 3, false]],
    ['>=', [2, 3, false], [3, 3, true], [4, 3, true]],
  ] as const)('%s holds at every ordering', (op, lt, eq, gt) => {
    for (const [l, r, expected] of [lt, eq, gt]) {
      expect(applyBinaryOp(op, l, r)).toBe(expected)
    }
  })
})

describe('applyBinaryOp - in / not in', () => {
  it('checks substring and array membership', () => {
    expect(applyBinaryOp('in', 'ell', 'hello')).toBe(true)
    expect(applyBinaryOp('in', 'xyz', 'hello')).toBe(false)
    expect(applyBinaryOp('in', 2, [1, 2, 3])).toBe(true)
    expect(applyBinaryOp('not in', 2, [1, 2, 3])).toBe(false)
    expect(applyBinaryOp('not in', 9, [1, 2, 3])).toBe(true)
  })

  it('throws a typed error naming the operator for a non-string/array right side', () => {
    const inErr = errorOf(() => applyBinaryOp('in', 1, 42))
    expect(inErr).toBeInstanceOf(BonsaiTypeError)
    expect((inErr as BonsaiTypeError).transform).toBe('in')
    expect((inErr as BonsaiTypeError).expected).toBe('a string or array')

    const notInErr = errorOf(() => applyBinaryOp('not in', 1, 42))
    expect((notInErr as BonsaiTypeError).transform).toBe('not in')
    expect((notInErr as BonsaiTypeError).expected).toBe('a string or array')
  })

  it('rejects an unknown binary operator', () => {
    expect(() => applyBinaryOp('&&' as never, true, false)).toThrow('Unknown binary operator')
  })
})

describe('applyUnaryOp', () => {
  it('applies !, -, and +', () => {
    expect(applyUnaryOp('!', true)).toBe(false)
    expect(applyUnaryOp('!', false)).toBe(true)
    expect(applyUnaryOp('-', 5)).toBe(-5)
    expect(applyUnaryOp('+', '42')).toBe(42)
  })

  it('rejects an unknown unary operator', () => {
    expect(() => applyUnaryOp('~' as never, 1)).toThrow('Unknown unary operator')
  })
})

describe('validateMethodCall', () => {
  it('returns the method for an allowed call', () => {
    expect(typeof validateMethodCall([], 'map', guard())).toBe('function')
  })

  it('throws for a null receiver, naming the expectation', () => {
    const err = errorOf(() => validateMethodCall(null, 'map', guard()))
    expect(err).toBeInstanceOf(BonsaiTypeError)
    expect((err as BonsaiTypeError).expected).toBe('a non-null value')
  })

  it('throws METHOD_NOT_ALLOWED with a descriptive message for a disallowed method', () => {
    const err = errorOf(() => validateMethodCall([], 'push', guard()))
    expect(err).toBeInstanceOf(BonsaiSecurityError)
    expect((err as BonsaiSecurityError).code).toBe('METHOD_NOT_ALLOWED')
    expect((err as BonsaiSecurityError).message).toContain('not allowed')
  })

  it('routes the method name through the access guard', () => {
    expect(() => validateMethodCall([], '__proto__', guard())).toThrow(BonsaiSecurityError)
  })
})

describe('resolveTransform / resolveCallable', () => {
  it('resolves a registered transform and rejects an unknown one', () => {
    const t = (v: unknown) => v
    expect(resolveTransform('id', { id: t })).toBe(t)
    expect(() => resolveTransform('nope', {})).toThrow(BonsaiReferenceError)
  })

  it('resolves a registered function and rejects an unknown one', () => {
    const f = { kind: 'pure', fn: () => 1 } as const
    expect(resolveCallable('one', { one: f })).toBe(f)
    expect(() => resolveCallable('nope', {})).toThrow(BonsaiReferenceError)
  })
})

describe('getIdentifierName', () => {
  it('returns the name of an identifier node', () => {
    expect(getIdentifierName(parse('foo'))).toBe('foo')
  })

  it('throws the default message for a non-identifier node', () => {
    expect(() => getIdentifierName(parse('5'))).toThrow('Expected identifier')
  })

  it('throws a caller-supplied message for a non-identifier node', () => {
    expect(() => getIdentifierName(parse('5'), 'custom message')).toThrow('custom message')
  })
})

describe('getObjectLiteralKeyName', () => {
  it('returns the name of an identifier key and the value of a string-literal key', () => {
    expect(getObjectLiteralKeyName(parse('foo'))).toBe('foo')
    expect(getObjectLiteralKeyName(parse('"bar"'))).toBe('bar')
  })

  it('throws for a key that is neither an identifier nor a string literal', () => {
    expect(() => getObjectLiteralKeyName(parse('5'))).toThrow(
      'Expected identifier or string literal',
    )
  })
})

describe('expandSpreadValue', () => {
  it('returns an array unchanged', () => {
    expect(expandSpreadValue([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('allows an array exactly at the limit but rejects one past it', () => {
    expect(expandSpreadValue([1, 2], 2)).toEqual([1, 2])
    const err = errorOf(() => expandSpreadValue([1, 2, 3], 2))
    expect(err).toBeInstanceOf(BonsaiSecurityError)
    expect((err as BonsaiSecurityError).code).toBe('MAX_ARRAY_LENGTH')
  })

  it('materializes a non-array iterable into a fresh array', () => {
    expect(expandSpreadValue(new Set([1, 2, 3]))).toEqual([1, 2, 3])
  })

  it('allows an iterable exactly at the limit but rejects one past it', () => {
    expect(expandSpreadValue(new Set([1, 2]), 2)).toEqual([1, 2])
    const err = errorOf(() => expandSpreadValue(new Set([1, 2, 3]), 2))
    expect((err as BonsaiSecurityError).code).toBe('MAX_ARRAY_LENGTH')
  })

  it('throws a typed iterable error for a non-iterable value', () => {
    const err = errorOf(() => expandSpreadValue(42))
    expect(err).toBeInstanceOf(BonsaiTypeError)
    expect((err as BonsaiTypeError).transform).toBe('spread')
    expect((err as BonsaiTypeError).expected).toBe('an iterable value')
  })

  it('throws the typed iterable error (not a raw TypeError) for null', () => {
    expect(errorOf(() => expandSpreadValue(null))).toBeInstanceOf(BonsaiTypeError)
  })
})

describe('validateMethodArgs - replace family', () => {
  it('rejects function, RegExp, and object arguments but allows null/strings', () => {
    expect(argsThunk('s', 'replace', [() => 1])).toThrow('callbacks are not allowed')
    expect(argsThunk('s', 'replace', [/x/u])).toThrow('RegExp is not allowed')
    expect(argsThunk('s', 'replace', [{}])).toThrow('objects are not allowed')
    // null is typeof 'object' but the `arg != null` guard must let it through.
    expect(argsThunk('s', 'replace', [null])).not.toThrow()
  })
})

describe('validateMethodArgs - repeat count bounds', () => {
  it('allows the boundary counts 0 and the maximum', () => {
    expect(argsThunk('', 'repeat', [0])).not.toThrow()
    expect(argsThunk('', 'repeat', [100_000])).not.toThrow()
  })

  it('rejects negative, over-maximum, and non-finite counts', () => {
    expect(argsThunk('', 'repeat', [-1])).toThrow('a count between')
    expect(argsThunk('', 'repeat', [100_001])).toThrow('a count between')
    expect(argsThunk('', 'repeat', [Number.NaN])).toThrow('a count between')
    expect(argsThunk('', 'repeat', [Infinity])).toThrow('a count between')
    // The error names the offending method (kills a blanked transform name).
    const err = errorOf(argsThunk('', 'repeat', [-1]))
    expect((err as BonsaiTypeError).transform).toBe('repeat')
  })

  it('bounds the produced string size for a string receiver, not just the count', () => {
    // 10-char receiver repeated 10 times = 100 chars, past a 50-char ceiling.
    expect(argsThunk('a'.repeat(10), 'repeat', [10], { maxStringLength: 50 })).toThrow(
      BonsaiSecurityError,
    )
  })

  it('does not run the string-size check for a non-string receiver', () => {
    // A 10-element array receiver must not be treated as a 10-char string.
    expect(argsThunk(new Array(10), 'repeat', [10], { maxStringLength: 50 })).not.toThrow()
  })
})

describe('validateMethodArgs - padStart / padEnd target length', () => {
  it('caps the requested target length for both pad methods', () => {
    expect(argsThunk('x', 'padStart', [200], { maxStringLength: 100 })).toThrow(BonsaiSecurityError)
    expect(argsThunk('x', 'padEnd', [200], { maxStringLength: 100 })).toThrow(BonsaiSecurityError)
  })

  it('does not apply the pad cap to other methods', () => {
    expect(argsThunk('x', 'slice', [200], { maxStringLength: 100 })).not.toThrow()
  })
})

describe('validateMethodArgs - higher-order callback', () => {
  it('requires a function callback for higher-order methods', () => {
    const err = errorOf(argsThunk([], 'map', ['not a function']))
    expect(err).toBeInstanceOf(BonsaiTypeError)
    expect((err as BonsaiTypeError).expected).toContain('lambda or function callback')
  })

  it('accepts a function callback', () => {
    expect(argsThunk([], 'map', [() => 1])).not.toThrow()
  })
})

describe('checkResultArrayLength / checkResultStringLength', () => {
  it('enforces the array ceiling only on arrays', () => {
    const g = guard({ maxArrayLength: 3 })
    expect(() => {
      checkResultArrayLength([1, 2, 3], g)
    }).not.toThrow()
    expect(() => {
      checkResultArrayLength([1, 2, 3, 4], g)
    }).toThrow('Array length')
    expect(() => {
      checkResultArrayLength('not an array', g)
    }).not.toThrow()
  })

  it('enforces the string ceiling only on strings', () => {
    const g = guard({ maxStringLength: 3 })
    expect(() => {
      checkResultStringLength('abc', g)
    }).not.toThrow()
    expect(() => {
      checkResultStringLength('abcd', g)
    }).toThrow('String length')
    expect(() => {
      checkResultStringLength(['not', 'a', 'string'], g)
    }).not.toThrow()
  })
})

describe('accessMember', () => {
  it('reads a named property', () => {
    expect(accessMember({ x: 5 }, parse('x'), false, undefined, guard())).toBe(5)
  })

  it('reads a computed property from the evaluated key', () => {
    expect(accessMember({ x: 5 }, parse('x'), true, 'x', guard())).toBe(5)
  })

  it('yields undefined for a null object rather than throwing', () => {
    expect(accessMember(null, parse('x'), false, undefined, guard())).toBeUndefined()
  })

  it('routes the key through the access guard', () => {
    expect(() => accessMember({}, parse('x'), true, '__proto__', guard())).toThrow(
      BonsaiSecurityError,
    )
  })
})
