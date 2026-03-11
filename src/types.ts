import type {
  Span,
  SpanExporter,
  SpanLimits,
  SpanProcessor,
  ReadableSpan,
  BufferConfig,
} from '@opentelemetry/sdk-trace-base'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { FilteringSpanProcessorConfig } from './filtering-span-processor.js'
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node'

export interface TraceSummary {
  spans: ReadableSpan[]
  errorCount: number
  hasError: boolean
  durationMs: number
  rootSpan: ReadableSpan
  spanCount: number
}

export interface HeadSamplingConfig {
  /** Called once per root span in onStart. Return 1-in-N rate. */
  sample: (attrs: Readonly<Record<string, unknown>>, spanName: string) => number
  /**
   * Called on every span end when the trace was sampled out (rate > 1).
   * If returns true, rescues THIS span + the root span:
   * - The kept span is reparented to root
   * - Both get SampleRate=1 and opin_tel.meta.incomplete_trace=true
   * - Other sampled-out spans continue to be dropped
   */
  mustKeepSpan?: (span: ReadableSpan) => boolean
}

export interface TailSamplingConfig {
  /** Called when root span ends. Return 1-in-N rate. Overrides head. */
  sample: (
    rootAttrs: Readonly<Record<string, unknown>>,
    trace: TraceSummary,
  ) => number
  /**
   * Called on every span end while buffering. If returns true, marks the
   * trace as must-keep. Buffering continues until root ends, but the final
   * rate is clamped to 1 (always keep).
   */
  mustKeepSpan?: (span: ReadableSpan) => boolean
  /** Max traces in buffer. Oldest evicted when exceeded. Default: 1000 */
  maxTraces?: number
  /** Max buffer age in ms. Entries evicted after this. Default: 120_000 */
  maxAgeMs?: number
  /** Max spans per trace. Flushes with rate=1 when exceeded. Default: 500 */
  maxSpansPerTrace?: number
}

export interface BurstProtectionConfig {
  /** Extract a key from the span for rate tracking. Default: span.name */
  keyFn?: (span: ReadableSpan) => string
  /** EMA half-life in ms. Shorter = more responsive. Default: 10_000 */
  halfLifeMs?: number
  /** Spans/sec per key before throttling activates. Default: 100 */
  rateThreshold?: number
  /** Max sample rate during burst. Default: 100 */
  maxSampleRate?: number
}

export interface SamplingConfig {
  head?: HeadSamplingConfig
  tail?: TailSamplingConfig
  burstProtection?: BurstProtectionConfig
}

export interface OpinionatedLogger {
  warn: (message: string, ...args: any[]) => void
}

export interface BaggagePropagationConfig {
  /**
   * Host patterns where baggage should be propagated on outgoing requests.
   * Supports exact matches and wildcard prefixes (e.g., '*.internal.example.com').
   * If omitted or empty, baggage is never injected outbound (safe default).
   */
  allowedHosts?: string[]
  /**
   * Baggage key patterns that are safe to propagate outbound.
   * Only entries matching these patterns are included.
   * If omitted or empty, no baggage keys are propagated.
   * Use '*' to allow all keys. Supports exact matches and wildcard prefixes (e.g., 'app.*').
   */
  allowedKeys?: string[]
}

type NodeSDKConfig = Partial<
  Pick<
    NodeSDKConfiguration,
    | 'idGenerator'
    | 'resourceDetectors'
    | 'autoDetectResources'
    | 'metricReaders'
  >
>

export interface OpinionatedTelemetryConfig
  extends FilteringSpanProcessorConfig, NodeSDKConfig {
  serviceName: string
  resourceAttributes?: Record<string, string>
  spanLimits?: SpanLimits
  /**
   * Signal to register shutdown handler on. Default: 'SIGTERM'
   */
  shutdownSignal?: string | null
  /**
   * Instrumentations to pass to the
   */
  instrumentations: Instrumentation[]
  /**
   * Trace Exporter for the spans passed to the FilteringSpanProcessor
   */
  traceExporter: SpanExporter
  /**
   * Any additional span processors other than the FilteringSpanProcessor
   * which the raw spans will be passed to
   */
  additionalSpanProcessors?: SpanProcessor[]
  /**
   * BatchSpanProcessor config overrides. Set to false to disable batching (uses SimpleSpanProcessor). Opinionated defaults: scheduledDelayMillis=2000, exportTimeoutMillis=10000
   */
  batchProcessorConfig?: BufferConfig | false
  /**
   * Control which baggage entries are propagated on outgoing HTTP requests.
   * Default: suppresses all outbound baggage injection (extract/inbound still works).
   */
  baggagePropagation?: BaggagePropagationConfig
}

