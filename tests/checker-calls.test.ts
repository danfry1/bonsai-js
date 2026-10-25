import { describe, expect, it } from 'vitest'
import { bonsai, formatType, t } from '../src/index.js'

// What checking a call reports: its code, severity, message, and the range it
// underlines, and how a call's lambda refines and checks what it returns.

const user = t.object({
  name: t.string(),
  email: t.optional(t.string()),
  flag: t.optional(t.boolean()),
  tags: t.list(t.string()),
})
const env = bonsai({ variables: { n: t.number(), ns: t.list(t.number()), users: t.list(user) } })

const problems = (source: string, on = env) =>
  on.check(source).diagnostics.map((d) => [d.code, d.severity, d.message, d.start, d.end])

const typeOf = (source: string): string => {
  const { type } = env.check(source)
  if (type === undefined) throw new Error('expected the source to parse')
  return formatType(type)
}

describe('a JavaScript global', () => {
  const hint =
    'There is no Math object; call the function directly, e.g. max(a, b), round(x), abs(x)'

  it('is an error where variables are declared, and a warning in an open environment', () => {
    expect(problems('Math.max(1, 2)')).toEqual([['UNKNOWN_VARIABLE', 'error', hint, 0, 4]])
    expect(problems('Math.max(1, 2)', bonsai())).toEqual([
      ['UNKNOWN_VARIABLE', 'warning', hint, 0, 4],
    ])
  })
})

describe('an unknown function', () => {
  it('is underlined by its name, and its lambdas are still checked', () => {
    const unknown = 'Unknown function "foo"; did you mean "floor"?'
    expect(problems('foo(1, 2)')).toEqual([['UNKNOWN_FUNCTION', 'error', unknown, 0, 3]])
    expect(problems('n.foo()')).toEqual([['UNKNOWN_FUNCTION', 'error', unknown, 2, 5]])
    expect(problems('foo(x => zz)')).toEqual([
      ['UNKNOWN_FUNCTION', 'error', unknown, 0, 3],
      ['UNKNOWN_VARIABLE', 'error', 'Unknown variable "zz"; did you mean "n"?', 9, 11],
    ])
  })
})

describe('spread arguments', () => {
  it('must be lists, and cannot fill a lambda parameter', () => {
    expect(problems('max(...n)')).toEqual([
      ['TYPE_ERROR', 'error', 'Only a list can be spread into arguments, not number', 4, 8],
    ])
    expect(problems('ns.map(...ns)')[0]).toEqual([
      'INVALID_LAMBDA',
      'error',
      'Spread arguments cannot be used with map(), which takes a lambda',
      0,
      13,
    ])
  })
})

describe('a lambda', () => {
  it('must return what the function needs, and may-be-null is a warning', () => {
    expect(problems('ns.filter(x => x + 1)')).toEqual([
      [
        'TYPE_ERROR',
        'error',
        'The lambda for filter() must return boolean but returns number',
        15,
        20,
      ],
    ])
    expect(problems('users.filter(.flag)')).toEqual([
      [
        'MAYBE_NULL',
        'warning',
        'The lambda for filter() must return boolean but returns boolean | null',
        13,
        18,
      ],
    ])
  })

  it('narrows what it filtered on, by . or by name', () => {
    expect(typeOf('users.filter(.email != null).map(.email.length)')).toBe('number[]')
    expect(typeOf('users.filter(u => u.email != null).map(u => u.email.length)')).toBe('number[]')
    expect(typeOf('users.map(.email.length)')).toBe('(number | null)[]')
    expect(typeOf('users.filter(.flag)')).toBe(
      '{ name: string, email: string | null, flag: boolean, tags: string[] }[]',
    )
  })
})

describe('narrowing by find, and only by the item', () => {
  const people = bonsai({
    variables: {
      users: t.list(t.object({ name: t.string(), email: t.optional(t.string()) })),
      maybe: t.optional(t.string()),
    },
  })
  const typeIn = (source: string): string => {
    const { type } = people.check(source)
    if (type === undefined) throw new Error('expected the source to parse')
    return formatType(type)
  }

  it('narrows what find matched', () => {
    expect(typeIn('users.find(.email != null)')).toBe('{ name: string, email: string } | null')
    expect(typeIn('users.find(u => u.email != null)?.email.length')).toBe('number | null')
  })

  it('does not narrow the items by a condition on something else', () => {
    expect(typeIn('users.filter(u => maybe != null)')).toBe(
      '{ name: string, email: string | null }[]',
    )
  })
})

describe('overloads the arguments do not decide', () => {
  const open = bonsai()
  interface Checks {
    check: (source: string) => { readonly type?: Parameters<typeof formatType>[0] | undefined }
  }
  const typeIn = (source: string, on: Checks): string => {
    const { type } = on.check(source)
    if (type === undefined) throw new Error('expected the source to parse')
    return formatType(type)
  }

  it('give an unknown result, unless every candidate agrees', () => {
    expect(typeIn('abs(x)', open)).toBe('any')
    expect(typeIn('x.slice(1)', open)).toBe('any')
    expect(typeIn('x.includes(1)', open)).toBe('boolean')
    const mixed = bonsai({ variables: { sl: t.union(t.string(), t.list(t.number())) } })
    expect(typeIn('sl.slice(1)', mixed)).toBe('string | number[]')
  })
})

describe('call-specific checks', () => {
  it('warn when includes can never be true', () => {
    expect(problems('ns.includes("a")')).toEqual([
      ['ALWAYS_FALSE', 'warning', '"a" can never be in number[]', 0, 16],
    ])
    expect(problems('users.some(.tags.includes(1))')).toEqual([
      ['ALWAYS_FALSE', 'warning', '1 can never be in string[]', 11, 28],
    ])
  })

  it('refuse ordering by a value that has no order', () => {
    expect(problems('users.sortBy(.tags)')).toEqual([
      [
        'TYPE_ERROR',
        'error',
        'sortBy() can only order numbers, text, timestamps, or durations (one kind at a time), not string[]',
        0,
        19,
      ],
    ])
  })
})
