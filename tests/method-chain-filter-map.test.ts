import { describe, it, expect } from 'vitest'
import { bonsai } from '../src/index.js'
import { arrays } from '../src/stdlib/index.js'

describe('JS-style .filter().map() with lambdas (sync)', () => {
  const expr = bonsai()

  it('users.filter(.age >= 18)', () => {
    const result = expr.evaluateSync('users.filter(.age >= 18)', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }]
    })
    expect(result).toEqual([{ name: 'Alice', age: 25 }])
  })

  it('users.filter(.age >= 18).map(.name)', () => {
    const result = expr.evaluateSync('users.filter(.age >= 18).map(.name)', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }]
    })
    expect(result).toEqual(['Alice'])
  })

  it('[1,2,3,4].filter(. > 2)', () => {
    expect(expr.evaluateSync('[1,2,3,4].filter(. > 2)')).toEqual([3, 4])
  })

  it('[1,2,3,4].map(. * 2)', () => {
    expect(expr.evaluateSync('[1,2,3,4].map(. * 2)')).toEqual([2, 4, 6, 8])
  })

  it('[1,2,3].some(. > 2)', () => {
    expect(expr.evaluateSync('[1,2,3].some(. > 2)')).toBe(true)
  })

  it('[1,2,3].some(. > 10)', () => {
    expect(expr.evaluateSync('[1,2,3].some(. > 10)')).toBe(false)
  })

  it('[1,2,3].every(. > 0)', () => {
    expect(expr.evaluateSync('[1,2,3].every(. > 0)')).toBe(true)
  })

  it('[1,2,3].every(. > 1)', () => {
    expect(expr.evaluateSync('[1,2,3].every(. > 1)')).toBe(false)
  })

  it('[1,2,3].find(. > 1)', () => {
    expect(expr.evaluateSync('[1,2,3].find(. > 1)')).toBe(2)
  })

  it('[1,2,3].find(. > 10) returns undefined', () => {
    expect(expr.evaluateSync('[1,2,3].find(. > 10)')).toBe(undefined)
  })

  it('empty array: [].filter(. > 0)', () => {
    expect(expr.evaluateSync('[].filter(. > 0)')).toEqual([])
  })

  it('chained: users.filter(.name.startsWith("A"))', () => {
    const result = expr.evaluateSync('users.filter(.name.startsWith("A"))', {
      users: [{ name: 'Alice' }, { name: 'Bob' }]
    })
    expect(result).toEqual([{ name: 'Alice' }])
  })

  it('triple chain: arr.filter(. > 1).map(. * 10).filter(. < 40)', () => {
    expect(expr.evaluateSync('[1,2,3,4].filter(. > 1).map(. * 10).filter(. < 40)'))
      .toEqual([20, 30])
  })

  it('[].every(. > 0) returns true (vacuous truth)', () => {
    expect(expr.evaluateSync('[].every(. > 0)')).toBe(true)
  })

  it('[].some(. > 0) returns false', () => {
    expect(expr.evaluateSync('[].some(. > 0)')).toBe(false)
  })

  it('[].find(. > 0) returns undefined', () => {
    expect(expr.evaluateSync('[].find(. > 0)')).toBe(undefined)
  })

  it('nested lambda method: users.find(.name.startsWith("B"))', () => {
    const result = expr.evaluateSync('users.find(.name.startsWith("B"))', {
      users: [{ name: 'Alice' }, { name: 'Bob' }]
    })
    expect(result).toEqual({ name: 'Bob' })
  })

  it('users.some(.age >= 18)', () => {
    expect(expr.evaluateSync('users.some(.age >= 18)', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }]
    })).toBe(true)
  })

  it('users.every(.age >= 18)', () => {
    expect(expr.evaluateSync('users.every(.age >= 18)', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }]
    })).toBe(false)
  })

  it('identity lambda with nullish coalescing: . ?? "default"', () => {
    const expr2 = bonsai().use(arrays)
    expect(expr2.evaluateSync('[null, 1, null, 2] |> filter(. ?? false)')).toEqual([1, 2])
  })
})

