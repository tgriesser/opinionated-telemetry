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
} as const
