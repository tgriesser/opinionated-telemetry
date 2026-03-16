import { crc32 } from 'node:zlib'
import { trace } from '@opentelemetry/api'
import debugLib from 'debug'
import { stabilizeQuery } from '../sql-utils.js'
import type { StableQueryResult } from '../sql-utils.js'

const debug = debugLib('opin_tel:knex')

export interface KnexQueryHookContext {
  /** The raw SQL string */
  sql: string
  /** The query bindings array (if present) */
  bindings: any[] | undefined
  /** Result of stabilizeQuery(sql) */
  stable: StableQueryResult
  /** Set a span attribute */
  setAttribute: (key: string, value: string | number | boolean) => void
}

export interface KnexOtelConfig {
  /** Custom hash function for query+bindings. Default uses CRC32 */
  hashFn?: (input: any) => string
  /** Custom function to sanitize an array of bindings into a string */
  sanitizeBindingsFn?: (bindings: any[]) => string
  /** Capture sanitized bindings. Default: true */
  captureBindings?: boolean
  /** Capture pool stats. Default: true */
  capturePoolStats?: boolean
  /**
   * Custom hook called for each query, after default attributes are set.
   * Use to set additional attributes like request tags, response tags, etc.
   */
  queryHook?: (ctx: KnexQueryHookContext) => void
}

interface KnexQueryInfo {
  __knexUid: string
  __knexTxId: string | undefined
  __knexQueryUid: string
  method?: string
  options?: unknown
  timeout?: number
  cancelOnTimeout?: boolean
  bindings?: Array<any>
  sql?: string
  queryContext?: unknown
}

const ATTRS = {
  CONNECTION_ID: 'db.connection.id',
  TX_ID: 'db.tx.id',
  TIMEOUT: 'db.timeout',
  STABLE_QUERY: 'db.query.stable',
  STABLE_QUERY_HASH: 'db.query.stable_hash',
  GROUP_COUNT: 'db.query.group_count',
  GROUPED_BINDING_COUNT: 'db.query.grouped_binding_count',
  QUERY_HASH: 'db.query.hash',
  BINDINGS: 'db.query.sanitized_bindings',
}

const POOL_STATS: Record<string, string> = {
  numUsed: 'db.pool.used_count',
  numFree: 'db.pool.free_count',
  numPendingAcquires: 'db.pool.pending_acquire_count',
  numPendingValidations: 'db.pool.pending_validation_count',
  numPendingCreates: 'db.pool.pending_create_count',
}
const POOL_STAT_KEYS = Object.keys(POOL_STATS)

/**
 * Hashes input with CRC32 via zlib (fast native binding).
 */
export function defaultHash(input: any): string {
  return crc32(JSON.stringify(input)).toString(16)
}

export function sanitizeBinding(value: any): any {
  switch (typeof value) {
    case 'boolean':
    case 'number':
      return value
    case 'string':
      return `string<${value.length}>`
    case 'bigint':
    case 'symbol':
      return `${typeof value}<<${value.toString()}>>`
    case 'undefined':
    case 'function':
      return `<<${value}>>`
    case 'object': {
      if (value === null) {
        return null
      }
      if (Array.isArray(value)) {
        return value.map(sanitizeBinding)
      }
      if (value !== null && Object.getPrototypeOf(value) === Object.prototype) {
        const result: Record<string, any> = {}
        for (const [k, v] of Object.entries(value)) {
          result[k] = sanitizeBinding(v)
        }
        return result
      }
      return `<<Object#${value?.constructor?.name ?? 'unknown'}>>`
    }
  }
}

export function sanitizeBindings(bindings: any[]): string {
  return JSON.stringify(bindings.map(sanitizeBinding))
}

const hasInstrumentedKey = '__opin_tel_init'

/**
 * Initializes knex query event listener that enriches active OTel spans
 * with connection ID, TX ID, pool stats, and sanitized bindings.
 *
 * Returns a cleanup function to remove the listener.
 */
export function otelInitKnex(
  knexInstance: any,
  config?: KnexOtelConfig,
): () => void {
  if (!knexInstance) {
    debug('passed undefined knexInstance')
    return () => {}
  }
  if (knexInstance[hasInstrumentedKey]) {
    debug('skipping init on instrumented instance')
    return () => {}
  }
  Object.defineProperty(knexInstance, hasInstrumentedKey, { value: true })

  const hashFn = config?.hashFn ?? defaultHash
  const sanitizeFn = config?.sanitizeBindingsFn ?? sanitizeBindings
  const captureBindings = config?.captureBindings ?? true
  const capturePoolStats = config?.capturePoolStats ?? true
  const queryHook = config?.queryHook

  debug('attaching knex query listener')

  function onQuery(info: KnexQueryInfo) {
    const span = trace.getActiveSpan()
    if (!span) {
      debug('no active span for query: %s', info.sql?.slice(0, 80))
      return
    }

    const toSet: Record<string, any> = {
      [ATTRS.CONNECTION_ID]: info.__knexUid.replace('__knexUid', ''),
    }

    if (info.__knexTxId) {
      toSet[ATTRS.TX_ID] = info.__knexTxId
    }

    if (capturePoolStats) {
      for (const poolMethod of POOL_STAT_KEYS) {
        const value = knexInstance.client?.pool?.[poolMethod]?.() ?? undefined
        if (value != null) {
          toSet[POOL_STATS[poolMethod]] = value
        }
      }
    }

    let stable: StableQueryResult | undefined
    if (info.sql) {
      stable = stabilizeQuery(info.sql)
      toSet[ATTRS.STABLE_QUERY] = stable.stableQuery
      toSet[ATTRS.STABLE_QUERY_HASH] = crc32(stable.stableQuery).toString(16)
      toSet[ATTRS.GROUP_COUNT] = stable.groupCount
      toSet[ATTRS.GROUPED_BINDING_COUNT] = stable.groupedBindingCount
    }

    if (captureBindings && Array.isArray(info.bindings)) {
      toSet[ATTRS.BINDINGS] = sanitizeFn(info.bindings)
      toSet[ATTRS.QUERY_HASH] = hashFn([info.sql, info.bindings])
    }

    span.setAttributes(toSet)

    if (queryHook && info.sql && stable) {
      queryHook({
        sql: info.sql,
        bindings: info.bindings,
        stable,
        setAttribute: (key, value) => span.setAttribute(key, value),
      })
    }
  }

  knexInstance.on('query', onQuery)
  return () => {
    knexInstance.off('query', onQuery)
  }
}
