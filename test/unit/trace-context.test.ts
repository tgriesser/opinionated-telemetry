import { describe, it, expect, afterEach } from 'vitest'
import { context, trace } from '@opentelemetry/api'
import { createTestProvider, nextTick, cleanupOtel } from '../helpers.js'
import { setTraceContext, getRootSpan } from '../../src/trace-context.js'

describe('trace-level context', () => {
  afterEach(() => cleanupOtel())

  describe('setTraceContext', () => {
    it('applies trace context attributes to all spans in a trace', async () => {
      const { tracer, exporter, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        setTraceContext({ 'user.id': '123', 'user.role': 'admin' })

        const rootCtx = trace.setSpan(context.active(), root)
        const child = tracer.startSpan('child', {}, rootCtx)
        await nextTick()
        child.end()

        await nextTick()
        root.end()
      })
      await shutdown()

      const rootSpan = exporter.assertSpanExists('root')
      expect(rootSpan.attributes['user.id']).toBe('123')
      expect(rootSpan.attributes['user.role']).toBe('admin')

      const childSpan = exporter.assertSpanExists('child')
      expect(childSpan.attributes['user.id']).toBe('123')
      expect(childSpan.attributes['user.role']).toBe('admin')
    })

    it('does not overwrite existing span attributes', async () => {
      const { tracer, exporter, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        setTraceContext({ 'user.id': 'trace-level', custom: 'from-trace' })

        const rootCtx = trace.setSpan(context.active(), root)
        const child = tracer.startSpan(
          'child',
          { attributes: { 'user.id': 'span-level' } },
          rootCtx,
        )
        await nextTick()
        child.end()

        await nextTick()
        root.end()
      })
      await shutdown()

      const childSpan = exporter.assertSpanExists('child')
      // Span-level attribute takes precedence
      expect(childSpan.attributes['user.id']).toBe('span-level')
      // Trace context fills in missing attributes
      expect(childSpan.attributes['custom']).toBe('from-trace')
    })

    it('is a no-op when called without active span', () => {
      // Should not throw, and no processor state is modified
      setTraceContext({ 'user.id': '123' })
    })

    it('merges attributes from multiple calls', async () => {
      const { tracer, exporter, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        setTraceContext({ 'user.id': '123' })
        setTraceContext({ 'user.role': 'admin' })

        await nextTick()
        root.end()
      })
      await shutdown()

      const rootSpan = exporter.assertSpanExists('root')
      expect(rootSpan.attributes['user.id']).toBe('123')
      expect(rootSpan.attributes['user.role']).toBe('admin')
    })

    it('later calls overwrite earlier trace context values for the same key', async () => {
      const { tracer, exporter, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        setTraceContext({ 'user.id': 'old' })
        setTraceContext({ 'user.id': 'new' })

        await nextTick()
        root.end()
      })
      await shutdown()

      const rootSpan = exporter.assertSpanExists('root')
      expect(rootSpan.attributes['user.id']).toBe('new')
    })

    it('isolates trace context between different traces', async () => {
      const { tracer, exporter, shutdown } = createTestProvider()

      // Trace 1
      await tracer.startActiveSpan('root-1', async (root) => {
        setTraceContext({ source: 'trace-1' })
        await nextTick()
        root.end()
      })

      // Trace 2
      await tracer.startActiveSpan('root-2', async (root) => {
        setTraceContext({ source: 'trace-2' })
        await nextTick()
        root.end()
      })

      await shutdown()

      const span1 = exporter.assertSpanExists('root-1')
      expect(span1.attributes['source']).toBe('trace-1')

      const span2 = exporter.assertSpanExists('root-2')
      expect(span2.attributes['source']).toBe('trace-2')
    })
  })

  describe('getRootSpan', () => {
    it('returns the root span from a child span context', async () => {
      const { tracer, exporter, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        const rootCtx = trace.setSpan(context.active(), root)

        await tracer.startActiveSpan('child', {}, rootCtx, async (child) => {
          const rootSpan = getRootSpan()
          expect(rootSpan).toBeDefined()
          rootSpan!.setAttribute('user.id', '123')

          await nextTick()
          child.end()
        })

        await nextTick()
        root.end()
      })
      await shutdown()

      const rootSpan = exporter.assertSpanExists('root')
      expect(rootSpan.attributes['user.id']).toBe('123')
    })

    it('returns the root span from the root span context itself', async () => {
      const { tracer, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        const rootSpan = getRootSpan()
        expect(rootSpan).toBe(root)

        await nextTick()
        root.end()
      })
      await shutdown()
    })

    it('returns undefined when no active span', () => {
      expect(getRootSpan()).toBeUndefined()
    })

    it('returns undefined after root span has ended', async () => {
      const { tracer, shutdown } = createTestProvider()

      await tracer.startActiveSpan('root', async (root) => {
        await nextTick()
        root.end()

        // Root has ended — getRootSpan should return undefined
        // (we're still in the active span context but the root span was cleaned up)
        expect(getRootSpan()).toBeUndefined()
      })
      await shutdown()
    })
  })

  describe('tail buffer retroactive application', () => {
    it('applies trace context retroactively to tail-buffered spans', async () => {
      const { tracer, exporter, shutdown } = createTestProvider({
        sampling: {
          tail: {
            sample: () => 1, // keep all
          },
        },
      })

      await tracer.startActiveSpan('root', async (root) => {
        const rootCtx = trace.setSpan(context.active(), root)

        // Child ends and enters tail buffer
        const child = tracer.startSpan('child', {}, rootCtx)
        await nextTick()
        child.end()

        // Set trace context AFTER child was already buffered
        setTraceContext({ 'user.id': 'late-set' })

        // Root ends, triggers tail flush
        await nextTick()
        root.end()
      })
      await shutdown()

      // Both spans should have the trace context
      const rootSpan = exporter.assertSpanExists('root')
      expect(rootSpan.attributes['user.id']).toBe('late-set')

      const childSpan = exporter.assertSpanExists('child')
      expect(childSpan.attributes['user.id']).toBe('late-set')
    })

    it('does not overwrite span attributes during retroactive application', async () => {
      const { tracer, exporter, shutdown } = createTestProvider({
        sampling: {
          tail: {
            sample: () => 1,
          },
        },
      })

      await tracer.startActiveSpan('root', async (root) => {
        const rootCtx = trace.setSpan(context.active(), root)

        const child = tracer.startSpan(
          'child',
          { attributes: { 'user.id': 'original' } },
          rootCtx,
        )
        await nextTick()
        child.end()

        // Set trace context with conflicting key
        setTraceContext({ 'user.id': 'should-not-overwrite', extra: 'added' })

        await nextTick()
        root.end()
      })
      await shutdown()

      const childSpan = exporter.assertSpanExists('child')
      expect(childSpan.attributes['user.id']).toBe('original')
      expect(childSpan.attributes['extra']).toBe('added')
    })

    it('applies trace context set before and during trace to tail-buffered spans', async () => {
      const { tracer, exporter, shutdown } = createTestProvider({
        sampling: {
          tail: {
            sample: () => 1,
          },
        },
      })

      await tracer.startActiveSpan('root', async (root) => {
        const rootCtx = trace.setSpan(context.active(), root)

        // Set trace context before any children
        setTraceContext({ 'app.env': 'test' })

        const child1 = tracer.startSpan('child-1', {}, rootCtx)
        await nextTick()
        child1.end()

        // Add more trace context mid-trace
        setTraceContext({ 'user.id': '456' })

        const child2 = tracer.startSpan('child-2', {}, rootCtx)
        await nextTick()
        child2.end()

        await nextTick()
        root.end()
      })
      await shutdown()

      // All spans get all trace context attributes (retroactive application)
      for (const name of ['root', 'child-1', 'child-2']) {
        const span = exporter.assertSpanExists(name)
        expect(span.attributes['app.env']).toBe('test')
        expect(span.attributes['user.id']).toBe('456')
      }
    })
  })
})