describe('native array methods (non-callback)', () => {
  const expr = bonsai()

  it('[1,2,3].join(", ")', () => {
    expect(expr.evaluateSync('[1,2,3].join(", ")')).toBe('1, 2, 3')
  })

  it('chained: users.filter(.age >= 18).map(.name).join(", ")', () => {
    expect(expr.evaluateSync('users.filter(.age >= 18).map(.name).join(", ")', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }, { name: 'Carol', age: 30 }]
    })).toBe('Alice, Carol')
  })

  it('[[1,2],[3,4]].flat()', () => {
    expect(expr.evaluateSync('[[1,2],[3,4]].flat()')).toEqual([1, 2, 3, 4])
  })

  it('[1,2,3].concat([4,5])', () => {
    expect(expr.evaluateSync('[1,2,3].concat([4,5])')).toEqual([1, 2, 3, 4, 5])
  })

  it('[1,2,3,2].lastIndexOf(2)', () => {
    expect(expr.evaluateSync('[1,2,3,2].lastIndexOf(2)')).toBe(3)
  })

  it('[1,2,3,4].findIndex(. > 2)', () => {
    expect(expr.evaluateSync('[1,2,3,4].findIndex(. > 2)')).toBe(2)
  })

  it('[[1,2],[3]].flatMap(. * 2) — not useful but should not crash', () => {
    expect(expr.evaluateSync('[1,2,3].flatMap(. * 2)')).toEqual([2, 4, 6])
  })

  it('[3,1,2].toReversed()', () => {
    expect(expr.evaluateSync('[3,1,2].toReversed()')).toEqual([2, 1, 3])
  })

  it('[3,1,2].toSorted()', () => {
    expect(expr.evaluateSync('[3,1,2].toSorted()')).toEqual([1, 2, 3])
  })

  it('[1,2,3].with(1, 99)', () => {
    expect(expr.evaluateSync('[1,2,3].with(1, 99)')).toEqual([1, 99, 3])
  })

  it('toReversed does not mutate original', () => {
    const ctx = { arr: [1, 2, 3] }
    expr.evaluateSync('arr.toReversed()', ctx)
    expect(ctx.arr).toEqual([1, 2, 3])
  })

  it('toSorted does not mutate original', () => {
    const ctx = { arr: [3, 1, 2] }
    expr.evaluateSync('arr.toSorted()', ctx)
    expect(ctx.arr).toEqual([3, 1, 2])
  })
})

describe('native string methods', () => {
  const expr = bonsai()

  it('"  hello  ".trim()', () => {
    expect(expr.evaluateSync('"  hello  ".trim()')).toBe('hello')
  })

  it('"Hello".toLowerCase()', () => {
    expect(expr.evaluateSync('"Hello".toLowerCase()')).toBe('hello')
  })

  it('"hello".toUpperCase()', () => {
    expect(expr.evaluateSync('"hello".toUpperCase()')).toBe('HELLO')
  })

  it('"hello world".split(" ")', () => {
    expect(expr.evaluateSync('"hello world".split(" ")')).toEqual(['hello', 'world'])
  })

  it('"5".padStart(3, "0")', () => {
    expect(expr.evaluateSync('"5".padStart(3, "0")')).toBe('005')
  })

  it('"5".padEnd(3, "0")', () => {
    expect(expr.evaluateSync('"5".padEnd(3, "0")')).toBe('500')
  })

  it('"hello".concat(" world")', () => {
    expect(expr.evaluateSync('"hello".concat(" world")')).toBe('hello world')
  })

  it('"hello world".lastIndexOf("o")', () => {
    expect(expr.evaluateSync('"hello world".lastIndexOf("o")')).toBe(7)
  })
})

describe('mutating methods are blocked', () => {
  const expr = bonsai()

  it('arr.reverse() is blocked', () => {
    expect(() => expr.evaluateSync('[1,2,3].reverse()')).toThrow()
  })

  it('arr.sort() is blocked', () => {
    expect(() => expr.evaluateSync('[1,2,3].sort()')).toThrow()
  })

  it('arr.push() is blocked', () => {
    expect(() => expr.evaluateSync('[1,2,3].push(4)')).toThrow()
  })

  it('arr.pop() is blocked', () => {
    expect(() => expr.evaluateSync('[1,2,3].pop()')).toThrow()
  })

  it('arr.splice() is blocked', () => {
    expect(() => expr.evaluateSync('[1,2,3].splice(0,1)')).toThrow()
  })
})

describe('JS-style .filter().map() with lambdas (async)', () => {
  const expr = bonsai()

  it('users.filter(.age >= 18) async', async () => {
    const result = await expr.evaluate('users.filter(.age >= 18)', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }]
    })
    expect(result).toEqual([{ name: 'Alice', age: 25 }])
  })

  it('[1,2,3,4].filter(. > 2) async', async () => {
    expect(await expr.evaluate('[1,2,3,4].filter(. > 2)')).toEqual([3, 4])
  })

  it('[1,2,3,4].map(. * 2) async', async () => {
    expect(await expr.evaluate('[1,2,3,4].map(. * 2)')).toEqual([2, 4, 6, 8])
  })

  it('[1,2,3].some(. > 10) async returns false', async () => {
    expect(await expr.evaluate('[1,2,3].some(. > 10)')).toBe(false)
  })

  it('[1,2,3].every(. > 1) async returns false', async () => {
    expect(await expr.evaluate('[1,2,3].every(. > 1)')).toBe(false)
  })

  it('[1,2,3].find(. > 1) async', async () => {
    expect(await expr.evaluate('[1,2,3].find(. > 1)')).toBe(2)
  })

  it('[1,2,3].find(. > 10) async returns undefined', async () => {
    expect(await expr.evaluate('[1,2,3].find(. > 10)')).toBe(undefined)
  })

  it('chained async: users.filter(.age >= 18).map(.name)', async () => {
    const result = await expr.evaluate('users.filter(.age >= 18).map(.name)', {
      users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }]
    })
    expect(result).toEqual(['Alice'])
  })
})

