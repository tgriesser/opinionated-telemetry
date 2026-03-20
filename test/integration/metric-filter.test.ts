import { describe, it, expect, afterEach, vi } from 'vitest'
import { metrics } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import {
  AggregationTemporality,
  AggregationType,
} from '@opentelemetry/sdk-metrics'
import { opinionatedTelemetryInit } from '../../src/opinionated-telemetry-init.js'
import { cleanupOtel } from '../helpers.js'

const silentLogger = { warn: vi.fn() }

function createMockMetricExporter(): PushMetricExporter & {
  exported: ResourceMetrics[]
} {
  const exported: ResourceMetrics[] = []
  return {
    exported,
    export(m, cb) {
      exported.push(m)
      cb({ code: 0 })
    },
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    selectAggregation: () => ({ type: AggregationType.DEFAULT }),
  }
}

describe('metricFilter integration', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('metricExporter + metricFilter.drop filters metrics at exporter level', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricExporter: mockExporter,
      metricExportInterval: 100,
      metricFilter: {
        drop: ['drop.*'],
      },
      logger: silentLogger,
    })

    // Create metrics — some should be dropped, some kept
    const meter = metrics.getMeter('test')
    const kept = meter.createObservableGauge('keep.metric')
    const dropped = meter.createObservableGauge('drop.metric')
    meter.addBatchObservableCallback(
      (observer) => {
        observer.observe(kept, 1)
        observer.observe(dropped, 2)
      },
      [kept, dropped],
    )

    // Wait for the periodic reader to export
    await new Promise((r) => setTimeout(r, 300))

    expect(mockExporter.exported.length).toBeGreaterThan(0)

    // Check that only 'keep.metric' made it through
    const allNames = mockExporter.exported.flatMap((rm) =>
      rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
    )
    expect(allNames).toContain('keep.metric')
    expect(allNames).not.toContain('drop.metric')

    await shutdown()
  })

  it('metricFilter.drop with glob works alongside other views', async () => {
    // Simulates the honeycomb case: flatMetricExporterViews create streams
    // for http.* metrics, and metricFilter should still drop them
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricExporter: mockExporter,
      metricExportInterval: 100,
      metricFilter: {
        drop: ['http.*'],
      },
      // Simulate having views that also match http.* metrics
      views: [
        {
          instrumentName: 'http.server.request.duration',
          // This view creates a stream — DROP views can't override it,
          // so FilteringMetricExporter must handle the drop
        },
      ],
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const httpMetric = meter.createObservableGauge(
      'http.server.request.duration',
    )
    const nodeMetric = meter.createObservableGauge('node.heap.used_mb')
    meter.addBatchObservableCallback(
      (observer) => {
        observer.observe(httpMetric, 100)
        observer.observe(nodeMetric, 256)
      },
      [httpMetric, nodeMetric],
    )

    await new Promise((r) => setTimeout(r, 300))

    expect(mockExporter.exported.length).toBeGreaterThan(0)

    const allNames = mockExporter.exported.flatMap((rm) =>
      rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
    )
    expect(allNames).toContain('node.heap.used_mb')
    expect(allNames).not.toContain('http.server.request.duration')

    await shutdown()
  })

  it('metricFilter.allow keeps only matching metrics', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricExporter: mockExporter,
      metricExportInterval: 100,
      metricFilter: {
        allow: ['keep.*'],
      },
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const kept = meter.createObservableGauge('keep.metric')
    const dropped = meter.createObservableGauge('other.metric')
    meter.addBatchObservableCallback(
      (observer) => {
        observer.observe(kept, 1)
        observer.observe(dropped, 2)
      },
      [kept, dropped],
    )

    await new Promise((r) => setTimeout(r, 300))

    expect(mockExporter.exported.length).toBeGreaterThan(0)

    const allNames = mockExporter.exported.flatMap((rm) =>
      rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
    )
    expect(allNames).toContain('keep.metric')
    expect(allNames).not.toContain('other.metric')

    await shutdown()
  })

  it('metricFilter with regex works via metricExporter path', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricExporter: mockExporter,
      metricExportInterval: 100,
      metricFilter: {
        drop: [/^drop\./],
      },
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const kept = meter.createObservableGauge('keep.metric')
    const dropped = meter.createObservableGauge('drop.metric')
    meter.addBatchObservableCallback(
      (observer) => {
        observer.observe(kept, 1)
        observer.observe(dropped, 2)
      },
      [kept, dropped],
    )

    await new Promise((r) => setTimeout(r, 300))

    const allNames = mockExporter.exported.flatMap((rm) =>
      rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
    )
    expect(allNames).toContain('keep.metric')
    expect(allNames).not.toContain('drop.metric')

    await shutdown()
  })

  it('throws when both metricExporter and metricReaders are provided', () => {
    expect(() =>
      opinionatedTelemetryInit({
        serviceName: 'test',
        traceExporter: new InMemorySpanExporter(),
        instrumentations: [],
        metricExporter: createMockMetricExporter(),
        metricReaders: [],
        logger: silentLogger,
      }),
    ).toThrow('Cannot use both metricExporter and metricReaders')
  })

  it('warns when metricFilter has non-string patterns without metricExporter', () => {
    const warn = vi.fn()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricFilter: {
        drop: [/^http\./],
      },
      logger: { warn },
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('requires metricExporter'),
    )

    shutdown()
  })
})
