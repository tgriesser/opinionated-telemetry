import { describe, it, expect } from 'vitest'
import {
  sanitizeBinding,
  sanitizeBindings,
} from '../../src/integrations/knex.js'

describe('sanitizeBinding', () => {
  it('passes through booleans', () => {
    expect(sanitizeBinding(true)).toBe(true)
    expect(sanitizeBinding(false)).toBe(false)
  })

  it('passes through numbers', () => {
    expect(sanitizeBinding(42)).toBe(42)
    expect(sanitizeBinding(0)).toBe(0)
    expect(sanitizeBinding(-3.14)).toBe(-3.14)
  })

  it('replaces strings with length placeholder', () => {
    expect(sanitizeBinding('hello')).toBe('string<5>')
    expect(sanitizeBinding('')).toBe('string<0>')
    expect(sanitizeBinding('a longer string')).toBe('string<15>')
  })

  it('formats bigints', () => {
    expect(sanitizeBinding(BigInt(123))).toBe('bigint<<123>>')
    expect(sanitizeBinding(BigInt(0))).toBe('bigint<<0>>')
  })

  it('formats undefined', () => {
    expect(sanitizeBinding(undefined)).toBe('<<undefined>>')
  })

  it('formats symbols', () => {
    expect(sanitizeBinding(Symbol('test'))).toBe('symbol<<Symbol(test)>>')
  })

  it('formats functions', () => {
    const fn = function myFn() {}
    expect(sanitizeBinding(fn)).toBe(`<<${fn}>>`)
  })

  it('recursively sanitizes arrays', () => {
    expect(sanitizeBinding([1, 'hi', true])).toEqual([1, 'string<2>', true])
  })

  it('handles nested arrays', () => {
    expect(sanitizeBinding([[1, 'a'], [2]])).toEqual([[1, 'string<1>'], [2]])
  })

  it('recursively sanitizes plain objects', () => {
    expect(sanitizeBinding({ name: 'alice', age: 30 })).toEqual({
      name: 'string<5>',
      age: 30,
    })
  })

  it('handles nested plain objects', () => {
    expect(sanitizeBinding({ user: { name: 'bob' } })).toEqual({
      user: { name: 'string<3>' },
    })
  })

  it('passes through null', () => {
    expect(sanitizeBinding(null)).toBe(null)
  })

  it('formats class instances with constructor name', () => {
    expect(sanitizeBinding(new Date())).toBe('<<Object#Date>>')
    expect(sanitizeBinding(new Map())).toBe('<<Object#Map>>')
    expect(sanitizeBinding(/regex/)).toBe('<<Object#RegExp>>')
  })

  it('formats Buffer with constructor name', () => {
    expect(sanitizeBinding(Buffer.from('test'))).toBe('<<Object#Buffer>>')
  })
})

describe('sanitizeBindings', () => {
  it('returns JSON string of sanitized array', () => {
    const result = sanitizeBindings([1, 'hello', true])
    expect(result).toBe('[1,"string<5>",true]')
  })

  it('handles empty array', () => {
    expect(sanitizeBindings([])).toBe('[]')
  })

  it('handles mixed types', () => {
    const result = sanitizeBindings([42, 'test', null, { id: 1 }])
    expect(result).toBe('[42,"string<4>",null,{"id":1}]')
  })
})
