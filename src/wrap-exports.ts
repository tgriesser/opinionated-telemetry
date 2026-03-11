import { SpanStatusCode, type Tracer } from '@opentelemetry/api'
import debugLib from 'debug'
import type {
  AutoInstrumentHooks,
  ClassInstrumentationConfig,
  FunctionInstrumentationConfig,
  IgnoreRuleEntry,
  ShouldWrapFn,
} from './types.js'
import { OPIN_TEL_INTERNAL } from './constants.js'
import type { Span } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

const debug = debugLib('opin_tel:wrap-exports')

/**
 * Default shouldWrap: only wraps async functions.
 */
export const defaultShouldWrap: ShouldWrapFn = (fn) =>
  fn.constructor?.name === 'AsyncFunction'

/**
 * Wraps a single function with an OpenTelemetry span.
 * Preserves function.name (for debugging) and function.length
 * (Express uses arity to distinguish error handlers).
 */
export type WrapCallContext =
  | { type: 'function'; fnName: string; filename: string }
  | { type: 'method'; className: string; methodName: string; filename: string }

export function wrapFunction(
  fn: (...args: any[]) => any,
  spanName: string,
  callContext: WrapCallContext,
  tracer: Tracer,
  hooks?: AutoInstrumentHooks,
): (...args: any[]) => any {
  function setSpanAttrs(span: Span) {
    span.setAttribute(OPIN_TEL_INTERNAL.code.type, callContext.type)
    span.setAttribute(OPIN_TEL_INTERNAL.code.filename, callContext.filename)
    if (callContext.type === 'function') {
      span.setAttribute(OPIN_TEL_INTERNAL.code.function, callContext.fnName)
    } else {
      span.setAttribute(OPIN_TEL_INTERNAL.code.class, callContext.className)
      span.setAttribute(OPIN_TEL_INTERNAL.code.method, callContext.methodName)
    }
  }

  function hookContext<T extends Record<string, any>>(extra: T) {
    return { ...callContext, ...extra }
  }

  const wrapper = {
    [fn.name || 'anonymous']: function (this: any, ...args: any[]) {
      return tracer.startActiveSpan(spanName, (span) => {
        setSpanAttrs(span)
        if (hooks?.onStart) {
          hooks.onStart(span as Span & ReadableSpan, hookContext({ args }))
        }
        try {
          const result = fn.apply(this, args)

          // Handle async functions (promises)
          if (result && typeof result.then === 'function') {
            return result.then(
              (val: any) => {
                if (hooks?.onEnd) {
                  hooks.onEnd(
                    span as Span & ReadableSpan,
                    hookContext({ args, returnValue: val }),
                  )
                }
                span.end()
                return val
              },
              (err: any) => {
                span.recordException(err)
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: err.message,
                })
                if (hooks?.onEnd) {
                  hooks.onEnd(
                    span as Span & ReadableSpan,
                    hookContext({ args, error: err }),
                  )
                }
                span.end()
                throw err
              },
            )
          }

          if (hooks?.onEnd) {
            hooks.onEnd(
              span as Span & ReadableSpan,
              hookContext({ args, returnValue: result }),
            )
          }
          span.end()
          return result
        } catch (err: any) {
          span.recordException(err)
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
          if (hooks?.onEnd) {
            hooks.onEnd(
              span as Span & ReadableSpan,
              hookContext({ args, error: err }),
            )
          }
          span.end()
          throw err
        }
      })
    },
  }[fn.name || 'anonymous']!

  // Preserve function.length (arity)
  Object.defineProperty(wrapper, 'length', {
    value: fn.length,
    configurable: true,
  })

  return wrapper
}

/**
 * Checks whether a specific export should be ignored based on ignore rules.
 */
function shouldIgnore(
  spanPrefix: string,
  exportKey: string,
  ignoreRules: IgnoreRuleEntry[],
): boolean {
  for (const rule of ignoreRules) {
    if (typeof rule === 'string') {
      if (spanPrefix === rule) return true
    } else if (rule.file === spanPrefix) {
      if (!rule.exports || rule.exports.includes(exportKey)) return true
    }
  }
  return false
}

/**
 * Checks if a function is an ES class (vs a plain function/constructor).
 */
function isClass(fn: Function): boolean {
  return Function.prototype.toString.call(fn).startsWith('class ')
}

