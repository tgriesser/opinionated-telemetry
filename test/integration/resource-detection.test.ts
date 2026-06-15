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

async function collectResourceAttrs(autoDetectResources: boolean | undefined) {
  const mockExporter = createMockMetricExporter()
  const { shutdown } = opinionatedTelemetryInit({
    serviceName: 'test',
    traceExporter: new InMemorySpanExporter(),
    instrumentations: [],
    autoDetectResources,
    runtimeMetrics: false,
    processorMetrics: false,
    metricExporter: mockExporter,
    metricExportInterval: 100,
    logger: silentLogger,
  })

  const meter = metrics.getMeter('test')
  const gauge = meter.createObservableGauge('some.metric')
  meter.addBatchObservableCallback((o) => o.observe(gauge, 1), [gauge])

  await new Promise((r) => setTimeout(r, 300))
  const attrs = mockExporter.exported[0]?.resource.attributes ?? {}
  await shutdown()
  return attrs
}

describe('autoDetectResources forwarding', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('runs resource detectors by default (host/process attrs present)', async () => {
    const attrs = await collectResourceAttrs(undefined)
    expect(attrs['service.name']).toBe('test')
    // host/process detectors populate these synchronously at SDK start
    expect(attrs).toHaveProperty('process.pid')
  })

  it('skips resource detectors when autoDetectResources is false', async () => {
    const attrs = await collectResourceAttrs(false)
    expect(attrs['service.name']).toBe('test')
    expect(attrs).not.toHaveProperty('process.pid')
    expect(attrs).not.toHaveProperty('host.name')
  })
})

describe('idGenerator forwarding', () => {
  afterEach(async () => {
    cleanupOtel()
  })

  it('uses a custom idGenerator for span/trace ids', async () => {
    const FIXED_TRACE = '0af7651916cd43dd8448eb211c80319c'
    const FIXED_SPAN = 'b7ad6b7169203331'
    const { getTracer, shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      idGenerator: {
        generateTraceId: () => FIXED_TRACE,
        generateSpanId: () => FIXED_SPAN,
      },
      logger: silentLogger,
    })

    const span = getTracer('t').startSpan('s')
    expect(span.spanContext().traceId).toBe(FIXED_TRACE)
    expect(span.spanContext().spanId).toBe(FIXED_SPAN)
    span.end()

    await shutdown()
  })
})
