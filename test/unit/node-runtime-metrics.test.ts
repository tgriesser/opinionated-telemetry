import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { metrics } from '@opentelemetry/api'
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'
import { NodeRuntimeMetrics } from '../../src/node-runtime-metrics.js'

function createTestMeterProvider() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000, // manual flush only
  })
  const provider = new MeterProvider({
    readers: [reader],
  })
  // Register globally so default meter works
  metrics.setGlobalMeterProvider(provider)

  return {
    provider,
    exporter,
    reader,
    async collectAndGetMetrics() {
      await reader.forceFlush()
      return exporter.getMetrics()
    },
  }
}

describe('NodeRuntimeMetrics', () => {
  let provider: MeterProvider
  let cleanup: ReturnType<typeof createTestMeterProvider>

  beforeEach(() => {
    cleanup = createTestMeterProvider()
    provider = cleanup.provider
  })

  afterEach(async () => {
    metrics.disable()
    await cleanup.provider.shutdown()
  })

  it('registers all 18 metrics with default config', async () => {
    const rtm = new NodeRuntimeMetrics()
    rtm.start()

    // Small delay so CPU delta calculation has a non-zero elapsed time
    await new Promise((r) => setTimeout(r, 20))

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricNames = new Set<string>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          metricNames.add(m.descriptor.name)
        }
      }
    }

    const expectedNames = [
      'node.eventloop.delay.p50',
      'node.eventloop.delay.p99',
      'node.eventloop.delay.max',
      'node.heap.used_mb',
      'node.heap.total_mb',
      'node.heap.used_pct',
      'node.gc.major.count',
      'node.gc.major.avg_ms',
      'node.gc.major.max_ms',
      'node.gc.major.p99_ms',
      'node.handles',
      'node.requests',
      'node.cpu.user_pct',
      'node.cpu.system_pct',
      'node.cpu.total_pct',
      'node.memory.rss_mb',
      'node.memory.external_mb',
      'node.memory.array_buffers_mb',
    ]

    for (const name of expectedNames) {
      expect(metricNames, `missing metric: ${name}`).toContain(name)
    }
    expect(metricNames.size).toBe(18)

    rtm.stop()
  })

  it('supports custom prefix', async () => {
    const rtm = new NodeRuntimeMetrics({ prefix: 'app' })
    rtm.start()

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricNames = new Set<string>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          metricNames.add(m.descriptor.name)
        }
      }
    }

    expect(metricNames).toContain('app.heap.used_mb')
    expect(metricNames).not.toContain('node.heap.used_mb')

    rtm.stop()
  })

  it('selectively disables metric groups', async () => {
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        gc: false,
        cpu: false,
      },
    })
    rtm.start()

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricNames = new Set<string>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          metricNames.add(m.descriptor.name)
        }
      }
    }

    // Should have heap (3) + handles/requests (2) + memory (3) = 8
    expect(metricNames).toContain('node.heap.used_mb')
    expect(metricNames).toContain('node.handles')
    expect(metricNames).toContain('node.memory.rss_mb')
    expect(metricNames).not.toContain('node.eventloop.delay.p50')
    expect(metricNames).not.toContain('node.gc.major.count')
    expect(metricNames).not.toContain('node.cpu.user_pct')
    expect(metricNames.size).toBe(8)

    rtm.stop()
  })

  it('start is idempotent', async () => {
    const rtm = new NodeRuntimeMetrics()
    rtm.start()
    rtm.start() // should not throw or register duplicates

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricNames: string[] = []
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          metricNames.push(m.descriptor.name)
        }
      }
    }

    // No duplicate metric names — second start() was a no-op
    expect(new Set(metricNames).size).toBe(metricNames.length)

    rtm.stop()
  })

  it('stop is idempotent', () => {
    const rtm = new NodeRuntimeMetrics()
    rtm.start()
    rtm.stop()
    rtm.stop() // should not throw
  })

  it('stop before start is safe', () => {
    const rtm = new NodeRuntimeMetrics()
    rtm.stop() // should not throw
  })

  it('heap metrics return reasonable values', async () => {
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        gc: false,
        handlesRequests: false,
        cpu: false,
        memory: false,
      },
    })
    rtm.start()

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricValues = new Map<string, number>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          const dp = m.dataPoints[0]
          if (dp) metricValues.set(m.descriptor.name, dp.value as number)
        }
      }
    }

    const heapUsed = metricValues.get('node.heap.used_mb')!
    const heapTotal = metricValues.get('node.heap.total_mb')!
    const heapPct = metricValues.get('node.heap.used_pct')!

    expect(heapUsed).toBeGreaterThan(0)
    expect(heapTotal).toBeGreaterThan(0)
    expect(heapUsed).toBeLessThanOrEqual(heapTotal)
    expect(heapPct).toBeGreaterThan(0)
    expect(heapPct).toBeLessThanOrEqual(100)

    rtm.stop()
  })

  it('cpu metrics return non-negative values', async () => {
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        heap: false,
        gc: false,
        handlesRequests: false,
        memory: false,
      },
    })
    rtm.start()

    // Wait a bit so there's a time delta for CPU calculation
    await new Promise((r) => setTimeout(r, 50))

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricValues = new Map<string, number>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          const dp = m.dataPoints[0]
          if (dp) metricValues.set(m.descriptor.name, dp.value as number)
        }
      }
    }

    expect(metricValues.get('node.cpu.user_pct')).toBeGreaterThanOrEqual(0)
    expect(metricValues.get('node.cpu.system_pct')).toBeGreaterThanOrEqual(0)
    expect(metricValues.get('node.cpu.total_pct')).toBeGreaterThanOrEqual(0)

    rtm.stop()
  })

  it('accepts a custom meter', async () => {
    const meter = provider.getMeter('custom-meter')
    const rtm = new NodeRuntimeMetrics({
      meter,
      enable: {
        eventLoopDelay: false,
        gc: false,
        cpu: false,
        handlesRequests: false,
        memory: false,
      },
    })
    rtm.start()

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const scopeNames = new Set<string>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        scopeNames.add(sm.scope.name)
      }
    }

    expect(scopeNames).toContain('custom-meter')

    rtm.stop()
  })
})
