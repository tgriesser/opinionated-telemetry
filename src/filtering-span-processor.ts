import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { Attributes, Context } from '@opentelemetry/api'
import {
  ROOT_CONTEXT,
  propagation,
  SpanStatusCode,
  type SpanContext,
} from '@opentelemetry/api'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { crc32 } from 'node:zlib'
import debugLib from 'debug'
import type {
  AggregateConfig,
  OpinionatedOptions,
  SamplingConfig,
} from './types.js'
// Private import — used for instanceof checks and constructing snapshot spans.
// Pinned to @opentelemetry/sdk-trace-base v2.x. If the SDK restructures its
// build output, this import will fail at startup (not silently).
import { SpanImpl } from '@opentelemetry/sdk-trace-base/build/src/Span.js'
import { OPIN_TEL_INTERNAL, OPIN_TEL_PREFIX } from './constants.js'

const debug = debugLib('opin_tel:filtering-processor')
const TICK_KEY = '__tick'
const MEMORY_KEY = '__memStart'
const ELU_KEY = '__eluStart'
const AGGREGATE_KEY = '__aggregateKey'

type HrTime = [number, number]

interface AttributeTracker {
  sourceAttribute: string
  options: string[]
  values: (string | number | boolean)[]
}

interface AggregateGroup {
  firstSpan: ReadableSpan
  config: AggregateConfig
  inflight: number
  count: number
  errorCount: number
  earliestStart: HrTime
  latestEnd: HrTime
  totalDurationMs: number
  minDurationMs: number
  maxDurationMs: number
  nonErrorCount: number
  bufferedFirstNonError: ReadableSpan | null
  createdAt: number
  attrTrackers: Map<string, AttributeTracker> | null
}

type MemoryKey = keyof NodeJS.MemoryUsage

export interface MemoryConfig {
  /** Capture rss */
  rss?: boolean
  /** Capture heapTotal */
  heapTotal?: boolean
  /** Capture heapUsed */
  heapUsed?: boolean
  /** Capture external */
  external?: boolean
  /** Capture arrayBuffers */
  arrayBuffers?: boolean
}

export interface StuckSpanConfig {
  /** How long a span must be in-flight before it's considered stuck. Default: 60_000ms */
  thresholdMs?: number
  /** How often to check for stuck spans. Default: 5_000ms */
  intervalMs?: number
  /** Called when a stuck span is detected, before exporting. Can return false to skip. */
  onStuckSpan?: (span: Span & ReadableSpan) => boolean | void
}

export interface FilteringSpanProcessorConfig {
  /** Drop spans that start and end in the same tick. Default: true */
  dropSyncSpans?: boolean | ((span: Span & ReadableSpan) => boolean)
  /** Enable collapse for instrumentations with collapse: true. Default: true */
  enableCollapse?: boolean
  /** Propagate baggage entries as span attributes in onStart. Default: true */
  baggageToAttributes?: boolean
  /**
   * Capture memory usage on root spans
   * - `true` (default): capture rss delta only via the fast `process.memoryUsage.rss()` path
   * - `MemoryConfig`: pick specific fields (rss, heapTotal, heapUsed, external, arrayBuffers)
   * — uses `process.memoryUsage()` which includes V8 heap stats
   * - `false`: disable
   */
  memory?: boolean | MemoryConfig
  /**
   * Capture memory usage deltas on root spans.
   * - `true` (default): capture rss delta only via the fast `process.memoryUsage.rss()` path
   * - `MemoryConfig`: pick specific fields (rss, heapTotal, heapUsed, external, arrayBuffers)
   *   — uses `process.memoryUsage()` which includes V8 heap stats
   * - `false`: disable
   */
  memoryDelta?: boolean | MemoryConfig
  /**
   * Capture event loop utilization on spans.
   * - `true` (default): capture on all spans
   * - `'root'`: capture on root spans only
   * - `false`: disable
   */
  eventLoopUtilization?: boolean | 'root'
  /** Called when a span ends after shutdown and won't be exported. Default: debug log */
  onSpanAfterShutdown?: (span: Span & ReadableSpan) => void
  /** Enable stuck span detection. Default: true */
  stuckSpanDetection?: boolean | StuckSpanConfig
  /** Sampling configuration for head, tail, and burst protection. */
  sampling?: SamplingConfig
  /** Predicate to determine if a span should be aggregated. Return true for default config, or an AggregateConfig object. */
  aggregateSpan?: (span: Span & ReadableSpan) => boolean | AggregateConfig
  /** Per-instrumentation hooks keyed by instrumentation scope name */
  instrumentationHooks?: Record<string, OpinionatedOptions>
}

interface TailBufferEntry {
  spans: ReadableSpan[]
  rootSpan: ReadableSpan | null
  headSampleRate: number
  createdAt: number
  errorCount: number
  hasError: boolean
  mustKeep: boolean
  flushed: boolean
  decidedRate: number
}

