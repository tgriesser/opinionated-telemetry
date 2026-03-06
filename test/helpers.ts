import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BasicTracerProvider,
} from '@opentelemetry/sdk-trace-base'
import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { FilteringSpanProcessor } from '../src/filtering-span-processor.js'
import type { FilteringSpanProcessorConfig } from '../src/filtering-span-processor.js'
import { OpinionatedInstrumentation } from '../src/opinionated-instrumentation.js'

/**
 * Set up a global context manager so startActiveSpan / getActiveSpan work.
 * Call cleanupOtel() in afterEach to tear it down.
 */
export function setupOtel() {
  const contextManager = new AsyncLocalStorageContextManager().enable()
  context.setGlobalContextManager(contextManager)
}

export function createTestProvider(config?: FilteringSpanProcessorConfig) {
  setupOtel()
  const exporter = new InMemorySpanExporter()
  const inner = new SimpleSpanProcessor(exporter)
  const processor = new FilteringSpanProcessor(inner, config)
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  })

  return {
    exporter,
    processor,
    provider,
    tracer: provider.getTracer('test'),
    getSpans: () => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    async shutdown() {
      await provider.forceFlush()
    },
  }
}

export function createSimpleProvider() {
  setupOtel()
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  return {
    tracer: provider.getTracer('test'),
    exporter,
    provider,
    getSpans: () => exporter.getFinishedSpans(),
    async shutdown() {
      await provider.forceFlush()
    },
  }
}

/**
 * Wait for a nextTick to pass so sync span detection advances.
 */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve))
}

/**
 * Clean up the global OTel context between tests.
 */
export function cleanupOtel() {
  trace.disable()
  context.disable()
  propagation.disable()
  OpinionatedInstrumentation.clearRegistry()
}
