import { describe, it, expect, afterEach } from 'vitest'
import { buildMatchers, matchPath } from '../../src/auto-instrument-matchers.js'
import { wrapModuleExports } from '../../src/wrap-exports.js'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

describe('ESM hook shared matchers', () => {
  describe('buildMatchers', () => {
    it('creates matchers from instrument paths', () => {
      const matchers = buildMatchers([
        { base: '/app', dirs: ['src/routes', 'src/services'] },
      ])
      expect(matchers).toHaveLength(2)
      expect(matchers[0].prefix).toBe('/app/src/routes/')
      expect(matchers[1].prefix).toBe('/app/src/services/')
    })

    it('handles multiple base paths', () => {
      const matchers = buildMatchers([
        { base: '/app', dirs: ['lib'] },
        { base: '/pkg', dirs: ['src'] },
      ])
      expect(matchers).toHaveLength(2)
      expect(matchers[0].prefix).toBe('/app/lib/')
      expect(matchers[1].prefix).toBe('/pkg/src/')
    })
  })

  describe('matchPath', () => {
    it('returns relative path for matching paths', () => {
      const matchers = buildMatchers([{ base: '/app', dirs: ['src/routes'] }])
      const result = matchPath('/app/src/routes/users.ts', matchers)
      expect(result).toBe('src/routes/users')
    })

    it('strips file extension', () => {
      const matchers = buildMatchers([{ base: '/app', dirs: ['src'] }])
      expect(matchPath('/app/src/handler.js', matchers)).toBe('src/handler')
      expect(matchPath('/app/src/handler.mjs', matchers)).toBe('src/handler')
    })

    it('returns null for non-matching paths', () => {
      const matchers = buildMatchers([{ base: '/app', dirs: ['src/routes'] }])
      expect(matchPath('/other/path/file.ts', matchers)).toBeNull()
    })

    it('handles nested paths', () => {
      const matchers = buildMatchers([{ base: '/app', dirs: ['src'] }])
      expect(matchPath('/app/src/deep/nested/file.ts', matchers)).toBe(
        'src/deep/nested/file',
      )
    })
  })
})

describe('wrapModuleExports on plain objects (ESM namespace simulation)', () => {
  afterEach(() => cleanupOtel())

  it('wraps async functions on a plain object', async () => {
    const { tracer, getSpans, shutdown } = createSimpleProvider()

    const ns = {
      asyncFn: async function asyncFn() {
        return 'result'
      },
      syncFn: function syncFn() {
        return 'sync'
      },
      value: 42,
    }

    wrapModuleExports(ns, 'test/esm-module', tracer)

    const result = await ns.asyncFn()
    expect(result).toBe('result')

    const spans = getSpans()
    expect(spans.length).toBe(1)
    expect(spans[0].name).toBe('asyncFn')
    expect(spans[0].attributes['code.filename']).toBe('test/esm-module')

    await shutdown()
  })
})
