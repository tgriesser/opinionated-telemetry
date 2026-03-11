export { createAutoInstrumentHookESM } from './auto-instrument-hook-esm.js'
export { buildMatchers, matchPath } from './auto-instrument-matchers.js'
export type { Matcher } from './auto-instrument-matchers.js'
export {
  wrapModuleExports,
  wrapFunction,
  defaultShouldWrap,
} from './wrap-exports.js'
export type {
  WrapCallContext,
  WrapModuleExportsConfig,
} from './wrap-exports.js'
export type {
  AutoInstrumentPath,
  AutoInstrumentHookConfig,
  AutoInstrumentHooks,
  AutoInstrumentCallContext,
  AutoInstrumentFunctionContext,
  AutoInstrumentMethodContext,
  IgnoreRule,
  IgnoreRuleEntry,
  ShouldWrapFn,
  FunctionInstrumentationConfig,
  ClassInstrumentationConfig,
} from './types.js'
