export { opinionatedTelemetryInit } from './init.js'
export { OpinionatedInstrumentation } from './opinionated-instrumentation.js'
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
export { createAutoInstrumentHookCJS } from './auto-instrument-hook.js'
export { buildMatchers, matchPath } from './auto-instrument-matchers.js'
export type { Matcher } from './auto-instrument-matchers.js'
export { createAutoInstrumentHookESM } from './auto-instrument-hook-esm.js'

export type {
  OpinionatedTelemetryConfig,
  OpinionatedOptions,
  AggregateConfig,
  AggregateAttributeConfig,
  AggregateGenericOption,
  AggregateNumericOption,
  IgnoreRule,
  IgnoreRuleEntry,
  AutoInstrumentPath,
  AutoInstrumentHookConfig,
  SamplingConfig,
  HeadSamplingConfig,
  TailSamplingConfig,
  BurstProtectionConfig,
  TraceSummary,
} from './types.js'