describe('nested async array methods inside lambdas', () => {
  it('groups.map(.users.filter(.age >= 18)) async', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('groups.map(.users.filter(.age >= 18))', {
      groups: [
        { users: [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 15 }] },
        { users: [{ name: 'Carol', age: 30 }] },
      ]
    })
    expect(result).toEqual([
      [{ name: 'Alice', age: 25 }],
      [{ name: 'Carol', age: 30 }],
    ])
  })

  it('groups.map(.items.map(. * 2)) async', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('groups.map(.items.map(. * 2))', {
      groups: [
        { items: [1, 2, 3] },
        { items: [4, 5] },
      ]
    })
    expect(result).toEqual([[2, 4, 6], [8, 10]])
  })

  it('groups.map(.users.every(.age >= 18)) async', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('groups.map(.users.every(.age >= 18))', {
      groups: [
        { users: [{ age: 25 }, { age: 30 }] },
        { users: [{ age: 25 }, { age: 15 }] },
      ]
    })
    expect(result).toEqual([true, false])
  })

  it('groups.map(.users.some(. > 20)) async with primitives', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('groups.map(.scores.some(. > 90))', {
      groups: [
        { scores: [85, 92, 78] },
        { scores: [60, 70, 80] },
      ]
    })
    expect(result).toEqual([true, false])
  })

  it('groups.map(.users.find(.name == "Alice")) async', async () => {
    const expr = bonsai()
    const result = await expr.evaluate('groups.map(.users.find(.name == "Alice"))', {
      groups: [
        { users: [{ name: 'Alice' }, { name: 'Bob' }] },
        { users: [{ name: 'Carol' }] },
      ]
    })
    expect(result).toEqual([{ name: 'Alice' }, undefined])
  })
})

describe('bare dot lambda in pipes', () => {
  const expr = bonsai().use(arrays)

  it('[1,2,3,4] |> filter(. > 2)', () => {
    expect(expr.evaluateSync('[1,2,3,4] |> filter(. > 2)')).toEqual([3, 4])
  })

  it('[1,2,3] |> map(. * 10)', () => {
    expect(expr.evaluateSync('[1,2,3] |> map(. * 10)')).toEqual([10, 20, 30])
  })

  it('[1,2,3] |> filter(. > 2) async', async () => {
    expect(await expr.evaluate('[1,2,3] |> filter(. > 2)')).toEqual([3])
  })
})

describe('bare dot lambda parse errors', () => {
  const expr = bonsai()

  it('rejects bare dot without operator', () => {
    expect(() => expr.evaluateSync('items.filter(.)')).toThrow()
  })

  it('rejects standalone bare dot', () => {
    expect(() => expr.evaluateSync('.')).toThrow()
  })
})

describe('security: array methods respect property guards', () => {
  it('allowedProperties blocks lambda property access inside method call', () => {
    const expr = bonsai({ allowedProperties: ['filter', 'age'] })
    expect(() => expr.evaluateSync('users.filter(.secret == "x")', {
      users: [{ age: 25, secret: 'x' }]
    })).toThrow('secret')
  })

  it('allowedProperties blocks lambda property access in pipe', () => {
    const expr = bonsai({ allowedProperties: ['age'] }).use(arrays)
    expect(() => expr.evaluateSync('users |> filter(.secret == "x")', {
      users: [{ age: 25, secret: 'x' }]
    })).toThrow('secret')
  })

  it('deniedProperties blocks lambda property access inside method call', () => {
    const expr = bonsai({ deniedProperties: ['secret'] })
    expect(() => expr.evaluateSync('users.filter(.secret == "x")', {
      users: [{ age: 25, secret: 'x' }]
    })).toThrow('secret')
  })

  it('null receiver throws BonsaiTypeError', () => {
    const expr = bonsai()
    expect(() => expr.evaluateSync('arr.filter(. > 0)', { arr: null })).toThrow('non-null')
  })
})
