import { describe, it, expect, afterEach } from 'vitest'
import Knex from 'knex'
import { otelInitKnex } from '../../src/integrations/knex.js'
import { cleanupOtel, createSimpleProvider } from '../helpers.js'

function createKnex() {
  return Knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  })
}

describe('otelInitKnex (real Knex + SQLite)', () => {
  let knex: ReturnType<typeof createKnex>

  afterEach(async () => {
    if (knex) await knex.destroy()
    cleanupOtel()
  })

  it('enriches the active span with connection and query info', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('users').insert({ id: 1, name: 'Alice' })
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan).toBeDefined()
    expect(dbSpan!.attributes['db.connection.id']).toBeDefined()
  })

  it('captures pool stats by default', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE t (id INTEGER)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t').insert({ id: 1 })
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.pool.used_count']).toBeDefined()
    expect(dbSpan!.attributes['db.pool.free_count']).toBeDefined()
  })

  it('skips pool stats when capturePoolStats is false', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex, { capturePoolStats: false })

    await knex.raw('CREATE TABLE t2 (id INTEGER)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t2').insert({ id: 1 })
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.pool.used_count']).toBeUndefined()
  })

  it('captures sanitized bindings', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE t3 (id INTEGER, name TEXT)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t3').where('id', '=', 42).select('*')
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.query.sanitized_bindings']).toBeDefined()
    expect(dbSpan!.attributes['db.query.hash']).toBeDefined()
  })

  it('skips bindings when captureBindings is false', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex, { captureBindings: false })

    await knex.raw('CREATE TABLE t4 (id INTEGER)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t4').where('id', '=', 1).select('*')
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.query.sanitized_bindings']).toBeUndefined()
    expect(dbSpan!.attributes['db.query.hash']).toBeUndefined()
  })

  it('uses custom hash function', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex, { hashFn: () => 'custom-hash' })

    await knex.raw('CREATE TABLE t5 (id INTEGER)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t5').where('id', '=', 1).select('*')
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.query.hash']).toBe('custom-hash')
  })

  it('cleanup function removes the listener', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    const cleanup = otelInitKnex(knex)

    await knex.raw('CREATE TABLE t6 (id INTEGER)')
    cleanup()

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t6').insert({ id: 1 })
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.connection.id']).toBeUndefined()
  })

  it('captures tx ID when present', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE t7 (id INTEGER, name TEXT)')

    await tracer.startActiveSpan('tx-query', async (span) => {
      await knex.transaction(async (trx) => {
        await trx('t7').insert({ id: 1, name: 'Bob' })
      })
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'tx-query')
    expect(dbSpan).toBeDefined()
    expect(dbSpan!.attributes['db.tx.id']).toBeDefined()
  })

  it('handles queries with various binding types', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE t8 (id INTEGER, name TEXT, active INTEGER)')

    await tracer.startActiveSpan('varied-bindings', async (span) => {
      await knex('t8').insert({ id: 1, name: 'test', active: 1 })
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'varied-bindings')
    expect(dbSpan).toBeDefined()
    const bindings = dbSpan!.attributes['db.query.sanitized_bindings'] as string
    expect(bindings).toBeDefined()
    // String bindings should be sanitized to string<N>
    expect(bindings).toContain('string<')
  })

  it('default hash returns a 16-char hex string', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE t_hash (id INTEGER)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t_hash').where('id', '=', 1).select('*')
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    const hash = dbSpan!.attributes['db.query.hash'] as string
    expect(hash).toMatch(/^[0-9a-f]{1,8}$/)
  })

  it('uses custom sanitizeBindingsFn', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex, {
      sanitizeBindingsFn: () => 'custom-sanitized',
    })

    await knex.raw('CREATE TABLE t_custom (id INTEGER)')

    await tracer.startActiveSpan('db-query', async (span) => {
      await knex('t_custom').where('id', '=', 1).select('*')
      span.end()
    })

    await provider.forceFlush()
    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'db-query')
    expect(dbSpan!.attributes['db.query.sanitized_bindings']).toBe(
      'custom-sanitized',
    )
  })

  it('skips query enrichment when no active span', async () => {
    const { exporter, provider } = createSimpleProvider()
    knex = createKnex()
    otelInitKnex(knex)

    await knex.raw('CREATE TABLE t9 (id INTEGER)')

    // Execute without an active span
    await knex('t9').insert({ id: 1 })

    await provider.forceFlush()
    // Should not throw, just silently skip
    expect(exporter.getFinishedSpans().length).toBe(0)
  })
})
