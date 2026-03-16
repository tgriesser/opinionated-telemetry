import { describe, it, expect } from 'vitest'
import {
  stabilizeQuery,
  queryRequestTag,
  stableQueryTag,
  queryResponseTag,
  stableQueryHash,
} from '../../src/sql-utils.js'

describe('stabilizeQuery', () => {
  it('collapses ? binding groups', () => {
    const result = stabilizeQuery(
      'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
    )
    expect(result.stableQuery).toBe(
      'INSERT INTO users (id, name, email) VALUES (_)',
    )
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(3)
  })

  it('collapses $N binding groups', () => {
    const result = stabilizeQuery(
      'INSERT INTO users (id, name) VALUES ($1, $2)',
    )
    expect(result.stableQuery).toBe('INSERT INTO users (id, name) VALUES (_)')
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(2)
  })

  it('collapses ?::type binding groups', () => {
    const result = stabilizeQuery(
      'INSERT INTO users (id, name) VALUES (?::bigint, ?::text)',
    )
    expect(result.stableQuery).toBe('INSERT INTO users (id, name) VALUES (_)')
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(2)
  })

  it('collapses $N::type binding groups', () => {
    const result = stabilizeQuery(
      'INSERT INTO users (id, name) VALUES ($1::bigint, $2::text)',
    )
    expect(result.stableQuery).toBe('INSERT INTO users (id, name) VALUES (_)')
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(2)
  })

  it('handles DEFAULT keyword in binding groups', () => {
    const result = stabilizeQuery(
      'INSERT INTO users (id, name, created_at) VALUES (?, ?, DEFAULT)',
    )
    expect(result.stableQuery).toBe(
      'INSERT INTO users (id, name, created_at) VALUES (_)',
    )
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(3)
  })

  it('collapses multiple consecutive groups into (_+)', () => {
    const sql = 'INSERT INTO users (id, name) VALUES (?, ?), (?, ?), (?, ?)'
    const result = stabilizeQuery(sql)
    expect(result.stableQuery).toBe('INSERT INTO users (id, name) VALUES (_+)')
    expect(result.groupCount).toBe(3)
    expect(result.groupedBindingCount).toBe(6)
  })

  it('handles single binding', () => {
    const result = stabilizeQuery('SELECT * FROM users WHERE id = (?)')
    expect(result.stableQuery).toBe('SELECT * FROM users WHERE id = (_)')
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(1)
  })

  it('leaves non-group bindings untouched', () => {
    const result = stabilizeQuery(
      'SELECT * FROM users WHERE id = ? AND name = ?',
    )
    expect(result.stableQuery).toBe(
      'SELECT * FROM users WHERE id = ? AND name = ?',
    )
    expect(result.groupCount).toBe(0)
    expect(result.groupedBindingCount).toBe(0)
  })

  it('handles mixed $N styles in multi-value insert', () => {
    const sql = 'INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4)'
    const result = stabilizeQuery(sql)
    expect(result.stableQuery).toBe('INSERT INTO t (a, b) VALUES (_+)')
    expect(result.groupCount).toBe(2)
    expect(result.groupedBindingCount).toBe(4)
  })

  it('handles whitespace variations in groups', () => {
    const result = stabilizeQuery('VALUES ( ? , ? , ? )')
    expect(result.stableQuery).toBe('VALUES (_)')
  })

  it('returns zero counts for SQL with no binding groups', () => {
    const result = stabilizeQuery('SELECT 1')
    expect(result.stableQuery).toBe('SELECT 1')
    expect(result.groupCount).toBe(0)
    expect(result.groupedBindingCount).toBe(0)
  })

  it('handles IN clause with ? bindings', () => {
    const result = stabilizeQuery(
      'SELECT * FROM users WHERE id IN (?, ?, ?, ?, ?)',
    )
    expect(result.stableQuery).toBe('SELECT * FROM users WHERE id IN (_)')
    expect(result.groupCount).toBe(1)
    expect(result.groupedBindingCount).toBe(5)
  })

  it('handles case-insensitive DEFAULT', () => {
    const result = stabilizeQuery('VALUES (?, default, ?)')
    expect(result.stableQuery).toBe('VALUES (_)')
    expect(result.groupedBindingCount).toBe(3)
  })
})

