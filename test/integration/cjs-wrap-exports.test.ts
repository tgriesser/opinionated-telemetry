import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

const require = createRequire(import.meta.url)

/**
 * These tests load the CJS build of wrap-exports to verify that
 * `defaultShouldWrap` resolves correctly when the `exports` parameter
 * name could shadow the module-level `exports` object.
 *
 * Bug: TypeScript compiles `export const defaultShouldWrap` references
 * as `exports.defaultShouldWrap` in CJS. If the function parameter is
 * also named `exports`, it shadows the module's `exports` object, causing
 * `defaultShouldWrap` to resolve to `undefined` on the target module.
 */
describe('CJS wrapModuleExports – defaultShouldWrap resolution', () => {
  const cjsPath = path.resolve('dist/cjs/wrap-exports.js')

  afterEach(() => cleanupOtel())

  function loadCjs() {
    // Clear require cache to get a fresh module each time
    delete require.cache[require.resolve(cjsPath)]
    return require(cjsPath) as {
      wrapModuleExports: typeof import('../../src/wrap-exports.js').wrapModuleExports
      defaultShouldWrap: typeof import('../../src/wrap-exports.js').defaultShouldWrap
    }
  }

  it('wraps async function exports using default shouldWrap (no custom shouldWrap)', async () => {
    const { wrapModuleExports } = loadCjs()
    const { tracer, exporter } = createSimpleProvider()

    const moduleObj = {
      asyncFn: async function asyncFn() {
        return 'hello'
      },
      syncFn: function syncFn() {
        return 'world'
      },
    }

    const original = moduleObj.asyncFn

    wrapModuleExports(moduleObj, 'test/cjs-module', tracer)

    // asyncFn should be wrapped (default shouldWrap wraps async functions)
    expect(moduleObj.asyncFn).not.toBe(original)
    const result = await moduleObj.asyncFn()
    expect(result).toBe('hello')

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('asyncFn')
  })

  it('does not wrap sync functions using default shouldWrap', () => {
    const { wrapModuleExports } = loadCjs()
    const { tracer } = createSimpleProvider()

    const syncFn = function syncFn() {
      return 'sync'
    }
    const moduleObj = { syncFn }

    wrapModuleExports(moduleObj, 'test/cjs-module', tracer)

    expect(moduleObj.syncFn).toBe(syncFn)
  })

  it('wraps async class methods using default shouldWrap (no custom shouldWrap)', async () => {
    const { wrapModuleExports } = loadCjs()
    const { tracer, exporter } = createSimpleProvider()

    class UserService {
      async findUser(id: number) {
        return { id, name: 'test' }
      }
      syncMethod() {
        return 'sync'
      }
    }

    const originalFind = UserService.prototype.findUser
    const originalSync = UserService.prototype.syncMethod
    const moduleObj = { UserService }

    wrapModuleExports(
      moduleObj,
      'services/user',
      tracer,
      [],
      undefined,
      undefined,
      {},
    )

    // async method should be wrapped
    expect(UserService.prototype.findUser).not.toBe(originalFind)
    // sync method should NOT be wrapped
    expect(UserService.prototype.syncMethod).toBe(originalSync)

    const svc = new moduleObj.UserService()
    await svc.findUser(1)
    svc.syncMethod()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('UserService.findUser')
  })

  it('wraps direct function export using default shouldWrap', async () => {
    const { wrapModuleExports } = loadCjs()
    const { tracer, exporter } = createSimpleProvider()

    const directExport = async function handler() {
      return 'handled'
    }

    const wrapped = wrapModuleExports(
      directExport as any,
      'handlers/main',
      tracer,
    )

    expect(wrapped).not.toBe(directExport)
    const result = await wrapped()
    expect(result).toBe('handled')

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('handler')
  })

  it('wraps direct class export using default shouldWrap', async () => {
    const { wrapModuleExports } = loadCjs()
    const { tracer, exporter } = createSimpleProvider()

    class DirectService {
      async run() {
        return 'ran'
      }
      syncOp() {
        return 'sync'
      }
    }

    const originalRun = DirectService.prototype.run
    const originalSync = DirectService.prototype.syncOp

    wrapModuleExports(
      DirectService as any,
      'services/direct',
      tracer,
      [],
      undefined,
      undefined,
      {},
    )

    expect(DirectService.prototype.run).not.toBe(originalRun)
    expect(DirectService.prototype.syncOp).toBe(originalSync)

    const svc = new DirectService()
    await svc.run()
    svc.syncOp()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('DirectService.run')
  })

  it('does not pick up a defaultShouldWrap property from the target module', async () => {
    const { wrapModuleExports } = loadCjs()
    const { tracer, exporter } = createSimpleProvider()

    const moduleObj = {
      // A target module that happens to have a defaultShouldWrap property
      // (e.g. if someone re-exports from this lib) — should be irrelevant
      defaultShouldWrap: undefined,
      asyncFn: async function asyncFn() {
        return 'ok'
      },
    }

    const original = moduleObj.asyncFn

    // Should not throw "fnShouldWrap is not a function"
    wrapModuleExports(moduleObj, 'test/shadowed', tracer)

    expect(moduleObj.asyncFn).not.toBe(original)
    const result = await moduleObj.asyncFn()
    expect(result).toBe('ok')

    exporter.assertTotalSpanCount(1)
  })
})
