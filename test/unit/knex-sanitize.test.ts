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
    expect(sanitizeBinding(new Map())).toBe('<<Object#Map>>')
    expect(sanitizeBinding(/regex/)).toBe('<<Object#RegExp>>')
  })

  it('serializes Date to an ISO string', () => {
    expect(sanitizeBinding(new Date('2026-06-22T12:34:56.000Z'))).toBe(
      '2026-06-22T12:34:56.000Z',
    )
  })

  it('formats an invalid Date with the constructor placeholder', () => {
    expect(sanitizeBinding(new Date('not a date'))).toBe('<<Object#Date>>')
  })

  it('keeps UUID strings unredacted', () => {
    expect(sanitizeBinding('00000000-0000-0000-0000-000000000000')).toBe(
      '00000000-0000-0000-0000-000000000000',
    )
    expect(sanitizeBinding('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(
      'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
    )
  })

  it('redacts strings that only resemble a UUID', () => {
    // missing a character in the final group
    expect(sanitizeBinding('00000000-0000-0000-0000-00000000000')).toBe(
      'string<35>',
    )
    // surrounding whitespace means it is not a bare UUID
    expect(sanitizeBinding(' 00000000-0000-0000-0000-000000000000')).toBe(
      'string<37>',
    )
  })

  it('formats Buffer with constructor name', () => {
    expect(sanitizeBinding(Buffer.from('test'))).toBe('<<Object#Buffer>>')
  })
})

describe('sanitizeBinding with custom sanitizer', () => {
  it('uses the sanitizer string result over the default', () => {
    const sanitizer = (value: any) =>
      typeof value === 'string' ? `redacted<${value.length}>` : undefined
    expect(sanitizeBinding('secret', sanitizer)).toBe('redacted<6>')
  })

  it('falls through to default when the sanitizer returns a non-string', () => {
    const sanitizer = (value: any) =>
      typeof value === 'string' ? 'REDACTED' : undefined
    // numbers are untouched by the sanitizer, so the default applies
    expect(sanitizeBinding(42, sanitizer)).toBe(42)
    expect(sanitizeBinding('hi', sanitizer)).toBe('REDACTED')
  })

  it('applies the sanitizer recursively to array elements', () => {
    const sanitizer = (value: any) =>
      value === 'secret' ? 'REDACTED' : undefined
    expect(sanitizeBinding(['secret', 'other', 1], sanitizer)).toEqual([
      'REDACTED',
      'string<5>',
      1,
    ])
  })

  it('applies the sanitizer recursively to object values', () => {
    const sanitizer = (value: any) =>
      value === 'hunter2' ? 'REDACTED' : undefined
    expect(
      sanitizeBinding({ user: 'alice', password: 'hunter2' }, sanitizer),
    ).toEqual({ user: 'string<5>', password: 'REDACTED' })
  })

  it('can short-circuit an entire array/object', () => {
    const sanitizer = (value: any) =>
      Array.isArray(value) ? '<<array>>' : undefined
    expect(sanitizeBinding([1, 2, 3], sanitizer)).toBe('<<array>>')
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

  it('threads a custom per-binding sanitizer through', () => {
    const sanitizer = (value: any) =>
      value === 'secret' ? 'REDACTED' : undefined
    const result = sanitizeBindings([1, 'secret', 'other'], sanitizer)
    expect(result).toBe('[1,"REDACTED","string<5>"]')
  })
})