/**
 * Evaluates a flexible filter (string[], RegExp, or function) against a name.
 * Returns true if the filter passes (or is undefined = allow all).
 */
function matchesFnFilter(
  name: string,
  fn: Function,
  filename: string,
  filter: FunctionInstrumentationConfig['include'],
): boolean {
  if (!filter) return true
  if (Array.isArray(filter)) return filter.includes(name)
  if (filter instanceof RegExp) return filter.test(name)
  return filter(name, fn, filename)
}

/**
 * Evaluates the includeClass filter.
 */
function matchesClassFilter(
  className: string,
  ClassObj: Function,
  filename: string,
  filter: ClassInstrumentationConfig['includeClass'],
): boolean {
  if (!filter) return true
  if (Array.isArray(filter)) return filter.includes(className)
  if (filter instanceof RegExp) return filter.test(className)
  return filter(className, ClassObj, filename)
}

/**
 * Evaluates the includeMethod filter.
 */
function matchesMethodFilter(
  methodName: string,
  className: string,
  method: Function,
  filename: string,
  filter: ClassInstrumentationConfig['includeMethod'],
): boolean {
  if (!filter) return true
  if (Array.isArray(filter)) return filter.includes(methodName)
  if (filter instanceof RegExp) return filter.test(methodName)
  return filter(methodName, className, method, filename)
}

/**
 * Handles the case where module.exports is directly a function or class
 * (e.g., `module.exports = function handler() {}` or `module.exports = class Service {}`).
 */
function wrapDirectExport(
  exportedFn: Function,
  spanPrefix: string,
  tracer: Tracer,
  ignoreRules: IgnoreRuleEntry[],
  hooks?: AutoInstrumentHooks,
  functionInstrumentation?: FunctionInstrumentationConfig,
  classInstrumentation?: ClassInstrumentationConfig,
): any {
  const fnName = exportedFn.name || 'default'

  if (shouldIgnore(spanPrefix, 'default', ignoreRules)) {
    debug('ignoring direct export %s', spanPrefix)
    return exportedFn
  }

  // Class instrumentation (opt-in)
  if (isClass(exportedFn) && classInstrumentation) {
    const className = fnName
    const classShouldWrap = classInstrumentation.shouldWrap ?? defaultShouldWrap

    if (
      !matchesClassFilter(
        className,
        exportedFn,
        spanPrefix,
        classInstrumentation.includeClass,
      )
    ) {
      return exportedFn
    }

    debug('wrapping direct class export %s:%s', spanPrefix, className)
    const protoKeys = Object.getOwnPropertyNames(exportedFn.prototype)
    for (const method of protoKeys) {
      if (method === 'constructor') continue
      const methodDesc = Object.getOwnPropertyDescriptor(
        exportedFn.prototype,
        method,
      )
      if (!methodDesc || !('value' in methodDesc)) continue
      const methodFn = methodDesc.value
      if (typeof methodFn !== 'function') continue
      if (!classShouldWrap(methodFn, method, spanPrefix)) continue
      if (
        !matchesMethodFilter(
          method,
          className,
          methodFn,
          spanPrefix,
          classInstrumentation.includeMethod,
        )
      ) {
        continue
      }

      const spanName = `${className}.${method}`
      debug('wrapping method %s:%s', spanPrefix, spanName)
      exportedFn.prototype[method] = wrapFunction(
        methodFn,
        spanName,
        {
          type: 'method',
          className,
          methodName: method,
          filename: spanPrefix,
        },
        tracer,
        hooks,
      )
    }
    return exportedFn
  }

  // Function instrumentation
  const fnShouldWrap = functionInstrumentation?.shouldWrap ?? defaultShouldWrap
  if (!fnShouldWrap(exportedFn, fnName, spanPrefix)) return exportedFn
  if (
    !matchesFnFilter(
      fnName,
      exportedFn,
      spanPrefix,
      functionInstrumentation?.include,
    )
  ) {
    return exportedFn
  }

  debug('wrapping direct export %s:%s', spanPrefix, fnName)
  const wrapped = wrapFunction(
    exportedFn as (...args: any[]) => any,
    fnName,
    { type: 'function', fnName, filename: spanPrefix },
    tracer,
    hooks,
  )

  // Copy static properties from the original to the wrapper
  // (common pattern: module.exports = fn; module.exports.helper = ...)
  const staticKeys = Object.getOwnPropertyNames(exportedFn)
  for (const key of staticKeys) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue
    const desc = Object.getOwnPropertyDescriptor(exportedFn, key)
    if (desc) {
      Object.defineProperty(wrapped, key, desc)
    }
  }

  return wrapped
}

