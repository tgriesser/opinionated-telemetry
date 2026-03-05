import type {
  Span,
  SpanExporter,
  SpanLimits,
  SpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { OpinionatedInstrumentation } from './opinionated-instrumentation.js'

export interface OpinionatedTelemetryConfig {
  serviceName: string
  resourceAttributes?: Record<string, string>
  traceExporter?: SpanExporter
  metricReader?: MetricReader
  spanLimits?: SpanLimits
  /** Drop spans that start and end in the same tick. Default: true */
  dropSyncSpans?: true | ((span: Span & ReadableSpan) => boolean)
  /** Enable reparenting for instrumentations that opt in. Default: true */
  enableReparenting?: boolean
  /** Propagate baggage entries as span attributes. Default: true */
  baggageToAttributes?: boolean
  /** Signal to register shutdown handler on. Default: 'SIGTERM' */
  shutdownSignal?: string
  instrumentations: Array<Instrumentation | OpinionatedInstrumentation>
  additionalSpanProcessors?: SpanProcessor[]
}

export interface OpinionatedOptions {
  /** Drop this span and reparent its children to its parent */
  reparent?: boolean
  /** Rename span in onStart */
  renameSpan?: (
    spanName: string,
    span: Span & ReadableSpan,
  ) => string | undefined
  /** Rename span in onEnd */
  renameSpanOnEnd?: (span: Span & ReadableSpan) => string | undefined
  /** Custom onStart hook */
  onStart?: (span: Span & ReadableSpan) => void
  /** Custom onEnd hook */
  onEnd?: (span: Span & ReadableSpan) => void
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
  tracer: import('@opentelemetry/api').Tracer
  instrumentPaths: AutoInstrumentPath[]
  ignoreRules?: IgnoreRuleEntry[]
}
