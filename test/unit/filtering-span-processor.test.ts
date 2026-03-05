import { describe, it, expect, afterEach, vi } from 'vitest'
import { context, propagation, trace } from '@opentelemetry/api'
import { createTestProvider, nextTick, cleanupOtel } from '../helpers.js'
import { OpinionatedInstrumentation } from '../../src/opinionated-instrumentation.js'

describe('FilteringSpanProcessor', () => {
  afterEach(() => cleanupOtel())

  describe('sync span dropping', () => {
    it('drops spans that start and end in the same tick', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider()

      // Sync span — starts and ends in same tick
      const span = tracer.startSpan('sync-span')
      span.end()

      await nextTick()

      // Async span — crosses a tick boundary
      const asyncSpan = tracer.startSpan('async-span')
      await nextTick()
      asyncSpan.end()

      await shutdown()

      const names = getSpans().map((s) => s.name)
      expect(names).not.toContain('sync-span')
      expect(names).toContain('async-span')
    })

    it('keeps all spans when dropSyncSpans is false', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
      })

      const span = tracer.startSpan('sync-span')
      span.end()

      await nextTick()
      await shutdown()

      expect(getSpans().map((s) => s.name)).toContain('sync-span')
    })

    it('supports custom dropSyncSpans function', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: (span) => span.name.startsWith('drop-'),
      })

      const drop = tracer.startSpan('drop-me')
      drop.end()
      const keep = tracer.startSpan('keep-me')
      keep.end()

      await nextTick()
      await shutdown()

      const names = getSpans().map((s) => s.name)
      expect(names).not.toContain('drop-me')
      expect(names).toContain('keep-me')
    })
  })

  describe('baggage to attributes', () => {
    it('propagates baggage entries as span attributes', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider()

      const baggage = propagation.createBaggage({
        'app.user': { value: 'user-123' },
        'app.team': { value: 'team-456' },
      })
      const ctx = propagation.setBaggage(context.active(), baggage)

      context.with(ctx, () => {
        const span = tracer.startSpan('with-baggage')
        // Need to cross tick boundary
        setTimeout(() => span.end(), 0)
      })

      // Wait for the span to end
      await new Promise((r) => setTimeout(r, 10))
      await shutdown()

      const span = getSpans().find((s) => s.name === 'with-baggage')
      expect(span).toBeDefined()
      expect(span!.attributes['app.user']).toBe('user-123')
      expect(span!.attributes['app.team']).toBe('team-456')
    })

    it('skips baggage propagation when disabled', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        baggageToAttributes: false,
        dropSyncSpans: false,
      })

      const baggage = propagation.createBaggage({
        'app.user': { value: 'user-123' },
      })
      const ctx = propagation.setBaggage(context.active(), baggage)

      context.with(ctx, () => {
        const span = tracer.startSpan('no-baggage')
        span.end()
      })

      await shutdown()

      const span = getSpans().find((s) => s.name === 'no-baggage')
      expect(span).toBeDefined()
      expect(span!.attributes['app.user']).toBeUndefined()
    })
  })

  describe('reparenting', () => {
    it('reparents child spans when instrumentation has reparent: true', async () => {
      // Register a mock instrumentation with reparent
      // Use 'reparent-scope' as the instrumentation name
      const mockInst = {
        instrumentationName: 'reparent-scope',
        instrumentationVersion: '1.0.0',
        setTracerProvider() {},
        setMeterProvider() {},
        getConfig() {
          return {}
        },
        setConfig() {},
        enable() {},
        disable() {},
      } as any

      new OpinionatedInstrumentation(mockInst, { reparent: true })

      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
      })

      // Use a tracer named 'reparent-scope' so spans get that instrumentationScope
      const reparentTracer = provider.getTracer('reparent-scope')
      const normalTracer = provider.getTracer('test')

      // Simulate: grandparent -> reparent-span -> child
      const grandparent = normalTracer.startSpan('grandparent')

      context.with(trace.setSpan(context.active(), grandparent), () => {
        // Create a span from the reparent tracer (gets instrumentationScope 'reparent-scope')
        const reparentSpan = reparentTracer.startSpan('reparent-target')
        reparentSpan.setAttribute('parent.attr', 'from-parent')

        context.with(trace.setSpan(context.active(), reparentSpan), () => {
          const child = normalTracer.startSpan('child-span')
          child.setAttribute('child.attr', 'yes')
          child.end()
        })
        reparentSpan.end()
      })

      grandparent.end()
      await shutdown()

      const spans = getSpans()
      const childSpan = spans.find((s) => s.name === 'child-span')
      // The reparent-target span should be dropped
      const reparentSpan = spans.find((s) => s.name === 'reparent-target')
      expect(reparentSpan).toBeUndefined()

      // The child should have inherited the parent's attributes
      expect(childSpan).toBeDefined()
      expect(childSpan!.attributes['parent.attr']).toBe('from-parent')
      expect(childSpan!.attributes['child.attr']).toBe('yes')
    })
  })

  describe('rename hooks', () => {
    it('calls renameSpan on start', async () => {
      const mockInst = {
        instrumentationName: '@test/rename-start',
        instrumentationVersion: '1.0.0',
        setTracerProvider() {},
        setMeterProvider() {},
        getConfig() {
          return {}
        },
        setConfig() {},
        enable() {},
        disable() {},
      } as any

      new OpinionatedInstrumentation(mockInst, {
        renameSpan: (name) => `prefixed:${name}`,
      })

      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
      })

      const scopedTracer = provider.getTracer('@test/rename-start')
      const span = scopedTracer.startSpan('original')
      span.end()

      await shutdown()

      const found = getSpans().find((s) => s.name === 'prefixed:original')
      expect(found).toBeDefined()
    })

    it('calls renameSpanOnEnd', async () => {
      const mockInst = {
        instrumentationName: '@test/rename-end',
        instrumentationVersion: '1.0.0',
        setTracerProvider() {},
        setMeterProvider() {},
        getConfig() {
          return {}
        },
        setConfig() {},
        enable() {},
        disable() {},
      } as any

      new OpinionatedInstrumentation(mockInst, {
        renameSpanOnEnd: (span) => `ended:${span.name}`,
      })

      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
      })

      const scopedTracer = provider.getTracer('@test/rename-end')
      const span = scopedTracer.startSpan('will-rename')
      span.end()

      await shutdown()

      const found = getSpans().find((s) => s.name === 'ended:will-rename')
      expect(found).toBeDefined()
    })
  })

  describe('custom hooks', () => {
    it('calls onStart and onEnd hooks', async () => {
      const onStart = vi.fn()
      const onEnd = vi.fn()

      const mockInst = {
        instrumentationName: '@test/hooks',
        instrumentationVersion: '1.0.0',
        setTracerProvider() {},
        setMeterProvider() {},
        getConfig() {
          return {}
        },
        setConfig() {},
        enable() {},
        disable() {},
      } as any

      new OpinionatedInstrumentation(mockInst, { onStart, onEnd })

      const { provider, shutdown } = createTestProvider({
        dropSyncSpans: false,
      })

      const scopedTracer = provider.getTracer('@test/hooks')
      const span = scopedTracer.startSpan('hooked')
      span.end()

      await shutdown()

      expect(onStart).toHaveBeenCalledOnce()
      expect(onEnd).toHaveBeenCalledOnce()
    })
  })

  describe('reparenting chain', () => {
    it('walks up a multi-level reparent chain', async () => {
      // Register two reparent instrumentations
      const mockInstA = {
        instrumentationName: 'reparent-a',
        instrumentationVersion: '1.0.0',
        setTracerProvider() {},
        setMeterProvider() {},
        getConfig() {
          return {}
        },
        setConfig() {},
        enable() {},
        disable() {},
      } as any
      const mockInstB = {
        instrumentationName: 'reparent-b',
        instrumentationVersion: '1.0.0',
        setTracerProvider() {},
        setMeterProvider() {},
        getConfig() {
          return {}
        },
        setConfig() {},
        enable() {},
        disable() {},
      } as any

      new OpinionatedInstrumentation(mockInstA, { reparent: true })
      new OpinionatedInstrumentation(mockInstB, { reparent: true })

      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
      })

      const tracerA = provider.getTracer('reparent-a')
      const tracerB = provider.getTracer('reparent-b')
      const normalTracer = provider.getTracer('test')

      // grandparent -> reparent-a -> reparent-b -> child
      const grandparent = normalTracer.startSpan('grandparent')

      context.with(trace.setSpan(context.active(), grandparent), () => {
        const spanA = tracerA.startSpan('reparent-a-span')
        spanA.setAttribute('from.a', 'yes')

        context.with(trace.setSpan(context.active(), spanA), () => {
          const spanB = tracerB.startSpan('reparent-b-span')
          spanB.setAttribute('from.b', 'yes')

          context.with(trace.setSpan(context.active(), spanB), () => {
            const child = normalTracer.startSpan('deep-child')
            child.end()
          })
          spanB.end()
        })
        spanA.end()
      })
      grandparent.end()

      await shutdown()

      const spans = getSpans()
      // Both reparent spans should be dropped
      expect(spans.find((s) => s.name === 'reparent-a-span')).toBeUndefined()
      expect(spans.find((s) => s.name === 'reparent-b-span')).toBeUndefined()

      // Child should exist and inherit attributes from the top of the reparent chain (spanA)
      const child = spans.find((s) => s.name === 'deep-child')
      expect(child).toBeDefined()
      expect(child!.attributes['from.a']).toBe('yes')
    })
  })

  describe('memoryDelta', () => {
    it('captures rss delta on root spans by default (fast path)', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider()

      const span = tracer.startSpan('root-span')
      await nextTick()
      span.end()

      await shutdown()

      const root = getSpans().find((s) => s.name === 'root-span')
      expect(root).toBeDefined()
      expect(root!.attributes['memory.delta.rss']).toBeTypeOf('number')
      expect(root!.attributes['memory.delta.heap_used']).toBeUndefined()
    })

    it('captures specific fields when configured with object', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        memoryDelta: { heapUsed: true, rss: true },
      })

      const span = tracer.startSpan('root-span')
      await nextTick()
      span.end()

      await shutdown()

      const root = getSpans().find((s) => s.name === 'root-span')
      expect(root).toBeDefined()
      expect(root!.attributes['memory.delta.heap_used']).toBeTypeOf('number')
      expect(root!.attributes['memory.delta.rss']).toBeTypeOf('number')
      expect(root!.attributes['memory.delta.heap_total']).toBeUndefined()
    })

    it('does not capture memory when disabled', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        memoryDelta: false,
      })

      const span = tracer.startSpan('root-span')
      await nextTick()
      span.end()

      await shutdown()

      const root = getSpans().find((s) => s.name === 'root-span')
      expect(root).toBeDefined()
      expect(root!.attributes['memory.delta.rss']).toBeUndefined()
      expect(root!.attributes['memory.delta.heap_used']).toBeUndefined()
    })

    it('does not capture memory on child spans', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        const child = tracer.startSpan('child')
        await nextTick()
        child.end()
        root.end()
      })

      await shutdown()

      const child = getSpans().find((s) => s.name === 'child')
      expect(child).toBeDefined()
      expect(child!.attributes['memory.delta.rss']).toBeUndefined()
    })
  })

  describe('onSpanAfterShutdown', () => {
    it('calls onSpanAfterShutdown when a span ends after shutdown', async () => {
      const afterShutdown = vi.fn()
      const { tracer, processor } = createTestProvider({
        dropSyncSpans: false,
        onSpanAfterShutdown: afterShutdown,
      })

      const span = tracer.startSpan('late-span')
      await processor.shutdown()
      span.end()

      expect(afterShutdown).toHaveBeenCalledOnce()
      expect(afterShutdown.mock.calls[0][0].name).toBe('late-span')
    })

    it('does not throw when no onSpanAfterShutdown is provided', async () => {
      const { tracer, processor } = createTestProvider({
        dropSyncSpans: false,
      })

      const span = tracer.startSpan('late-span-no-handler')
      await processor.shutdown()

      // Should not throw
      expect(() => span.end()).not.toThrow()
    })
  })
})