interface EmaState {
  rate: number
  lastEventMs: number
}

function shouldKeep(traceId: string, rate: number): boolean {
  if (rate <= 1) return true
  return (crc32(traceId) >>> 0) % rate === 0
}

export class FilteringSpanProcessor implements SpanProcessor {
  private _wrapped: SpanProcessor
  private _config: FilteringSpanProcessorConfig
  private _collapseSpans = new Map<string, Span & ReadableSpan>()
  private _rootSpans = new Map<string, ReadableSpan>()
  private _allSpans = new Set<Span>()
  private _didShutdown = false
  private _nextTickScheduled = false
  private _currentTick = 0
  private _memoryUse = false
  /** When true, use fast process.memoryUsage.rss() path (rss only) */
  private _memoryFastPath = false
  // private _memoryCapture = false
  private _memoryCaptureKeys: MemoryKey[] = []
  // private _memoryDeltaCapture = false
  private _memoryDeltaKeys: MemoryKey[] = []
  private _eventLoopUtilization: boolean | 'root' = false
  private _stuckSpanInterval: ReturnType<typeof setInterval> | null = null
  private _reportedStuckSpans = new Set<string>()
  private _stuckSpanConfig: StuckSpanConfig | null = null
  private _sampling: SamplingConfig | null = null
  private _headDecisions = new Map<string, number>()
  private _rescuedTraces = new Set<string>()
  private _tailBuffer = new Map<string, TailBufferEntry>()
  private _burstEma = new Map<string, EmaState>()
  private _samplingEvictionInterval: ReturnType<typeof setInterval> | null =
    null
  private _aggregateGroups = new Map<string, AggregateGroup>()
  private _instrumentationHooks: Record<string, OpinionatedOptions>

  constructor(wrapped: SpanProcessor, config?: FilteringSpanProcessorConfig) {
    this._wrapped = wrapped
    this._config = {
      dropSyncSpans: config?.dropSyncSpans ?? true,
      enableCollapse: config?.enableCollapse ?? true,
      baggageToAttributes: config?.baggageToAttributes ?? true,
      memory: config?.memory ?? true,
      memoryDelta: config?.memoryDelta ?? true,
      eventLoopUtilization: config?.eventLoopUtilization ?? true,
      onSpanAfterShutdown: config?.onSpanAfterShutdown,
      stuckSpanDetection: config?.stuckSpanDetection ?? true,
      aggregateSpan: config?.aggregateSpan,
    }
    this._instrumentationHooks = config?.instrumentationHooks ?? {}
    const captureMemory = Boolean(
      this._config.memory || this._config.memoryDelta,
    )
    if (captureMemory) {
      this._memoryUse = true
      const mem = this._config.memory
      if (mem === true) {
        this._memoryCaptureKeys = ['rss']
      } else if (mem && typeof mem === 'object') {
        this._memoryCaptureKeys = (Object.keys(mem) as MemoryKey[]).filter(
          (k) => mem[k],
        )
      }
      const md = this._config.memoryDelta
      if (md === true) {
        this._memoryDeltaKeys = ['rss']
      } else if (md && typeof md === 'object') {
        this._memoryDeltaKeys = (Object.keys(md) as MemoryKey[]).filter(
          (k) => md[k],
        )
      }
      this._memoryFastPath =
        this._memoryDeltaKeys.length === 1 &&
        this._memoryCaptureKeys.length === 1
    }

    this._eventLoopUtilization = this._config.eventLoopUtilization ?? true
    if (this._config.stuckSpanDetection) {
      const ssd = this._config.stuckSpanDetection
      this._stuckSpanConfig = typeof ssd === 'object' ? ssd : {}
      const intervalMs = this._stuckSpanConfig.intervalMs ?? 5_000
      this._stuckSpanInterval = setInterval(
        () => this._reapStuckSpans(),
        intervalMs,
      )
      this._stuckSpanInterval.unref()
    }
    if (config?.sampling) {
      this._sampling = config.sampling
    }
    if (
      this._sampling?.tail ||
      this._sampling?.burstProtection ||
      config?.aggregateSpan
    ) {
      this._samplingEvictionInterval = setInterval(
        () => this._evictSamplingState(),
        5_000,
      )
      this._samplingEvictionInterval.unref()
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
        if (this._memoryUse) {
          this._captureMemoryOnSpan(span)
        }

        // Head sampling decision
        if (this._sampling?.head) {
          const headRate = this._sampling.head.sample(
            span.attributes,
            span.name,
          )
          this._headDecisions.set(spanCtx.traceId, headRate)
        }

        // Tail buffer initialization
        if (this._sampling?.tail) {
          const headRate = this._headDecisions.get(spanCtx.traceId) ?? 1
          this._tailBuffer.set(spanCtx.traceId, {
            spans: [],
            rootSpan: null,
            headSampleRate: headRate,
            createdAt: Date.now(),
            errorCount: 0,
            hasError: false,
            mustKeep: false,
            flushed: false,
            decidedRate: 1,
          })
          this._evictOldestTailEntry()
        }
      } else {
        debug(
          'multiple root spans for trace=%s span=%s',
          spanCtx.traceId,
          span.name,
        )
      }
    }

