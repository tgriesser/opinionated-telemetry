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
  metrics: {
    activeSpans: `${prefix}active_spans`,
    activeRootSpans: `${prefix}active_root_spans`,
  },
  meta: {
    isAggregate: `${prefix}meta.is_aggregate`,
    incompleteTrace: `${prefix}meta.incomplete_trace`,
  },
  stuck: {
    isSnapshot: `${prefix}stuck.is_snapshot`,
    durationMs: `${prefix}stuck.duration_ms`,
  },
  code: {
    type: `${prefix}code.type`,
    function: `${prefix}code.function`,
    class: `${prefix}code.class`,
    method: `${prefix}code.method`,
    filename: `${prefix}code.filename`,
  },
  trace: {
    startedSpanCount: `${prefix}trace.started_span_count`,
    capturedSpanCount: `${prefix}trace.captured_span_count`,
  },
  dropped: {
    syncCount: `${prefix}dropped.sync_count`,
    conditionalCount: `${prefix}dropped.conditional_count`,
    aggregatedCount: `${prefix}dropped.aggregated_count`,
  },
  sampled: {
    headCount: `${prefix}sampled.head_count`,
    tailCount: `${prefix}sampled.tail_count`,
    burstCount: `${prefix}sampled.burst_count`,
  },
  agg: {
    count: `${prefix}agg.count`,
    errorCount: `${prefix}agg.error_count`,
    minDurationMs: `${prefix}agg.min_duration_ms`,
    maxDurationMs: `${prefix}agg.max_duration_ms`,
    avgDurationMs: `${prefix}agg.avg_duration_ms`,
    totalDurationMs: `${prefix}agg.total_duration_ms`,
    chunkIndex: `${prefix}agg.chunk_index`,
  },
} as const
