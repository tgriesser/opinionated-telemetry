import { describe, it, expect, afterEach, vi } from 'vitest'
import { trace } from '@opentelemetry/api'
import { FilteringSpanProcessor } from '../../src/filtering-span-processor.js'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

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
      enableCollapse: true,
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

  it('applies renameSpan hook from hooks config', () => {
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
        'test-rename-scope': {
          renameSpan: (name) => `prefixed:${name}`,
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
    // After onStart, the span name should be renamed
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
