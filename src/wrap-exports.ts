import { SpanStatusCode, type Tracer } from '@opentelemetry/api'
import debugLib from 'debug'
import type { AutoInstrumentHooks, IgnoreRuleEntry } from './types.js'
import { OPIN_TEL_INTERNAL } from './constants.js'

const debug = debugLib('opin_tel:wrap-exports')

/**
 * Wraps a single function with an OpenTelemetry span.
 * Preserves function.name (for debugging) and function.length
 * (Express uses arity to distinguish error handlers).
 */
export function wrapFunction(
  fn: (...args: any[]) => any,
  fnName: string,
  filename: string,
  tracer: Tracer,
  hooks?: AutoInstrumentHooks,
): (...args: any[]) => any {
  const callContext = { fnName, filename }
  const wrapper = {
    [fn.name || 'anonymous']: function (this: any, ...args: any[]) {
      return tracer.startActiveSpan(fnName, (span) => {
        span.setAttribute(OPIN_TEL_INTERNAL.code.function, fnName)
        span.setAttribute(OPIN_TEL_INTERNAL.code.filename, filename)
        if (hooks?.onStart) {
          hooks.onStart(span as any, { ...callContext, args })
        }
        try {
          const result = fn.apply(this, args)

          // Handle async functions (promises)
          if (result && typeof result.then === 'function') {
            return result.then(
              (val: any) => {
                if (hooks?.onEnd) {
                  hooks.onEnd(span as any, {
                    ...callContext,
                    args,
                    returnValue: val,
                  })
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
                  hooks.onEnd(span as any, {
                    ...callContext,
                    args,
                    error: err,
                  })
                }
                span.end()
                throw err
              },
            )
          }

          if (hooks?.onEnd) {
            hooks.onEnd(span as any, {
              ...callContext,
              args,
              returnValue: result,
            })
          }
          span.end()
          return result
        } catch (err: any) {
          span.recordException(err)
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
          if (hooks?.onEnd) {
            hooks.onEnd(span as any, { ...callContext, args, error: err })
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
): Record<string, any> {
  if (!exports || typeof exports !== 'object') {
    return exports
  }

  const keys = Object.getOwnPropertyNames(exports)
  for (const key of keys) {
    if (key === '__esModule') continue

    const desc = Object.getOwnPropertyDescriptor(exports, key)
    // Skip getters/setters to avoid triggering side effects
    if (!desc || !('value' in desc)) continue

    const value = desc.value
    if (typeof value !== 'function') continue
    if (value.constructor?.name !== 'AsyncFunction') continue

    if (shouldIgnore(spanPrefix, key, ignoreRules)) {
      debug('ignoring %s:%s', spanPrefix, key)
      continue
    }

    const fnName = key === 'default' ? value.name || 'default' : key
    debug('wrapping %s:%s', spanPrefix, fnName)
    exports[key] = wrapFunction(value, fnName, spanPrefix, tracer, hooks)
  }

  return exports
}
