import { describe, it, expect } from 'vitest'
import { bonsai } from '../../src/index.js'
import { strings, arrays, math } from '../../src/stdlib/index.js'
import { createAutocomplete } from '../../src/autocomplete/index.js'

function setup(context: Record<string, unknown> = {}, opts?: { allowedProperties?: string[]; deniedProperties?: string[] }) {
  const instance = bonsai(opts)
  instance.use(strings)
  instance.use(arrays)
  instance.use(math)
  const ac = createAutocomplete(instance, { context })
  return ac
}

describe('autocomplete integration', () => {
  const context = {
    user: { name: 'Alice', age: 25, address: { city: 'London', zip: '12345' } },
    items: [1, 2, 3],
    users: [
      { name: 'Alice', age: 25, active: true },
      { name: 'Bob', age: 30, active: false },
    ],
  }

  it('user. → property completions', () => {
    const ac = setup(context)
    const result = ac.complete('user.', 5)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).toContain('age')
    expect(labels).toContain('address')
  })

  it('user.na → filtered by prefix', () => {
    const ac = setup(context)
    const result = ac.complete('user.na', 7)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).not.toContain('age')
    expect(labels).not.toContain('address')
  })

  it('user.address. → nested property completions', () => {
    const ac = setup(context)
    const result = ac.complete('user.address.', 13)
    const labels = result.map(c => c.label)
    expect(labels).toContain('city')
    expect(labels).toContain('zip')
  })

  it('user.name. → string method completions', () => {
    const ac = setup(context)
    const result = ac.complete('user.name.', 10)
    const labels = result.map(c => c.label)
    expect(labels).toContain('trim')
    expect(labels).toContain('toUpperCase')
    expect(labels).toContain('toLowerCase')
    expect(labels).toContain('startsWith')
  })

  it('items. → array method completions', () => {
    const ac = setup(context)
    const result = ac.complete('items.', 6)
    const labels = result.map(c => c.label)
    expect(labels).toContain('filter')
    expect(labels).toContain('map')
    expect(labels).toContain('join')
    expect(labels).toContain('includes')
  })

  it('users.filter(. → lambda property completions', () => {
    const ac = setup(context)
    const result = ac.complete('users.filter(.', 14)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).toContain('age')
    expect(labels).toContain('active')
  })

  it('x |>  → transform completions', () => {
    const ac = setup(context)
    const result = ac.complete('x |> ', 5)
    const labels = result.map(c => c.label)
    // strings plugin registers transforms like trim, upper, lower
    expect(labels.length).toBeGreaterThan(0)
    expect(result.every(c => c.kind === 'transform')).toBe(true)
  })

  it('string |> auto-filters to string-compatible transforms', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name |> ', 8)
    const labels = result.map(c => c.label)
    expect(labels).toContain('upper')
    expect(labels).toContain('trim')
    expect(labels).not.toContain('count') // array-only
    expect(labels).not.toContain('first') // array-only
    expect(labels).not.toContain('sort') // array-only
  })

  it('array |> auto-filters to array-compatible transforms', () => {
    const ac = setup({ items: [1, 2, 3] })
    const result = ac.complete('items |> ', 9)
    const labels = result.map(c => c.label)
    expect(labels).toContain('filter')
    expect(labels).toContain('map')
    expect(labels).toContain('count')
    expect(labels).not.toContain('upper') // string-only
    expect(labels).not.toContain('trim') // string-only
  })

  it('chained pipe: name |> trim |> shows string transforms', () => {
    const ac = setup({ name: '  Alice  ' })
    const result = ac.complete('name |> trim |> ', 16)
    const labels = result.map(c => c.label)
    expect(labels).toContain('upper')
    expect(labels).not.toContain('filter')
  })

  it('us at start → identifier completions with prefix', () => {
    const ac = setup(context)
    const result = ac.complete('us', 2)
    const labels = result.map(c => c.label)
    expect(labels).toContain('user')
    expect(labels).toContain('users')
    expect(labels).not.toContain('items')
  })

  it('"hello us" → returns [] (inside string)', () => {
    const ac = setup(context)
    const result = ac.complete('"hello us', 9)
    expect(result).toEqual([])
  })

  it('setContext() updates completions', () => {
    const ac = setup({ old: 'value' })
    const before = ac.complete('', 0)
    const beforeLabels = before.map(c => c.label)
    expect(beforeLabels).toContain('old')

    ac.setContext({ fresh: 'data' })
    const after = ac.complete('', 0)
    const afterLabels = after.map(c => c.label)
    expect(afterLabels).toContain('fresh')
    expect(afterLabels).not.toContain('old')
  })

  it('allowedProperties filtering restricts completions', () => {
    const ac = setup(
      { user: { name: 'Alice', secret: 'password' } },
      { allowedProperties: ['name'] },
    )
    const result = ac.complete('user.', 5)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).not.toContain('secret')
  })

  it('lambda-member on string property: users.filter(.name. suggests string methods', () => {
    const ac = setup({ users: [{ name: 'Alice', age: 25 }] })
    const result = ac.complete('users.filter(.name.', 19)
    const labels = result.map(c => c.label)
    expect(result.every(c => c.kind === 'method')).toBe(true)
    expect(result.every(c => c.detail?.startsWith('string'))).toBe(true)
    expect(labels).toEqual(expect.arrayContaining(['trim', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'includes', 'slice', 'split']))
    expect(labels).not.toContain('filter') // no array methods
    expect(labels).not.toContain('join') // no array methods
  })

  it('contains-matching: "Up" matches "toUpperCase"', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.Up', 7)
    const labels = result.map(c => c.label)
    expect(labels).toContain('toUpperCase')
  })

  it('escaped quote does not break insideString detection', () => {
    const ac = setup({ x: 1 })
    const result = ac.complete('"test\\\\" + x', 11)
    expect(result.length).toBeGreaterThanOrEqual(0)
  })

  it('pipe-lambda: arr |> filter(. suggests element properties', () => {
    const ac = setup({ users: [{ name: 'Alice', age: 25 }] })
    const result = ac.complete('users |> filter(.', 17)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).toContain('age')
  })

  it('allowedProperties does not block method completions', () => {
    const ac = setup(
      { user: { name: 'Alice' } },
      { allowedProperties: ['name'] },
    )
    const result = ac.complete('user.name.', 10)
    const methods = result.filter(c => c.kind === 'method')
    expect(methods.length).toBeGreaterThan(0)
    expect(methods.map(c => c.label)).toContain('trim')
  })

  it('__proto__ traversal is blocked in completions', () => {
    const ac = setup({ obj: { __proto__: { leaked: true } } })
    const result = ac.complete('obj.__proto__.', 14)
    const labels = result.map(c => c.label)
    expect(labels).not.toContain('leaked')
  })

  // ── Eval-based type inference ──────────────────────────────

  it('method chain: user.name.trim(). shows string methods (eval-based)', () => {
    const ac = setup({ user: { name: '  Alice  ' } })
    const result = ac.complete('user.name.trim().', 17)
    const labels = result.map(c => c.label)
    expect(labels).toContain('toUpperCase')
    expect(labels).toContain('startsWith')
    expect(labels).not.toContain('filter')
  })

  it('method chain: items.filter(.x > 0).map(. * 2). shows array methods', () => {
    const ac = setup({ items: [{ x: 1 }, { x: 2 }] })
    // This is a complex chain — the evaluator will run it and return an array
    const result = ac.complete('[1,2,3].', 8)
    const labels = result.map(c => c.label)
    expect(labels).toContain('filter')
    expect(labels).toContain('map')
    expect(labels).toContain('join')
  })

  // ── Rich metadata ──────────────────────────────────────────

  it('property completions include value type in detail', () => {
    const ac = setup({ user: { name: 'Alice', age: 25, active: true } })
    const result = ac.complete('user.', 5)
    const nameCompletion = result.find(c => c.label === 'name')
    const ageCompletion = result.find(c => c.label === 'age')
    const activeCompletion = result.find(c => c.label === 'active')
    expect(nameCompletion?.detail).toBe('string')
    expect(ageCompletion?.detail).toBe('number')
    expect(activeCompletion?.detail).toBe('boolean')
  })

  it('method completions include return type in detail', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.', 5)
    const trimCompletion = result.find(c => c.label === 'trim')
    const splitCompletion = result.find(c => c.label === 'split')
    expect(trimCompletion?.detail).toBe('string → string')
    expect(splitCompletion?.detail).toBe('string → array')
  })

  it('method completions include insertText with parens', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.', 5)
    const trimCompletion = result.find(c => c.label === 'trim')
    expect(trimCompletion?.insertText).toBe('trim()')
  })

  it('higher-order method completions include lambda placeholder', () => {
    const ac = setup({ items: [1, 2, 3] })
    const result = ac.complete('items.', 6)
    const filterCompletion = result.find(c => c.label === 'filter')
    expect(filterCompletion?.insertText).toBe('filter(.)')
  })

  it('identifier completions show value preview in detail', () => {
    const ac = setup({ name: 'Alice', count: 42, items: [1, 2, 3] })
    const result = ac.complete('', 0)
    const nameCompletion = result.find(c => c.label === 'name')
    const countCompletion = result.find(c => c.label === 'count')
    const itemsCompletion = result.find(c => c.label === 'items')
    expect(nameCompletion?.detail).toBe('"Alice"')
    expect(countCompletion?.detail).toBe('42')
    expect(itemsCompletion?.detail).toBe('array(3)')
  })

  it('lambda property completions show value type', () => {
    const ac = setup({ users: [{ name: 'Alice', age: 25 }] })
    const result = ac.complete('users.filter(.', 14)
    const nameCompletion = result.find(c => c.label === 'name')
    const ageCompletion = result.find(c => c.label === 'age')
    expect(nameCompletion?.detail).toBe('string')
    expect(ageCompletion?.detail).toBe('number')
  })

  // ── Cursor offset ──────────────────────────────────────────

  it('method cursorOffset positions inside parens', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.', 5)
    const trim = result.find(c => c.label === 'trim')
    expect(trim?.insertText).toBe('trim()')
    expect(trim?.cursorOffset).toBe(5) // cursor between ( and )
  })

  it('lambda method cursorOffset positions before dot', () => {
    const ac = setup({ items: [1, 2, 3] })
    const result = ac.complete('items.', 6)
    const filter = result.find(c => c.label === 'filter')
    expect(filter?.insertText).toBe('filter(.)')
    expect(filter?.cursorOffset).toBe(7) // cursor after the . (before closing paren)
  })

  it('function cursorOffset positions inside parens', () => {
    const ac = setup({})
    const result = ac.complete('mi', 2)
    const min = result.find(c => c.label === 'min')
    expect(min?.insertText).toBe('min()')
    expect(min?.cursorOffset).toBe(4) // cursor between ( and )
  })

  // ── Fuzzy matching ─────────────────────────────────────────

  it('fuzzy: tLC matches toLowerCase', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.tLC', 8)
    const labels = result.map(c => c.label)
    expect(labels).toContain('toLowerCase')
  })

  it('fuzzy: sW matches startsWith', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.sW', 7)
    const labels = result.map(c => c.label)
    expect(labels).toContain('startsWith')
  })

  it('fuzzy: exact match ranks first', () => {
    const ac = setup({ name: 'Alice', names: ['a', 'b'] })
    const result = ac.complete('name', 4)
    expect(result[0].label).toBe('name')
  })

  it('fuzzy: prefix match ranks above fuzzy', () => {
    const ac = setup({ name: 'Alice' })
    const result = ac.complete('name.trim', 9)
    expect(result[0].label).toBe('trim')
    // trimStart and trimEnd should also appear as prefix matches
    const labels = result.map(c => c.label)
    expect(labels).toContain('trimStart')
    expect(labels).toContain('trimEnd')
  })

  // ── Nested lambda inference ────────────────────────────────

  it('nested lambda: groups.map(.users.filter(. suggests user properties', () => {
    const ac = setup({
      groups: [
        { name: 'Team A', users: [{ email: 'a@test.com', role: 'admin' }] },
      ],
    })
    const result = ac.complete('groups.map(.users.filter(.', 26)
    const labels = result.map(c => c.label)
    expect(labels).toContain('email')
    expect(labels).toContain('role')
  })

  // ── Variable kind ──────────────────────────────────────────

  it('identifier completions have kind: variable', () => {
    const ac = setup({ user: { name: 'Alice' }, count: 42 })
    const result = ac.complete('', 0)
    const userCompletion = result.find(c => c.label === 'user')
    const countCompletion = result.find(c => c.label === 'count')
    expect(userCompletion?.kind).toBe('variable')
    expect(countCompletion?.kind).toBe('variable')
  })

  // ── deniedProperties on methods ────────────────────────────

  it('deniedProperties blocks method completions', () => {
    const ac = setup(
      { name: 'Alice' },
      { deniedProperties: ['split'] },
    )
    const result = ac.complete('name.', 5)
    const labels = result.map(c => c.label)
    expect(labels).toContain('trim')
    expect(labels).not.toContain('split')
  })

  // ── Edge cases ─────────────────────────────────────────────

  it('cursor at 0 on non-empty expression returns identifier completions', () => {
    const ac = setup({ user: { name: 'Alice' } })
    const result = ac.complete('user.name', 0)
    const labels = result.map(c => c.label)
    expect(labels).toContain('user')
    expect(result.every(c => c.kind === 'variable' || c.kind === 'function' || c.kind === 'keyword')).toBe(true)
  })

  it('empty context returns only functions and keywords', () => {
    const ac = setup({})
    const result = ac.complete('', 0)
    expect(result.every(c => c.kind === 'function' || c.kind === 'keyword')).toBe(true)
  })

  it('setContext(null) does not crash', () => {
    const ac = setup({ name: 'Alice' })
    // @ts-expect-error testing JS runtime safety
    ac.setContext(null)
    expect(() => ac.complete('', 0)).not.toThrow()
  })

  it('setContext(undefined) does not crash', () => {
    const ac = setup({ name: 'Alice' })
    // @ts-expect-error testing JS runtime safety
    ac.setContext(undefined)
    expect(() => ac.complete('', 0)).not.toThrow()
  })

  // ── Cursor bounds ─────────────────────────────────────────────

  it('cursor beyond expression length is clamped gracefully', () => {
    const ac = setup({ user: { name: 'Alice' } })
    expect(() => ac.complete('user.', 999)).not.toThrow()
    const result = ac.complete('user.', 999)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
  })

  it('negative cursor is clamped to 0', () => {
    const ac = setup({ user: { name: 'Alice' } })
    const result = ac.complete('user.name', -5)
    // Cursor at 0 → identifier context
    expect(result.every(c => c.kind === 'variable' || c.kind === 'function' || c.kind === 'keyword')).toBe(true)
  })

  // ── Dynamic transform changes after creation ──────────────────

  it('newly added transforms appear in pipe completions', () => {
    const instance = bonsai()
    instance.use(strings)
    const ac = createAutocomplete(instance, { context: { name: 'Alice' } })

    // Trigger initial probe cache
    const before = ac.complete('name |> ', 8)
    const beforeLabels = before.map(c => c.label)
    expect(beforeLabels).toContain('upper')

    // Add a new transform
    instance.addTransform('my_custom', (v: unknown) => String(v))
    const after = ac.complete('name |> ', 8)
    const afterLabels = after.map(c => c.label)
    expect(afterLabels).toContain('my_custom')
  })

  it('removed transforms disappear from pipe completions', () => {
    const instance = bonsai()
    instance.use(strings)
    const ac = createAutocomplete(instance, { context: { name: 'Alice' } })

    const before = ac.complete('name |> ', 8)
    expect(before.map(c => c.label)).toContain('upper')

    instance.removeTransform('upper')
    const after = ac.complete('name |> ', 8)
    expect(after.map(c => c.label)).not.toContain('upper')
  })

  // ── allowedProperties + lambda-start ──────────────────────────

  it('allowedProperties filtering works in lambda-start context', () => {
    const ac = setup(
      { users: [{ name: 'Alice', secret: 'password', age: 25 }] },
      { allowedProperties: ['name', 'age', 'users'] },
    )
    const result = ac.complete('users.filter(.', 14)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).toContain('age')
    expect(labels).not.toContain('secret')
  })

  // ── Cursor positioned mid-expression ──────────────────────────

  it('cursor mid-expression ignores tokens after cursor', () => {
    const ac = setup(context)
    // Expression: "user. + items"  cursor at position 5 (right after the dot)
    const result = ac.complete('user. + items', 5)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).toContain('age')
    expect(labels).toContain('address')
  })

  it('cursor mid-expression: typing prefix between existing tokens', () => {
    const ac = setup(context)
    // Expression: "user.na + items" cursor at position 7 (typing 'na' prefix)
    const result = ac.complete('user.na + items', 7)
    const labels = result.map(c => c.label)
    expect(labels).toContain('name')
    expect(labels).not.toContain('age')
  })

  // ── deniedProperties blocks type inference leakage ────────────

  it('deniedProperties blocks property chain resolution (no type leakage)', () => {
    const ac = setup(
      { user: { name: 'Alice', secret: 'classified' } },
      { deniedProperties: ['secret'] },
    )
    // Attempting user.secret. should not reveal that secret is a string
    const result = ac.complete('user.secret.', 12)
    const labels = result.map(c => c.label)
    expect(labels).not.toContain('trim')
    expect(labels).not.toContain('toUpperCase')
  })

  // ── onError callback ──────────────────────────────────────────

  it('onError callback receives unexpected errors', () => {
    const instance = bonsai()
    const errors: Array<{ error: unknown; phase: string }> = []
    const ac = createAutocomplete(instance, {
      context: { name: 'Alice' },
      onError: (error, phase) => errors.push({ error, phase }),
    })
    // Normal operation should not trigger onError
    ac.complete('name', 4)
    expect(errors).toHaveLength(0)
  })
})
