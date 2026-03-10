export { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
export { trace, context, propagation } from '@opentelemetry/api'

export type { SpanExporter, BufferConfig } from '@opentelemetry/sdk-trace-base'
export { opinionatedTelemetryInit } from './opinionated-telemetry-init.js'
export { FilteringSpanProcessor } from './filtering-span-processor.js'
export type {
  FilteringSpanProcessorConfig,
  MemoryConfig,
  StuckSpanConfig,
} from './filtering-span-processor.js'

export { withBaggage, getBaggageValue } from './baggage.js'

export {
  sanitizeBinding,
  sanitizeBindings,
  defaultHash,
} from './integrations/knex.js'

export { wrapModuleExports, wrapFunction } from './wrap-exports.js'

export type {
  OpinionatedTelemetryConfig,
  OpinionatedLogger,
  OpinionatedOptions,
  AggregateConfig,
  AggregateAttributeConfig,
  AggregateGenericOption,
  AggregateNumericOption,
  IgnoreRule,
  IgnoreRuleEntry,
  SamplingConfig,
  HeadSamplingConfig,
  TailSamplingConfig,
  BurstProtectionConfig,
  TraceSummary,
} from './types.js'
