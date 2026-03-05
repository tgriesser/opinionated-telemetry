import path from 'node:path'
import Module from 'node:module'
import debugLib from 'debug'
import { wrapModuleExports } from './wrap-exports.js'
import type { AutoInstrumentHookConfig } from './types.js'

const debug = debugLib('opin-tel:auto-instrument')

/**
 * Creates a Module._load hook that auto-wraps exported async functions
 * from target directories with OpenTelemetry spans.
 *
 * Call this early (before application code loads) to patch Module._load.
 * Typically used in a --require preload script.
 */
export function createAutoInstrumentHook(
  config: AutoInstrumentHookConfig,
): void {
  const { tracer, instrumentPaths, ignoreRules = [] } = config

  // Build matchers: resolved base + dir prefix
  const matchers: Array<{ base: string; dir: string; prefix: string }> = []
  for (const entry of instrumentPaths) {
    for (const dir of entry.dirs) {
      matchers.push({
        base: entry.base,
        dir,
        prefix: path.join(entry.base, dir) + path.sep,
      })
    }
  }

  debug('patching Module._load with %d matcher(s)', matchers.length)
  for (const m of matchers) {
    debug('  watching: %s', m.prefix)
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

    for (const matcher of matchers) {
      if (resolvedPath.startsWith(matcher.prefix)) {
        const relativePath = resolvedPath
          .slice(matcher.base.length + 1)
          .replace(/\.[^.]+$/, '')
        debug('wrapping module: %s', relativePath)
        return wrapModuleExports(result, relativePath, tracer, ignoreRules)
      }
    }

    return result
  }
}
