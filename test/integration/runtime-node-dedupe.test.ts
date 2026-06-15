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

function init(
  overrides: Record<string, any>,
  inst: ReturnType<typeof fakeRuntimeNode>,
) {
  return opinionatedTelemetryInit({
    serviceName: 'test',
    traceExporter: new InMemorySpanExporter(),
    instrumentations: [inst as any],
    runtimeMetrics: false,
    processorMetrics: false,
    metricExporter: createMockMetricExporter(),
    metricExportInterval: 60_000,
    logger: silentLogger,
    ...overrides,
  })
}

describe('runtime-node instrumentation dedupe', () => {
  afterEach(async () => {
    metrics.disable()
    cleanupOtel()
  })

  it('disables runtime-node by default when our runtime metrics are on', async () => {
    const inst = fakeRuntimeNode()
    // runtimeMetrics defaults to enabled here (override the false from init())
    const { shutdown } = init({ runtimeMetrics: undefined }, inst)
    expect(inst.disable).toHaveBeenCalled()
    await shutdown()
  })

  it('keeps runtime-node when our runtime metrics are off', async () => {
    const inst = fakeRuntimeNode()
    const { shutdown } = init({ runtimeMetrics: false }, inst)
    expect(inst.disable).not.toHaveBeenCalled()
    await shutdown()
  })

  it('keeps runtime-node when disableRuntimeNodeInstrumentation:false', async () => {
    const inst = fakeRuntimeNode()
    const { shutdown } = init(
      { runtimeMetrics: undefined, disableRuntimeNodeInstrumentation: false },
      inst,
    )
    expect(inst.disable).not.toHaveBeenCalled()
    await shutdown()
  })

  it('disables runtime-node when disableRuntimeNodeInstrumentation:true even with our metrics off', async () => {
    const inst = fakeRuntimeNode()
    const { shutdown } = init(
      { runtimeMetrics: false, disableRuntimeNodeInstrumentation: true },
      inst,
    )
    expect(inst.disable).toHaveBeenCalled()
    await shutdown()
  })

  it('warns when auto-disabling runtime-node (side effect, not opt-in)', async () => {
    const inst = fakeRuntimeNode()
    const logger = { warn: vi.fn() }
    const { shutdown } = init({ runtimeMetrics: undefined, logger }, inst)
    expect(inst.disable).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Disabled @opentelemetry/instrumentation-runtime-node',
      ),
    )
    await shutdown()
  })

  it('does not warn when disableRuntimeNodeInstrumentation:true (intentional opt-in)', async () => {
    const inst = fakeRuntimeNode()
    const logger = { warn: vi.fn() }
    const { shutdown } = init(
      {
        runtimeMetrics: false,
        disableRuntimeNodeInstrumentation: true,
        logger,
      },
      inst,
    )
    expect(inst.disable).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'Disabled @opentelemetry/instrumentation-runtime-node',
      ),
    )
    await shutdown()
  })
})