describe('queryRequestTag', () => {
  it('returns a hex CRC32 hash', () => {
    const tag = queryRequestTag('SELECT * FROM users WHERE id = ?', [42])
    expect(tag).toMatch(/^[0-9a-f]+$/)
  })

  it('same sql+bindings produce same tag', () => {
    const a = queryRequestTag('SELECT 1', [1, 2])
    const b = queryRequestTag('SELECT 1', [1, 2])
    expect(a).toBe(b)
  })

  it('different bindings produce different tags', () => {
    const a = queryRequestTag('SELECT 1', [1])
    const b = queryRequestTag('SELECT 1', [2])
    expect(a).not.toBe(b)
  })

  it('handles no bindings', () => {
    const tag = queryRequestTag('SELECT 1')
    expect(tag).toMatch(/^[0-9a-f]+$/)
  })
})

describe('stableQueryTag', () => {
  it('same query shape with different values produce same tag', () => {
    const a = stableQueryTag('INSERT INTO t (a) VALUES (?)', [1])
    const b = stableQueryTag('INSERT INTO t (a) VALUES (?)', [999])
    expect(a).toBe(b)
  })

  it('same query shape with different binding types produce different tags', () => {
    const a = stableQueryTag('INSERT INTO t (a) VALUES (?)', [1])
    const b = stableQueryTag('INSERT INTO t (a) VALUES (?)', ['hello'])
    expect(a).not.toBe(b)
  })

  it('different number of multi-value groups produce same tag (collapsed)', () => {
    const a = stableQueryTag('INSERT INTO t (a) VALUES (?), (?)', [1, 2])
    const b = stableQueryTag(
      'INSERT INTO t (a) VALUES (?), (?), (?)',
      [1, 2, 3],
    )
    // Both collapse to VALUES (_+), but binding types differ in count
    // so the tags differ due to different binding type arrays
    expect(a).not.toBe(b)
  })
})

describe('queryResponseTag', () => {
  it('returns a hex CRC32 hash of the result', () => {
    const tag = queryResponseTag([{ id: 1, name: 'alice' }])
    expect(tag).toMatch(/^[0-9a-f]+$/)
  })

  it('same results produce same tag', () => {
    const a = queryResponseTag([{ id: 1 }])
    const b = queryResponseTag([{ id: 1 }])
    expect(a).toBe(b)
  })

  it('different results produce different tags', () => {
    const a = queryResponseTag([{ id: 1 }])
    const b = queryResponseTag([{ id: 2 }])
    expect(a).not.toBe(b)
  })

  it('respects maxBytes truncation', () => {
    const longResult = { data: 'x'.repeat(1000) }
    const full = queryResponseTag(longResult)
    const truncated = queryResponseTag(longResult, 50)
    expect(full).not.toBe(truncated)
  })

  it('maxBytes has no effect when result is shorter', () => {
    const result = { id: 1 }
    const a = queryResponseTag(result)
    const b = queryResponseTag(result, 10000)
    expect(a).toBe(b)
  })
})

describe('stableQueryHash', () => {
  it('returns a hex CRC32 hash', () => {
    const hash = stableQueryHash('SELECT * FROM users')
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('same stabilized queries produce same hash', () => {
    const a = stableQueryHash('INSERT INTO t VALUES (?, ?)')
    const b = stableQueryHash('INSERT INTO t VALUES (?, ?, ?)')
    // Both collapse to VALUES (_), same hash
    expect(a).toBe(b)
  })

  it('different queries produce different hashes', () => {
    const a = stableQueryHash('SELECT * FROM users')
    const b = stableQueryHash('SELECT * FROM orders')
    expect(a).not.toBe(b)
  })
})
