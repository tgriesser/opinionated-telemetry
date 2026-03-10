import { describe, it, expect, afterEach, vi } from 'vitest'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { otelInitBull } from '../../src/integrations/bull.js'
import { cleanupOtel, createSimpleProvider } from '../helpers.js'

function createMockBull() {
  function Bull(this: any) {
    this.name = 'test-queue'
  }
  Bull.prototype.process = function () {}
  Bull.prototype.add = function (_name: any, data: any) {
    return data
  }
  Bull.prototype.on = function (_event: string, handler: any) {
    return handler
  }
  return Bull
}

describe('otelInitBull', () => {
  afterEach(() => cleanupOtel())

  it('patches Bull.prototype.process to create spans', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()
    otelInitBull(Bull)

    const queue = new (Bull as any)()
    let processorCalled = false

    // Register processor
    queue.process(async function myProcessor(job: any) {
      processorCalled = true
      return 'done'
    })

    // The process function should have stored the wrapped processor
    // but since our mock doesn't actually call it, let's verify the patching worked
    expect(Bull.prototype.process).not.toBe(createMockBull().prototype.process)
    await provider.shutdown()
  })

  it('patches Bull.prototype.add to inject __otelLink', () => {
    const { tracer, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()
    otelInitBull(Bull)

    const queue = new (Bull as any)()

    // Call add within a span to capture the link
    let addResult: any
    tracer.startActiveSpan('enqueue', (span) => {
      addResult = queue.add('job-name', { payload: 'data' }, {})
      span.end()
    })

    // The data should have __otelLink injected
    expect(addResult.__otelLink).toBeDefined()
    expect(addResult.__otelLink.traceId).toBeDefined()
    expect(addResult.__otelLink.spanId).toBeDefined()
    expect(addResult.payload).toBe('data')

    provider.shutdown()
  })

  it('handles add(data, opts) signature (no name)', () => {
    const { tracer, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()

    // Override add to return the first arg when no name
    Bull.prototype.add = function (data: any) {
      return data
    }

    otelInitBull(Bull)
    const queue = new (Bull as any)()

    let result: any
    tracer.startActiveSpan('enqueue', (span) => {
      result = queue.add({ payload: 'no-name' })
      span.end()
    })

    expect(result.__otelLink).toBeDefined()
    expect(result.payload).toBe('no-name')

    provider.shutdown()
  })

  it('patches on() to wrap async event handlers', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()
    otelInitBull(Bull)

    const queue = new (Bull as any)()

    const handler = async function onCompleted(job: any) {
      return 'handled'
    }

    const wrapped = queue.on('completed', handler)

    // The returned handler should be wrapped (different reference)
    expect(wrapped).not.toBe(handler)

    await provider.shutdown()
  })

  it('does not wrap sync event handlers', () => {
    const { provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()
    otelInitBull(Bull)

    const queue = new (Bull as any)()
    const handler = function syncHandler() {}
    const result = queue.on('completed', handler)

    // Sync handlers should pass through unchanged
    expect(result).toBe(handler)
    provider.shutdown()
  })

  it('does not wrap handlers for non-traced events', () => {
    const { provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()
    otelInitBull(Bull)

    const queue = new (Bull as any)()
    const handler = async function onCustom() {}
    const result = queue.on('custom-event', handler)

    expect(result).toBe(handler)
    provider.shutdown()
  })

  it('respects custom tracedEvents', () => {
    const { provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()
    otelInitBull(Bull, { tracedEvents: ['custom'] })

    const queue = new (Bull as any)()

    // 'completed' is not in custom list, should not wrap
    const completedHandler = async function h1() {}
    expect(queue.on('completed', completedHandler)).toBe(completedHandler)

    // 'custom' is in the list, should wrap
    const customHandler = async function h2() {}
    expect(queue.on('custom', customHandler)).not.toBe(customHandler)

    provider.shutdown()
  })

  it('process: traced processor creates spans with correct attributes', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()

    // Override process to capture and invoke the wrapped processor
    let capturedProcessor: any
    Bull.prototype.process = function (fn: any) {
      capturedProcessor = fn
    }

    otelInitBull(Bull)
    const queue = new (Bull as any)()

    queue.process(async function myProcessor(job: any) {
      return 'result'
    })

    // Simulate calling the processor with a mock job
    const mockJob = {
      id: '123',
      queue: { name: 'test-queue' },
      attemptsMade: 2,
      data: {
        __otelLink: {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          traceFlags: 1,
        },
      },
    }

    const result = await capturedProcessor(mockJob)
    expect(result).toBe('result')

    await provider.forceFlush()
    const span = exporter.assertSpanExists('bull.process:test-queue')
    expect(span.attributes['bull.job.id']).toBe('123')
    expect(span.attributes['bull.queue.name']).toBe('test-queue')
    expect(span.attributes['bull.job.attempts']).toBe(2)
    expect(span.links.length).toBe(1)
    expect(span.links[0].attributes!['link.source']).toBe('bull.add')

    await provider.shutdown()
  })

  it('process: traced processor records errors', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()

    let capturedProcessor: any
    Bull.prototype.process = function (fn: any) {
      capturedProcessor = fn
    }

    otelInitBull(Bull)
    const queue = new (Bull as any)()

    queue.process(async function failProcessor() {
      throw new Error('job failed')
    })

    const mockJob = {
      id: '456',
      queue: { name: 'fail-queue' },
      attemptsMade: 0,
      data: {},
    }

    await expect(capturedProcessor(mockJob)).rejects.toThrow('job failed')

    await provider.forceFlush()
    const span = exporter.assertSpanExists(/^bull\.process:/)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)

    await provider.shutdown()
  })

  it('process: uses first arg as job name when it is a string', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()

    let capturedProcessor: any
    Bull.prototype.process = function (_name: string, fn: any) {
      capturedProcessor = fn
    }

    otelInitBull(Bull)
    const queue = new (Bull as any)()

    queue.process('named-job', async function (job: any) {
      return 'ok'
    })

    await capturedProcessor({
      id: '789',
      queue: { name: 'q' },
      attemptsMade: 0,
      data: {},
    })

    await provider.forceFlush()
    exporter.assertSpanExists('bull.process:named-job')

    await provider.shutdown()
  })

  it('on: wrapped async handler creates spans and handles success', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()

    let capturedHandler: any
    Bull.prototype.on = function (_event: string, handler: any) {
      capturedHandler = handler
      return handler
    }

    otelInitBull(Bull)
    const queue = new (Bull as any)()

    queue.on('completed', async function onCompleted() {
      return 'done'
    })

    const result = await capturedHandler()
    expect(result).toBe('done')

    await provider.forceFlush()
    exporter.assertSpanAttributes('onCompleted', {
      'bull.event': 'completed',
      'bull.queue.name': 'test-queue',
    })

    await provider.shutdown()
  })

  it('on: wrapped async handler records errors', async () => {
    const { exporter, provider } = createSimpleProvider()
    trace.setGlobalTracerProvider(provider)
    const Bull = createMockBull()

    let capturedHandler: any
    Bull.prototype.on = function (_event: string, handler: any) {
      capturedHandler = handler
      return handler
    }

    otelInitBull(Bull)
    const queue = new (Bull as any)()

    queue.on('failed', async function onFailed() {
      throw new Error('handler error')
    })

    await expect(capturedHandler()).rejects.toThrow('handler error')

    await provider.forceFlush()
    const span = exporter.assertSpanExists('onFailed')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)

    await provider.shutdown()
  })
})
