import { crc32 } from 'node:zlib'

export interface StableQueryResult {
  /** The stabilized SQL with collapsed binding groups */
  stableQuery: string
  /** Number of binding groups found */
  groupCount: number
  /** Total number of individual bindings that were collapsed */
  groupedBindingCount: number
}

/**
 * Collapses a single parenthesized binding group to `(_)`.
 * Handles: ?, ?::type, $N, $N::type, DEFAULT
 */
const BINDING_GROUP_RE =
  /\(\s*(?:(?:\?(?:::\w+)?|\$\d+(?:::\w+)?|DEFAULT)(?:\s*,\s*(?:\?(?:::\w+)?|\$\d+(?:::\w+)?|DEFAULT))*)\s*\)/gi

/**
 * Collapses consecutive `(_), (_), ...` into `(_+)`.
 */
const MULTI_GROUP_RE = /\(_\)(?:\s*,\s*\(_\))+/g

/**
 * Normalizes SQL by collapsing variadic binding groups into stable placeholders.
 *
 * - Single binding groups like `(?, ?, ?)` → `(_)`
 * - Multiple consecutive groups like `(_), (_), (_)` → `(_+)`
 * - Handles `?`, `$1`, `?::type`, `$1::type`, and `DEFAULT` placeholders
 */
export function stabilizeQuery(sql: string): StableQueryResult {
  let groupCount = 0
  let groupedBindingCount = 0

  // Step 1: collapse individual binding groups to (_)
  let result = sql.replace(BINDING_GROUP_RE, (match) => {
    groupCount++
    // Count individual bindings in this group
    const bindings = match.slice(1, -1).split(',')
    groupedBindingCount += bindings.length
    return '(_)'
  })

  // Step 2: collapse consecutive (_), (_), ... to (_+)
  result = result.replace(MULTI_GROUP_RE, (_match) => {
    // Count how many groups are being collapsed (already counted in step 1)
    return '(_+)'
  })

  return {
    stableQuery: result,
    groupCount,
    groupedBindingCount,
  }
}

/**
 * CRC32 hash of the raw SQL + actual bindings.
 * Exact cache key for dedup of identical invocations.
 */
export function queryRequestTag(sql: string, bindings?: any[]): string {
  return crc32(JSON.stringify([sql, bindings ?? []])).toString(16)
}

/**
 * CRC32 of the stabilized SQL + sanitized binding types.
 * Groups queries by shape — same query structure with same binding types
 * produce the same tag, regardless of actual values.
 */
export function stableQueryTag(sql: string, bindings?: any[]): string {
  const { stableQuery } = stabilizeQuery(sql)
  const bindingTypes = (bindings ?? []).map((b) => {
    if (b === null) return 'null'
    if (Array.isArray(b)) return 'array'
    return typeof b
  })
  return crc32(JSON.stringify([stableQuery, bindingTypes])).toString(16)
}

/**
 * CRC32 hash of `JSON.stringify(result)`.
 * Optional `maxBytes` truncates the serialized result before hashing.
 */
export function queryResponseTag(result: any, maxBytes?: number): string {
  let serialized = JSON.stringify(result)
  if (maxBytes != null && serialized.length > maxBytes) {
    serialized = serialized.slice(0, maxBytes)
  }
  return crc32(serialized).toString(16)
}

/**
 * CRC32 of just the stabilized query text.
 * For grouping queries by shape regardless of binding count or values.
 */
export function stableQueryHash(sql: string): string {
  return crc32(stabilizeQuery(sql).stableQuery).toString(16)
}
