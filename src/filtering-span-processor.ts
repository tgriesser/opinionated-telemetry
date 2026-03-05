import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { Context } from '@opentelemetry/api'
import { propagation } from '@opentelemetry/api'
import debugLib from 'debug'
import { OpinionatedInstrumentation } from './opinionated-instrumentation.js'
import type { SpanImpl } from '@opentelemetry/sdk-trace-base/build/src/Span.js'

const debug = debugLib('opin-tel:filtering-processor')
const TICK_KEY = '__tick'
const MEMORY_KEY = '__memStart'

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

export type MemoryDeltaKey = keyof NodeJS.MemoryUsage

export interface MemoryDeltaConfig {
  /** Capture rss delta */
  rss?: boolean
  /** Capture heapTotal delta */
  heapTotal?: boolean
  /** Capture heapUsed delta */
  heapUsed?: boolean
  /** Capture external delta */
  external?: boolean
  /** Capture arrayBuffers delta */
  arrayBuffers?: boolean
}

export interface FilteringSpanProcessorConfig {
  /** Drop spans that start and end in the same tick. Default: true */
  dropSyncSpans?: true | ((span: Span & ReadableSpan) => boolean)
  /** Enable reparenting for instrumentations with reparent: true. Default: true */
  enableReparenting?: boolean
  /** Propagate baggage entries as span attributes in onStart. Default: true */
  baggageToAttributes?: boolean
  /**
   * Capture memory usage deltas on root spans.
   * - `true` (default): capture rss delta only via the fast `process.memoryUsage.rss()` path
   * - `MemoryDeltaConfig`: pick specific fields (rss, heapTotal, heapUsed, external, arrayBuffers)
   *   — uses `process.memoryUsage()` which includes V8 heap stats
   * - `false`: disable
   */
  memoryDelta?: boolean | MemoryDeltaConfig
  /** Called when a span ends after shutdown and won't be exported. Default: debug log */
  onSpanAfterShutdown?: (span: Span & ReadableSpan) => void
}

export class FilteringSpanProcessor implements SpanProcessor {
  private _wrapped: SpanProcessor
  private _config: FilteringSpanProcessorConfig
  private _reparentSpans = new Map<string, Span & ReadableSpan>()
  private _rootSpans = new Map<string, ReadableSpan>()
  private _allSpans = new Set<Span>()
  private _didShutdown = false
  private _nextTickScheduled = false
  private _currentTick = 0
  /** When true, use fast process.memoryUsage.rss() path (rss only) */
  private _memoryFastPath = false
  /** When set, use full process.memoryUsage() and capture these keys/attribute names */
  private _memoryKeys: [MemoryDeltaKey, string][] = []

  constructor(wrapped: SpanProcessor, config?: FilteringSpanProcessorConfig) {
    this._wrapped = wrapped
    this._config = {
      dropSyncSpans: config?.dropSyncSpans ?? true,
      enableReparenting: config?.enableReparenting ?? true,
      baggageToAttributes: config?.baggageToAttributes ?? true,
      memoryDelta: config?.memoryDelta ?? true,
      onSpanAfterShutdown: config?.onSpanAfterShutdown,
    }
    const md = this._config.memoryDelta
    if (md === true) {
      this._memoryFastPath = true
    } else if (md && typeof md === 'object') {
      this._memoryKeys = (Object.keys(md) as MemoryDeltaKey[])
        .filter((k) => md[k])
        .map((k) => [k, `memory.delta.${camelToSnake(k)}`])
    }
  }

  onStart(span: Span & ReadableSpan, ctx: Context): void {
    // Track all spans, for both dead span detection as well as knowing how many spans are open concurrently
    this._allSpans.add(span)

    // Track tick for sync span detection
    if (this._config.dropSyncSpans) {
      Object.defineProperty(span, TICK_KEY, {
        value: this._currentTick,
      })
      if (!this._nextTickScheduled) {
        this._scheduleNextTick()
      }
    }

    // Propagate baggage entries as span attributes
    if (this._config.baggageToAttributes) {
      const bag = propagation.getBaggage(ctx)
      if (bag) {
        for (const [key, entry] of bag.getAllEntries()) {
          span.setAttribute(key, entry.value)
        }
      }
    }

    // Track root spans
    if (!span.parentSpanContext) {
      const spanCtx = span.spanContext()
      if (!this._rootSpans.has(spanCtx.traceId)) {
        this._rootSpans.set(spanCtx.traceId, span)
        if (this._memoryFastPath) {
          Object.defineProperty(span, MEMORY_KEY, {
            value: process.memoryUsage.rss(),
          })
        } else if (this._memoryKeys.length > 0) {
          Object.defineProperty(span, MEMORY_KEY, {
            value: process.memoryUsage(),
          })
        }
      } else {
        debug(
          'multiple root spans for trace=%s span=%s',
          spanCtx.traceId,
          span.name,
        )
      }
    }

    // Check opinionated options for this instrumentation scope
    const scope = (span as any).instrumentationScope?.name
    if (scope) {
      const opts = OpinionatedInstrumentation.getOptions(scope)
      if (opts) {
        if (opts.reparent) {
          this._reparentSpans.set(span.spanContext().spanId, span)
        }
        if (opts.renameSpan) {
          const newName = opts.renameSpan(span.name, span)
          if (newName) {
            span.updateName(newName)
          }
        }
        if (opts.onStart) {
          opts.onStart(span)
        }
      }
    }

    this._wrapped.onStart(span, ctx)
  }

