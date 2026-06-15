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

describe('metricResourceAttributes', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('strips configured resource attribute keys from metrics only', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricExporter: mockExporter,
      metricExportInterval: 100,
      resourceAttributes: {
        'process.command_args': 'a b c',
        'process.executable.path': '/usr/bin/node',
        'keep.me': 'yes',
      },
      metricResourceAttributes: {
        drop: ['process.command_args', /^process\.executable/],
      },
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const gauge = meter.createObservableGauge('some.metric')
    meter.addBatchObservableCallback((o) => o.observe(gauge, 1), [gauge])

    await new Promise((r) => setTimeout(r, 300))

    expect(mockExporter.exported.length).toBeGreaterThan(0)
    const attrs = mockExporter.exported[0].resource.attributes
    // dropped (whether from our explicit attrs or a resource detector)
    expect(attrs).not.toHaveProperty('process.command_args')
    expect(attrs).not.toHaveProperty('process.executable.path')
    // kept
    expect(attrs['service.name']).toBe('test')
    expect(attrs['keep.me']).toBe('yes')

    await shutdown()
  })

  it('warns when used with metricReaders instead of metricExporter', async () => {
    const logger = { warn: vi.fn() }
    const mockExporter = createMockMetricExporter()
    const { PeriodicExportingMetricReader } =
      await import('@opentelemetry/sdk-metrics')
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: mockExporter,
          exportIntervalMillis: 100,
        }),
      ],
      metricResourceAttributes: { drop: ['process.command_args'] },
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'metricResourceAttributes requires the metricExporter path',
      ),
    )
    await shutdown()
  })
})
