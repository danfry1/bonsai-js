import { describe, it, expect } from 'vitest'
import { classifyCursor } from '../../src/autocomplete/context.js'
import { tolerantTokenize } from '../../src/autocomplete/tokenizer.js'

function ctx(expr: string, cursor?: number) {
  const c = cursor ?? expr.length
  const { tokens } = tolerantTokenize(expr, c)
  return classifyCursor(tokens, c)
}

describe('classifyCursor', () => {
  describe('top-level member access', () => {
    it('user.', () => {
      expect(ctx('user.')).toMatchObject({ kind: 'top-level-member', prefix: '' })
    })
    it('user.na', () => {
      expect(ctx('user.na')).toMatchObject({ kind: 'top-level-member', prefix: 'na' })
    })
    it('user?.', () => {
      expect(ctx('user?.')).toMatchObject({ kind: 'top-level-member', prefix: '' })
    })
  })

  describe('lambda-start dot', () => {
    it('.age after (', () => {
      expect(ctx('users.filter(.age')).toMatchObject({ kind: 'lambda-start', prefix: 'age' })
    })
    it('. after ( bare identity', () => {
      expect(ctx('items.filter(. ')).toMatchObject({ kind: 'lambda-start', prefix: '' })
    })
    it('.verified after &&', () => {
      expect(ctx('users.filter(.active && .ver')).toMatchObject({ kind: 'lambda-start', prefix: 'ver' })
    })
    it('. after ? (ternary)', () => {
      expect(ctx('items.filter(.x > 0 ? .na')).toMatchObject({ kind: 'lambda-start', prefix: 'na' })
    })
    it('. after : (ternary)', () => {
      expect(ctx('items.filter(.x > 0 ? .a : .b')).toMatchObject({ kind: 'lambda-start', prefix: 'b' })
    })
  })

  describe('lambda member-access dot', () => {
    it('.address.', () => {
      expect(ctx('users.filter(.address.')).toMatchObject({ kind: 'lambda-member', prefix: '' })
    })
    it('.address.ci', () => {
      expect(ctx('users.filter(.address.ci')).toMatchObject({ kind: 'lambda-member', prefix: 'ci' })
    })
    it('.profile?.', () => {
      expect(ctx('users.filter(.profile?.')).toMatchObject({ kind: 'lambda-member', prefix: '' })
    })
  })

  describe('pipe transform', () => {
    it('|> ', () => {
      expect(ctx('x |> ')).toMatchObject({ kind: 'pipe-transform', prefix: '' })
    })
    it('|> tri', () => {
      expect(ctx('x |> tri')).toMatchObject({ kind: 'pipe-transform', prefix: 'tri' })
    })
  })

  describe('identifier context', () => {
    it('empty expression', () => {
      expect(ctx('')).toMatchObject({ kind: 'identifier', prefix: '' })
    })
    it('after operator', () => {
      expect(ctx('x + ')).toMatchObject({ kind: 'identifier', prefix: '' })
    })
    it('partial identifier at start', () => {
      expect(ctx('us')).toMatchObject({ kind: 'identifier', prefix: 'us' })
    })
    it('after (', () => {
      expect(ctx('fn(')).toMatchObject({ kind: 'identifier', prefix: '' })
    })
    it('after ,', () => {
      expect(ctx('fn(a, ')).toMatchObject({ kind: 'identifier', prefix: '' })
    })
  })

  describe('pipe lambda', () => {
    it('arr |> filter(.ag', () => {
      expect(ctx('arr |> filter(.ag')).toMatchObject({ kind: 'lambda-start', prefix: 'ag' })
    })
  })
})
