// Core
export { opinionatedTelemetryInit } from './init.js'
export { OpinionatedInstrumentation } from './opinionated-instrumentation.js'
export { FilteringSpanProcessor } from './filtering-span-processor.js'
export type { FilteringSpanProcessorConfig } from './filtering-span-processor.js'

// Baggage utilities
export { withBaggage, getBaggageValue } from './baggage.js'

// Auto-instrumentation
export { wrapModuleExports, wrapFunction } from './wrap-exports.js'
export { createAutoInstrumentHook } from './auto-instrument-hook.js'

// Types
export type {
  OpinionatedTelemetryConfig,
  OpinionatedOptions,
  IgnoreRule,
  IgnoreRuleEntry,
  AutoInstrumentPath,
  AutoInstrumentHookConfig,
} from './types.js'
