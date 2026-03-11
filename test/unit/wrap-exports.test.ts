import { describe, it, expect, afterEach } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import {
  wrapFunction,
  wrapModuleExports,
  defaultShouldWrap,
} from '../../src/wrap-exports.js'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

describe('wrapFunction', () => {
  afterEach(() => cleanupOtel())

  it('wraps an async function and creates a span', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const original = async function myFunc(x: number) {
      return x * 2
    }
    const wrapped = wrapFunction(
      original,
      'myFunc',
      { type: 'function', fnName: 'myFunc', filename: 'test/file' },
      tracer,
    )

    const result = await wrapped(21)
    expect(result).toBe(42)

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanAttributes('myFunc', {
      'opin_tel.code.type': 'function',
      'opin_tel.code.function': 'myFunc',
      'opin_tel.code.filename': 'test/file',
    })
  })

  it('preserves function name', () => {
    const { tracer } = createSimpleProvider()
    const original = async function namedFn() {}
    const wrapped = wrapFunction(
      original,
      'namedFn',
      { type: 'function', fnName: 'namedFn', filename: 'file' },
      tracer,
    )
    expect(wrapped.name).toBe('namedFn')
  })

  it('preserves function arity', () => {
    const { tracer } = createSimpleProvider()
    const original = async function threeArgs(_a: any, _b: any, _c: any) {}
    const wrapped = wrapFunction(
      original,
      'threeArgs',
      { type: 'function', fnName: 'threeArgs', filename: 'file' },
      tracer,
    )
    expect(wrapped.length).toBe(3)
  })

  it('records errors on async rejection', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const original = async function failFn() {
      throw new Error('test error')
    }
    const wrapped = wrapFunction(
      original,
      'failFn',
      { type: 'function', fnName: 'failFn', filename: 'file' },
      tracer,
    )

    await expect(wrapped()).rejects.toThrow('test error')

    const span = exporter.assertSpanExists('failFn')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('test error')
  })

  it('records errors on sync throw', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const original = function syncFail() {
      throw new Error('sync error')
    }
    const wrapped = wrapFunction(
      original,
      'syncFail',
      { type: 'function', fnName: 'syncFail', filename: 'file' },
      tracer,
    )

    expect(() => wrapped()).toThrow('sync error')

    const span = exporter.assertSpanExists('syncFail')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe('wrapModuleExports', () => {
  afterEach(() => cleanupOtel())

  it('wraps async function exports', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const exports = {
      asyncFn: async function asyncFn() {
        return 'hello'
      },
      syncFn: function syncFn() {
        return 'world'
      },
      notAFunction: 42,
      __esModule: true,
    }

    wrapModuleExports(exports, 'test/module', tracer)

    const result = await exports.asyncFn()
    expect(result).toBe('hello')

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('asyncFn')
  })

  it('does not wrap sync functions', () => {
    const { tracer } = createSimpleProvider()
    const original = function syncFn() {}
    const exports = { syncFn: original }

    wrapModuleExports(exports, 'test/module', tracer)
    expect(exports.syncFn).toBe(original)
  })

  it('respects string ignore rules', () => {
    const { tracer } = createSimpleProvider()
    const original = async function ignored() {}
    const exports = { default: original }

    wrapModuleExports(exports, 'helpers/ignored-file', tracer, [
      'helpers/ignored-file',
    ])
    expect(exports.default).toBe(original)
  })

  it('respects object ignore rules with specific exports', () => {
    const { tracer } = createSimpleProvider()
    const ignoredFn = async function ignoredFn() {}
    const keptFn = async function keptFn() {}
    const exports = { ignoredFn, keptFn }

    wrapModuleExports(exports, 'helpers/mixed', tracer, [
      { file: 'helpers/mixed', exports: ['ignoredFn'] },
    ])
    expect(exports.ignoredFn).toBe(ignoredFn)
    expect(exports.keptFn).not.toBe(keptFn)
  })

  it('uses function name for default exports', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const exports = {
      default: async function myHandler() {
        return true
      },
    }

    wrapModuleExports(exports, 'handlers/foo', tracer)
    await exports.default()

    exporter.assertSpanExists('myHandler')
  })

  it('does not trigger getters on module exports', () => {
    const { tracer } = createSimpleProvider()
    let getterCalled = false
    const exports = Object.create(null)
    Object.defineProperty(exports, 'lazyValue', {
      get() {
        getterCalled = true
        return async function lazyFn() {}
      },
      enumerable: true,
      configurable: true,
    })
    exports.normalFn = async function normalFn() {}

    wrapModuleExports(exports, 'test/getters', tracer)

    expect(getterCalled).toBe(false)
    // The normal data property should still be wrapped
    expect(exports.normalFn).not.toBe(async function normalFn() {})
  })

  it('returns non-object exports unchanged', () => {
    const { tracer } = createSimpleProvider()
    expect(wrapModuleExports(null as any, 'x', tracer)).toBeNull()
    expect(wrapModuleExports('str' as any, 'x', tracer)).toBe('str')
  })

  it('ignores all exports when object rule has no exports list', () => {
    const { tracer } = createSimpleProvider()
    const fn = async function foo() {}
    const exports = { foo: fn }

    wrapModuleExports(exports, 'helpers/all-ignored', tracer, [
      { file: 'helpers/all-ignored' },
    ])
    expect(exports.foo).toBe(fn)
  })
})

