import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  bonsai,
  forEachChild,
  formatType,
  mapChildren,
  print,
  t,
  type BonsaiCheckError,
  type MemberNode,
  type Node,
} from '../src/index.js'
import { createLanguageService } from '../src/service/index.js'

const env = bonsai({
  variables: { user: t.object({ name: t.string(), age: t.number() }), items: t.list(t.number()) },
})

/** Every node of a tree, depth first. */
function nodes(root: Node): Node[] {
  const out: Node[] = [root]
  forEachChild(root, (child) => {
    out.push(...nodes(child))
  })
  return out
}

describe('diagnostics locate themselves like errors do', () => {
  const source = 'user.age > 1 &&\n  usr.name == "x"'

  it('carry a span, a 1-based position, and a code frame', () => {
    const [d] = env.check(source).diagnostics
    expect(d).toMatchObject({
      code: 'UNKNOWN_VARIABLE',
      span: { start: 18, end: 21 },
      position: { line: 2, column: 3 },
    })
    expect(d?.start).toBe(d?.span.start)
    expect(d?.formatted).toBe(
      'Unknown variable "usr"; did you mean "user"?\n2 |   usr.name == "x"\n  |   ^^^',
    )
  })

  it('keep the code frame out of the JSON form', () => {
    const json = JSON.parse(JSON.stringify(env.check(source).diagnostics[0])) as object
    expect(Object.keys(json).sort()).toEqual(
      ['code', 'end', 'message', 'position', 'severity', 'span', 'start', 'suggestion'].sort(),
    )
  })

  it('are located everywhere diagnostics appear', () => {
    let thrown: BonsaiCheckError | undefined
    try {
      env.compile(source)
    } catch (error) {
      thrown = error as BonsaiCheckError
    }
    expect(thrown?.diagnostics[0]?.position).toEqual({ line: 2, column: 3 })

    const warned = env.compile('user.age == "x" || true')
    expect(warned.warnings[0]?.position).toEqual({ line: 1, column: 1 })

    const syntax = env.check('user.age >\n  )')
    expect(syntax.diagnostics[0]).toMatchObject({ code: 'SYNTAX', position: { line: 2 } })

    const service = createLanguageService(env).diagnostics('items.map(.x')
    expect(service[0]?.formatted).toContain('items.map(.x')
  })

  it('locate thousands of findings in one pass over the source', () => {
    const many = `[${Array.from({ length: 3000 }, (_, i) => `usr${i}`).join(',\n')}]`
    const started = performance.now()
    const found = env.check(many).diagnostics
    expect(found).toHaveLength(3000)
    expect(found[2999]?.position.line).toBe(3000)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('diagnostics name the suggested replacement', () => {
  it('for unknown variables, properties, and functions', () => {
    const suggestion = (source: string) => env.check(source).diagnostics[0]?.suggestion
    expect(suggestion('usr.age')).toBe('user')
    expect(suggestion('user.agee')).toBe('age')
    expect(suggestion('user.name.toUppercase()')).toBe('toUpperCase')
    expect(suggestion('items.contains(1)')).toBe('includes')
  })

  it('and leave the field out when there is none', () => {
    const [d] = env.check('zzzzzzzz').diagnostics
    expect(d?.code).toBe('UNKNOWN_VARIABLE')
    expect(d !== undefined && 'suggestion' in d).toBe(false)
  })
})

describe('check() returns what an editor needs in one call', () => {
  it('compiles the checked expression on request', () => {
    const result = env.check('user.age >= 18', { expect: t.boolean() })
    if (!result.ok) throw new Error('expected ok')
    expect(result.program.evaluateSync({ user: { name: 'a', age: 30 }, items: [] })).toBe(true)
    expectTypeOf(result.program.evaluateSync).returns.toEqualTypeOf<boolean>()
    expect(result.program).toBe(result.program)
    expect(result.program.ast).toBe(result.ast)
  })

  it('has no program when checking failed', () => {
    const result = env.check('usr.age')
    expect(result.ok).toBe(false)
    expect('program' in result).toBe(false)
  })

  it('keeps its JSON form to ok, type, and diagnostics', () => {
    expect(Object.keys(JSON.parse(JSON.stringify(env.check('user.age'))) as object)).toEqual([
      'ok',
      'type',
      'diagnostics',
    ])
  })

  it('types any node of the checked tree', () => {
    const source = 'items.map(. * 2).sum() > user.age'
    const result = env.check(source)
    const ast = result.ast as Node
    const types = nodes(ast).map((node) => [
      source.slice(node.start, node.end),
      formatType(result.typeOf(node) as never),
    ])
    expect(types).toContainEqual(['user.age', 'number'])
    expect(types).toContainEqual(['items.map(. * 2)', 'number[]'])
    expect(types).toContainEqual([source, 'boolean'])
    expect(result.typeOf(env.parse('user.age'))).toBeUndefined()
    expect(Object.isFrozen(ast)).toBe(true)
  })

  it('still types the tree when checking reports errors', () => {
    const result = env.check('user.agee + user.age')
    expect(result.ok).toBe(false)
    const member = nodes(result.ast as Node).find(
      (node): node is MemberNode => node.type === 'Member' && node.name === 'age',
    ) as Node
    expect(formatType(result.typeOf(member) as never)).toBe('number')
  })

  it('has no tree when the source does not parse', () => {
    const result = env.check('user.')
    expect(result.ast).toBeUndefined()
    expect(result.typeOf(env.parse('1'))).toBeUndefined()
  })
})

describe('member nodes record the span of their name', () => {
  it('after . and ?., across whitespace, and inside implicit lambdas', () => {
    for (const source of ['user.name', 'user?.name', 'user .  name', 'items.map(.name)']) {
      const member = nodes(env.parse(source)).find((n) => n.type === 'Member') as MemberNode
      expect(source.slice(member.nameStart, member.nameEnd), source).toBe('name')
    }
  })

  it('lets a rename edit the source in place, keeping comments', () => {
    const source = 'user.name // the display name\n  .toUpperCase()'
    const member = nodes(env.parse(source)).find((n) => n.type === 'Member') as MemberNode
    const edited = `${source.slice(0, member.nameStart)}fullName${source.slice(member.nameEnd)}`
    expect(edited).toBe('user.fullName // the display name\n  .toUpperCase()')
  })

  it('are optional for trees built by hand', () => {
    const hand: MemberNode = {
      type: 'Member',
      object: { type: 'Variable', name: 'user', start: 0, end: 0 },
      name: 'age',
      optional: false,
      start: 0,
      end: 0,
    }
    expect(print(hand)).toBe('user.age')
  })
})

describe('mapChildren', () => {
  it('rewrites a tree without mutating it', () => {
    const tree = env.parse('user.age > 1 && items.some(. > user.age)')
    const rename = (node: Node): Node => {
      const mapped = mapChildren(node, rename)
      return mapped.type === 'Member' && mapped.name === 'age'
        ? { ...mapped, name: 'years' }
        : mapped
    }
    expect(print(rename(tree))).toBe('user.years > 1 && items.some(. > user.years)')
    expect(print(tree)).toBe('user.age > 1 && items.some(. > user.age)')
  })
})
