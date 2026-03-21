import { describe, bench } from 'vitest'
import { bonsai } from '../src/index.js'
import { strings, arrays, math } from '../src/stdlib/index.js'
import { createAutocomplete } from '../src/autocomplete/index.js'

describe('autocomplete benchmarks', () => {
  const expr = bonsai()
  expr.use(strings)
  expr.use(arrays)
  expr.use(math)

  const context = {
    user: { name: 'Alice', age: 25, address: { city: 'London', zip: '12345' } },
    items: [1, 2, 3, 4, 5],
    users: [
      { name: 'Alice', age: 25, active: true },
      { name: 'Bob', age: 30, active: false },
    ],
    price: 99.99,
    tags: ['a', 'b', 'c'],
  }

  const ac = createAutocomplete(expr, { context })

  // ── Property completions (most common case) ──────────────────
  bench('property: user.', () => {
    ac.complete('user.', 5)
  })

  bench('property: user.address.', () => {
    ac.complete('user.address.', 13)
  })

  // ── Method completions ───────────────────────────────────────
  bench('method: user.name.', () => {
    ac.complete('user.name.', 10)
  })

  // ── Eval-based inference (method chain) ──────────────────────
  bench('eval chain: user.name.trim().', () => {
    ac.complete('user.name.trim().', 17)
  })

  // ── Prefix filtering ─────────────────────────────────────────
  bench('prefix: user.na', () => {
    ac.complete('user.na', 7)
  })

  bench('prefix: user.name.to', () => {
    ac.complete('user.name.to', 12)
  })

  // ── Pipe transforms ──────────────────────────────────────────
  bench('pipe: name |> (first call, probes)', () => {
    // Fresh instance to measure cold-start probe cost
    const fresh = createAutocomplete(expr, { context })
    fresh.complete('user.name |> ', 13)
  })

  bench('pipe: name |> (cached)', () => {
    ac.complete('user.name |> ', 13)
  })

  // ── Lambda completions ───────────────────────────────────────
  bench('lambda-start: users.filter(.', () => {
    ac.complete('users.filter(.', 14)
  })

  bench('lambda-member: users.filter(.name.', () => {
    ac.complete('users.filter(.name.', 19)
  })

  // ── Identifier completions (empty expression) ────────────────
  bench('identifier: empty', () => {
    ac.complete('', 0)
  })

  bench('identifier: prefix us', () => {
    ac.complete('us', 2)
  })

  // ── Optional chaining ────────────────────────────────────────
  bench('optional: user?.address?.', () => {
    ac.complete('user?.address?.', 15)
  })

  // ── Fuzzy matching ───────────────────────────────────────────
  bench('fuzzy: user.name.tLC', () => {
    ac.complete('user.name.tLC', 13)
  })

  // ── Edge cases ───────────────────────────────────────────────
  bench('inside string (early return)', () => {
    ac.complete('"hello us', 9)
  })

  bench('setContext + complete', () => {
    ac.setContext(context)
    ac.complete('user.', 5)
  })
})
