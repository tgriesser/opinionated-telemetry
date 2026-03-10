import type {
  Span,
  SpanExporter,
  SpanLimits,
  SpanProcessor,
  ReadableSpan,
  BufferConfig,
} from '@opentelemetry/sdk-trace-base'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { FilteringSpanProcessorConfig } from './filtering-span-processor.js'

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

export interface OpinionatedTelemetryConfig extends FilteringSpanProcessorConfig {
  serviceName: string
  resourceAttributes?: Record<string, string>
  traceExporter: SpanExporter
  metricReader?: MetricReader
  spanLimits?: SpanLimits
  /** Signal to register shutdown handler on. Default: 'SIGTERM' */
  shutdownSignal?: string
  instrumentations: Instrumentation[]
  additionalSpanProcessors?: SpanProcessor[]
  /** BatchSpanProcessor config overrides. Opinionated defaults: scheduledDelayMillis=2000, exportTimeoutMillis=10000 */
  batchProcessorConfig?: BufferConfig
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

export interface OpinionatedOptions {
  /** Drop this span, merge its attributes into children, and reparent children to grandparent */
  collapse?: boolean
  /** Collapse parallel sibling spans with the same name into a single aggregate span */
  aggregate?: boolean | AggregateConfig
  /** Custom onStart hook */
  onStart?: (span: Span & ReadableSpan) => void
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

export interface AutoInstrumentHookConfig {
  /** Tracer to use for auto-instrumented spans. Default: `trace.getTracer('opin_tel.auto')` */
  tracer?: import('@opentelemetry/api').Tracer
  instrumentPaths: AutoInstrumentPath[]
  ignoreRules?: IgnoreRuleEntry[]
}