  onEnd(span: SpanImpl): void {
    this._allSpans.delete(span)

    // Drop sync spans
    if (this._config.dropSyncSpans) {
      const shouldDrop =
        typeof this._config.dropSyncSpans === 'function'
          ? this._config.dropSyncSpans(span)
          : (span as any)[TICK_KEY] === this._currentTick
      if (shouldDrop) {
        debug('dropping sync span: %s', span.name)
        return
      }
    }

    // Reopen the span for additional modifications in the onEnd
    span['_ended'] = false

    // Check opinionated options for rename/onEnd hooks
    const scope = (span as any).instrumentationScope?.name
    if (scope) {
      const opts = OpinionatedInstrumentation.getOptions(scope)
      if (opts) {
        if (opts.renameSpanOnEnd) {
          const newName = opts.renameSpanOnEnd(span)
          if (newName) {
            span.updateName(newName)
          }
        }
        if (opts.onEnd) {
          opts.onEnd(span)
        }
      }
    }

    // Memory delta for root spans
    if (!span.parentSpanContext) {
      const startMem = (span as any)[MEMORY_KEY]
      if (startMem != null) {
        if (this._memoryFastPath) {
          span.setAttribute(
            'memory.delta.rss',
            process.memoryUsage.rss() - (startMem as number),
          )
        } else {
          const endMem = process.memoryUsage()
          for (const [key, attr] of this._memoryKeys) {
            span.setAttribute(
              attr,
              endMem[key] - (startMem as NodeJS.MemoryUsage)[key],
            )
          }
        }
      }
    }

    // Reparenting logic
    if (!span.parentSpanContext) {
      this._rootSpans.delete(span.spanContext().traceId)
    } else if (this._config.enableReparenting) {
      const parentSpanId = (span as any).parentSpanContext.spanId
      let reparentSpan = this._reparentSpans.get(parentSpanId)
      if (reparentSpan) {
        // Walk up the reparent chain to find what we're actually reparenting to
        while (
          reparentSpan.parentSpanContext?.spanId &&
          this._reparentSpans.has(reparentSpan.parentSpanContext?.spanId)
        ) {
          reparentSpan = this._reparentSpans.get(
            reparentSpan.parentSpanContext.spanId,
          )!
        }
        debug(
          'reparenting span=%s from parent=%s to grandparent=%s',
          span.name,
          parentSpanId,
          reparentSpan.parentSpanContext?.spanId,
        )
        for (const [key, val] of Object.entries(reparentSpan.attributes)) {
          if (!span.attributes[key]) {
            span.setAttribute(key, val)
          }
        }
        // @ts-expect-error - readonly attribute, but we know what we're doing
        span['parentSpanContext'] = reparentSpan.parentSpanContext
        span['_ended'] = true
      }

      // Drop spans that were marked for reparenting
      const shouldDropSpan = this._reparentSpans.has(span.spanContext().spanId)
      if (shouldDropSpan) {
        this._reparentSpans.delete(span.spanContext().spanId)
        debug('dropping reparented span: %s', span.name)
        return
      }
    }

    if (this._didShutdown) {
      this._onSpanAfterShutdown(span)
      return
    }

    this._wrapped.onEnd(span)
  }

  shutdown(): Promise<void> {
    debug('shutting down')
    this._didShutdown = true
    return this._wrapped.shutdown()
  }

  forceFlush(): Promise<void> {
    return this._wrapped.forceFlush()
  }

  private _onSpanAfterShutdown(span: Span & ReadableSpan): void {
    if (this._config.onSpanAfterShutdown) {
      this._config.onSpanAfterShutdown(span)
    } else {
      debug('span after shutdown, not exported: %s', span.name)
    }
  }

  private _scheduleNextTick(): void {
    process.nextTick(() => {
      this._currentTick += 1
      this._nextTickScheduled = false
    })
    this._nextTickScheduled = true
  }
}