describe('classInstrumentation', () => {
  afterEach(() => cleanupOtel())

  it('wraps async methods on class prototypes when classInstrumentation is provided', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class UserService {
      async findUser(id: number) {
        return { id, name: 'test' }
      }
      async deleteUser(id: number) {
        return true
      }
      syncMethod() {
        return 'sync'
      }
    }

    const exports = { UserService }
    wrapModuleExports(
      exports,
      'services/user',
      tracer,
      [],
      undefined,
      undefined,
      {},
    )

    const svc = new exports.UserService()
    await svc.findUser(1)
    await svc.deleteUser(2)
    svc.syncMethod()

    exporter.assertTotalSpanCount(2)
    exporter.assertSpanExists('UserService.findUser')
    exporter.assertSpanExists('UserService.deleteUser')
  })

  it('does not wrap classes when classInstrumentation is not provided', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class MyClass {
      async doWork() {
        return 'done'
      }
    }

    const exports = { MyClass }
    wrapModuleExports(exports, 'test/module', tracer)

    const obj = new exports.MyClass()
    await obj.doWork()

    exporter.assertTotalSpanCount(0)
  })

  it('filters classes with includeClass as string[]', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class UserService {
      async find() {
        return true
      }
    }
    class OtherService {
      async find() {
        return true
      }
    }

    const exports = { UserService, OtherService }
    wrapModuleExports(exports, 'services', tracer, [], undefined, undefined, {
      includeClass: ['UserService'],
    })

    const u = new exports.UserService()
    const o = new exports.OtherService()
    await u.find()
    await o.find()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('UserService.find')
  })

  it('filters classes with includeClass as RegExp', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class UserService {
      async find() {
        return true
      }
    }
    class UserHelper {
      async find() {
        return true
      }
    }

    const exports = { UserService, UserHelper }
    wrapModuleExports(exports, 'services', tracer, [], undefined, undefined, {
      includeClass: /Service$/,
    })

    await new exports.UserService().find()
    await new exports.UserHelper().find()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('UserService.find')
  })

  it('filters classes with includeClass as function', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class AllowedClass {
      async run() {
        return true
      }
    }
    class DeniedClass {
      async run() {
        return true
      }
    }

    const exports = { AllowedClass, DeniedClass }
    wrapModuleExports(exports, 'test/file', tracer, [], undefined, undefined, {
      includeClass: (name, _cls, filename) =>
        name === 'AllowedClass' && filename === 'test/file',
    })

    await new exports.AllowedClass().run()
    await new exports.DeniedClass().run()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('AllowedClass.run')
  })

  it('filters methods with includeMethod as string[]', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class Svc {
      async allowed() {
        return true
      }
      async denied() {
        return true
      }
    }

    const exports = { Svc }
    wrapModuleExports(exports, 'test', tracer, [], undefined, undefined, {
      includeMethod: ['allowed'],
    })

    const svc = new exports.Svc()
    await svc.allowed()
    await svc.denied()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('Svc.allowed')
  })

  it('filters methods with includeMethod as RegExp', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class Svc {
      async findUser() {
        return true
      }
      async _internal() {
        return true
      }
    }

    const exports = { Svc }
    wrapModuleExports(exports, 'test', tracer, [], undefined, undefined, {
      includeMethod: /^[^_]/,
    })

    const svc = new exports.Svc()
    await svc.findUser()
    await svc._internal()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('Svc.findUser')
  })

  it('filters methods with includeMethod as function receiving filename', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class Svc {
      async find() {
        return true
      }
      async delete() {
        return true
      }
    }

    const exports = { Svc }
    wrapModuleExports(
      exports,
      'services/user',
      tracer,
      [],
      undefined,
      undefined,
      {
        includeMethod: (_method, _cls, _fn, filename) =>
          filename === 'services/user',
      },
    )

    const svc = new exports.Svc()
    await svc.find()
    await svc.delete()

    exporter.assertTotalSpanCount(2)
  })

  it('uses custom shouldWrap for class methods', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class Svc {
      fetchData() {
        return Promise.resolve('data')
      }
      syncMethod() {
        return 'sync'
      }
    }

    const exports = { Svc }
    wrapModuleExports(exports, 'test', tracer, [], undefined, undefined, {
      shouldWrap: (fn) => fn.name.startsWith('fetch'),
    })

    const svc = new exports.Svc()
    await svc.fetchData()
    svc.syncMethod()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('Svc.fetchData')
  })

  it('sets correct span attributes for class methods', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class UserService {
      async findUser() {
        return true
      }
    }

    const exports = { UserService }
    wrapModuleExports(
      exports,
      'services/user',
      tracer,
      [],
      undefined,
      undefined,
      {},
    )

    await new exports.UserService().findUser()

    exporter.assertSpanAttributes('UserService.findUser', {
      'opin_tel.code.type': 'method',
      'opin_tel.code.class': 'UserService',
      'opin_tel.code.method': 'findUser',
      'opin_tel.code.filename': 'services/user',
    })
  })
})

