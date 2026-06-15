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
import { honeycombInit } from '../../src/honeycomb.js'
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

function exportedNames(exporter: { exported: ResourceMetrics[] }): string[] {
  return exporter.exported.flatMap((rm) =>
    rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
  )
}

function fakeRuntimeNode() {
  return {
    instrumentationName: '@opentelemetry/instrumentation-runtime-node',
    instrumentationVersion: '0.0.0',
    disable: vi.fn(),
    enable: vi.fn(),
    setTracerProvider: vi.fn(),
    setMeterProvider: vi.fn(),
    setLoggerProvider: vi.fn(),
    setConfig: vi.fn(),
    getConfig: vi.fn(() => ({ enabled: true })),
  }
}

describe('honeycombInit opinionated defaults', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('defaults http and processor metric sources off, runtime on', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = honeycombInit({
      serviceName: 'test',
      apiKey: 'test',
      instrumentations: [],
      // Supplying both exporters avoids any real Honeycomb network calls.
      traceExporter: new InMemorySpanExporter(),
      metricExporter: mockExporter,
      metricExportInterval: 100,
      shutdownSignal: null,
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const httpMetric = meter.createObservableGauge('http.server.duration')
    meter.addBatchObservableCallback(
      (o) => o.observe(httpMetric, 1),
      [httpMetric],
    )

    await new Promise((r) => setTimeout(r, 300))
    const names = exportedNames(mockExporter)

    expect(names).not.toContain('http.server.duration') // http source off
    expect(names.some((n) => n.startsWith('opin_tel.processor'))).toBe(false) // processor off
    expect(names.some((n) => n.startsWith('node.'))).toBe(true) // runtime still on

    await shutdown()
  })

  it('honors explicit metricSources overrides', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = honeycombInit({
      serviceName: 'test',
      apiKey: 'test',
      instrumentations: [],
      traceExporter: new InMemorySpanExporter(),
      metricExporter: mockExporter,
      metricExportInterval: 100,
      shutdownSignal: null,
      metricSources: { http: true }, // opt http back in; processor stays off
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const httpMetric = meter.createObservableGauge('http.server.duration')
    meter.addBatchObservableCallback(
      (o) => o.observe(httpMetric, 1),
      [httpMetric],
    )

    await new Promise((r) => setTimeout(r, 300))
    const names = exportedNames(mockExporter)

    expect(names).toContain('http.server.duration') // override won
    expect(names.some((n) => n.startsWith('opin_tel.processor'))).toBe(false) // still off

    await shutdown()
  })

  it('disables runtime-node by default, without warning', async () => {
    const inst = fakeRuntimeNode()
    const logger = { warn: vi.fn() }
    const { shutdown } = honeycombInit({
      serviceName: 'test',
      apiKey: 'test',
      instrumentations: [inst as any],
      traceExporter: new InMemorySpanExporter(),
      metricExporter: createMockMetricExporter(),
      metricExportInterval: 60_000,
      shutdownSignal: null,
      logger,
    })

    expect(inst.disable).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'Disabled @opentelemetry/instrumentation-runtime-node',
      ),
    )

    await shutdown()
  })
})
