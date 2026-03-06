export const OPIN_TEL_INTERNAL = {
  memory: {
    rss: 'opin_tel.memory.rss',
    heapUsed: 'opin_tel.memory.heap_used',
    heapTotal: 'opin_tel.memory.heap_total',
    arrayBuffers: 'opin_tel.memory.array_buffers',
    external: 'opin_tel.memory.external',
  } as const satisfies Record<keyof NodeJS.MemoryUsage, string>,
  memoryDelta: {
    rss: 'opin_tel.memory_delta.rss',
    heapUsed: 'opin_tel.memory_delta.heap_used',
    heapTotal: 'opin_tel.memory_delta.heap_total',
    arrayBuffers: 'opin_tel.memory_delta.array_buffers',
    external: 'opin_tel.memory_delta.external',
  } as const satisfies Record<keyof NodeJS.MemoryUsage, string>,
  eventLoop: {
    utilization: 'opin_tel.event_loop.utilization',
  },
  meta: {
    activeSpans: 'open_tel.meta.active_spans',
    activeRootSpans: 'open_tel.meta.active_root_spans',
    incompleteTrace: 'opin_tel.meta.incomplete_trace',
  },
  stuck: {
    isSnapshot: 'opin_tel.stuck.is_snapshot',
    durationMs: 'opin_tel.stuck.duration_ms',
  },
  code: {
    function: 'opin_tel.code.function',
    filename: 'opin_tel.code.filename',
  },
  aggregate: {
    count: 'opin_tel.aggregate.count',
    errorCount: 'opin_tel.aggregate.error_count',
    minDurationMs: 'opin_tel.aggregate.min_duration_ms',
    maxDurationMs: 'opin_tel.aggregate.max_duration_ms',
    avgDurationMs: 'opin_tel.aggregate.avg_duration_ms',
    totalDurationMs: 'opin_tel.aggregate.total_duration_ms',
  },
} as const
