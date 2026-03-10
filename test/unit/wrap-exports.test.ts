import { describe, it, expect, afterEach } from 'vitest'
import { wrapFunction, wrapModuleExports } from '../../src/wrap-exports.js'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

describe('wrapFunction', () => {
  afterEach(() => cleanupOtel())

  it('wraps an async function and creates a span', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const original = async function myFunc(x: number) {
      return x * 2
    }
    const wrapped = wrapFunction(original, 'myFunc', 'test/file', tracer)

    const result = await wrapped(21)
    expect(result).toBe(42)

    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBe(1)
    expect(spans[0].name).toBe('myFunc')
    expect(spans[0].attributes['opin_tel.code.function']).toBe('myFunc')
    expect(spans[0].attributes['opin_tel.code.filename']).toBe('test/file')
  })

  it('preserves function name', () => {
    const { tracer } = createSimpleProvider()
    const original = async function namedFn() {}
    const wrapped = wrapFunction(original, 'namedFn', 'file', tracer)
    expect(wrapped.name).toBe('namedFn')
  })

  it('preserves function arity', () => {
    const { tracer } = createSimpleProvider()
    const original = async function threeArgs(_a: any, _b: any, _c: any) {}
    const wrapped = wrapFunction(original, 'threeArgs', 'file', tracer)
    expect(wrapped.length).toBe(3)
  })

  it('records errors on async rejection', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const original = async function failFn() {
      throw new Error('test error')
    }
    const wrapped = wrapFunction(original, 'failFn', 'file', tracer)

    await expect(wrapped()).rejects.toThrow('test error')

    const spans = exporter.getFinishedSpans()
    expect(spans[0].status.code).toBe(2) // ERROR
    expect(spans[0].status.message).toBe('test error')
  })

  it('records errors on sync throw', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const original = function syncFail() {
      throw new Error('sync error')
    }
    const wrapped = wrapFunction(original, 'syncFail', 'file', tracer)

    expect(() => wrapped()).toThrow('sync error')

    const spans = exporter.getFinishedSpans()
    expect(spans[0].status.code).toBe(2) // ERROR
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

    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBe(1)
    expect(spans[0].name).toBe('asyncFn')
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

    const spans = exporter.getFinishedSpans()
    expect(spans[0].name).toBe('myHandler')
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

describe('wrapFunction sync return', () => {
  afterEach(() => cleanupOtel())

  it('wraps a sync function and ends the span on return', () => {
    const { tracer, exporter } = createSimpleProvider()
    const original = function syncReturn(x: number) {
      return x + 1
    }
    const wrapped = wrapFunction(original, 'syncReturn', 'test/file', tracer)

    const result = wrapped(5)
    expect(result).toBe(6)

    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBe(1)
    expect(spans[0].name).toBe('syncReturn')
  })

  it('uses "anonymous" for unnamed functions', () => {
    const { tracer } = createSimpleProvider()
    const wrapped = wrapFunction(async () => 'hi', 'test', 'file', tracer)
    // Arrow functions have empty name, should fall back to 'anonymous'
    expect(wrapped.name).toBe('anonymous')
  })
})