export type AggregateGenericOption = 'uniq'

export type AggregateNumericOption =
  | AggregateGenericOption
  | 'sum'
  | 'count'
  | 'min'
  | 'max'
  | 'range'
  | 'avg'
  | 'median'

export interface AggregateAttributeConfig {
  /** Source attribute name on the individual spans */
  attribute: string
  /** Stats to compute. A single option string or array of options. */
  options: AggregateNumericOption | AggregateNumericOption[]
}

export interface AggregateConfig {
  /** Export error spans individually. Default: true */
  keepErrors?: boolean
  /** Custom attribute stats to compute on the aggregate span */
  attributes?: Record<string, AggregateAttributeConfig>
}

/**
 * Return value from shouldDrop callback:
 * - `true` or `'drop'` — drop the span, reparent children to grandparent (no attribute inheritance)
 * - `'collapse'` — drop the span like collapse: inherit attributes into children, reparent to grandparent
 * - `false` — keep the span and all buffered children
 */
export type ShouldDropFn = (
  span: Span & ReadableSpan,
  durationMs: number,
) => boolean | 'drop' | 'collapse'

export interface OnStartResult {
  /** Mark this span for collapse: drop it, inherit attributes into children, reparent children to grandparent */
  collapse?: boolean
  /** Register a conditional drop callback evaluated when the span ends. Ignored if collapse is true. */
  shouldDrop?: ShouldDropFn
}

export interface GlobalHooks {
  /** Called on every span start. Return { collapse } and/or { shouldDrop } to control span behavior. */
  onStart?: (span: Span & ReadableSpan) => OnStartResult | void
  /** Called on every span end, after enrichment. */
  onEnd?: (span: Span & ReadableSpan, durationMs: number) => void
}

export interface OpinionatedOptions {
  /** Drop this span, merge its attributes into children, and reparent children to grandparent */
  collapse?: boolean
  /** Collapse parallel sibling spans with the same name into a single aggregate span */
  aggregate?: boolean | AggregateConfig
  /** Custom onStart hook. Return { collapse } and/or { shouldDrop } to control span behavior. */
  onStart?: (span: Span & ReadableSpan) => OnStartResult | void
  /** Custom onEnd hook */
  onEnd?: (span: Span & ReadableSpan, durationMs: number) => void
}

export interface IgnoreRule {
  file: string
  exports?: string[]
}

export type IgnoreRuleEntry = string | IgnoreRule

export interface AutoInstrumentPath {
  base: string
  dirs: string[]
}

export interface AutoInstrumentCallContext {
  /** Arguments passed to the wrapped function */
  args: any[]
  /** The export name (or function name for default exports) */
  fnName: string
  /** The relative file path (span prefix) */
  filename: string
}

export interface AutoInstrumentHooks {
  /** Called after the span is created, before the wrapped function executes. Use to enrich the span with function call context. */
  onStart?: (
    span: import('@opentelemetry/api').Span &
      import('@opentelemetry/sdk-trace-base').ReadableSpan,
    context: AutoInstrumentCallContext,
  ) => void
  /** Called after the wrapped function completes (success or error), before span.end(). */
  onEnd?: (
    span: import('@opentelemetry/api').Span &
      import('@opentelemetry/sdk-trace-base').ReadableSpan,
    context: AutoInstrumentCallContext & {
      /** The return value of the function (undefined if it threw) */
      returnValue?: any
      /** The error thrown by the function, if any */
      error?: any
    },
  ) => void
}

export interface AutoInstrumentHookConfig {
  /** Tracer to use for auto-instrumented spans. Default: `trace.getTracer('opin_tel.auto')` */
  tracer?: import('@opentelemetry/api').Tracer
  instrumentPaths: AutoInstrumentPath[]
  ignoreRules?: IgnoreRuleEntry[]
  /** Hooks called on every auto-instrumented function invocation */
  hooks?: AutoInstrumentHooks
}
