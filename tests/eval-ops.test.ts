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
  arrayMethodReceiver,
  chargeNativeMethod,
  checkResultLimits,
  accessMember,
} from '../src/eval-ops.js'
import { parse } from '../src/parser.js'
import { createBonsaiLambda } from '../src/lambda.js'
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

  it('concatenates strings but rejects every mixed or unsupported pair', () => {
    expect(applyBinaryOp('+', 'bon', 'sai')).toBe('bonsai')

    for (const [left, right, received] of [
      [1, '2', 'string'],
      ['1', 2, 'number'],
      [true, 2, 'boolean'],
      [2, false, 'boolean'],
    ] as const) {
      const error = errorOf(() => applyBinaryOp('+', left, right)) as BonsaiTypeError
      expect(error).toBeInstanceOf(BonsaiTypeError)
      expect(error.transform).toBe('+')
      expect(error.expected).toMatch(/^two numbers or two strings \(use a template literal/u)
      expect(error.received).toBe(received)
    }
  })

  it.each(['-', '*', '/', '%', '**'] as const)(
    '%s rejects a bad left or right operand and reports the offending side',
    (operator) => {
      const badLeft = errorOf(() => applyBinaryOp(operator, '7', 2)) as BonsaiTypeError
      expect(badLeft).toMatchObject({
        transform: operator,
        expected: 'two numbers',
        received: 'string',
      })

      const badRight = errorOf(() => applyBinaryOp(operator, 7, true)) as BonsaiTypeError
      expect(badRight).toMatchObject({
        transform: operator,
        expected: 'two numbers',
        received: 'boolean',
      })
    },
  )
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

  it.each([
    ['<', ['a', 'b', true], ['b', 'b', false], ['c', 'b', false]],
    ['>', ['a', 'b', false], ['b', 'b', false], ['c', 'b', true]],
    ['<=', ['a', 'b', true], ['b', 'b', true], ['c', 'b', false]],
    ['>=', ['a', 'b', false], ['b', 'b', true], ['c', 'b', true]],
  ] as const)('%s orders strings without number coercion', (op, lt, eq, gt) => {
    for (const [left, right, expected] of [lt, eq, gt]) {
      expect(applyBinaryOp(op, left, right)).toBe(expected)
    }
  })

  it.each(['<', '>', '<=', '>='] as const)(
    '%s rejects mixed and unsupported operands with a stable type error',
    (operator) => {
      for (const [left, right, received] of [
        [false, 1, 'boolean'],
        [1, false, 'boolean'],
        ['1', 2, 'number'],
        [1, '2', 'string'],
      ] as const) {
        const error = errorOf(() => applyBinaryOp(operator, left, right)) as BonsaiTypeError
        expect(error).toMatchObject({
          transform: operator,
          expected: 'two numbers or two strings of the same type',
          received,
        })
      }
    },
  )
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

  it('requires a string search value when the right side is a string', () => {
    for (const operator of ['in', 'not in'] as const) {
      const error = errorOf(() => applyBinaryOp(operator, 1, '123')) as BonsaiTypeError
      expect(error).toMatchObject({
        transform: operator,
        expected: 'a string search value',
        received: 'number',
      })
    }
  })

  it('rejects an unknown binary operator', () => {
    expect(() => applyBinaryOp('&&', true, false)).toThrow('Unknown binary operator: &&')
  })
})

