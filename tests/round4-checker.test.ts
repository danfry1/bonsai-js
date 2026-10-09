import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  bonsai,
  BonsaiRuntimeError,
  forEachChild,
  formatType,
  parse,
  print,
  t,
  type Node,
} from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

/** A tree as JSON without positions, for comparing shapes. */
const shape = (node: Node): string =>
  JSON.stringify(node, (key, value: unknown) =>
    key === 'start' || key === 'end' || key === 'nameStart' || key === 'nameEnd'
      ? undefined
      : value,
  )

/** Every node of a tree, depth first, with its parent. */
function nodes(root: Node): { node: Node; parent: Node | undefined }[] {
  const out: { node: Node; parent: Node | undefined }[] = []
  const visit = (node: Node, parent: Node | undefined): void => {
    out.push({ node, parent })
    forEachChild(node, (child) => {
      visit(child, node)
    })
  }
  visit(root, undefined)
  return out
}

describe('spans are balanced: a parenthesized node includes its parentheses', () => {
  const env = bonsai()

  it('gives explanation text that is whole source', () => {
    const explanation = env.explainSync('!(a == 1)', { a: 1 })
    expect(explanation.trace).toMatchObject({ text: '!(a == 1)', start: 0, end: 9 })
    expect(explanation.trace.children[0]).toMatchObject({ text: '(a == 1)', start: 1, end: 9 })
  })

  it('starts and ends a node at the same parenthesis depth', () => {
    const source = '(a + 1) * 2 > 0'
    const root = env.parse(source)
    expect(source.slice(root.start, root.end)).toBe(source)
    expect(root.type === 'Binary' && source.slice(root.left.start, root.left.end)).toBe(
      '(a + 1) * 2',
    )
  })

  it('points runtime errors and check errors at balanced source', () => {
    let error: unknown
    try {
      env.evaluateSync('(a + 1) / (b - 1)', { a: 1, b: 1 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(BonsaiRuntimeError)
    expect((error as BonsaiRuntimeError).span).toEqual({ start: 0, end: 17 })

    const typed = bonsai({ variables: { a: t.number(), s: t.string() } })
    const [diagnostic] = typed.check('(a + 1) * 2 + (s)').diagnostics
    expect(diagnostic?.span).toEqual({ start: 0, end: 17 })
    expect(diagnostic?.formatted).toContain('^^^^^^^^^^^^^^^^^')
  })

  it('keeps hover and printing working on parenthesized source', () => {
    const typed = bonsai({ variables: { a: t.number() } })
    const service = createLanguageService(typed)
    expect(service.hover('(a + 1) * 2', 1)?.detail).toBe('number')
    expect(service.hover('(a + 1) * 2', 0)).toMatchObject({ start: 0, end: 7 })
    expect(print(parse('((a)) + (b * c)'))).toBe('a + b * c')
  })

  const atom = fc.constantFrom('a', 'b', '1', '2.5', '"x"', 'true', 'null', 'xs', 'm')
  const source: fc.Arbitrary<string> = fc.letrec<{ expr: string }>((tie) => ({
    expr: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      atom,
      fc
        .tuple(
          tie('expr'),
          fc.constantFrom('+', '-', '*', '==', '<', '&&', '||', '??', 'in'),
          tie('expr'),
        )
        .map(([left, op, right]) => `${left} ${op} ${right}`),
      tie('expr').map((inner) => `(${inner})`),
      tie('expr').map((inner) => `((${inner}))`),
      tie('expr').map((inner) => `!${inner}`),
      tie('expr').map((inner) => `-${inner}`),
      tie('expr').map((inner) => `${inner}.k`),
      tie('expr').map((inner) => `${inner}[0]`),
      tie('expr').map((inner) => `abs(${inner})`),
      tie('expr').map((inner) => `[${inner}, 1]`),
      tie('expr').map((inner) => `{ k: ${inner} }`),
      tie('expr').map((inner) => `\`t\${${inner}}\``),
      fc
        .tuple(tie('expr'), tie('expr'), tie('expr'))
        .map(([test, then, otherwise]) => `${test} ? ${then} : ${otherwise}`),
    ),
  })).expr

  it('slices every node to source that parses to the same tree, nested in its parent', () => {
    fc.assert(
      fc.property(source, (text) => {
        let root: Node
        try {
          root = parse(text)
        } catch {
          fc.pre(false)
          return true
        }
        for (const { node, parent } of nodes(root)) {
          expect(shape(parse(text.slice(node.start, node.end)))).toBe(shape(node))
          if (parent !== undefined) {
            expect(node.start).toBeGreaterThanOrEqual(parent.start)
            expect(node.end).toBeLessThanOrEqual(parent.end)
          }
        }
        return true
      }),
      { numRuns: 1500 },
    )
  })
})

describe('a map literal type follows what it holds', () => {
  const env = bonsai({
    variables: {
      s: t.string(),
      b: t.boolean(),
      rec: t.record(t.number()),
      um: t.union(t.object({ a: t.number(), b: t.string() }), t.record(t.number())),
      o1: t.object({ a: t.number(), b: t.string() }),
      opt: t.object({ a: t.number(), b: t.optional(t.string()) }),
      nrec: t.optional(t.record(t.number())),
    },
  })
  const typeOf = (source: string): string => {
    const result = env.check(source)
    return result.ok ? formatType(result.type) : `error: ${result.diagnostics[0]?.code}`
  }

  it('lets a later computed key overwrite an earlier field', () => {
    expect(typeOf('{a: "x", [s]: 1}.a')).toBe('string | number')
    expect(typeOf('{a: "x", [s]: 1}.a.length')).toBe('error: TYPE_ERROR')
    expect(env.check('{a: "x", [s]: 1}', { expect: t.object({ a: t.string() }) }).ok).toBe(false)
    // A constant computed key is a static one.
    expect(typeOf('{a: 2.5, ["a"]: b}["a"]')).toBe('boolean')
    expect(typeOf('{a: 2.5, ["a"]: b}["a"] + 1')).toBe('error: TYPE_ERROR')
  })

  it('reads a key that only a record member may hold as possibly null', () => {
    expect(typeOf('{...(b ? rec : {b: 2})}.b')).toBe('number | null')
    expect(typeOf('{...(b ? rec : {b: 2})}.b + 1')).toBe('error: TYPE_ERROR')
    expect(typeOf('{...um}.a + 1')).toBe('error: TYPE_ERROR')
    expect(typeOf('{...(b ? {[s]: 2} : {k: 1})}.k.toFixed(1)')).toBe('error: NULLABLE_RECEIVER')
    expect(env.check('{...(b ? rec : {b: 2})}', { expect: t.object({ b: t.number() }) }).ok).toBe(
      false,
    )
  })

  it('keeps any other key of a spread declared object, which may carry extra keys', () => {
    expect(typeOf('{...o1, ...rec}.extra')).toBe('any | null')
    expect(typeOf('{...o1, ...rec}')).toBe('{ a: number, b: string | number, [key: string]: any }')
    const spread = bonsai({
      variables: { o1: t.object({ a: t.number(), b: t.string() }), rec: t.record(t.number()) },
    })
    const o1 = { a: 1, b: 'x', extra: { a: 4 } }
    expect(spread.evaluateSync('{...o1, ...rec}', { o1, rec: {} })).toEqual({
      a: 1,
      b: 'x',
      extra: { a: 4 },
    })
  })

  it('keeps an earlier value where a spread optional field may be absent', () => {
    expect(typeOf('{b: [1], ...opt}.b')).toBe('number[] | string | null')
    expect(typeOf('{[s]: true, ...opt}.b')).toBe('boolean | string | null')
    expect(typeOf('{[s]: true, ...nrec}.z')).toBe('boolean | number | null')
  })
})

describe('the language service agrees with check()', () => {
  const env = bonsai({
    variables: { user: t.object({ name: t.string(), age: t.number() }), s: t.string() },
  })
  const service = createLanguageService(env)
  const properties = (source: string, offset = source.length): string[] =>
    service
      .complete(source, offset)
      .items.filter((item) => item.kind === 'property')
      .map((item) => item.label)

  it("completes members inside try()'s first argument and a computed key", () => {
    expect(properties('try(user.')).toEqual(['age', 'name'])
    expect(properties('try(user.name, s)', 13)).toEqual(['name'])
    expect(properties('{[user.')).toEqual(['age', 'name'])
  })

  it('gives completion details that match the type a read has', () => {
    const union = bonsai({
      variables: {
        b: t.boolean(),
        s: t.string(),
        shape: t.union(
          t.object({ kind: t.literal('c'), r: t.number() }),
          t.object({ kind: t.literal('q'), side: t.number() }),
        ),
      },
    })
    const unionService = createLanguageService(union)
    const detail = (source: string, label: string): string | undefined =>
      unionService.complete(source, source.length).items.find((item) => item.label === label)
        ?.detail
    expect(detail('(b ? {[s]: 2} : {b: 2}).', 'b')).toBe('number | null')
    const read = union.check('shape.r').type ?? t.never()
    expect(detail('shape.', 'r')).toBe(formatType(read))
    expect(formatType(read)).toBe('any')
  })

  it('rejects a negative or fractional offset', () => {
    expect(() => service.complete('user.', -1)).toThrow(RangeError)
    expect(() => service.hover('user', 1.5)).toThrow(RangeError)
    expect(service.complete('user.', 99).items.length).toBeGreaterThan(0)
  })

  it('checks an expected type when given one', () => {
    const filters = createLanguageService(env, { expect: t.boolean() })
    expect(filters.diagnostics('user.age').map((d) => d.code)).toEqual(['EXPECTED_TYPE'])
    expect(filters.diagnostics('user.age > 1')).toEqual([])
    expect(service.diagnostics('user.age')).toEqual([])
    expect(() => createLanguageService(env, { expect: 'boolean' } as never)).toThrow(TypeError)
    expect(() => createLanguageService(env, { expected: t.boolean() } as never)).toThrow(
      /Unknown language service option key "expected"/u,
    )
  })
})

describe('print keeps the shape of logical runs', () => {
  it('keeps the parentheses of a right-nested run', () => {
    for (const source of ['a ?? (b ?? c)', 'a && (b && c)', 'a || (b || c)']) {
      const printed = print(parse(source))
      expect(printed).toBe(source)
      expect(shape(parse(printed))).toBe(shape(parse(source)))
    }
  })

  it('prints a run as written when the parser builds it', () => {
    for (const source of ['a && b && c && d', 'a || b || c', 'a ?? b ?? c ?? d ?? e']) {
      expect(print(parse(source))).toBe(source)
    }
    const nested = 'a && b && (c && d) && e'
    expect(shape(parse(print(parse(nested))))).toBe(shape(parse(nested)))
  })
})

describe('warnings stay quiet on idiomatic code', () => {
  const env = bonsai({
    variables: { users: t.list(t.object({ age: t.optional(t.number()) })), n: t.number() },
  })
  const codes = (source: string): string[] => env.check(source).diagnostics.map((d) => d.code)

  it('does not warn on an ordering that may see null', () => {
    expect(codes('users.filter(.age >= 18)')).toEqual([])
    expect(codes('users[0].age > n')).toEqual([])
  })

  it('does not warn on a large literal written with an exponent', () => {
    expect(codes('n < 1e308')).toEqual([])
    expect(codes('n < 9007199254740993')).toEqual(['UNSAFE_INTEGER'])
    expect(codes('n < 0x20000000000001')).toEqual(['UNSAFE_INTEGER'])
  })
})
