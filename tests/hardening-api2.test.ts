import { describe, expect, it } from 'vitest'
import { bonsai, print, t, type EvaluateOptions, type Node } from '../src/index.js'

describe('per-evaluation options are validated like limits', () => {
  const env = bonsai()
  const program = env.compile('1 + 1')

  it.each([
    [{ maxSteps: -1 }, RangeError],
    [{ maxSteps: Number.NaN }, RangeError],
    [{ maxSteps: Number.POSITIVE_INFINITY }, RangeError],
    [{ maxSteps: 1.5 }, RangeError],
    [{ maxSteps: '10' }, TypeError],
    [{ timeout: -1 }, RangeError],
    [{ timeout: 'x' }, TypeError],
    [{ signal: {} }, TypeError],
    [{ signal: 'x' }, TypeError],
    [{ maxstep: 1 }, TypeError],
    [null, TypeError],
  ])('%j throws', (options, error) => {
    expect(() => program.evaluateSync({}, options as EvaluateOptions)).toThrow(error)
    expect(() => env.evaluateSync('1', {}, options as EvaluateOptions)).toThrow(error)
  })

  it('rejects the same options in async evaluation', async () => {
    await expect(program.evaluate({}, { maxSteps: -1 })).rejects.toThrow(RangeError)
  })

  it('never fails open: a small budget still applies', () => {
    const loop = env.compile('[1, 2, 3, 4, 5].map(. * 2).sum()')
    expect(() => loop.evaluateSync({}, { maxSteps: 3 })).toThrow(
      expect.objectContaining({ code: 'STEP_LIMIT' }),
    )
    expect(loop.evaluateSync({}, { maxSteps: 0 })).toBe(30)
    expect(loop.evaluateSync({}, { maxSteps: undefined, timeout: undefined })).toBe(30)
  })

  it('accepts a real AbortSignal', () => {
    const controller = new AbortController()
    expect(program.evaluateSync({}, { signal: controller.signal })).toBe(2)
    controller.abort()
    expect(() => program.evaluateSync({}, { signal: controller.signal })).toThrow(
      expect.objectContaining({ code: 'ABORTED' }),
    )
  })
})

describe('variables', () => {
  it('declaring variables, even none, makes the environment strict', () => {
    const env = bonsai({ variables: {} })
    expect(env.strict).toBe(true)
    expect(env.check('user').ok).toBe(false)
  })

  it.each(['null', 'true', 'let', 'in', 'not', '__proto__', 'constructor', 'prototype', 'a b', ''])(
    'rejects the variable name %j',
    (name) => {
      expect(() => bonsai({ variables: { [name]: t.number() } })).toThrow(TypeError)
    },
  )

  it('rejects a variable declared twice across libraries and variables', () => {
    const library = { name: 'geo', variables: { region: t.string() } }
    expect(() => bonsai({ libraries: [library], variables: { region: t.string() } })).toThrow(
      /declared by both library "geo" and the variables option/u,
    )
    expect(() =>
      bonsai({ libraries: [library, { name: 'other', variables: { region: t.string() } }] }),
    ).toThrow(TypeError)
  })

  it('rejects a library listed twice', () => {
    const library = { name: 'geo', variables: { region: t.string() } }
    expect(() => bonsai({ libraries: [library, { name: 'geo' }] })).toThrow(/listed twice/u)
  })
})

describe('an open environment accepts any object as context', () => {
  interface AppContext {
    user: { id: string }
  }

  it('accepts values typed by an interface', () => {
    const context: AppContext = { user: { id: 'u1' } }
    expect(bonsai().evaluateSync('user.id', context)).toBe('u1')
    expect(bonsai().compile('user.id').evaluateSync(context)).toBe('u1')
  })
})

describe('print() rejects trees that would not reparse to the same tree', () => {
  const at = { start: 0, end: 0 }
  const lit = (value: number): Node => ({ type: 'Literal', value, ...at })
  const variable = (name: string): Node => ({ type: 'Variable', name, ...at })

  it.each<[string, unknown]>([
    ['a reserved word as a variable', variable('null')],
    ['an invalid identifier', variable('a b')],
    ['a blocked name', variable('__proto__')],
    [
      'an unknown binary operator',
      { type: 'Binary', operator: '===', left: lit(1), right: lit(1), ...at },
    ],
    ['an unknown unary operator', { type: 'Unary', operator: '~', operand: lit(1), ...at }],
    [
      'a blocked member',
      { type: 'Member', name: 'constructor', optional: false, object: variable('x'), ...at },
    ],
    [
      'a blocked map key',
      { type: 'Map', entries: [{ type: 'Entry', key: '__proto__', value: lit(1), ...at }], ...at },
    ],
    ['an unknown node type', { type: 'Nope', ...at }],
    [
      'a call named like syntax',
      {
        type: 'Call',
        name: 'has',
        args: [],
        style: 'function',
        optional: false,
        nameStart: 0,
        nameEnd: 0,
        ...at,
      },
    ],
    ['an unbound local', { type: 'Local', name: 'x', ...at }],
    [
      'a variable shadowed by a let',
      { type: 'Let', name: 'x', value: lit(1), body: variable('x'), ...at },
    ],
    [
      'a lambda outside a call',
      { type: 'Lambda', params: ['x'], implicit: false, body: lit(1), ...at },
    ],
    ['a non-finite number', { type: 'Literal', value: Number.NaN, ...at }],
  ])('%s', (_, tree) => {
    expect(() => print(tree as Node)).toThrow(TypeError)
  })

  it('prints parsed and compiled trees unchanged', () => {
    const env = bonsai({
      variables: { users: t.list(t.object({ age: t.number(), name: t.string() })) },
    })
    for (const source of [
      'users.filter(.age >= 18).map(.name)',
      'let a = 1; users.map(u => u.age + a)',
      'users.map({ n: .name, [.name]: .age })',
    ]) {
      expect(print(env.parse(source))).toBe(source)
      expect(print(env.compile(source).ast)).toBe(source)
    }
  })

  it('rejects an unknown call style option', () => {
    expect(() => print(variable('x'), { calls: 'loud' as never })).toThrow(TypeError)
  })
})
