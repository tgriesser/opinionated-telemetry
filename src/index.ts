// Core
export { opinionatedTelemetryInit } from './init.js'
export { OpinionatedInstrumentation } from './opinionated-instrumentation.js'
export { FilteringSpanProcessor } from './filtering-span-processor.js'
export type {
  FilteringSpanProcessorConfig,
  MemoryConfig,
  StuckSpanConfig,
} from './filtering-span-processor.js'

// Baggage utilities
export { withBaggage, getBaggageValue } from './baggage.js'

// Query sanitization utilities
export {
  sanitizeBinding,
  sanitizeBindings,
  defaultHash,
} from './integrations/knex.js'

// Auto-instrumentation
export { wrapModuleExports, wrapFunction } from './wrap-exports.js'
export { createAutoInstrumentHookCJS } from './auto-instrument-hook.js'
export { buildMatchers, matchPath } from './auto-instrument-matchers.js'
export type { Matcher } from './auto-instrument-matchers.js'
export { createAutoInstrumentHookESM } from './auto-instrument-hook-esm.js'

// Types
export type {
  OpinionatedTelemetryConfig,
  OpinionatedOptions,
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