describe('applyUnaryOp', () => {
  it('applies !, -, and +', () => {
    expect(applyUnaryOp('!', true)).toBe(false)
    expect(applyUnaryOp('!', false)).toBe(true)
    expect(applyUnaryOp('-', 5)).toBe(-5)
    expect(applyUnaryOp('+', '42')).toBe(42)
  })

  it('rejects non-numeric negation and unsafe positive coercion', () => {
    const negative = errorOf(() => applyUnaryOp('-', '5')) as BonsaiTypeError
    expect(negative).toMatchObject({ transform: '-', expected: 'a number', received: 'string' })

    const positive = errorOf(() => applyUnaryOp('+', {})) as BonsaiTypeError
    expect(positive).toMatchObject({
      transform: '+',
      expected: 'a string, number, boolean, null, or undefined',
      received: 'object',
    })
  })

  it('rejects an unknown unary operator', () => {
    expect(() => applyUnaryOp('~' as never, 1)).toThrow('Unknown unary operator: ~')
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

  it('rejects non-array iterables instead of invoking host iterator code', () => {
    expect(() => expandSpreadValue(new Set([1, 2, 3]))).toThrow(BonsaiTypeError)
  })

  it('throws a typed iterable error for a non-iterable value', () => {
    const err = errorOf(() => expandSpreadValue(42))
    expect(err).toBeInstanceOf(BonsaiTypeError)
    expect((err as BonsaiTypeError).transform).toBe('spread')
    expect((err as BonsaiTypeError).expected).toBe('an array')
  })

  it('throws the typed iterable error (not a raw TypeError) for null', () => {
    expect(errorOf(() => expandSpreadValue(null))).toBeInstanceOf(BonsaiTypeError)
  })

  it('materializes holes, including trailing holes, without consulting an iterator', () => {
    const sparse = new Array<unknown>(3)
    sparse[0] = 'first'
    let iteratorCalls = 0
    Object.defineProperty(sparse, Symbol.iterator, {
      value() {
        iteratorCalls++
        return [][Symbol.iterator]()
      },
    })

    const spread = expandSpreadValue(sparse)
    expect(spread).toHaveLength(3)
    expect(spread).toEqual(['first', undefined, undefined])
    expect(Object.hasOwn(spread, 1)).toBe(true)
    expect(Object.hasOwn(spread, 2)).toBe(true)
    expect(iteratorCalls).toBe(0)
  })
})

describe('arrayMethodReceiver', () => {
  it('returns ordinary arrays as-is (no per-call copy)', () => {
    const items = [1, 2, 3]
    expect(arrayMethodReceiver(items, 'map', guard())).toBe(items)
  })

  it('copies arrays with a foreign prototype into a plain Array, preserving holes', () => {
    class Sub extends Array<unknown> {}
    const sub = new Sub(3)
    sub[0] = 'a'
    const g = guard({ maxSteps: 100 })
    const copy = arrayMethodReceiver(sub, 'map', g)
    expect(copy).not.toBe(sub)
    expect(Object.getPrototypeOf(copy)).toBe(Array.prototype)
    expect(copy).toHaveLength(3)
    expect(copy[0]).toBe('a')
    expect(Object.hasOwn(copy, 1)).toBe(false)
  })
})

describe('validateMethodArgs - host-code conversion boundaries', () => {
  it.each([
    ['text', 'includes', 'a string argument', 'function'],
    [42, 'toString', 'a number argument', 'function'],
    [[], 'toSorted', '0 arguments', '1'],
    [[], 'concat', 'an array or primitive value', 'function'],
  ] as const)('rejects a host function passed to %s.%s', (receiver, method, expected, received) => {
    const error = errorOf(argsThunk(receiver, method, [() => 1])) as BonsaiTypeError
    expect(error).toMatchObject({
      transform: method,
      expected,
      received,
    })
  })

  it.each(['object', 'symbol', 'bigint'] as const)(
    'rejects a %s argument before a primitive receiver can coerce it',
    (kind) => {
      let value: unknown = {}
      if (kind === 'symbol') value = Symbol('x')
      if (kind === 'bigint') value = 1n
      const error = errorOf(argsThunk('text', 'includes', [value])) as BonsaiTypeError
      expect(error).toMatchObject({
        transform: 'includes',
        expected: 'a string argument',
        received: kind,
      })
    },
  )

  it('enforces the shared signature while only checking coercing array positions', () => {
    expect(argsThunk('text', 'includes', ['x'])).not.toThrow()
    expect(argsThunk('text', 'includes', ['x', 1])).not.toThrow()
    for (const value of [null, undefined, true, 1]) {
      expect(argsThunk('text', 'includes', [value])).toThrow('string argument')
    }
    expect(argsThunk([], 'includes', [{}])).not.toThrow()
    expect(argsThunk([], 'includes', ['x', {}])).toThrow('number argument')
    expect(argsThunk([], 'slice', [{}])).toThrow('number argument')
    expect(argsThunk([], 'join', [{}])).toThrow('string argument')
  })

  it('reports exact arity contracts for fixed and optional signatures', () => {
    // Arity errors report the received COUNT, not the type of the count.
    expect(errorOf(argsThunk('text', 'at', []))).toMatchObject({
      transform: 'at',
      expected: '1 argument',
      received: '0',
    })
    expect(errorOf(argsThunk('text', 'trim', [1]))).toMatchObject({
      transform: 'trim',
      expected: '0 arguments',
      received: '1',
    })
    expect(errorOf(argsThunk('text', 'substring', [0, 1, 2]))).toMatchObject({
      transform: 'substring',
      expected: '0 to 2 arguments',
      received: '3',
    })
    expect(errorOf(argsThunk([], 'with', [0]))).toMatchObject({
      transform: 'with',
      expected: '2 arguments',
      received: '1',
    })
  })

  it('reports exact argument-kind contracts and accepts every data primitive', () => {
    expect(errorOf(argsThunk('text', 'includes', [1]))).toMatchObject({
      transform: 'includes',
      expected: 'a string argument',
      received: 'number',
    })
    expect(errorOf(argsThunk([], 'slice', ['0']))).toMatchObject({
      transform: 'slice',
      expected: 'a number argument',
      received: 'string',
    })
    expect(errorOf(argsThunk([], 'concat', [1n]))).toMatchObject({
      transform: 'concat',
      expected: 'an array or primitive value',
      received: 'bigint',
    })
    for (const value of [null, undefined, 'x', 1, true, [2]]) {
      expect(argsThunk([], 'concat', [value])).not.toThrow()
    }
  })
})

describe('chargeNativeMethod', () => {
  const stepsFor = (receiver: unknown, method: string, args: unknown[] = []): number => {
    const g = guard({ maxSteps: 100 })
    g.beginRun()
    chargeNativeMethod(receiver, method, args, g)
    g.endRun()
    return g.stepsTaken
  }

  it.each([
    'startsWith',
    'endsWith',
    'includes',
    'indexOf',
    'lastIndexOf',
    'slice',
    'substring',
    'repeat',
    'trim',
    'trimStart',
    'trimEnd',
    'toLowerCase',
    'toUpperCase',
    'replace',
    'replaceAll',
    'padStart',
    'padEnd',
    'split',
    'concat',
  ])('charges the linear string method %s by receiver length', (method) => {
    expect(stepsFor('abcd', method)).toBe(4)
  })

  it.each([
    'includes',
    'indexOf',
    'lastIndexOf',
    'slice',
    'concat',
    'join',
    'flat',
    'toReversed',
    'toSorted',
    'toSpliced',
    'with',
  ])('charges the linear array method %s by receiver length', (method) => {
    expect(stepsFor([1, 2, 3], method)).toBe(3)
  })

  it('does not charge constant-time or wrong-family calls', () => {
    expect(stepsFor('abcd', 'at')).toBe(0)
    expect(stepsFor([1, 2, 3], 'map')).toBe(0)
    expect(stepsFor(123, 'slice')).toBe(0)
    expect(stepsFor({}, 'slice')).toBe(0)
  })

  it('charges slice by its normalized span, not the receiver length', () => {
    // slice copies O(span); charging the whole receiver would reject cheap
    // slices of big arrays under tight budgets and re-sample the clock on
    // every call.
    expect(stepsFor([1, 2, 3, 4], 'slice', [0, 2])).toBe(2)
    expect(stepsFor('abcdefgh', 'slice', [1, 4])).toBe(3)
    expect(stepsFor([1, 2, 3, 4], 'slice', [-2])).toBe(2)
    expect(stepsFor([1, 2, 3, 4], 'slice', [0, -1])).toBe(3)
    expect(stepsFor([1, 2, 3, 4], 'slice', [2, 1])).toBe(0)
    expect(stepsFor([1, 2, 3, 4], 'slice', [0, 99])).toBe(4)
    // No arguments still copies everything.
    expect(stepsFor([1, 2, 3, 4], 'slice')).toBe(4)
  })
})

describe('validateMethodArgs - replace family', () => {
  it('rejects function, RegExp, object, and non-string arguments', () => {
    expect(argsThunk('s', 'replace', [() => 1, 'x'])).toThrow('string argument')
    expect(argsThunk('s', 'replace', [/x/u, 'x'])).toThrow('string argument')
    expect(argsThunk('s', 'replace', [{}, 'x'])).toThrow('string argument')
    expect(argsThunk('s', 'replace', [null, 'x'])).toThrow('string argument')
    expect(argsThunk('s', 'replace', ['s', 'x'])).not.toThrow()
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
    expect((err as BonsaiTypeError).expected).toContain('Bonsai lambda callback')
  })

  it('rejects a host callback and accepts a callback created by Bonsai', () => {
    expect(argsThunk([], 'map', [() => 1])).toThrow(BonsaiTypeError)
    expect(argsThunk([], 'map', [createBonsaiLambda(() => 1)])).not.toThrow()
  })
})

describe('validateMethodArgs - array stringification methods', () => {
  it.each(['join', 'toSorted'] as const)(
    '%s accepts primitive elements and sparse holes but rejects host-code values',
    (method) => {
      const sparse: unknown[] = [null, undefined, 'x', 1, true]
      sparse.length = 7
      expect(argsThunk(sparse, method, [])).not.toThrow()

      for (const value of [{}, Symbol('x'), 1n, () => 1]) {
        const error = errorOf(argsThunk([value], method, [])) as BonsaiTypeError
        expect(error).toMatchObject({
          transform: method,
          expected: 'array elements with primitive string representations',
        })
      }
    },
  )

  it('does not inspect array elements for unrelated methods', () => {
    expect(argsThunk([{}], 'slice', [])).not.toThrow()
  })
})

describe('checkResultLimits', () => {
  it('enforces the array ceiling only on arrays', () => {
    const g = guard({ maxArrayLength: 3 })
    expect(() => {
      checkResultLimits([1, 2, 3], g)
    }).not.toThrow()
    expect(() => {
      checkResultLimits([1, 2, 3, 4], g)
    }).toThrow('Array length')
    expect(() => {
      checkResultLimits('not an array', g)
    }).not.toThrow()
  })

  it('enforces the string ceiling only on strings', () => {
    const g = guard({ maxStringLength: 3 })
    expect(() => {
      checkResultLimits('abc', g)
    }).not.toThrow()
    expect(() => {
      checkResultLimits('abcd', g)
    }).toThrow('String length')
    expect(() => {
      checkResultLimits(['not', 'a', 'string'], g)
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

  it('yields undefined for a nullish object rather than throwing', () => {
    expect(accessMember(null, parse('x'), false, undefined, guard())).toBeUndefined()
    expect(accessMember(undefined, parse('x'), false, undefined, guard())).toBeUndefined()
  })

  it('reads own properties only and never traverses the prototype chain', () => {
    const inherited = Object.create({ x: 5 }) as Record<string, unknown>
    let getterCalls = 0
    const ownAccessor = Object.defineProperty({}, 'x', {
      get() {
        getterCalls++
        return 5
      },
    })

    expect(accessMember(inherited, parse('x'), false, undefined, guard())).toBeUndefined()
    expect(accessMember(ownAccessor, parse('x'), false, undefined, guard())).toBe(5)
    expect(getterCalls).toBe(1)
  })

  it('routes the key through the access guard', () => {
    expect(() => accessMember({}, parse('x'), true, '__proto__', guard())).toThrow(
      BonsaiSecurityError,
    )
  })
})
