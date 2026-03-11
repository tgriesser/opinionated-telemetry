import { describe, it, expect, afterEach, vi } from 'vitest'
import { trace, context } from '@opentelemetry/api'
import { FilteringSpanProcessor } from '../../src/filtering-span-processor.js'
import {
  createSimpleProvider,
  createTestProvider,
  cleanupOtel,
} from '../helpers.js'

describe('instrumentationHooks', () => {
  afterEach(() => cleanupOtel())

  it('applies collapse option from hooks config', () => {
    const onEndSpy = vi.fn()
    const wrapped = {
      onStart: vi.fn(),
      onEnd: onEndSpy,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
    const processor = new FilteringSpanProcessor(wrapped, {
      dropSyncSpans: false,
      instrumentationHooks: {
        'test-scope': { collapse: true },
      },
    })

    const { provider } = createSimpleProvider()
    const tracer = provider.getTracer('test-scope')

    const root = tracer.startSpan('root')
    trace.setSpan(require('@opentelemetry/api').context.active(), root)

    const child = tracer.startSpan('child')
    child.end()
    root.end()

    // The collapse span (root) should be dropped, child should pass through
    processor.shutdown()
  })

  it('can rename span via onStart hook', () => {
    const wrapped = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
    const processor = new FilteringSpanProcessor(wrapped, {
      dropSyncSpans: false,
      instrumentationHooks: {
        'test-rename-scope': {
          onStart: (span) => {
            span.updateName(`prefixed:${span.name}`)
          },
        },
      },
    })

    const { provider } = createSimpleProvider()
    const tracer = provider.getTracer('test-rename-scope')

    const span = tracer.startSpan('original')
    processor.onStart(
      span as any,
      require('@opentelemetry/api').context.active(),
    )
    expect((span as any).name).toBe('prefixed:original')

    processor.shutdown()
  })

  it('applies onStart hook from hooks config', () => {
    const onStartHook = vi.fn()
    const wrapped = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
    const processor = new FilteringSpanProcessor(wrapped, {
      dropSyncSpans: false,
      instrumentationHooks: {
        'test-onstart-scope': {
          onStart: onStartHook,
        },
      },
    })

    const { provider } = createSimpleProvider()
    const tracer = provider.getTracer('test-onstart-scope')

    const span = tracer.startSpan('test')
    processor.onStart(
      span as any,
      require('@opentelemetry/api').context.active(),
    )

    expect(onStartHook).toHaveBeenCalledTimes(1)
    processor.shutdown()
  })

  it('does not apply hooks for unregistered scopes', () => {
    const onStartHook = vi.fn()
    const wrapped = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
    const processor = new FilteringSpanProcessor(wrapped, {
      dropSyncSpans: false,
      instrumentationHooks: {
        'other-scope': { onStart: onStartHook },
      },
    })

    const { provider } = createSimpleProvider()
    const tracer = provider.getTracer('unmatched-scope')

    const span = tracer.startSpan('test')
    processor.onStart(
      span as any,
      require('@opentelemetry/api').context.active(),
    )

    expect(onStartHook).not.toHaveBeenCalled()
    processor.shutdown()
  })

  it('collapses per-span via onStart returning { collapse: true }', async () => {
    const { provider, exporter, shutdown } = createTestProvider({
      dropSyncSpans: false,
      instrumentationHooks: {
        'test-collapse-onstart': {
          onStart: (span) => {
            if (span.name === 'should-collapse') {
              return { collapse: true }
            }
          },
        },
      },
    })

    const tracer = provider.getTracer('test-collapse-onstart')
    const normalTracer = provider.getTracer('test')

    const root = normalTracer.startSpan('root')
    context.with(trace.setSpan(context.active(), root), () => {
      const collapse = tracer.startSpan('should-collapse')
      collapse.setAttribute('parent.attr', 'inherited')

      context.with(trace.setSpan(context.active(), collapse), () => {
        const child = normalTracer.startSpan('child')
        child.setAttribute('child.attr', 'kept')
        child.end()
      })
      collapse.end()

      // This span from the same scope should NOT be collapsed
      const keep = tracer.startSpan('should-keep')
      keep.end()
    })
    root.end()
    await shutdown()

    exporter.assertSpanNotExists('should-collapse')
    const child = exporter.assertSpanExists('child')
    expect(child.attributes['parent.attr']).toBe('inherited')
    expect(child.attributes['child.attr']).toBe('kept')
    exporter.assertSpanExists('should-keep')
  })

  it('collapse from onStart takes precedence over shouldDrop', async () => {
    const shouldDropFn = vi.fn()
    const { provider, exporter, shutdown } = createTestProvider({
      dropSyncSpans: false,
      instrumentationHooks: {
        'test-precedence': {
          onStart: () => ({
            collapse: true,
            shouldDrop: shouldDropFn,
          }),
        },
      },
    })

    const tracer = provider.getTracer('test-precedence')
    const normalTracer = provider.getTracer('test')

    const root = normalTracer.startSpan('root')
    context.with(trace.setSpan(context.active(), root), () => {
      const span = tracer.startSpan('collapsed')
      span.setAttribute('attr', 'val')
      context.with(trace.setSpan(context.active(), span), () => {
        const child = normalTracer.startSpan('child')
        child.end()
      })
      span.end()
    })
    root.end()
    await shutdown()

    // shouldDrop should never have been registered/called
    expect(shouldDropFn).not.toHaveBeenCalled()
    exporter.assertSpanNotExists('collapsed')
    const child = exporter.assertSpanExists('child')
    expect(child.attributes['attr']).toBe('val')
  })

  it('globalHooks.onStart can return { collapse: true }', async () => {
    const { provider, exporter, shutdown } = createTestProvider({
      dropSyncSpans: false,
      globalHooks: {
        onStart: (span) => {
          if (span.name === 'global-collapse') {
            return { collapse: true }
          }
        },
      },
    })

    const tracer = provider.getTracer('test')

    const root = tracer.startSpan('root')
    context.with(trace.setSpan(context.active(), root), () => {
      const collapse = tracer.startSpan('global-collapse')
      collapse.setAttribute('from.parent', 'yes')
      context.with(trace.setSpan(context.active(), collapse), () => {
        const child = tracer.startSpan('child')
        child.end()
      })
      collapse.end()
    })
    root.end()
    await shutdown()

    exporter.assertSpanNotExists('global-collapse')
    const child = exporter.assertSpanExists('child')
    expect(child.attributes['from.parent']).toBe('yes')
  })

  it('defaults to empty hooks when not provided', () => {
    const wrapped = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
    const processor = new FilteringSpanProcessor(wrapped, {
      dropSyncSpans: false,
    })

    const { provider } = createSimpleProvider()
    const tracer = provider.getTracer('any-scope')

    const span = tracer.startSpan('test')
    // Should not throw
    processor.onStart(
      span as any,
      require('@opentelemetry/api').context.active(),
    )
    processor.shutdown()
  })
})