    // Snapshot ELU at span start
    if (
      this._eventLoopUtilization === true ||
      (this._eventLoopUtilization === 'root' && !span.parentSpanContext)
    ) {
      Object.defineProperty(span, ELU_KEY, {
        value: performance.eventLoopUtilization(),
      })
    }

    // Check instrumentation hooks for this scope
    const scope = (span as any).instrumentationScope?.name
    if (scope) {
      const opts = this._instrumentationHooks[scope]
      if (opts) {
        if (opts.collapse) {
          this._collapseSpans.set(span.spanContext().spanId, span)
        }
        if (opts.onStart) {
          opts.onStart(span)
        }
      }
    }

    // Aggregate tracking for child spans
    if (span.parentSpanContext) {
      const aggConfig = this._resolveAggregateConfig(span)
      if (aggConfig) {
        const key = `${span.parentSpanContext.spanId}:${span.name}`
        const group = this._aggregateGroups.get(key)
        if (group) {
          group.inflight++
        } else {
          let attrTrackers: Map<string, AttributeTracker> | null = null
          if (aggConfig.attributes) {
            attrTrackers = new Map()
            for (const [outputKey, block] of Object.entries(
              aggConfig.attributes,
            )) {
              const opts = Array.isArray(block.options)
                ? block.options
                : [block.options]
              attrTrackers.set(outputKey, {
                sourceAttribute: block.attribute,
                options: opts,
                values: [],
              })
            }
          }
          this._aggregateGroups.set(key, {
            firstSpan: span,
            config: aggConfig,
            inflight: 1,
            count: 0,
            errorCount: 0,
            earliestStart: [...span.startTime] as HrTime,
            latestEnd: [0, 0],
            totalDurationMs: 0,
            minDurationMs: Infinity,
            maxDurationMs: 0,
            nonErrorCount: 0,
            bufferedFirstNonError: null,
            createdAt: Date.now(),
            attrTrackers,
          })
        }
        Object.defineProperty(span, AGGREGATE_KEY, { value: key })
      }
    }

