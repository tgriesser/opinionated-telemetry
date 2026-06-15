import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { metrics } from '@opentelemetry/api'
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  DataPointType,
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

  it('registers the expected runtime metrics with default config', async () => {
    // A ref'd timer guarantees getActiveResourcesInfo() is non-empty, so
    // node.active_resources reliably exports during the test.
    const keepAlive = setTimeout(() => {}, 10_000)
    // Short sample interval so the CPU/ELU histograms (interval deltas) record
    // at least once before we collect.
    const rtm = new NodeRuntimeMetrics({ sampleIntervalMs: 5 })
    rtm.start()

    await new Promise((r) => setTimeout(r, 40))

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricNames = new Set<string>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          metricNames.add(m.descriptor.name)
        }
      }
    }

    // GC is a histogram that only exports once a major GC has fired, so it's
    // verified separately below.
    const expectedNames = [
      'node.eventloop.delay.p50',
      'node.eventloop.delay.p99',
      'node.eventloop.delay.max',
      'node.eventloop.utilization',
      'node.heap.used_mib',
      'node.heap.total_mib',
      'node.heap.used_pct',
      'node.active_resources',
      'node.cpu.user_pct',
      'node.cpu.system_pct',
      'node.cpu.total_pct',
      'node.memory.rss_mib',
      'node.memory.external_mib',
      'node.memory.array_buffers_mib',
    ]

    for (const name of expectedNames) {
      expect(metricNames, `missing metric: ${name}`).toContain(name)
    }
    // The GC histogram may or may not have fired during the test — exclude it
    // so the count assertion stays deterministic.
    metricNames.delete('node.gc.major.duration')
    expect(metricNames.size).toBe(14)

    clearTimeout(keepAlive)
    rtm.stop()
  })

  it('records major GC durations into a histogram', async () => {
    if (typeof global.gc !== 'function') {
      // Requires running node with --expose-gc; skip otherwise.
      return
    }

    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        eventLoopUtilization: false,
        heap: false,
        activeResources: false,
        cpu: false,
        memory: false,
      },
    })
    rtm.start()

    global.gc()
    // GC PerformanceObserver entries are delivered asynchronously.
    await new Promise((r) => setTimeout(r, 20))

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    let gcMetric: { dataPointType: DataPointType } | undefined
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          if (m.descriptor.name === 'node.gc.major.duration') {
            gcMetric = m
          }
        }
      }
    }

    expect(gcMetric, 'expected node.gc.major.duration histogram').toBeDefined()
    expect(gcMetric!.dataPointType).toBe(DataPointType.HISTOGRAM)

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

    expect(metricNames).toContain('app.heap.used_mib')
    expect(metricNames).not.toContain('node.heap.used_mib')

    rtm.stop()
  })

  it('selectively disables metric groups', async () => {
    const keepAlive = setTimeout(() => {}, 10_000)
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        eventLoopUtilization: false,
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

    // Should have heap (3) + active_resources (1) + memory (3) = 7
    expect(metricNames).toContain('node.heap.used_mib')
    expect(metricNames).toContain('node.active_resources')
    expect(metricNames).toContain('node.memory.rss_mib')
    expect(metricNames).not.toContain('node.eventloop.delay.p50')
    expect(metricNames).not.toContain('node.eventloop.utilization')
    expect(metricNames).not.toContain('node.gc.major.duration')
    expect(metricNames).not.toContain('node.cpu.user_pct')
    expect(metricNames.size).toBe(7)

    clearTimeout(keepAlive)
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

  it('heap metrics record reasonable histogram values', async () => {
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        eventLoopUtilization: false,
        gc: false,
        activeResources: false,
        cpu: false,
        memory: false,
      },
    })
    rtm.start()

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const hist = new Map<
      string,
      { count: number; min?: number; max?: number }
    >()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          const dp = m.dataPoints[0]
          if (dp) hist.set(m.descriptor.name, dp.value as never)
        }
      }
    }

    const heapUsed = hist.get('node.heap.used_mib')!
    const heapTotal = hist.get('node.heap.total_mib')!
    const heapPct = hist.get('node.heap.used_pct')!

    // The sampler seeds one sample at start(), so each histogram has ≥1 value.
    expect(heapUsed.count).toBeGreaterThan(0)
    expect(heapUsed.max!).toBeGreaterThan(0)
    expect(heapTotal.max!).toBeGreaterThan(0)
    expect(heapUsed.max!).toBeLessThanOrEqual(heapTotal.max!)
    // used_pct is now measured against the V8 heap limit → never exceeds 100%
    expect(heapPct.max!).toBeGreaterThan(0)
    expect(heapPct.max!).toBeLessThanOrEqual(100)

    rtm.stop()
  })

  it('cpu metrics record non-negative histogram values', async () => {
    const rtm = new NodeRuntimeMetrics({
      sampleIntervalMs: 5,
      enable: {
        eventLoopDelay: false,
        eventLoopUtilization: false,
        heap: false,
        gc: false,
        activeResources: false,
        memory: false,
      },
    })
    rtm.start()

    // Wait for a few sample ticks (CPU% is an interval delta → needs ≥1 tick)
    await new Promise((r) => setTimeout(r, 40))

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const hist = new Map<string, { count: number; min?: number }>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          const dp = m.dataPoints[0]
          if (dp) hist.set(m.descriptor.name, dp.value as never)
        }
      }
    }

    const user = hist.get('node.cpu.user_pct')
    const system = hist.get('node.cpu.system_pct')
    const total = hist.get('node.cpu.total_pct')
    expect(user?.count).toBeGreaterThan(0)
    // CPU deltas are monotonic → percentages are never negative
    expect(user!.min!).toBeGreaterThanOrEqual(0)
    expect(system!.min!).toBeGreaterThanOrEqual(0)
    expect(total!.min!).toBeGreaterThanOrEqual(0)

    rtm.stop()
  })

  it('scales histogram bucket boundaries to each metric (ELU fits 0-1)', async () => {
    const rtm = new NodeRuntimeMetrics({
      sampleIntervalMs: 5,
      enable: {
        eventLoopDelay: false,
        heap: false,
        gc: false,
        activeResources: false,
        cpu: false,
        memory: false,
      },
    })
    rtm.start()
    await new Promise((r) => setTimeout(r, 40))

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    let boundaries: number[] | undefined
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          if (m.descriptor.name === 'node.eventloop.utilization') {
            boundaries = (
              m.dataPoints[0]?.value as { buckets?: { boundaries: number[] } }
            )?.buckets?.boundaries
          }
        }
      }
    }

    expect(boundaries).toBeDefined()
    // Not the OTel defaults (which top out at 10000) — ELU is a 0-1 ratio, so
    // its boundaries must fit that range to give any percentile resolution.
    expect(Math.max(...boundaries!)).toBeLessThanOrEqual(1)
    expect(boundaries!.length).toBeGreaterThan(5)

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
        activeResources: false,
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

  it('produces no metrics when started before global MeterProvider is registered', async () => {
    // Tear down the provider registered in beforeEach so we start clean
    metrics.disable()
    await cleanup.provider.shutdown()

    // Start runtime metrics BEFORE any MeterProvider is registered globally —
    // metrics.getMeter() returns a NoopMeter, so nothing is collected
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        eventLoopUtilization: false,
        gc: false,
        cpu: false,
      },
    })
    rtm.start()

    // Now register the real provider (simulating the ordering bug)
    cleanup = createTestMeterProvider()
    provider = cleanup.provider

    const resourceMetrics = await cleanup.collectAndGetMetrics()
    const metricNames = new Set<string>()
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          metricNames.add(m.descriptor.name)
        }
      }
    }

    // The gauges were registered on a NoopMeter — nothing shows up
    expect(metricNames.size).toBe(0)

    rtm.stop()
  })

  it('produces metrics when started after global MeterProvider is registered', async () => {
    const keepAlive = setTimeout(() => {}, 10_000)
    // cleanup.provider is already registered globally from beforeEach
    const rtm = new NodeRuntimeMetrics({
      enable: {
        eventLoopDelay: false,
        eventLoopUtilization: false,
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

    // heap (3) + active_resources (1) + memory (3) = 7
    expect(metricNames.size).toBe(7)
    expect(metricNames).toContain('node.heap.used_mib')
    expect(metricNames).toContain('node.active_resources')
    expect(metricNames).toContain('node.memory.rss_mib')

    clearTimeout(keepAlive)
    rtm.stop()
  })
})
