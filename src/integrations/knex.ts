import { crc32 } from 'node:zlib'
import { trace } from '@opentelemetry/api'
import debugLib from 'debug'

const debug = debugLib('opin-tel:knex')

export interface KnexOtelConfig {
  /** Custom hash function for query+bindings. Default uses CRC32 */
  hashFn?: (input: any) => string
  /** Custom function to sanitize a single binding value */
  sanitizeBindingFn?: (value: any) => any
  /** Custom function to sanitize an array of bindings into a string */
  sanitizeBindingsFn?: (bindings: any[]) => string
  /** Capture sanitized bindings. Default: true */
  captureBindings?: boolean
  /** Capture pool stats. Default: true */
  capturePoolStats?: boolean
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
      return `Bigint<${value.toString()}>`
    case 'undefined':
    case 'symbol':
    case 'function':
      return `<<${value}>>`
    case 'object': {
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
  const hashFn = config?.hashFn ?? defaultHash
  const sanitizeFn = config?.sanitizeBindingsFn ?? sanitizeBindings
  const captureBindings = config?.captureBindings ?? true
  const capturePoolStats = config?.capturePoolStats ?? true

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

    if (captureBindings && Array.isArray(info.bindings)) {
      toSet[ATTRS.BINDINGS] = sanitizeFn(info.bindings)
      toSet[ATTRS.QUERY_HASH] = hashFn([info.sql, info.bindings])
    }

    span.setAttributes(toSet)
  }

  knexInstance.on('query', onQuery)
  return () => {
    knexInstance.off('query', onQuery)
  }
}
