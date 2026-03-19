export { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
export {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
} from '@opentelemetry/api'

export type { SpanExporter, BufferConfig } from '@opentelemetry/sdk-trace-base'
export { opinionatedTelemetryInit } from './opinionated-telemetry-init.js'
export { FilteringSpanProcessor } from './filtering-span-processor.js'
export type {
  FilteringSpanProcessorConfig,
  MemoryConfig,
  StuckSpanConfig,
} from './filtering-span-processor.js'

export { withBaggage, getBaggageValue } from './baggage.js'
export { setTraceContext, getRootSpan } from './trace-context.js'
export { FilteredBaggagePropagator } from './filtered-baggage-propagator.js'

export {
  sanitizeBinding,
  sanitizeBindings,
  defaultHash,
} from './integrations/knex.js'
export type { KnexQueryHookContext } from './integrations/knex.js'

export { wrapModuleExports, wrapFunction } from './wrap-exports.js'

export {
  stabilizeQuery,
  queryRequestTag,
  stableQueryTag,
  queryResponseTag,
  stableQueryHash,
} from './sql-utils.js'
export type { StableQueryResult } from './sql-utils.js'

export type {
  OpinionatedTelemetryConfig,
  OpinionatedLogger,
  OpinionatedOptions,
  AggregateConfig,
  AggregateAttributeConfig,
  AggregateGenericOption,
  AggregateGroupStats,
  AggregateNumericOption,
  IgnoreRule,
  IgnoreRuleEntry,
  SamplingConfig,
  HeadSamplingConfig,
  TailSamplingConfig,
  BurstProtectionConfig,
  BaggagePropagationConfig,
  TraceSummary,
  GlobalHooks,
  OnStartResult,
  ShouldDropFn,
} from './types.js'