    this._wrapped.onStart(span, ctx)
  }

  onEnd(span: ReadableSpan): void {
    this._allSpans.delete(span as Span)
    this._reportedStuckSpans.delete(span.spanContext().spanId)

    // Drop sync spans
    if (this._config.dropSyncSpans) {
      const shouldDrop =
        typeof this._config.dropSyncSpans === 'function'
          ? this._config.dropSyncSpans(span as Span & ReadableSpan)
          : (span as any)[TICK_KEY] === this._currentTick
      if (shouldDrop) {
        debug('dropping sync span: %s', span.name)
        return
      }
    }

    const isSpanImpl = span instanceof SpanImpl
    if (isSpanImpl) {
      // Reopen the span for additional modifications in the onEnd
      ;(span as SpanImpl)['_ended'] = false
    }

    this._enrichSpan(span as Span & ReadableSpan)

    if (isSpanImpl) {
      ;(span as SpanImpl)['_ended'] = true
    }

    // Collapse drop decision (not part of enrichment)
    if (span.parentSpanContext && this._config.enableCollapse) {
      // Drop spans that were marked for collapse
      const shouldDropSpan = this._collapseSpans.has(span.spanContext().spanId)
      if (shouldDropSpan) {
        this._collapseSpans.delete(span.spanContext().spanId)
        debug('dropping collapsed span: %s', span.name)
        return
      }
    }

    // Aggregation — consume non-error spans, let error spans fall through
    const aggregateKey = (span as any)[AGGREGATE_KEY] as string | undefined
    if (aggregateKey) {
      const group = this._aggregateGroups.get(aggregateKey)
      if (group) {
        const handled = this._handleAggregateSpan(span, group, aggregateKey)
        if (handled) return // non-error span consumed by aggregation
        // error span falls through to normal export path
      }
    }

    if (this._didShutdown) {
      this._onSpanAfterShutdown(span as Span & ReadableSpan)
      return
    }

    // Stuck span snapshots bypass sampling entirely
    if (span.attributes[OPIN_TEL_INTERNAL.stuck.isSnapshot]) {
      this._wrapped.onEnd(span)
      return
    }

    // Sampling
    if (this._sampling) {
      this._applySampling(span as Span & ReadableSpan, isSpanImpl)
      return
    }

    this._wrapped.onEnd(span)
  }

  shutdown(): Promise<void> {
    debug('shutting down')
    this._didShutdown = true
    if (this._stuckSpanInterval) {
      clearInterval(this._stuckSpanInterval)
      this._stuckSpanInterval = null
    }
    if (this._samplingEvictionInterval) {
      clearInterval(this._samplingEvictionInterval)
      this._samplingEvictionInterval = null
    }
    // Flush incomplete aggregate groups
    for (const [key, group] of this._aggregateGroups) {
      this._emitAggregateSpan(key, group)
    }
    this._aggregateGroups.clear()

    // Flush remaining tail buffer entries
    for (const [traceId, entry] of this._tailBuffer) {
      if (!entry.flushed) {
        // If root ended (rootSpan set), evaluate tail; otherwise use head rate
        if (entry.rootSpan && this._sampling?.tail) {
          const durationMs = this._spanDurationMs(entry.rootSpan)
          const tailRate = this._sampling.tail.sample(
            entry.rootSpan.attributes,
            {
              spans: entry.spans,
              errorCount: entry.errorCount,
              hasError: entry.hasError,
              durationMs,
              rootSpan: entry.rootSpan,
              spanCount: entry.spans.length,
            },
          )
          entry.decidedRate = entry.mustKeep ? 1 : tailRate
        } else {
          entry.decidedRate = entry.mustKeep ? 1 : entry.headSampleRate
        }
        entry.flushed = true
        this._flushTailEntry(traceId, entry)
      }
    }
    const hadBuffered = this._tailBuffer.size > 0
    this._tailBuffer.clear()
    this._headDecisions.clear()
    this._rescuedTraces.clear()
    this._burstEma.clear()
    if (hadBuffered) {
      return this._wrapped.forceFlush().then(() => this._wrapped.shutdown())
    }
    return this._wrapped.shutdown()
  }

  forceFlush(): Promise<void> {
    return this._wrapped.forceFlush()
  }

  private _resolveAggregateConfig(
    span: Span & ReadableSpan,
  ): AggregateConfig | null {
    if (this._config.aggregateSpan) {
      const result = this._config.aggregateSpan(span)
      if (result === true) return {}
      if (result && typeof result === 'object') return result
    }
    const scope = (span as any).instrumentationScope?.name
    if (scope) {
      const opts = this._instrumentationHooks[scope]
      if (opts?.aggregate === true) return {}
      if (opts?.aggregate && typeof opts.aggregate === 'object')
        return opts.aggregate
    }
    return null
  }

  /**
   * Handle a span that belongs to an aggregate group.
   * Returns true if the span was consumed, false if it should fall through (error with keepErrors).
   */
  private _handleAggregateSpan(
    span: ReadableSpan,
    group: AggregateGroup,
    key: string,
  ): boolean {
    group.inflight--
    group.count++
    const durationMs = this._spanDurationMs(span)

    // Update time bounds (always, including errors)
    if (
      span.startTime[0] < group.earliestStart[0] ||
      (span.startTime[0] === group.earliestStart[0] &&
        span.startTime[1] < group.earliestStart[1])
    ) {
      group.earliestStart = [...span.startTime] as HrTime
    }
    if (
      span.endTime[0] > group.latestEnd[0] ||
      (span.endTime[0] === group.latestEnd[0] &&
        span.endTime[1] > group.latestEnd[1])
    ) {
      group.latestEnd = [...span.endTime] as HrTime
    }

    const isError = span.status.code === SpanStatusCode.ERROR
    const keepErrors = group.config.keepErrors !== false

    if (isError) {
      group.errorCount++
    } else {
      group.totalDurationMs += durationMs
      group.nonErrorCount++
      group.minDurationMs = Math.min(group.minDurationMs, durationMs)
      group.maxDurationMs = Math.max(group.maxDurationMs, durationMs)

      // Buffer the first non-error span for single-span optimization
      if (group.bufferedFirstNonError === null) {
        group.bufferedFirstNonError = span
      }
    }

    // Track attribute values (from all spans, including errors)
    if (group.attrTrackers) {
      for (const tracker of group.attrTrackers.values()) {
        const val = span.attributes[tracker.sourceAttribute]
        if (val != null) {
          tracker.values.push(val as string | number | boolean)
        }
      }
    }

    if (group.inflight === 0) {
      this._emitAggregateSpan(key, group)
      this._aggregateGroups.delete(key)
    }

    // Error spans with keepErrors fall through to normal export
    if (isError && keepErrors) return false
    // Everything else is consumed by aggregation
    return true
  }

  private _emitAggregateSpan(_key: string, group: AggregateGroup): void {
    const keepErrors = group.config.keepErrors !== false

    // When keepErrors is true: no non-error spans means nothing to aggregate
    // When keepErrors is false: no spans at all means nothing to aggregate
    const totalNonDropped = keepErrors
      ? group.nonErrorCount
      : group.nonErrorCount + group.errorCount
    if (totalNonDropped === 0) return

    // Single non-error span with no errors — export original directly
    if (
      group.nonErrorCount === 1 &&
      group.bufferedFirstNonError &&
      group.errorCount === 0
    ) {
      this._wrapped.onEnd(group.bufferedFirstNonError)
      return
    }

    const template = group.firstSpan
    const templateCtx = template.spanContext()

    const spanContext: SpanContext = {
      traceId: templateCtx.traceId,
      spanId: randomBytes(8).toString('hex'),
      traceFlags: templateCtx.traceFlags,
    }

    const attributes: Attributes = {
      ...template.attributes,
      [OPIN_TEL_INTERNAL.meta.isAggregate]: true,
      [OPIN_TEL_INTERNAL.agg.count]: group.count,
      [OPIN_TEL_INTERNAL.agg.errorCount]: group.errorCount,
    }

    if (group.nonErrorCount > 0) {
      attributes[OPIN_TEL_INTERNAL.agg.minDurationMs] = Math.round(
        group.minDurationMs,
      )
      attributes[OPIN_TEL_INTERNAL.agg.maxDurationMs] = Math.round(
        group.maxDurationMs,
      )
      attributes[OPIN_TEL_INTERNAL.agg.avgDurationMs] = Math.round(
        group.totalDurationMs / group.nonErrorCount,
      )
      attributes[OPIN_TEL_INTERNAL.agg.totalDurationMs] = Math.round(
        group.totalDurationMs,
      )
    }

    // Compute custom attribute stats
    if (group.attrTrackers) {
      for (const [outputKey, tracker] of group.attrTrackers) {
        const prefix = `${OPIN_TEL_PREFIX}agg.${outputKey}`
        const nums = tracker.values.filter(
          (v) => typeof v === 'number',
        ) as number[]

        for (const opt of tracker.options) {
          switch (opt) {
            case 'uniq': {
              const uniq = [...new Set(tracker.values.map(String))]
              attributes[`${prefix}.uniq`] = uniq
              break
            }
            case 'count':
              attributes[`${prefix}.count`] = tracker.values.length
              break
            case 'sum':
              if (nums.length)
                attributes[`${prefix}.sum`] = nums.reduce((a, b) => a + b, 0)
              break
            case 'min':
              if (nums.length) attributes[`${prefix}.min`] = Math.min(...nums)
              break
            case 'max':
              if (nums.length) attributes[`${prefix}.max`] = Math.max(...nums)
              break
            case 'range':
              if (nums.length)
                attributes[`${prefix}.range`] =
                  Math.max(...nums) - Math.min(...nums)
              break
            case 'avg':
              if (nums.length)
                attributes[`${prefix}.avg`] =
                  nums.reduce((a, b) => a + b, 0) / nums.length
              break
            case 'median':
              if (nums.length) {
                const sorted = [...nums].sort((a, b) => a - b)
                const mid = Math.floor(sorted.length / 2)
                attributes[`${prefix}.median`] =
                  sorted.length % 2
                    ? sorted[mid]!
                    : (sorted[mid - 1]! + sorted[mid]!) / 2
              }
              break
          }
        }
      }
    }

    const aggregateSpan = new SpanImpl({
      resource: template.resource,
      scope: template.instrumentationScope,
      context: ROOT_CONTEXT,
      spanContext,
      name: template.name,
      kind: template.kind,
      parentSpanContext: template.parentSpanContext,
      links: [],
      startTime: group.earliestStart,
      attributes,
      spanLimits: (template as any)._spanLimits,
      spanProcessor: this._wrapped,
    })

    aggregateSpan.end(group.latestEnd)
  }

  private _reapStuckSpans(): void {
    if (!this._stuckSpanConfig) return
    const thresholdMs = this._stuckSpanConfig.thresholdMs ?? 60_000
    const nowMs = Date.now()

    for (const span of this._allSpans) {
      const readable = span as Span & ReadableSpan
      const startMs = readable.startTime[0] * 1e3 + readable.startTime[1] / 1e6
      const durationMs = nowMs - startMs

      if (durationMs < thresholdMs) continue

      const spanId = span.spanContext().spanId
      if (this._reportedStuckSpans.has(spanId)) continue

      if (this._stuckSpanConfig.onStuckSpan) {
        if (this._stuckSpanConfig.onStuckSpan(readable) === false) continue
      }

      this._reportedStuckSpans.add(spanId)
      debug(
        'stuck span detected: %s (duration=%dms)',
        readable.name,
        durationMs,
      )

      const snapshotSpan = new SpanImpl({
        resource: readable.resource,
        scope: readable.instrumentationScope,
        context: ROOT_CONTEXT,
        spanContext: span.spanContext(),
        name: `${readable.name} (incomplete)`,
        kind: readable.kind,
        parentSpanContext: readable.parentSpanContext,
        links: readable.links,
        startTime: readable.startTime,
        attributes: {
          ...readable.attributes,
          [OPIN_TEL_INTERNAL.stuck.durationMs]: Math.round(durationMs),
          [OPIN_TEL_INTERNAL.stuck.isSnapshot]: true,
        },
        spanLimits: (span as any)._spanLimits,
        spanProcessor: this._wrapped,
      })

      // Copy start values so _enrichSpan can compute deltas
      const memStart = (readable as any)[MEMORY_KEY]
      if (memStart != null) {
        Object.defineProperty(snapshotSpan, MEMORY_KEY, { value: memStart })
      }
      const eluStart = (readable as any)[ELU_KEY]
      if (eluStart != null) {
        Object.defineProperty(snapshotSpan, ELU_KEY, { value: eluStart })
      }

      this._enrichSpan(snapshotSpan)
      snapshotSpan.end()
    }
  }

  private _enrichSpan(span: Span & ReadableSpan): void {
    // Instrumentation hooks
    const scope = (span as any).instrumentationScope?.name
    if (scope) {
      const opts = this._instrumentationHooks[scope]
      if (opts?.onEnd) {
        opts.onEnd(span)
      }
    }

    // Memory delta for root spans
    if (!span.parentSpanContext) {
      if (this._memoryUse && this._memoryDeltaKeys.length > 0) {
        this._captureMemory(span)
      }
    }

    // Event loop utilization
    const startElu = (span as any)[ELU_KEY]
    if (startElu != null) {
      const delta = performance.eventLoopUtilization(startElu)
      span.setAttribute(
        OPIN_TEL_INTERNAL.eventLoop.utilization,
        delta.utilization,
      )
    }

    // Collapse: attribute inheritance and child reparenting
    if (!span.parentSpanContext) {
      if (!span.attributes[OPIN_TEL_INTERNAL.stuck.isSnapshot]) {
        this._rootSpans.delete(span.spanContext().traceId)
      }
    } else if (this._config.enableCollapse) {
      const parentSpanId = (span as any).parentSpanContext.spanId
      let collapsedSpan = this._collapseSpans.get(parentSpanId)
      if (collapsedSpan) {
        while (
          collapsedSpan.parentSpanContext?.spanId &&
          this._collapseSpans.has(collapsedSpan.parentSpanContext?.spanId)
        ) {
          collapsedSpan = this._collapseSpans.get(
            collapsedSpan.parentSpanContext.spanId,
          )!
        }
        debug(
          'collapsing span=%s from parent=%s to grandparent=%s',
          span.name,
          parentSpanId,
          collapsedSpan.parentSpanContext?.spanId,
        )
        for (const [key, val] of Object.entries(collapsedSpan.attributes)) {
          if (!span.attributes[key] && val != null) {
            span.setAttribute(key, val)
          }
        }
        // Snapshots keep their original parent so we can see which intermediate
        // span the stuck span is waiting under — the real span gets collapsed when it ends.
        if (!span.attributes[OPIN_TEL_INTERNAL.stuck.isSnapshot]) {
          // @ts-expect-error - readonly attribute, but we know what we're doing
          span['parentSpanContext'] = collapsedSpan.parentSpanContext
        }
      }
    }
  }

  private _applySampling(span: Span & ReadableSpan, isSpanImpl: boolean): void {
    const traceId = span.spanContext().traceId
    const isRoot = !span.parentSpanContext
    const burstRate = this._computeBurstRate(span)

    // TAIL MODE
    const tailEntry = this._tailBuffer.get(traceId)
    if (tailEntry) {
      if (tailEntry.flushed) {
        // Decision already made — apply same rate to late child span
        const finalRate = tailEntry.decidedRate * burstRate
        if (finalRate > 1) {
          if (!shouldKeep(traceId, finalRate)) {
            debug(
              'sampling: dropping late tail span %s (rate=%d)',
              span.name,
              finalRate,
            )
            return
          }
          this._setSpanAttr(span, isSpanImpl, 'SampleRate', finalRate)
        }
        this._wrapped.onEnd(span)
        return
      }

      // Track errors
      if (span.status.code === SpanStatusCode.ERROR) {
        tailEntry.errorCount++
        tailEntry.hasError = true
      }

      // Buffer the span
      tailEntry.spans.push(span)

      // mustKeepSpan: sets flag but does NOT flush
      if (
        this._sampling!.tail!.mustKeepSpan &&
        this._sampling!.tail!.mustKeepSpan(span)
      ) {
        tailEntry.mustKeep = true
      }

      // Max spans overflow: flush with rate=1 (trace is "interesting")
      const maxSpans = this._sampling!.tail!.maxSpansPerTrace ?? 500
      if (tailEntry.spans.length >= maxSpans) {
        tailEntry.decidedRate = 1
        tailEntry.flushed = true
        this._flushTailEntry(traceId, tailEntry, burstRate)
        return
      }

      if (isRoot) {
        // Root ended — evaluate tail.sample
        tailEntry.rootSpan = span
        const durationMs = this._spanDurationMs(span)
        const tailRate = this._sampling!.tail!.sample(span.attributes, {
          spans: tailEntry.spans,
          errorCount: tailEntry.errorCount,
          hasError: tailEntry.hasError,
          durationMs,
          rootSpan: span,
          spanCount: tailEntry.spans.length,
        })
        tailEntry.decidedRate = tailEntry.mustKeep ? 1 : tailRate
        tailEntry.flushed = true
        this._flushTailEntry(traceId, tailEntry, burstRate)
        // Clean up head decision
        this._headDecisions.delete(traceId)
        return
      }

      // Not root, not flushed — just buffer
      return
    }

    // HEAD-ONLY MODE
    if (this._headDecisions.has(traceId)) {
      const headRate = this._headDecisions.get(traceId)!
      const finalRate = headRate * burstRate

      // Root of a rescued trace — always export regardless of sample decision
      if (isRoot && this._rescuedTraces.has(traceId)) {
        this._setSpanAttr(span, isSpanImpl, 'SampleRate', 1)
        this._setSpanAttr(
          span,
          isSpanImpl,
          OPIN_TEL_INTERNAL.meta.incompleteTrace,
          true,
        )
        this._rescuedTraces.delete(traceId)
        this._headDecisions.delete(traceId)
        this._wrapped.onEnd(span)
        return
      }

      // Trace is sampled out — check mustKeepSpan for rescue
      if (finalRate > 1 && !shouldKeep(traceId, finalRate)) {
        if (
          this._sampling!.head?.mustKeepSpan &&
          this._sampling!.head.mustKeepSpan(span)
        ) {
          // RESCUE: keep this span + guarantee root export
          this._rescuedTraces.add(traceId)
          // Reparent to root (skip intermediate dropped spans)
          const rootSpan = this._rootSpans.get(traceId)
          if (rootSpan && span.parentSpanContext) {
            // @ts-expect-error — readonly, but we need to reparent rescued span to root
            span['parentSpanContext'] = rootSpan.spanContext()
          }
          this._setSpanAttr(span, isSpanImpl, 'SampleRate', 1)
          this._setSpanAttr(
            span,
            isSpanImpl,
            OPIN_TEL_INTERNAL.meta.incompleteTrace,
            true,
          )
          debug('sampling: rescued span %s in trace %s', span.name, traceId)
          this._wrapped.onEnd(span)
          return
        }
        // Drop this span
        debug(
          'sampling: dropping head-sampled span %s (rate=%d)',
          span.name,
          finalRate,
        )
        return
      }

      if (isRoot) {
        this._headDecisions.delete(traceId)
      }

      if (finalRate > 1) {
        this._setSpanAttr(span, isSpanImpl, 'SampleRate', finalRate)
      }
      this._wrapped.onEnd(span)
      return
    }

    // BURST-ONLY MODE (no head, no tail)
    if (burstRate > 1) {
      if (!shouldKeep(traceId, burstRate)) {
        debug(
          'sampling: dropping burst span %s (rate=%d)',
          span.name,
          burstRate,
        )
        return
      }
      this._setSpanAttr(span, isSpanImpl, 'SampleRate', burstRate)
    }
    this._wrapped.onEnd(span)
  }

  private _computeBurstRate(span: ReadableSpan): number {
    if (!this._sampling?.burstProtection) return 1
    const bp = this._sampling.burstProtection
    const key = bp.keyFn ? bp.keyFn(span) : span.name
    const nowMs = Date.now()
    const emaRate = this._updateEma(key, nowMs)
    const threshold = bp.rateThreshold ?? 100
    if (emaRate <= threshold) return 1
    const rate = Math.ceil(emaRate / threshold)
    return Math.min(rate, bp.maxSampleRate ?? 100)
  }

  private _updateEma(key: string, nowMs: number): number {
    let state = this._burstEma.get(key)
    if (!state) {
      this._burstEma.set(key, { rate: 0, lastEventMs: nowMs })
      return 0
    }
    const dtMs = nowMs - state.lastEventMs
    if (dtMs <= 0) {
      state.rate += 1
      return state.rate
    }
    const halfLifeMs = this._sampling!.burstProtection!.halfLifeMs ?? 10_000
    const alpha = 1 - Math.exp(-dtMs / halfLifeMs)
    const instantRate = 1000 / dtMs
    state.rate = alpha * instantRate + (1 - alpha) * state.rate
    state.lastEventMs = nowMs
    return state.rate
  }

  private _flushTailEntry(
    traceId: string,
    entry: TailBufferEntry,
    burstRate = 1,
  ): void {
    const finalRate = entry.decidedRate * burstRate
    if (finalRate > 1 && !shouldKeep(traceId, finalRate)) {
      debug(
        'sampling: dropping tail-buffered trace %s (%d spans, rate=%d)',
        traceId,
        entry.spans.length,
        finalRate,
      )
      return
    }
    debug(
      'sampling: flushing tail-buffered trace %s (%d spans, rate=%d)',
      traceId,
      entry.spans.length,
      finalRate,
    )
    for (const buffered of entry.spans) {
      if (finalRate > 1) {
        // Reopen span to set attribute
        const isImpl = buffered instanceof SpanImpl
        this._setSpanAttr(
          buffered as Span & ReadableSpan,
          isImpl,
          'SampleRate',
          finalRate,
        )
      }
      this._wrapped.onEnd(buffered)
    }
  }

  private _setSpanAttr(
    span: Span & ReadableSpan,
    isSpanImpl: boolean,
    key: string,
    value: number | boolean,
  ): void {
    if (isSpanImpl) {
      ;(span as SpanImpl)['_ended'] = false
      span.setAttribute(key, value)
      ;(span as SpanImpl)['_ended'] = true
    } else {
      span.setAttribute(key, value)
    }
  }

  private _spanDurationMs(span: ReadableSpan): number {
    const [startSec, startNano] = span.startTime
    const [endSec, endNano] = span.endTime
    return (endSec - startSec) * 1e3 + (endNano - startNano) / 1e6
  }

  private _evictOldestTailEntry(): void {
    if (!this._sampling?.tail) return
    const maxTraces = this._sampling.tail.maxTraces ?? 1000
    while (this._tailBuffer.size > maxTraces) {
      // Evict oldest by iteration order (Map preserves insertion order)
      const oldest = this._tailBuffer.entries().next()
      if (oldest.done) break
      const [oldTraceId, oldEntry] = oldest.value
      if (!oldEntry.flushed) {
        oldEntry.decidedRate = oldEntry.mustKeep ? 1 : oldEntry.headSampleRate
        oldEntry.flushed = true
        this._flushTailEntry(oldTraceId, oldEntry)
      }
      this._tailBuffer.delete(oldTraceId)
    }
  }

  private _evictSamplingState(): void {
    const nowMs = Date.now()

    // Evict stale tail buffer entries
    if (this._sampling?.tail) {
      const maxAgeMs = this._sampling.tail.maxAgeMs ?? 120_000
      const graceMs = 30_000
      for (const [traceId, entry] of this._tailBuffer) {
        const age = nowMs - entry.createdAt
        if (entry.flushed && age > graceMs) {
          this._tailBuffer.delete(traceId)
        } else if (!entry.flushed && age > maxAgeMs) {
          // Timed out — flush with head rate
          entry.decidedRate = entry.mustKeep ? 1 : entry.headSampleRate
          entry.flushed = true
          this._flushTailEntry(traceId, entry)
        }
      }
    }

    // Evict orphaned aggregate groups (inflight > 0 for too long)
    for (const [key, group] of this._aggregateGroups) {
      if (nowMs - group.createdAt > 60_000) {
        this._emitAggregateSpan(key, group)
        this._aggregateGroups.delete(key)
      }
    }

    // Evict stale EMA entries
    if (this._sampling?.burstProtection) {
      const halfLifeMs = this._sampling.burstProtection.halfLifeMs ?? 10_000
      const maxAge = 3 * halfLifeMs
      for (const [key, state] of this._burstEma) {
        if (nowMs - state.lastEventMs > maxAge) {
          this._burstEma.delete(key)
        }
      }
    }
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

  private _captureMemoryOnSpan(span: Span & ReadableSpan) {
    if (this._memoryFastPath) {
      const rss = process.memoryUsage.rss()
      if (this._memoryCaptureKeys.length) {
        span.setAttribute(OPIN_TEL_INTERNAL.memory.rss, rss)
      }
      if (this._memoryDeltaKeys.length) {
        Object.defineProperty(span, MEMORY_KEY, {
          value: rss,
        })
      }
    } else {
      const memUsage = process.memoryUsage()
      if (this._memoryCaptureKeys.length) {
        for (const key of this._memoryCaptureKeys) {
          span.setAttribute(OPIN_TEL_INTERNAL.memory[key], memUsage[key])
        }
        if (this._memoryDeltaKeys.length) {
          Object.defineProperty(span, MEMORY_KEY, {
            value: memUsage,
          })
        }
      }
    }
  }

  private _captureMemory(span: Span & ReadableSpan) {
    const startMem = (span as any)[MEMORY_KEY]
    if (startMem != null) {
      if (this._memoryFastPath) {
        span.setAttribute(
          OPIN_TEL_INTERNAL.memoryDelta.rss,
          process.memoryUsage.rss() - (startMem as number),
        )
      } else {
        const endMem = process.memoryUsage()
        for (const key of this._memoryDeltaKeys) {
          span.setAttribute(
            OPIN_TEL_INTERNAL.memoryDelta[key],
            endMem[key] - (startMem as NodeJS.MemoryUsage)[key],
          )
        }
      }
    }
  }
}