export interface WrapModuleExportsConfig {
  ignoreRules?: IgnoreRuleEntry[]
  hooks?: AutoInstrumentHooks
  functionInstrumentation?: FunctionInstrumentationConfig
  classInstrumentation?: ClassInstrumentationConfig
}

/**
 * Wraps all async function exports from a module with OpenTelemetry spans.
 *
 * Handles Babel-transpiled patterns:
 *   - exports.default = fn → span uses function name
 *   - exports.bar = fn     → span uses export key
 */
export function wrapModuleExports(
  exports: Record<string, any>,
  spanPrefix: string,
  tracer: Tracer,
  ignoreRules: IgnoreRuleEntry[] = [],
  hooks?: AutoInstrumentHooks,
  functionInstrumentation?: FunctionInstrumentationConfig,
  classInstrumentation?: ClassInstrumentationConfig,
): Record<string, any> {
  if (!exports) {
    return exports
  }

  // Handle module.exports = function or module.exports = class
  if (typeof exports === 'function') {
    return wrapDirectExport(
      exports,
      spanPrefix,
      tracer,
      ignoreRules,
      hooks,
      functionInstrumentation,
      classInstrumentation,
    )
  }

  if (typeof exports !== 'object') {
    return exports
  }

  const fnShouldWrap = functionInstrumentation?.shouldWrap ?? defaultShouldWrap
  const classShouldWrap = classInstrumentation?.shouldWrap ?? defaultShouldWrap

  const keys = Object.getOwnPropertyNames(exports)
  for (const key of keys) {
    if (key === '__esModule') continue

    const desc = Object.getOwnPropertyDescriptor(exports, key)
    // Skip getters/setters to avoid triggering side effects
    if (!desc || !('value' in desc)) continue

    const value = desc.value
    if (typeof value !== 'function') continue

    if (shouldIgnore(spanPrefix, key, ignoreRules)) {
      debug('ignoring %s:%s', spanPrefix, key)
      continue
    }

    // Class instrumentation (opt-in)
    if (isClass(value) && classInstrumentation) {
      const className = value.name || key
      if (
        !matchesClassFilter(
          className,
          value,
          spanPrefix,
          classInstrumentation.includeClass,
        )
      ) {
        continue
      }

      debug('wrapping class %s:%s', spanPrefix, className)
      const protoKeys = Object.getOwnPropertyNames(value.prototype)
      for (const method of protoKeys) {
        if (method === 'constructor') continue
        const methodDesc = Object.getOwnPropertyDescriptor(
          value.prototype,
          method,
        )
        if (!methodDesc || !('value' in methodDesc)) continue
        const methodFn = methodDesc.value
        if (typeof methodFn !== 'function') continue
        if (!classShouldWrap(methodFn, method, spanPrefix)) continue
        if (
          !matchesMethodFilter(
            method,
            className,
            methodFn,
            spanPrefix,
            classInstrumentation.includeMethod,
          )
        ) {
          continue
        }

        const spanName = `${className}.${method}`
        debug('wrapping method %s:%s', spanPrefix, spanName)
        value.prototype[method] = wrapFunction(
          methodFn,
          spanName,
          {
            type: 'method',
            className,
            methodName: method,
            filename: spanPrefix,
          },
          tracer,
          hooks,
        )
      }
      continue
    }

    // Function instrumentation
    if (!fnShouldWrap(value, key, spanPrefix)) continue
    if (
      !matchesFnFilter(key, value, spanPrefix, functionInstrumentation?.include)
    ) {
      continue
    }

    const fnName = key === 'default' ? value.name || 'default' : key
    debug('wrapping %s:%s', spanPrefix, fnName)
    exports[key] = wrapFunction(
      value,
      fnName,
      { type: 'function', fnName, filename: spanPrefix },
      tracer,
      hooks,
    )
  }

  return exports
}
