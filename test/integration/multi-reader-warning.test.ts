import { describe, it, expect, afterEach, vi } from 'vitest'
import { metrics } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import {
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'
import { opinionatedTelemetryInit } from '../../src/opinionated-telemetry-init.js'
import { cleanupOtel } from '../helpers.js'

function reader() {
  return new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000,
  })
}

describe('multiple metric readers warning', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('warns when more than one metric reader is configured', async () => {
    const logger = { warn: vi.fn() }
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricReaders: [reader(), reader()],
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Multiple metric readers configured'),
    )
    await shutdown()
  })

  it('does not warn with a single reader', async () => {
    const logger = { warn: vi.fn() }
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test',
      traceExporter: new InMemorySpanExporter(),
      instrumentations: [],
      runtimeMetrics: false,
      processorMetrics: false,
      metricReaders: [reader()],
      logger,
    })

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Multiple metric readers configured'),
    )
    await shutdown()
  })
})
