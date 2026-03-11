import Module from 'node:module'
import { trace } from '@opentelemetry/api'
import debugLib from 'debug'
import { wrapModuleExports } from './wrap-exports.js'
import { buildMatchers, matchPath } from './auto-instrument-matchers.js'
import type { AutoInstrumentHookConfig } from './types.js'
import { OPIN_TEL_PREFIX } from './constants.js'

const debug = debugLib('opin_tel:auto-instrument')

export function createAutoInstrumentHookCJS(
  config: AutoInstrumentHookConfig,
): void {
  const { instrumentPaths, ignoreRules = [], hooks } = config
  const getTracer = () =>
    config.tracer ?? trace.getTracer(`${OPIN_TEL_PREFIX}auto`)
  const matchers = buildMatchers(instrumentPaths)

  debug('patching Module._load with %d matcher(s)', matchers.length)
  for (const m of matchers) {
    debug('  matching: %s', m.prefix)
  }
  if (ignoreRules.length > 0) {
    debug('  ignore rules: %o', ignoreRules)
  }

  const originalLoad = (Module as any)._load

  ;(Module as any)._load = function otelInstrumentedLoad(
    request: string,
    parent: any,
    isMain: boolean,
  ) {
    const result = originalLoad.apply(this, arguments)

    if (!parent?.filename) {
      return result
    }

    let resolvedPath: string
    try {
      resolvedPath = (Module as any)._resolveFilename(request, parent)
    } catch {
      return result
    }

    const relativePath = matchPath(resolvedPath, matchers)
    if (relativePath) {
      debug('wrapping module: %s', relativePath)
      return wrapModuleExports(
        result,
        relativePath,
        getTracer(),
        ignoreRules,
        hooks,
      )
    }

    return result
  }
}
