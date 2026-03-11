export { createAutoInstrumentHookCJS } from './auto-instrument-hook.js'
export { buildMatchers, matchPath } from './auto-instrument-matchers.js'
export type { Matcher } from './auto-instrument-matchers.js'
export { wrapModuleExports, wrapFunction } from './wrap-exports.js'
export type {
  AutoInstrumentPath,
  AutoInstrumentHookConfig,
  AutoInstrumentHooks,
  AutoInstrumentCallContext,
  IgnoreRule,
  IgnoreRuleEntry,
} from './types.js'
