import { describe, it, expect } from 'vitest'
import { tolerantTokenize } from '../../src/autocomplete/tokenizer.js'

describe('tolerantTokenize', () => {
  it('tokenizes valid expression', () => {
    const result = tolerantTokenize('1 + 2', 5)
    expect(result.partial).toBe(false)
    expect(result.tokens.length).toBeGreaterThan(0)
  })

  it('handles unterminated string', () => {
    const result = tolerantTokenize('"hello', 6)
    expect(result.partial).toBe(true)
    expect(result.insideString).toBe(true)
  })

  it('handles unterminated template literal', () => {
    const result = tolerantTokenize('`hello ${name', 13)
    expect(result.partial).toBe(true)
  })

  it('handles empty input', () => {
    const result = tolerantTokenize('', 0)
    expect(result.partial).toBe(false)
    expect(result.tokens.length).toBe(0)
  })

  it('extracts tokens before unterminated string', () => {
    const result = tolerantTokenize('user.name == "hel', 17)
    expect(result.partial).toBe(true)
    expect(result.insideString).toBe(true)
    const identifiers = result.tokens.filter(t => t.type === 'Identifier')
    expect(identifiers.length).toBeGreaterThanOrEqual(1)
  })

  it('detects cursor inside string literal', () => {
    const result = tolerantTokenize('"hello world"', 6)
    expect(result.insideString).toBe(true)
  })

  it('detects cursor NOT inside string when after closing quote', () => {
    const result = tolerantTokenize('"hello" + ', 10)
    expect(result.insideString).toBe(false)
  })

  it('extracts dot and optional chain tokens', () => {
    const result = tolerantTokenize('user.na', 7)
    expect(result.partial).toBe(false)
    const hasDot = result.tokens.some(t => t.type === 'Punctuation' && t.value === '.')
    expect(hasDot).toBe(true)
  })

  it('extracts pipe token', () => {
    const result = tolerantTokenize('x |> ', 5)
    const hasPipe = result.tokens.some(t => t.type === 'Pipe')
    expect(hasPipe).toBe(true)
  })

  it('handles single unterminated quote', () => {
    const result = tolerantTokenize("'test", 5)
    expect(result.partial).toBe(true)
    expect(result.insideString).toBe(true)
  })

  it('extracts optional chain token', () => {
    const result = tolerantTokenize('user?.name', 10)
    const hasOptChain = result.tokens.some(t => t.type === 'OptionalChain')
    expect(hasOptChain).toBe(true)
  })

  it('extracts nullish coalescing token', () => {
    const result = tolerantTokenize('x ?? y', 6)
    const hasNullish = result.tokens.some(t => t.type === 'NullishCoalescing')
    expect(hasNullish).toBe(true)
  })
})
