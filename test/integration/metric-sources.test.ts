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

function exportedNames(exporter: { exported: ResourceMetrics[] }): string[] {
  return exporter.exported.flatMap((rm) =>
    rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
  )
}

describe('metricSources integration', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('metricSources.processor false suppresses processor metrics', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      metricSources: { processor: false },
      metricExporter: mockExporter,
      metricExportInterval: 100,
      logger: silentLogger,
    })

    await new Promise((r) => setTimeout(r, 300))
    expect(
      exportedNames(mockExporter).some((n) =>
        n.startsWith('opin_tel.processor'),
      ),
    ).toBe(false)
    await shutdown()
  })

  it('metricSources.runtime false suppresses node runtime metrics', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown, runtimeMetrics } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      processorMetrics: false,
      metricSources: { runtime: false },
      metricExporter: mockExporter,
      metricExportInterval: 100,
      logger: silentLogger,
    })

    expect(runtimeMetrics).toBeUndefined()
    await new Promise((r) => setTimeout(r, 300))
    expect(exportedNames(mockExporter).some((n) => n.startsWith('node.'))).toBe(
      false,
    )
    await shutdown()
  })

  it('metricSources.http false drops http.* instruments via DROP views', async () => {
    const mockExporter = createMockMetricExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricSources: { http: false },
      metricExporter: mockExporter,
      metricExportInterval: 100,
      logger: silentLogger,
    })

    const meter = metrics.getMeter('test')
    const httpMetric = meter.createObservableGauge('http.server.duration')
    const keep = meter.createObservableGauge('keep.metric')
    meter.addBatchObservableCallback(
      (observer) => {
        observer.observe(httpMetric, 1)
        observer.observe(keep, 1)
      },
      [httpMetric, keep],
    )

    await new Promise((r) => setTimeout(r, 300))
    const names = exportedNames(mockExporter)
    expect(names).toContain('keep.metric')
    expect(names).not.toContain('http.server.duration')
    await shutdown()
  })
})
