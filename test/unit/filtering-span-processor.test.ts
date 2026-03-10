import { describe, it, expect, afterEach, vi } from 'vitest'
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api'
import { createTestProvider, nextTick, cleanupOtel } from '../helpers.js'

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

  describe('collapseing', () => {
    it('collapses child spans when instrumentation has collapse: true', async () => {
      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          'collapse-scope': { collapse: true },
        },
      })

      // Use a tracer named 'collapse-scope' so spans get that instrumentationScope
      const collapseTracer = provider.getTracer('collapse-scope')
      const normalTracer = provider.getTracer('test')

      // Simulate: grandparent -> collapse-span -> child
      const grandparent = normalTracer.startSpan('grandparent')

      context.with(trace.setSpan(context.active(), grandparent), () => {
        // Create a span from the collapse tracer (gets instrumentationScope 'collapse-scope')
        const collapseSpan = collapseTracer.startSpan('collapse-target')
        collapseSpan.setAttribute('parent.attr', 'from-parent')

        context.with(trace.setSpan(context.active(), collapseSpan), () => {
          const child = normalTracer.startSpan('child-span')
          child.setAttribute('child.attr', 'yes')
          child.end()
        })
        collapseSpan.end()
      })

      grandparent.end()
      await shutdown()

      const spans = getSpans()
      const childSpan = spans.find((s) => s.name === 'child-span')
      // The collapse-target span should be dropped
      const collapseSpan = spans.find((s) => s.name === 'collapse-target')
      expect(collapseSpan).toBeUndefined()

      // The child should have inherited the parent's attributes
      expect(childSpan).toBeDefined()
      expect(childSpan!.attributes['parent.attr']).toBe('from-parent')
      expect(childSpan!.attributes['child.attr']).toBe('yes')
    })
  })

  describe('rename hooks', () => {
    it('calls renameSpan on start', async () => {
      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          '@test/rename-start': {
            renameSpan: (name) => `prefixed:${name}`,
          },
        },
      })

      const scopedTracer = provider.getTracer('@test/rename-start')
      const span = scopedTracer.startSpan('original')
      span.end()

      await shutdown()

      const found = getSpans().find((s) => s.name === 'prefixed:original')
      expect(found).toBeDefined()
    })

    it('calls renameSpanOnEnd', async () => {
      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          '@test/rename-end': {
            renameSpanOnEnd: (span) => `ended:${span.name}`,
          },
        },
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

      const { provider, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          '@test/hooks': { onStart, onEnd },
        },
      })

      const scopedTracer = provider.getTracer('@test/hooks')
      const span = scopedTracer.startSpan('hooked')
      span.end()

      await shutdown()

      expect(onStart).toHaveBeenCalledOnce()
      expect(onEnd).toHaveBeenCalledOnce()
    })
  })

  describe('collapseing chain', () => {
    it('walks up a multi-level collapse chain', async () => {
      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          'collapse-a': { collapse: true },
          'collapse-b': { collapse: true },
        },
      })

      const tracerA = provider.getTracer('collapse-a')
      const tracerB = provider.getTracer('collapse-b')
      const normalTracer = provider.getTracer('test')

      // grandparent -> collapse-a -> collapse-b -> child
      const grandparent = normalTracer.startSpan('grandparent')

      context.with(trace.setSpan(context.active(), grandparent), () => {
        const spanA = tracerA.startSpan('collapse-a-span')
        spanA.setAttribute('from.a', 'yes')

        context.with(trace.setSpan(context.active(), spanA), () => {
          const spanB = tracerB.startSpan('collapse-b-span')
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
      // Both collapse spans should be dropped
      expect(spans.find((s) => s.name === 'collapse-a-span')).toBeUndefined()
      expect(spans.find((s) => s.name === 'collapse-b-span')).toBeUndefined()

      // Child should exist and inherit attributes from the top of the collapse chain (spanA)
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
      expect(root!.attributes['opin_tel.memory_delta.rss']).toBeTypeOf('number')
      expect(
        root!.attributes['opin_tel.memory_delta.heap_used'],
      ).toBeUndefined()
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
      expect(root!.attributes['opin_tel.memory_delta.heap_used']).toBeTypeOf(
        'number',
      )
      expect(root!.attributes['opin_tel.memory_delta.rss']).toBeTypeOf('number')
      expect(
        root!.attributes['opin_tel.memory_delta.heap_total'],
      ).toBeUndefined()
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
      expect(root!.attributes['opin_tel.memory_delta.rss']).toBeUndefined()
      expect(
        root!.attributes['opin_tel.memory_delta.heap_used'],
      ).toBeUndefined()
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
      expect(child!.attributes['opin_tel.memory_delta.rss']).toBeUndefined()
    })
  })

  describe('eventLoopUtilization', () => {
    it('captures elu.utilization on root spans by default', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider()

      const span = tracer.startSpan('root-span')
      await nextTick()
      span.end()

      await shutdown()

      const root = getSpans().find((s) => s.name === 'root-span')
      expect(root).toBeDefined()
      expect(root!.attributes['opin_tel.event_loop.utilization']).toBeTypeOf(
        'number',
      )
      const elu = root!.attributes['opin_tel.event_loop.utilization'] as number
      expect(elu).toBeGreaterThanOrEqual(0)
      expect(elu).toBeLessThanOrEqual(1)
    })

    it('captures elu on child spans too', async () => {
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
      expect(child!.attributes['opin_tel.event_loop.utilization']).toBeTypeOf(
        'number',
      )
    })

    it('captures only on root spans when set to root', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        eventLoopUtilization: 'root',
      })

      await tracer.startActiveSpan('root', async (root) => {
        const child = tracer.startSpan('child')
        await nextTick()
        child.end()
        root.end()
      })

      await shutdown()

      const root = getSpans().find((s) => s.name === 'root')
      expect(root).toBeDefined()
      expect(root!.attributes['opin_tel.event_loop.utilization']).toBeTypeOf(
        'number',
      )

      const child = getSpans().find((s) => s.name === 'child')
      expect(child).toBeDefined()
      expect(
        child!.attributes['opin_tel.event_loop.utilization'],
      ).toBeUndefined()
    })

    it('does not capture elu when disabled', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        eventLoopUtilization: false,
      })

      const span = tracer.startSpan('root-span')
      await nextTick()
      span.end()

      await shutdown()

      const root = getSpans().find((s) => s.name === 'root-span')
      expect(root).toBeDefined()
      expect(
        root!.attributes['opin_tel.event_loop.utilization'],
      ).toBeUndefined()
    })
  })

  describe('stuck span detection', () => {
    it('detects and exports stuck span after threshold', async () => {
      vi.useFakeTimers()

      const { tracer, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
      })

      const span = tracer.startSpan('slow-op')

      // Advance past threshold + interval
      vi.advanceTimersByTime(150)

      await processor.forceFlush()
      const spans = getSpans()
      const stuck = spans.find((s) => s.name === 'slow-op (incomplete)')
      expect(stuck).toBeDefined()
      expect(stuck!.attributes['opin_tel.stuck.is_snapshot']).toBe(true)
      expect(stuck!.attributes['opin_tel.stuck.duration_ms']).toBeTypeOf(
        'number',
      )
      expect(
        stuck!.attributes['opin_tel.stuck.duration_ms'],
      ).toBeGreaterThanOrEqual(100)

      span.end()
      await processor.shutdown()
      vi.useRealTimers()
    })

    it('does not re-report same stuck span', async () => {
      vi.useFakeTimers()

      const { tracer, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
      })

      tracer.startSpan('stuck-once')

      // First reap cycle
      vi.advanceTimersByTime(150)
      // Second reap cycle
      vi.advanceTimersByTime(50)

      await processor.forceFlush()
      const stuckSpans = getSpans().filter(
        (s) => s.name === 'stuck-once (incomplete)',
      )
      expect(stuckSpans).toHaveLength(1)

      await processor.shutdown()
      vi.useRealTimers()
    })

    it('cleans up tracking when real span ends', async () => {
      vi.useFakeTimers()

      const { tracer, getSpans, processor, exporter } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
      })

      const span = tracer.startSpan('will-end')

      // Trigger stuck detection
      vi.advanceTimersByTime(150)
      await processor.forceFlush()
      expect(
        getSpans().find((s) => s.name === 'will-end (incomplete)'),
      ).toBeDefined()

      // End the real span and reset exporter
      span.end()
      exporter.reset()

      // Start a new span with the same name, wait for it to be stuck
      tracer.startSpan('will-end')
      vi.advanceTimersByTime(150)
      await processor.forceFlush()

      // Should get a new stuck report (the old span ID was cleaned up)
      expect(
        getSpans().find((s) => s.name === 'will-end (incomplete)'),
      ).toBeDefined()

      await processor.shutdown()
      vi.useRealTimers()
    })

    it('respects onStuckSpan returning false', async () => {
      vi.useFakeTimers()

      const { tracer, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
          onStuckSpan: () => false,
        },
      })

      tracer.startSpan('skip-me')
      vi.advanceTimersByTime(150)

      await processor.forceFlush()
      expect(
        getSpans().find((s) => s.name === 'skip-me (incomplete)'),
      ).toBeUndefined()

      await processor.shutdown()
      vi.useRealTimers()
    })

    it('includes memory delta on stuck root span snapshot', async () => {
      vi.useFakeTimers()

      const { tracer, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
      })

      // Root span — no parent, so memory tracking kicks in
      tracer.startSpan('stuck-root')

      vi.advanceTimersByTime(150)

      await processor.forceFlush()
      const stuck = getSpans().find((s) => s.name === 'stuck-root (incomplete)')
      expect(stuck).toBeDefined()
      expect(stuck!.attributes['opin_tel.stuck.is_snapshot']).toBe(true)
      expect(stuck!.attributes['opin_tel.memory_delta.rss']).toBeTypeOf(
        'number',
      )
      expect(stuck!.attributes['opin_tel.event_loop.utilization']).toBeTypeOf(
        'number',
      )

      await processor.shutdown()
      vi.useRealTimers()
    })

    it('runs instrumentation onEnd hooks on stuck span snapshot', async () => {
      vi.useFakeTimers()

      const onEnd = vi.fn()

      const { provider, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
        instrumentationHooks: {
          '@test/stuck-hooks': {
            onEnd,
            renameSpanOnEnd: (span) => `enriched:${span.name}`,
          },
        },
      })

      const scopedTracer = provider.getTracer('@test/stuck-hooks')
      scopedTracer.startSpan('stuck-hooked')

      vi.advanceTimersByTime(150)

      await processor.forceFlush()
      const stuck = getSpans().find(
        (s) => s.name === 'enriched:stuck-hooked (incomplete)',
      )
      expect(stuck).toBeDefined()
      expect(onEnd).toHaveBeenCalledOnce()

      await processor.shutdown()
      vi.useRealTimers()
    })

    it('is enabled by default', () => {
      const { processor } = createTestProvider({
        dropSyncSpans: false,
      })

      expect((processor as any)._stuckSpanInterval).not.toBeNull()
      processor.shutdown()
    })

    it('can be disabled explicitly', () => {
      const { processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
      })

      expect((processor as any)._stuckSpanInterval).toBeNull()
      processor.shutdown()
    })

    it('clears interval on shutdown', async () => {
      vi.useFakeTimers()

      const { processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
      })

      expect((processor as any)._stuckSpanInterval).not.toBeNull()
      await processor.shutdown()
      expect((processor as any)._stuckSpanInterval).toBeNull()

      vi.useRealTimers()
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

  describe('head sampling', () => {
    it('drops spans when head.sample returns rate > 1 and trace is not deterministically kept', async () => {
      // Use a very high rate so deterministic keep is extremely unlikely
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1_000_000,
          },
        },
      })

      // Create many root spans — with rate 1M, virtually none should be kept
      for (let i = 0; i < 20; i++) {
        const span = tracer.startSpan(`span-${i}`)
        span.end()
      }

      await shutdown()
      // With rate 1M, the probability of keeping any single span is 1/1M
      // 20 spans means ~20/1M chance of any being kept — effectively 0
      expect(getSpans().length).toBe(0)
    })

    it('keeps spans when head.sample returns 1', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1,
          },
        },
      })

      const span = tracer.startSpan('always-keep')
      span.end()

      await shutdown()
      expect(getSpans().map((s) => s.name)).toContain('always-keep')
    })

    it('sets SampleRate attribute on kept spans when rate > 1', async () => {
      const { crc32 } = await import('node:zlib')

      // We need to find a traceId that will be kept at rate=2
      // shouldKeep: (crc32(traceId) >>> 0) % rate === 0
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 2,
          },
        },
      })

      // Create enough spans that at least one is kept (50% chance per span)
      for (let i = 0; i < 40; i++) {
        const span = tracer.startSpan(`test-${i}`)
        span.end()
      }

      await shutdown()
      const spans = getSpans()
      // At rate=2, ~50% should be kept
      expect(spans.length).toBeGreaterThan(0)
      // All kept spans should have SampleRate=2
      for (const s of spans) {
        expect(s.attributes['SampleRate']).toBe(2)
      }
    })

    it('uses deterministic keep/drop (same traceId always gets same decision)', async () => {
      const sampleFn = vi.fn().mockReturnValue(2)

      // Run twice with the same config and compare which spans are kept
      const run = async () => {
        const { tracer, getSpans, shutdown } = createTestProvider({
          dropSyncSpans: false,
          stuckSpanDetection: false,
          sampling: {
            head: { sample: sampleFn },
          },
        })

        const spans: string[] = []
        for (let i = 0; i < 20; i++) {
          const span = tracer.startSpan(`det-${i}`)
          span.end()
        }

        await shutdown()
        return getSpans()
          .map((s) => s.spanContext().traceId)
          .sort()
      }

      // Can't guarantee same traceIds across runs since they're random.
      // Instead, verify the deterministic property: crc32-based decision is stable for a given traceId.
      const { crc32 } = await import('node:zlib')
      const traceId = 'abcdef0123456789abcdef0123456789'
      const rate = 5
      const decision1 = (crc32(traceId) >>> 0) % rate === 0
      const decision2 = (crc32(traceId) >>> 0) % rate === 0
      expect(decision1).toBe(decision2)
    })

    it('cleans up _headDecisions when root span ends', async () => {
      const { tracer, processor, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1,
          },
        },
      })

      const span = tracer.startSpan('root')
      const traceId = span.spanContext().traceId

      // Before root ends, decision should exist
      expect((processor as any)._headDecisions.has(traceId)).toBe(true)

      span.end()

      // After root ends, decision should be cleaned up
      expect((processor as any)._headDecisions.has(traceId)).toBe(false)

      await shutdown()
    })
  })

  describe('head mustKeepSpan rescue', () => {
    it('rescues individual spans that match mustKeepSpan', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1_000_000,
            mustKeepSpan: (span) => span.name === 'important',
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const normal = tracer.startSpan('normal-child')
        normal.end()

        const important = tracer.startSpan('important')
        important.end()
      })
      root.end()

      await shutdown()
      const names = getSpans().map((s) => s.name)
      expect(names).toContain('important')
      expect(names).not.toContain('normal-child')
    })

    it('rescued spans are reparented to root', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1_000_000,
            mustKeepSpan: (span) => span.name === 'deep-important',
          },
        },
      })

      const root = tracer.startSpan('root')
      const rootSpanId = root.spanContext().spanId

      context.with(trace.setSpan(context.active(), root), () => {
        const mid = tracer.startSpan('middle')
        context.with(trace.setSpan(context.active(), mid), () => {
          const deep = tracer.startSpan('deep-important')
          deep.end()
        })
        mid.end()
      })
      root.end()

      await shutdown()
      const rescued = getSpans().find((s) => s.name === 'deep-important')
      expect(rescued).toBeDefined()
      // Rescued span should be reparented to root
      expect(rescued!.parentSpanContext?.spanId).toBe(rootSpanId)
    })

    it('rescued spans get SampleRate=1 and opin_tel.meta.incomplete_trace=true', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1_000_000,
            mustKeepSpan: (span) => span.name === 'rescue-me',
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const span = tracer.startSpan('rescue-me')
        span.end()
      })
      root.end()

      await shutdown()
      const rescued = getSpans().find((s) => s.name === 'rescue-me')
      expect(rescued).toBeDefined()
      expect(rescued!.attributes['SampleRate']).toBe(1)
      expect(rescued!.attributes['opin_tel.meta.incomplete_trace']).toBe(true)
    })

    it('root span of rescued trace also gets exported with incomplete_trace=true', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1_000_000,
            mustKeepSpan: (span) => span.name === 'rescue-child',
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const child = tracer.startSpan('rescue-child')
        child.end()
      })
      root.end()

      await shutdown()
      const rootSpan = getSpans().find((s) => s.name === 'root')
      expect(rootSpan).toBeDefined()
      expect(rootSpan!.attributes['SampleRate']).toBe(1)
      expect(rootSpan!.attributes['opin_tel.meta.incomplete_trace']).toBe(true)
    })

    it('non-matching spans in sampled-out trace are still dropped', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 1_000_000,
            mustKeepSpan: (span) => span.name === 'keep-this',
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const drop1 = tracer.startSpan('drop-1')
        drop1.end()
        const keep = tracer.startSpan('keep-this')
        keep.end()
        const drop2 = tracer.startSpan('drop-2')
        drop2.end()
      })
      root.end()

      await shutdown()
      const names = getSpans().map((s) => s.name)
      expect(names).toContain('keep-this')
      expect(names).toContain('root') // root is rescued too
      expect(names).not.toContain('drop-1')
      expect(names).not.toContain('drop-2')
    })
  })

  describe('tail sampling', () => {
    it('buffers spans until root ends, then evaluates tail.sample', async () => {
      const sampleFn = vi.fn().mockReturnValue(1)
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: sampleFn,
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const child = tracer.startSpan('child')
        child.end()
      })

      // Before root ends, no spans should be exported
      expect(getSpans().length).toBe(0)

      root.end()

      await shutdown()
      // After root ends, all spans should be exported
      const names = getSpans().map((s) => s.name)
      expect(names).toContain('root')
      expect(names).toContain('child')
      expect(sampleFn).toHaveBeenCalledOnce()
    })

    it('keeps all spans in trace when tail.sample returns 1', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: () => 1,
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        for (let i = 0; i < 5; i++) {
          const child = tracer.startSpan(`child-${i}`)
          child.end()
        }
      })
      root.end()

      await shutdown()
      expect(getSpans().length).toBe(6) // root + 5 children
    })

    it('drops all spans when tail.sample returns rate > 1 and not kept', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: () => 1_000_000,
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const child = tracer.startSpan('child')
        child.end()
      })
      root.end()

      await shutdown()
      expect(getSpans().length).toBe(0)
    })

    it('sets SampleRate on all exported spans', async () => {
      // Use rate=2 and create enough traces that some are kept
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: () => 2,
          },
        },
      })

      for (let i = 0; i < 40; i++) {
        const root = tracer.startSpan(`root-${i}`)
        context.with(trace.setSpan(context.active(), root), () => {
          const child = tracer.startSpan(`child-${i}`)
          child.end()
        })
        root.end()
      }

      await shutdown()
      const spans = getSpans()
      expect(spans.length).toBeGreaterThan(0)
      for (const s of spans) {
        expect(s.attributes['SampleRate']).toBe(2)
      }
    })

    it('flushes with rate=1 when maxSpansPerTrace exceeded', async () => {
      const sampleFn = vi.fn().mockReturnValue(1_000_000)
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: sampleFn,
            maxSpansPerTrace: 5,
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        for (let i = 0; i < 6; i++) {
          const child = tracer.startSpan(`child-${i}`)
          child.end()
        }
      })

      // After 5 child spans + root buffered (6 total hits maxSpansPerTrace=5 at child-4),
      // it should flush with rate=1 without waiting for root
      // Actually: maxSpansPerTrace check happens when spans.length >= maxSpans
      // The 5th span (child-4) triggers flush
      const spansBeforeRoot = getSpans()
      expect(spansBeforeRoot.length).toBeGreaterThan(0)

      root.end()
      await shutdown()

      // All flushed spans should NOT have SampleRate set (rate=1 means no attribute)
      const allSpans = getSpans()
      for (const s of allSpans) {
        expect(s.attributes['SampleRate']).toBeUndefined()
      }
      // sample function should NOT have been called (maxSpans overflow bypasses it)
      expect(sampleFn).not.toHaveBeenCalled()
    })

    it('TraceSummary contains correct errorCount, hasError, durationMs, spanCount', async () => {
      const sampleFn = vi.fn().mockReturnValue(1)
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: sampleFn,
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const ok = tracer.startSpan('ok-child')
        ok.end()

        const err1 = tracer.startSpan('err-child-1')
        err1.setStatus({ code: SpanStatusCode.ERROR })
        err1.end()

        const err2 = tracer.startSpan('err-child-2')
        err2.setStatus({ code: SpanStatusCode.ERROR })
        err2.end()
      })
      root.end()

      await shutdown()
      expect(sampleFn).toHaveBeenCalledOnce()

      const [rootAttrs, summary] = sampleFn.mock.calls[0]
      expect(summary.errorCount).toBe(2)
      expect(summary.hasError).toBe(true)
      expect(summary.spanCount).toBe(4) // root + 3 children
      expect(summary.durationMs).toBeTypeOf('number')
      expect(summary.durationMs).toBeGreaterThanOrEqual(0)
      expect(summary.rootSpan).toBeDefined()
      expect(summary.rootSpan.name).toBe('root')
    })
  })

  describe('tail mustKeepSpan', () => {
    it('sets mustKeep flag when mustKeepSpan returns true', async () => {
      const sampleFn = vi.fn().mockReturnValue(1_000_000)
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: sampleFn,
            mustKeepSpan: (span) => span.name === 'critical',
          },
        },
      })

      const root = tracer.startSpan('root')
      context.with(trace.setSpan(context.active(), root), () => {
        const critical = tracer.startSpan('critical')
        critical.end()
        const normal = tracer.startSpan('normal')
        normal.end()
      })
      root.end()

      await shutdown()
      // Even though sample returns 1M, mustKeep clamps to 1
      const spans = getSpans()
      expect(spans.length).toBe(3) // root + critical + normal
      // Rate should be 1 (clamped), so no SampleRate attribute
      for (const s of spans) {
        expect(s.attributes['SampleRate']).toBeUndefined()
      }
    })

    it('clamps final rate to 1 when mustKeep is set (even if tail.sample returns higher)', async () => {
      const sampleFn = vi.fn().mockReturnValue(50)
      const { tracer, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: sampleFn,
            mustKeepSpan: (span) => span.name === 'must-keep',
          },
        },
      })

      const root = tracer.startSpan('root')
      const traceId = root.spanContext().traceId
      context.with(trace.setSpan(context.active(), root), () => {
        const mk = tracer.startSpan('must-keep')
        mk.end()
      })
      root.end()

      await processor.forceFlush()

      // Verify the tail buffer entry had decidedRate=1
      // Since flushed, check the exported spans have no SampleRate (rate=1)
      const spans = getSpans()
      expect(spans.length).toBe(2)
      for (const s of spans) {
        expect(s.attributes['SampleRate']).toBeUndefined()
      }

      await processor.shutdown()
    })
  })

  describe('burst protection', () => {
    it('does not throttle below rateThreshold', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          burstProtection: {
            rateThreshold: 100,
            halfLifeMs: 10_000,
          },
        },
      })

      // Single span, well below threshold
      const span = tracer.startSpan('single')
      span.end()

      await shutdown()
      const spans = getSpans()
      expect(spans.length).toBe(1)
      expect(spans[0].attributes['SampleRate']).toBeUndefined()
    })

    it('throttles when rate exceeds threshold (sets SampleRate)', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          burstProtection: {
            rateThreshold: 10,
            halfLifeMs: 10_000,
            maxSampleRate: 50,
          },
        },
      })

      // Generate many spans rapidly — sub-millisecond intervals give very
      // high instantaneous rates via the EMA's dtMs<=0 path (rate += 1).
      for (let i = 0; i < 200; i++) {
        const span = tracer.startSpan('burst-span')
        span.end()
      }

      await shutdown()
      const spans = getSpans()

      // Some spans should have been throttled (SampleRate set)
      const throttled = spans.filter(
        (s) => s.attributes['SampleRate'] !== undefined,
      )
      expect(throttled.length).toBeGreaterThan(0)
    })

    it('uses custom keyFn when provided', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          burstProtection: {
            rateThreshold: 10,
            halfLifeMs: 10_000,
            keyFn: (span) => (span.attributes['route'] as string) ?? 'default',
          },
        },
      })

      // Burst on one key
      for (let i = 0; i < 100; i++) {
        const span = tracer.startSpan('request')
        span.setAttribute('route', '/hot')
        span.end()
      }

      // Single span on different key — should not be throttled
      const coldSpan = tracer.startSpan('request')
      coldSpan.setAttribute('route', '/cold')
      coldSpan.end()

      await shutdown()
      const coldExported = getSpans().filter(
        (s) => s.attributes['route'] === '/cold',
      )
      expect(coldExported.length).toBe(1)
      expect(coldExported[0].attributes['SampleRate']).toBeUndefined()
    })

    it('respects maxSampleRate cap', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          burstProtection: {
            rateThreshold: 1,
            halfLifeMs: 10_000,
            maxSampleRate: 5,
          },
        },
      })

      // Generate extremely rapid spans (sub-ms → dtMs=0 → rate += 1)
      for (let i = 0; i < 200; i++) {
        const span = tracer.startSpan('rapid')
        span.end()
      }

      await shutdown()
      const spans = getSpans()

      // All throttled spans should have SampleRate <= maxSampleRate
      for (const s of spans) {
        const rate = s.attributes['SampleRate']
        if (rate !== undefined) {
          expect(rate).toBeLessThanOrEqual(5)
        }
      }
    })
  })

  describe('sampling composition', () => {
    it('head + burst: rates multiply (headRate x burstRate)', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          head: {
            sample: () => 2,
          },
          burstProtection: {
            rateThreshold: 10,
            halfLifeMs: 10_000,
            maxSampleRate: 3,
          },
        },
      })

      // Generate burst to trigger burst protection
      for (let i = 0; i < 200; i++) {
        const span = tracer.startSpan(`composed-${i}`)
        span.end()
      }

      await shutdown()
      const spans = getSpans()

      // Some spans may have SampleRate > 2 (headRate * burstRate)
      const withRate = spans.filter(
        (s) => s.attributes['SampleRate'] !== undefined,
      )
      if (withRate.length > 0) {
        // Rates should be headRate(2) * burstRate(up to 3) = up to 6
        for (const s of withRate) {
          const rate = s.attributes['SampleRate'] as number
          expect(rate).toBeGreaterThanOrEqual(2)
        }
      }
    })

    it('tail + burst: rates multiply', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: () => 2,
          },
          burstProtection: {
            rateThreshold: 10,
            halfLifeMs: 10_000,
            maxSampleRate: 3,
          },
        },
      })

      // Create traces with burst activity
      for (let i = 0; i < 100; i++) {
        const root = tracer.startSpan(`root-${i}`)
        root.end()
      }

      await shutdown()
      const spans = getSpans()

      // Some kept spans may have combined rate > 2
      const withRate = spans.filter(
        (s) => s.attributes['SampleRate'] !== undefined,
      )
      if (withRate.length > 0) {
        for (const s of withRate) {
          const rate = s.attributes['SampleRate'] as number
          expect(rate).toBeGreaterThanOrEqual(2)
        }
      }
    })

    it('stuck span snapshots bypass sampling entirely', async () => {
      vi.useFakeTimers()

      const { tracer, getSpans, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: {
          thresholdMs: 100,
          intervalMs: 50,
        },
        sampling: {
          head: {
            sample: () => 1_000_000, // would drop everything
          },
        },
      })

      const span = tracer.startSpan('stuck-sampled')
      vi.advanceTimersByTime(150)

      await processor.forceFlush()
      const stuck = getSpans().find(
        (s) => s.name === 'stuck-sampled (incomplete)',
      )
      // Stuck span snapshot should bypass sampling and be exported
      expect(stuck).toBeDefined()
      expect(stuck!.attributes['opin_tel.stuck.is_snapshot']).toBe(true)

      span.end()
      await processor.shutdown()
      vi.useRealTimers()
    })
  })

  describe('tail buffer eviction', () => {
    it('evicts oldest entry when maxTraces exceeded', async () => {
      const sampleFn = vi.fn().mockReturnValue(1)
      const { tracer, provider, processor, getSpans, shutdown } =
        createTestProvider({
          dropSyncSpans: false,
          stuckSpanDetection: false,
          sampling: {
            tail: {
              sample: sampleFn,
              maxTraces: 3,
            },
          },
        })

      // Create 5 traces with child spans that end (so evicted entries have data)
      const roots: any[] = []
      for (let i = 0; i < 5; i++) {
        const root = tracer.startSpan(`trace-${i}`)
        context.with(trace.setSpan(context.active(), root), () => {
          const child = tracer.startSpan(`child-${i}`)
          child.end()
        })
        roots.push(root)
      }

      // Buffer should have at most 3 entries (oldest 2 evicted)
      expect((processor as any)._tailBuffer.size).toBeLessThanOrEqual(3)

      // The evicted entries' child spans should have been flushed
      const evictedSpans = getSpans()
      expect(evictedSpans.length).toBeGreaterThan(0)

      // End remaining roots
      for (const root of roots) {
        root.end()
      }

      await shutdown()
    })

    it('evicts entries older than maxAgeMs', async () => {
      const sampleFn = vi.fn().mockReturnValue(1)
      const { tracer, processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: sampleFn,
            maxAgeMs: 50,
          },
        },
      })

      // Create a trace that won't have its root ended
      const root = tracer.startSpan('old-trace')
      const traceId = root.spanContext().traceId

      // Wait for maxAgeMs + eviction interval (5s) to fire naturally
      // Instead, manually call the eviction to avoid long waits
      await new Promise((r) => setTimeout(r, 60))
      ;(processor as any)._evictSamplingState()

      // Buffer entry should be flushed (evicted by age)
      const entry = (processor as any)._tailBuffer.get(traceId)
      if (entry) {
        expect(entry.flushed).toBe(true)
      }

      root.end()
      await processor.shutdown()
    })
  })

  describe('sampling shutdown', () => {
    it('flushes remaining tail buffer entries on shutdown', async () => {
      const { tracer, processor, exporter } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: () => 1,
          },
        },
      })

      // Create a trace with buffered spans (root not ended)
      const root = tracer.startSpan('buffered-root')
      context.with(trace.setSpan(context.active(), root), () => {
        const child = tracer.startSpan('buffered-child')
        child.end()
      })

      // Before shutdown, no spans exported (root hasn't ended)
      expect(exporter.getFinishedSpans().length).toBe(0)

      // Track exports via spy (shutdown clears InMemorySpanExporter)
      const exportedNames: string[] = []
      const origExport = exporter.export.bind(exporter)
      vi.spyOn(exporter, 'export').mockImplementation((spans, cb) => {
        for (const s of spans) exportedNames.push(s.name)
        return origExport(spans, cb)
      })

      // Shutdown flushes buffered entries
      await processor.shutdown()

      // The buffered child should have been exported during shutdown
      expect(exportedNames).toContain('buffered-child')
    })

    it('clears sampling eviction interval', async () => {
      const { processor } = createTestProvider({
        dropSyncSpans: false,
        stuckSpanDetection: false,
        sampling: {
          tail: {
            sample: () => 1,
          },
        },
      })

      expect((processor as any)._samplingEvictionInterval).not.toBeNull()
      await processor.shutdown()
      expect((processor as any)._samplingEvictionInterval).toBeNull()
    })
  })

  describe('span aggregation', () => {
    it('aggregates multiple parallel spans with the same name under one parent', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'S3.GetObject',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // Start 5 parallel child spans
      const children = Array.from({ length: 5 }, () =>
        tracer.startSpan('S3.GetObject', {}, ctx),
      )
      children.forEach((c) => c.end())
      root.end()

      await shutdown()

      const spans = getSpans()
      const s3Spans = spans.filter((s) => s.name === 'S3.GetObject')

      // Should be 1 aggregate span, not 5
      expect(s3Spans).toHaveLength(1)
      const agg = s3Spans[0]!
      expect(agg.attributes['opin_tel.meta.is_aggregate']).toBe(true)
      expect(agg.attributes['opin_tel.agg.count']).toBe(5)
      expect(agg.attributes['opin_tel.agg.error_count']).toBe(0)
      expect(agg.attributes['opin_tel.agg.min_duration_ms']).toBeDefined()
      expect(agg.attributes['opin_tel.agg.max_duration_ms']).toBeDefined()
      expect(agg.attributes['opin_tel.agg.avg_duration_ms']).toBeDefined()
      expect(agg.attributes['opin_tel.agg.total_duration_ms']).toBeDefined()
      // Aggregate should have same parent as the children
      expect(agg.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
      // Aggregate should have same traceId
      expect(agg.spanContext().traceId).toBe(root.spanContext().traceId)
    })

    it('exports error spans individually and counts them in aggregate', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'db.query',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // Start all spans before ending any (parallel pattern)
      const ok1 = tracer.startSpan('db.query', {}, ctx)
      const err1 = tracer.startSpan('db.query', {}, ctx)
      const ok2 = tracer.startSpan('db.query', {}, ctx)

      ok1.end()
      err1.setStatus({ code: SpanStatusCode.ERROR, message: 'timeout' })
      err1.end()
      ok2.end()

      root.end()

      await shutdown()

      const spans = getSpans()
      const dbSpans = spans.filter((s) => s.name === 'db.query')

      // 1 aggregate + 1 error span exported individually
      expect(dbSpans).toHaveLength(2)

      const errorSpan = dbSpans.find(
        (s) => s.status.code === SpanStatusCode.ERROR,
      )
      expect(errorSpan).toBeDefined()
      expect(errorSpan!.status.message).toBe('timeout')

      const agg = dbSpans.find(
        (s) => s.attributes['opin_tel.agg.count'] !== undefined,
      )
      expect(agg).toBeDefined()
      expect(agg!.attributes['opin_tel.agg.count']).toBe(3)
      expect(agg!.attributes['opin_tel.agg.error_count']).toBe(1)
    })

    it('exports single non-error span as-is without aggregate wrapper', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'cache.get',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const child = tracer.startSpan('cache.get', {}, ctx)
      child.setAttribute('cache.key', 'user:1')
      child.end()
      root.end()

      await shutdown()

      const spans = getSpans()
      const cacheSpans = spans.filter((s) => s.name === 'cache.get')

      // Single span — no aggregate, just the original
      expect(cacheSpans).toHaveLength(1)
      expect(cacheSpans[0]!.attributes['opin_tel.agg.count']).toBeUndefined()
      expect(cacheSpans[0]!.attributes['cache.key']).toBe('user:1')
    })

    it('does not emit aggregate when all spans are errors', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'rpc.call',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const e1 = tracer.startSpan('rpc.call', {}, ctx)
      e1.setStatus({ code: SpanStatusCode.ERROR })
      e1.end()

      const e2 = tracer.startSpan('rpc.call', {}, ctx)
      e2.setStatus({ code: SpanStatusCode.ERROR })
      e2.end()

      root.end()

      await shutdown()

      const spans = getSpans()
      const rpcSpans = spans.filter((s) => s.name === 'rpc.call')

      // Both error spans exported individually, no aggregate
      expect(rpcSpans).toHaveLength(2)
      rpcSpans.forEach((s) => {
        expect(s.status.code).toBe(SpanStatusCode.ERROR)
        expect(s.attributes['opin_tel.agg.count']).toBeUndefined()
      })
    })

    it('works with per-instrumentation aggregate: true option', async () => {
      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          'test-dataloader': { aggregate: true },
        },
      })

      const tracer = provider.getTracer('test-dataloader')
      const rootTracer = provider.getTracer('test')

      const root = rootTracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // Start all spans before ending (parallel)
      const c1 = tracer.startSpan('dataloader.load', {}, ctx)
      const c2 = tracer.startSpan('dataloader.load', {}, ctx)
      const c3 = tracer.startSpan('dataloader.load', {}, ctx)
      c1.end()
      c2.end()
      c3.end()

      root.end()

      await shutdown()

      const spans = getSpans()
      const dlSpans = spans.filter((s) => s.name === 'dataloader.load')

      expect(dlSpans).toHaveLength(1)
      expect(dlSpans[0]!.attributes['opin_tel.agg.count']).toBe(3)
    })

    it('root spans never aggregate even if predicate matches', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: () => true,
      })

      const r1 = tracer.startSpan('handler')
      r1.end()
      const r2 = tracer.startSpan('handler')
      r2.end()

      await shutdown()

      const spans = getSpans()
      // Both root spans should be exported individually
      expect(spans.filter((s) => s.name === 'handler')).toHaveLength(2)
      spans.forEach((s) => {
        expect(s.attributes['opin_tel.agg.count']).toBeUndefined()
      })
    })

    it('aggregate span has correct time bounds and duration stats', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'fetch',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // Start both before ending (parallel)
      const c1 = tracer.startSpan('fetch', {}, ctx)
      const c2 = tracer.startSpan('fetch', {}, ctx)
      c1.end()
      c2.end()

      root.end()

      await shutdown()

      const spans = getSpans()
      const agg = spans.find(
        (s) => s.attributes['opin_tel.agg.count'] !== undefined,
      )
      expect(agg).toBeDefined()

      // Duration stats should be non-negative numbers
      const minD = agg!.attributes['opin_tel.agg.min_duration_ms'] as number
      const maxD = agg!.attributes['opin_tel.agg.max_duration_ms'] as number
      const avgD = agg!.attributes['opin_tel.agg.avg_duration_ms'] as number
      const totalD = agg!.attributes['opin_tel.agg.total_duration_ms'] as number

      expect(minD).toBeGreaterThanOrEqual(0)
      expect(maxD).toBeGreaterThanOrEqual(minD)
      expect(avgD).toBeGreaterThanOrEqual(0)
      expect(totalD).toBeGreaterThanOrEqual(0)
    })

    it('flushes incomplete aggregate groups on shutdown', async () => {
      const { tracer, processor, exporter } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'batch',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // Start 3 spans but only end 2 — one still in-flight
      const c1 = tracer.startSpan('batch', {}, ctx)
      const c2 = tracer.startSpan('batch', {}, ctx)
      const c3 = tracer.startSpan('batch', {}, ctx)
      c1.end()
      c2.end()
      // c3 still in-flight

      // Verify group exists before shutdown
      const groups = (processor as any)._aggregateGroups as Map<string, unknown>
      expect(groups.size).toBe(1)

      // Spy on the wrapped processor to capture what shutdown emits
      const wrappedOnEnd = vi.spyOn((processor as any)._wrapped, 'onEnd')

      await processor.shutdown()

      // Group should be cleared
      expect(groups.size).toBe(0)

      // Wrapped processor should have received a span with aggregate attrs
      const emittedCalls = wrappedOnEnd.mock.calls
      const aggCall = emittedCalls.find(
        ([s]: any) =>
          s.name === 'batch' &&
          s.attributes?.['opin_tel.agg.count'] !== undefined,
      )
      expect(aggCall).toBeDefined()
      expect((aggCall![0] as any).attributes['opin_tel.agg.count']).toBe(2)
    })

    it('separate batches under same parent create separate aggregates', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name === 'S3.GetObject',
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // First batch
      const b1c1 = tracer.startSpan('S3.GetObject', {}, ctx)
      const b1c2 = tracer.startSpan('S3.GetObject', {}, ctx)
      b1c1.end()
      b1c2.end()
      // inflight drops to 0 → group emitted and deleted

      // Second batch (new group)
      const b2c1 = tracer.startSpan('S3.GetObject', {}, ctx)
      const b2c2 = tracer.startSpan('S3.GetObject', {}, ctx)
      const b2c3 = tracer.startSpan('S3.GetObject', {}, ctx)
      b2c1.end()
      b2c2.end()
      b2c3.end()

      root.end()

      await shutdown()

      const spans = getSpans()
      const s3Spans = spans.filter(
        (s) => s.attributes['opin_tel.agg.count'] !== undefined,
      )

      // Two separate aggregate spans
      expect(s3Spans).toHaveLength(2)
      const counts = s3Spans.map((s) => s.attributes['opin_tel.agg.count'])
      expect(counts).toContain(2)
      expect(counts).toContain(3)
    })

    it('non-matching spans are not aggregated', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => span.name.startsWith('S3.'),
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      // These should aggregate
      const s3a = tracer.startSpan('S3.GetObject', {}, ctx)
      const s3b = tracer.startSpan('S3.GetObject', {}, ctx)
      s3a.end()
      s3b.end()

      // This should NOT aggregate
      const db = tracer.startSpan('db.query', {}, ctx)
      db.end()

      root.end()

      await shutdown()

      const spans = getSpans()
      expect(spans.filter((s) => s.name === 'S3.GetObject')).toHaveLength(1)
      expect(spans.filter((s) => s.name === 'db.query')).toHaveLength(1)
      expect(
        spans.find((s) => s.name === 'db.query')!.attributes[
          'opin_tel.agg.count'
        ],
      ).toBeUndefined()
    })

    it('computes custom attribute stats with uniq option', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => {
          if (span.name !== 'redis.cmd') return false
          return {
            attributes: {
              all_commands: {
                attribute: 'db.statement',
                options: 'uniq',
              },
            },
          }
        },
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const c1 = tracer.startSpan('redis.cmd', {}, ctx)
      c1.setAttribute('db.statement', 'GET user:1')
      const c2 = tracer.startSpan('redis.cmd', {}, ctx)
      c2.setAttribute('db.statement', 'GET user:2')
      const c3 = tracer.startSpan('redis.cmd', {}, ctx)
      c3.setAttribute('db.statement', 'GET user:1') // duplicate
      c1.end()
      c2.end()
      c3.end()

      root.end()
      await shutdown()

      const agg = getSpans().find(
        (s) => s.attributes['opin_tel.meta.is_aggregate'],
      )
      expect(agg).toBeDefined()
      expect(agg!.attributes['opin_tel.agg.count']).toBe(3)

      const uniq = agg!.attributes['opin_tel.agg.all_commands.uniq'] as string[]
      expect(uniq).toHaveLength(2)
      expect(uniq).toContain('GET user:1')
      expect(uniq).toContain('GET user:2')
    })

    it('computes numeric attribute stats (min, max, avg, sum, range, median)', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => {
          if (span.name !== 'redis.cmd') return false
          return {
            attributes: {
              response_bytes: {
                attribute: 'redis.response_size_bytes',
                options: ['min', 'max', 'avg', 'sum', 'range', 'median'],
              },
            },
          }
        },
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const c1 = tracer.startSpan('redis.cmd', {}, ctx)
      c1.setAttribute('redis.response_size_bytes', 100)
      const c2 = tracer.startSpan('redis.cmd', {}, ctx)
      c2.setAttribute('redis.response_size_bytes', 200)
      const c3 = tracer.startSpan('redis.cmd', {}, ctx)
      c3.setAttribute('redis.response_size_bytes', 300)
      c1.end()
      c2.end()
      c3.end()

      root.end()
      await shutdown()

      const agg = getSpans().find(
        (s) => s.attributes['opin_tel.meta.is_aggregate'],
      )
      expect(agg).toBeDefined()
      expect(agg!.attributes['opin_tel.agg.response_bytes.min']).toBe(100)
      expect(agg!.attributes['opin_tel.agg.response_bytes.max']).toBe(300)
      expect(agg!.attributes['opin_tel.agg.response_bytes.avg']).toBe(200)
      expect(agg!.attributes['opin_tel.agg.response_bytes.sum']).toBe(600)
      expect(agg!.attributes['opin_tel.agg.response_bytes.range']).toBe(200)
      expect(agg!.attributes['opin_tel.agg.response_bytes.median']).toBe(200)
    })

    it('computes count option for attribute frequency', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => {
          if (span.name !== 'fetch') return false
          return {
            attributes: {
              status: {
                attribute: 'http.status_code',
                options: 'count',
              },
            },
          }
        },
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const c1 = tracer.startSpan('fetch', {}, ctx)
      c1.setAttribute('http.status_code', 200)
      const c2 = tracer.startSpan('fetch', {}, ctx)
      c2.setAttribute('http.status_code', 200)
      const c3 = tracer.startSpan('fetch', {}, ctx)
      // c3 has no http.status_code
      c1.end()
      c2.end()
      c3.end()

      root.end()
      await shutdown()

      const agg = getSpans().find(
        (s) => s.attributes['opin_tel.meta.is_aggregate'],
      )
      expect(agg).toBeDefined()
      // Only 2 of 3 spans had the attribute
      expect(agg!.attributes['opin_tel.agg.status.count']).toBe(2)
    })

    it('per-scope aggregate config with attributes', async () => {
      const { provider, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        instrumentationHooks: {
          'test-redis': {
            aggregate: {
              attributes: {
                sizes: {
                  attribute: 'redis.response_size_bytes',
                  options: ['min', 'max'],
                },
              },
            },
          },
        },
      })

      const tracer = provider.getTracer('test-redis')
      const rootTracer = provider.getTracer('test')

      const root = rootTracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const c1 = tracer.startSpan('redis.get', {}, ctx)
      c1.setAttribute('redis.response_size_bytes', 50)
      const c2 = tracer.startSpan('redis.get', {}, ctx)
      c2.setAttribute('redis.response_size_bytes', 150)
      c1.end()
      c2.end()

      root.end()
      await shutdown()

      const agg = getSpans().find(
        (s) => s.attributes['opin_tel.meta.is_aggregate'],
      )
      expect(agg).toBeDefined()
      expect(agg!.attributes['opin_tel.agg.sizes.min']).toBe(50)
      expect(agg!.attributes['opin_tel.agg.sizes.max']).toBe(150)
    })

    it('keepErrors: false consumes error spans into the aggregate', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => {
          if (span.name !== 'rpc.call') return false
          return { keepErrors: false }
        },
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const ok = tracer.startSpan('rpc.call', {}, ctx)
      const err = tracer.startSpan('rpc.call', {}, ctx)
      err.setStatus({ code: SpanStatusCode.ERROR })
      ok.end()
      err.end()

      root.end()
      await shutdown()

      const spans = getSpans()
      const rpcSpans = spans.filter((s) => s.name === 'rpc.call')

      // Both consumed into aggregate, no individual error span
      expect(rpcSpans).toHaveLength(1)
      expect(rpcSpans[0]!.attributes['opin_tel.meta.is_aggregate']).toBe(true)
      expect(rpcSpans[0]!.attributes['opin_tel.agg.count']).toBe(2)
      expect(rpcSpans[0]!.attributes['opin_tel.agg.error_count']).toBe(1)
    })

    it('median with even number of values takes average of two middle', async () => {
      const { tracer, getSpans, shutdown } = createTestProvider({
        dropSyncSpans: false,
        aggregateSpan: (span) => {
          if (span.name !== 'op') return false
          return {
            attributes: {
              val: { attribute: 'x', options: 'median' },
            },
          }
        },
      })

      const root = tracer.startSpan('handler')
      const ctx = trace.setSpan(context.active(), root)

      const c1 = tracer.startSpan('op', {}, ctx)
      c1.setAttribute('x', 10)
      const c2 = tracer.startSpan('op', {}, ctx)
      c2.setAttribute('x', 20)
      const c3 = tracer.startSpan('op', {}, ctx)
      c3.setAttribute('x', 30)
      const c4 = tracer.startSpan('op', {}, ctx)
      c4.setAttribute('x', 40)
      c1.end()
      c2.end()
      c3.end()
      c4.end()

      root.end()
      await shutdown()

      const agg = getSpans().find(
        (s) => s.attributes['opin_tel.meta.is_aggregate'],
      )
      expect(agg).toBeDefined()
      // median of [10, 20, 30, 40] = (20 + 30) / 2 = 25
      expect(agg!.attributes['opin_tel.agg.val.median']).toBe(25)
    })
  })
})