describe('functionInstrumentation', () => {
  afterEach(() => cleanupOtel())

  it('filters functions with include as string[]', async () => {
    const { tracer, exporter } = createSimpleProvider()
    const exports = {
      allowed: async function allowed() {
        return true
      },
      denied: async function denied() {
        return true
      },
    }

    wrapModuleExports(exports, 'test', tracer, [], undefined, {
      include: ['allowed'],
    })

    await exports.allowed()
    await exports.denied()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('allowed')
  })

  it('filters functions with include as RegExp', async () => {
    const { tracer, exporter } = createSimpleProvider()
    const exports = {
      handleRequest: async function handleRequest() {
        return true
      },
      _internal: async function _internal() {
        return true
      },
    }

    wrapModuleExports(exports, 'test', tracer, [], undefined, {
      include: /^handle/,
    })

    await exports.handleRequest()
    await exports._internal()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('handleRequest')
  })

  it('filters functions with include as function receiving filename', async () => {
    const { tracer, exporter } = createSimpleProvider()
    const exports = {
      fn: async function fn() {
        return true
      },
    }

    wrapModuleExports(exports, 'routes/api', tracer, [], undefined, {
      include: (_name, _fn, filename) => filename.startsWith('routes/'),
    })

    await exports.fn()
    exporter.assertTotalSpanCount(1)
  })

  it('uses custom shouldWrap for functions', async () => {
    const { tracer, exporter } = createSimpleProvider()
    const exports = {
      fetchData: function fetchData() {
        return Promise.resolve('data')
      },
      syncFn: function syncFn() {
        return 'sync'
      },
    }

    wrapModuleExports(exports, 'test', tracer, [], undefined, {
      shouldWrap: (fn) => fn.name.startsWith('fetch'),
    })

    await exports.fetchData()
    exports.syncFn()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('fetchData')
  })

  it('does not affect class exports when only functionInstrumentation is set', async () => {
    const { tracer, exporter } = createSimpleProvider()

    class Svc {
      async run() {
        return true
      }
    }

    const exports = {
      Svc,
      fn: async function fn() {
        return true
      },
    }

    wrapModuleExports(exports, 'test', tracer, [], undefined, {})

    await exports.fn()
    await new exports.Svc().run()

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('fn')
  })
})

describe('defaultShouldWrap', () => {
  it('returns true for async functions', () => {
    expect(defaultShouldWrap(async function test() {}, 'test', 'file')).toBe(
      true,
    )
  })

  it('returns false for sync functions', () => {
    expect(defaultShouldWrap(function test() {}, 'test', 'file')).toBe(false)
  })

  it('returns false for arrow functions', () => {
    expect(defaultShouldWrap(() => {}, 'test', 'file')).toBe(false)
  })
})

describe('wrapFunction sync return', () => {
  afterEach(() => cleanupOtel())

  it('wraps a sync function and ends the span on return', () => {
    const { tracer, exporter } = createSimpleProvider()
    const original = function syncReturn(x: number) {
      return x + 1
    }
    const wrapped = wrapFunction(
      original,
      'syncReturn',
      { type: 'function', fnName: 'syncReturn', filename: 'test/file' },
      tracer,
    )

    const result = wrapped(5)
    expect(result).toBe(6)

    exporter.assertTotalSpanCount(1)
    exporter.assertSpanExists('syncReturn')
  })

  it('uses "anonymous" for unnamed functions', () => {
    const { tracer } = createSimpleProvider()
    const wrapped = wrapFunction(
      async () => 'hi',
      'test',
      { type: 'function', fnName: 'test', filename: 'file' },
      tracer,
    )
    // Arrow functions have empty name, should fall back to 'anonymous'
    expect(wrapped.name).toBe('anonymous')
  })
})
