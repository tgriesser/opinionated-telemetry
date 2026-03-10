import { describe, it, expect, afterEach, vi } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { trace } from '@opentelemetry/api'
import { opinionatedTelemetryInit } from '../../src/opinionated-telemetry-init.js'
import { cleanupOtel, nextTick } from '../helpers.js'

function createExporter() {
  return new InMemorySpanExporter()
}

const silentLogger = { warn: () => {} }

describe('opinionatedTelemetryInit', () => {
  afterEach(() => cleanupOtel())

  it('returns { sdk, getTracer, shutdown } with correct types', () => {
    const exporter = createExporter()
    const result = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
    })

    expect(result).toHaveProperty('sdk')
    expect(result).toHaveProperty('getTracer')
    expect(result).toHaveProperty('shutdown')
    expect(typeof result.getTracer).toBe('function')
    expect(typeof result.shutdown).toBe('function')

    result.shutdown()
  })

  it('getTracer() returns a tracer (default uses serviceName)', () => {
    const exporter = createExporter()
    const { getTracer, shutdown } = opinionatedTelemetryInit({
      serviceName: 'my-service',
      traceExporter: exporter,
      instrumentations: [],
    })

    const tracer = getTracer()
    // Verify it's a real tracer by starting a span
    const span = tracer.startSpan('test-span')
    expect(span).toBeDefined()
    span.end()

    shutdown()
  })

  it('getTracer("custom") returns a tracer with custom name', () => {
    const exporter = createExporter()
    const { getTracer, shutdown } = opinionatedTelemetryInit({
      serviceName: 'my-service',
      traceExporter: exporter,
      instrumentations: [],
    })

    const tracer = getTracer('custom')
    const span = tracer.startSpan('custom-span')
    expect(span).toBeDefined()
    span.end()

    shutdown()
  })

  it('shutdown() calls through to sdk.shutdown without throwing', async () => {
    const exporter = createExporter()
    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
    })

    await expect(shutdown()).resolves.not.toThrow()
  })

  it('additionalSpanProcessors are included in the processing chain', async () => {
    const exporter = createExporter()
    const onEndSpy = vi.fn()

    const customProcessor: SpanProcessor = {
      onStart: vi.fn(),
      onEnd: onEndSpy,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }

    const { getTracer, sdk } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
      additionalSpanProcessors: [customProcessor],
      dropSyncSpans: false,
    })

    const tracer = getTracer()
    const span = tracer.startSpan('processor-test')
    span.end()

    await sdk.shutdown()

    expect(onEndSpy).toHaveBeenCalled()
    const receivedSpan = onEndSpy.mock.calls[0][0] as ReadableSpan
    expect(receivedSpan.name).toBe('processor-test')
  })

  it('registers shutdown signal handler with the configured signal name', () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const exporter = createExporter()

    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
      shutdownSignal: 'SIGUSR2',
    })

    expect(processOnSpy).toHaveBeenCalledWith('SIGUSR2', expect.any(Function))

    processOnSpy.mockRestore()
    shutdown()
  })

  it('registers SIGTERM by default', () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const exporter = createExporter()

    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
    })

    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))

    processOnSpy.mockRestore()
    shutdown()
  })

  it('does not register a signal handler when shutdownSignal is empty string', () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const exporter = createExporter()

    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
      shutdownSignal: '',
    })

    // Filter calls to only signal-related ones (ignore unrelated process.on calls)
    const signalCalls = processOnSpy.mock.calls.filter(
      ([event]) =>
        typeof event === 'string' &&
        (event.startsWith('SIG') || event === 'SIGTERM'),
    )
    expect(signalCalls).toHaveLength(0)

    processOnSpy.mockRestore()
    shutdown()
  })

  it('warns when instrumentationHooks key does not match any instrumentation', () => {
    const exporter = createExporter()
    const logger = { warn: vi.fn() }

    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
      instrumentationHooks: {
        'nonexistent-scope': { collapse: true },
      },
      logger,
    })

    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent-scope'),
    )

    shutdown()
  })

  it('does not warn when instrumentationHooks match registered instrumentations', () => {
    const exporter = createExporter()
    const logger = { warn: vi.fn() }

    const fakeInstrumentation = {
      instrumentationName: 'my-scope',
      instrumentationVersion: '1.0.0',
      setTracerProvider: vi.fn(),
      setMeterProvider: vi.fn(),
      getModuleDefinitions: () => [],
      enable: vi.fn(),
      disable: vi.fn(),
      setConfig: vi.fn(),
      getConfig: () => ({}),
    }

    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [fakeInstrumentation as any],
      instrumentationHooks: {
        'my-scope': { collapse: true },
      },
      logger,
    })

    expect(logger.warn).not.toHaveBeenCalled()

    shutdown()
  })

  it('defaults to console.warn when no logger provided', () => {
    const exporter = createExporter()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { shutdown } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
      instrumentationHooks: {
        'missing-scope': { collapse: true },
      },
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing-scope'),
    )

    warnSpy.mockRestore()
    shutdown()
  })

  it('instrumentationHooks onEnd fires through the pipeline', async () => {
    const exporter = createExporter()
    const hookSpy = vi.fn()
    const onEndSpy = vi.fn()

    const collectingProcessor: SpanProcessor = {
      onStart: vi.fn(),
      onEnd: onEndSpy,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }

    const { sdk } = opinionatedTelemetryInit({
      serviceName: 'test-service',
      traceExporter: exporter,
      instrumentations: [],
      additionalSpanProcessors: [collectingProcessor],
      dropSyncSpans: false,
      logger: silentLogger,
      instrumentationHooks: {
        'test-onend-scope': {
          onEnd: hookSpy,
        },
      },
    })

    const tracer = trace.getTracer('test-onend-scope')
    const span = tracer.startSpan('hook-test')
    span.end()

    await sdk.shutdown()

    expect(hookSpy).toHaveBeenCalledTimes(1)
    const hookSpan = hookSpy.mock.calls[0][0] as ReadableSpan
    expect(hookSpan.name).toBe('hook-test')
  })
})
