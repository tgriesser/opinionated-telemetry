import { env } from 'node:process'
export const OPIN_TEL_PREFIX = env.OPIN_TEL_PREFIX ?? 'opin_tel.'
const prefix = OPIN_TEL_PREFIX

export const OPIN_TEL_INTERNAL = {
  memory: {
    rss: `${prefix}memory.rss`,
    heapUsed: `${prefix}memory.heap_used`,
    heapTotal: `${prefix}memory.heap_total`,
    arrayBuffers: `${prefix}memory.array_buffers`,
    external: `${prefix}memory.external`,
  } as const satisfies Record<keyof NodeJS.MemoryUsage, string>,
  memoryDelta: {
    rss: `${prefix}memory_delta.rss`,
    heapUsed: `${prefix}memory_delta.heap_used`,
    heapTotal: `${prefix}memory_delta.heap_total`,
    arrayBuffers: `${prefix}memory_delta.array_buffers`,
    external: `${prefix}memory_delta.external`,
  } as const satisfies Record<keyof NodeJS.MemoryUsage, string>,
  eventLoop: {
    utilization: `${prefix}event_loop.utilization`,
  },
  meta: {
    activeSpans: `${prefix}meta.active_spans`,
    activeRootSpans: `${prefix}meta.active_root_spans`,
    incompleteTrace: `${prefix}meta.incomplete_trace`,
    isAggregate: `${prefix}meta.is_aggregate`,
  },
  stuck: {
    isSnapshot: `${prefix}stuck.is_snapshot`,
    durationMs: `${prefix}stuck.duration_ms`,
  },
  code: {
    function: `${prefix}code.function`,
    filename: `${prefix}code.filename`,
  },
  agg: {
    count: `${prefix}agg.count`,
    errorCount: `${prefix}agg.error_count`,
    minDurationMs: `${prefix}agg.min_duration_ms`,
    maxDurationMs: `${prefix}agg.max_duration_ms`,
    avgDurationMs: `${prefix}agg.avg_duration_ms`,
    totalDurationMs: `${prefix}agg.total_duration_ms`,
  },
} as const
