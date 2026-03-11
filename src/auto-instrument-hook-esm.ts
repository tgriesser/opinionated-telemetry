import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { trace } from '@opentelemetry/api'
import debugLib from 'debug'
import { wrapModuleExports } from './wrap-exports.js'
import { buildMatchers, matchPath } from './auto-instrument-matchers.js'
import type { AutoInstrumentHookConfig } from './types.js'
import { OPIN_TEL_PREFIX } from './constants.js'

const debug = debugLib('opin_tel:auto-instrument-esm')

/**
 * Creates an ESM auto-instrument hook using import-in-the-middle.
 *
 * Uses the `Hook` class from `import-in-the-middle` (a transitive dep
 * via @opentelemetry/instrumentation) to intercept ESM module loading.
 *
 * The consumer must register the loader hooks first by starting Node with:
 *   --import @opentelemetry/instrumentation/hook.mjs
 *
 * Returns an unhook() cleanup function.
 */
export function createAutoInstrumentHookESM(
  config: AutoInstrumentHookConfig,
): () => void {
  const { instrumentPaths, ignoreRules = [], hooks } = config
  const getTracer = () =>
    config.tracer ?? trace.getTracer(`${OPIN_TEL_PREFIX}auto`)
  const matchers = buildMatchers(instrumentPaths)

  debug('setting up ESM hook with %d matcher(s)', matchers.length)
  for (const m of matchers) {
    debug('  matching: %s', m.prefix)
  }

  // @ts-ignore - not defined during CJS build
  const _require = createRequire(import.meta.url)
  const { Hook } = _require('import-in-the-middle')

  const hook = new Hook((exported: any, name: string, baseDir: string) => {
    let resolvedPath: string
    try {
      // name may be a file:// URL or a bare specifier
      if (name.startsWith('file://')) {
        resolvedPath = fileURLToPath(name)
      } else if (path.isAbsolute(name)) {
        resolvedPath = name
      } else if (baseDir) {
        resolvedPath = path.join(baseDir, name)
      } else {
        return
      }
    } catch (err) {
      debug('failed to resolve ESM module path for %s: %O', name, err)
      return
    }

    const relativePath = matchPath(resolvedPath, matchers)
    if (relativePath) {
      debug('wrapping ESM module: %s', relativePath)
      wrapModuleExports(exported, relativePath, getTracer(), ignoreRules, hooks)
    }
  })

  return () => {
    debug('unhooking ESM auto-instrument')
    hook.unhook()
  }
}
