import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { context, metrics, trace } from '@opentelemetry/api'
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'
import { createTestProvider, cleanupOtel, nextTick } from '../helpers.js'

function createTestMeterProvider() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  })
  const provider = new MeterProvider({ readers: [reader] })
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

/** Collect metrics and return a name→value map from the latest resource metrics */
async function getMetricValues(
  meterSetup: ReturnType<typeof createTestMeterProvider>,
) {
  const resourceMetrics = await meterSetup.collectAndGetMetrics()
  const result = new Map<string, number>()
  for (const rm of resourceMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        const dp = m.dataPoints[m.dataPoints.length - 1]
        if (dp) result.set(m.descriptor.name, dp.value as number)
      }
    }
  }
  return result
}

describe('processor meta metrics', () => {
  let meterSetup: ReturnType<typeof createTestMeterProvider>

  beforeEach(() => {
    meterSetup = createTestMeterProvider()
  })

  afterEach(async () => {
    metrics.disable()
    await meterSetup.provider.shutdown()
    cleanupOtel()
  })

  it('registers all expected metric names', async () => {
    const { processor } = createTestProvider({ stuckSpanDetection: false })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    const vals = await getMetricValues(meterSetup)
    const names = [...vals.keys()]

    const expected = [
      'opin_tel.processor.spans.active',
      'opin_tel.processor.spans.active.max',
      'opin_tel.processor.spans.active.min',
      'opin_tel.processor.traces.active',
      'opin_tel.processor.traces.active.max',
      'opin_tel.processor.traces.active.min',
      'opin_tel.processor.tail_buffer.traces',
      'opin_tel.processor.tail_buffer.traces.max',
      'opin_tel.processor.tail_buffer.traces.min',
      'opin_tel.processor.tail_buffer.spans',
      'opin_tel.processor.tail_buffer.spans.max',
      'opin_tel.processor.tail_buffer.spans.min',
      'opin_tel.processor.stuck_spans',
      'opin_tel.processor.aggregate_groups',
      'opin_tel.processor.conditional_drop_buffers',
      'opin_tel.processor.spans.started',
      'opin_tel.processor.spans.exported',
      'opin_tel.processor.spans.dropped.sync',
      'opin_tel.processor.spans.dropped.conditional',
      'opin_tel.processor.spans.dropped.aggregated',
      'opin_tel.processor.spans.dropped.head',
      'opin_tel.processor.spans.dropped.tail',
      'opin_tel.processor.spans.dropped.burst',
      'opin_tel.processor.spans.dropped.stuck',
    ]

    for (const name of expected) {
      expect(names, `missing metric: ${name}`).toContain(name)
    }
  })

  it('tracks active spans with watermarks', async () => {
    const { tracer, processor, shutdown } = createTestProvider({
      dropSyncSpans: false,
      stuckSpanDetection: false,
    })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    // Start 4 spans (root + 3 children), then end 1
    const root = tracer.startSpan('root')
    const ctx = trace.setSpan(context.active(), root)
    const child1 = tracer.startSpan('child1', {}, ctx)
    const child2 = tracer.startSpan('child2', {}, ctx)
    const child3 = tracer.startSpan('child3', {}, ctx)
    // Peak: 4 active (root + 3 children)

    child1.end()
    // Now 3 active — min is 0 (from initialization) since we started from 0

    const vals = await getMetricValues(meterSetup)
    expect(vals.get('opin_tel.processor.spans.active')).toBe(3)
    expect(vals.get('opin_tel.processor.spans.active.max')).toBe(4)
    expect(vals.get('opin_tel.processor.spans.active.min')).toBe(0) // started from 0

    child2.end()
    child3.end()
    root.end()
    await shutdown()
  })

  it('tracks active traces with watermarks', async () => {
    const { tracer, processor, shutdown } = createTestProvider({
      dropSyncSpans: false,
      stuckSpanDetection: false,
    })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    const root1 = tracer.startSpan('root1')
    const root2 = tracer.startSpan('root2')
    // Peak: 2 traces

    root1.end()
    // Now 1 trace — min is 0 (from initialization)

    const vals = await getMetricValues(meterSetup)
    expect(vals.get('opin_tel.processor.traces.active')).toBe(1)
    expect(vals.get('opin_tel.processor.traces.active.max')).toBe(2)
    expect(vals.get('opin_tel.processor.traces.active.min')).toBe(0)

    root2.end()
    await shutdown()
  })

  it('tracks throughput counters and resets on observation', async () => {
    const { tracer, processor, shutdown } = createTestProvider({
      dropSyncSpans: true,
      stuckSpanDetection: false,
    })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    // Create root + child where child is sync-dropped
    const root = tracer.startSpan('root')
    const ctx = trace.setSpan(context.active(), root)
    const child = tracer.startSpan('child', {}, ctx)
    child.end() // sync drop (same tick, has parent)
    await nextTick()
    root.end()

    const vals = await getMetricValues(meterSetup)
    expect(vals.get('opin_tel.processor.spans.started')).toBe(2)
    expect(vals.get('opin_tel.processor.spans.exported')).toBe(1) // only root
    expect(vals.get('opin_tel.processor.spans.dropped.sync')).toBe(1)

    // Second observation — counters should have reset
    const vals2 = await getMetricValues(meterSetup)
    expect(vals2.get('opin_tel.processor.spans.started')).toBe(0)
    expect(vals2.get('opin_tel.processor.spans.exported')).toBe(0)
    expect(vals2.get('opin_tel.processor.spans.dropped.sync')).toBe(0)

    await shutdown()
  })

  it('watermarks reset to current after observation', async () => {
    const { tracer, processor, shutdown } = createTestProvider({
      dropSyncSpans: false,
      stuckSpanDetection: false,
    })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    // Interval 1: start from 0, peak at 3, settle at 1
    const root = tracer.startSpan('root')
    const ctx = trace.setSpan(context.active(), root)
    const c1 = tracer.startSpan('c1', {}, ctx)
    const c2 = tracer.startSpan('c2', {}, ctx)
    c1.end()
    c2.end()
    // current=1 (root), max=3, min=0 (started from 0)

    const vals1 = await getMetricValues(meterSetup)
    expect(vals1.get('opin_tel.processor.spans.active')).toBe(1)
    expect(vals1.get('opin_tel.processor.spans.active.max')).toBe(3)
    expect(vals1.get('opin_tel.processor.spans.active.min')).toBe(0)

    // After observation, watermarks reset to current=1
    // Interval 2: no changes → max=1, min=1
    const vals2 = await getMetricValues(meterSetup)
    expect(vals2.get('opin_tel.processor.spans.active')).toBe(1)
    expect(vals2.get('opin_tel.processor.spans.active.max')).toBe(1)
    expect(vals2.get('opin_tel.processor.spans.active.min')).toBe(1)

    root.end()
    await shutdown()
  })

  it('tracks head sampling drops', async () => {
    const { tracer, processor, shutdown } = createTestProvider({
      dropSyncSpans: false,
      stuckSpanDetection: false,
      sampling: {
        head: { sample: () => 1_000_000 }, // drop nearly everything
      },
    })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    const root = tracer.startSpan('root')
    const ctx = trace.setSpan(context.active(), root)
    const child = tracer.startSpan('child', {}, ctx)
    await nextTick()
    child.end()
    root.end()

    const vals = await getMetricValues(meterSetup)
    expect(vals.get('opin_tel.processor.spans.started')).toBe(2)
    // With rate=1000000, almost certainly dropped
    expect(
      vals.get('opin_tel.processor.spans.dropped.head')!,
    ).toBeGreaterThanOrEqual(1)

    await shutdown()
  })

  it('tracks snapshot gauges (aggregate groups, conditional drop buffers)', async () => {
    const { processor } = createTestProvider({
      stuckSpanDetection: false,
    })
    processor.registerMetrics(metrics.getMeter('opin_tel.processor'))

    // Just verify they report 0 when nothing is happening
    const vals = await getMetricValues(meterSetup)
    expect(vals.get('opin_tel.processor.stuck_spans')).toBe(0)
    expect(vals.get('opin_tel.processor.aggregate_groups')).toBe(0)
    expect(vals.get('opin_tel.processor.conditional_drop_buffers')).toBe(0)
  })
})
