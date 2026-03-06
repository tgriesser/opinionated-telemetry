import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createAutoInstrumentHookCJS } from '../../src/auto-instrument-hook.js'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

let tmpDir: string
let originalLoad: any

beforeEach(() => {
  // Save the original Module._load before each test so we can restore it
  originalLoad = (Module as any)._load
  // Use realpathSync to resolve macOS /var -> /private/var symlink,
  // so paths match what Module._resolveFilename returns.
  tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'otel-hook-test-')),
  )
})

afterEach(() => {
  // Restore original Module._load to prevent test pollution
  ;(Module as any)._load = originalLoad
  cleanupOtel()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

/**
 * Write a CJS module file in the temp directory and return its absolute path.
 */
function writeTempModule(relativePath: string, content: string): string {
  const fullPath = path.join(tmpDir, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

describe('createAutoInstrumentHookCJS', () => {
  it('patches Module._load', () => {
    const { tracer } = createSimpleProvider()

    createAutoInstrumentHookCJS({
      tracer,
      instrumentPaths: [{ base: tmpDir, dirs: ['src'] }],
    })

    expect((Module as any)._load).not.toBe(originalLoad)
    expect((Module as any)._load.name).toBe('otelInstrumentedLoad')
  })

  it('wraps async exports from a matched module with spans', async () => {
    const { tracer, getSpans, shutdown } = createSimpleProvider()

    const srcDir = path.join(tmpDir, 'src')
    writeTempModule(
      'src/service.js',
      `
      exports.doWork = async function doWork() { return 'done' }
      exports.syncHelper = function syncHelper() { return 'sync' }
      exports.value = 42
    `,
    )

    createAutoInstrumentHookCJS({
      tracer,
      instrumentPaths: [{ base: tmpDir, dirs: ['src'] }],
    })

    // Use eval('require') to actually go through Module._load in CJS
    const mod = eval('require')(path.join(srcDir, 'service.js'))

    // Async export should be wrapped
    const result = await mod.doWork()
    expect(result).toBe('done')

    // Sync export should be unchanged
    expect(mod.syncHelper()).toBe('sync')

    // Non-function export should be unchanged
    expect(mod.value).toBe(42)

    await shutdown()
    const spans = getSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('doWork')
    expect(spans[0].attributes['opin_tel.code.filename']).toBe('src/service')
  })

  it('does not wrap exports from a non-matching module', async () => {
    const { tracer, getSpans, shutdown } = createSimpleProvider()

    writeTempModule(
      'other/utils.js',
      `
      exports.fetchData = async function fetchData() { return 'data' }
    `,
    )

    createAutoInstrumentHookCJS({
      tracer,
      // Only matching "src" dir, not "other"
      instrumentPaths: [{ base: tmpDir, dirs: ['src'] }],
    })

    const mod = eval('require')(path.join(tmpDir, 'other', 'utils.js'))
    const result = await mod.fetchData()
    expect(result).toBe('data')

    await shutdown()
    const spans = getSpans()
    expect(spans).toHaveLength(0)
  })

  it('respects string ignoreRules — ignores entire file', async () => {
    const { tracer, getSpans, shutdown } = createSimpleProvider()

    writeTempModule(
      'src/ignored.js',
      `
      exports.work = async function work() { return 'ok' }
    `,
    )
    writeTempModule(
      'src/tracked.js',
      `
      exports.work = async function work() { return 'ok' }
    `,
    )

    createAutoInstrumentHookCJS({
      tracer,
      instrumentPaths: [{ base: tmpDir, dirs: ['src'] }],
      ignoreRules: ['src/ignored'],
    })

    const ignored = eval('require')(path.join(tmpDir, 'src', 'ignored.js'))
    const tracked = eval('require')(path.join(tmpDir, 'src', 'tracked.js'))

    await ignored.work()
    await tracked.work()

    await shutdown()
    const spans = getSpans()
    // Only the tracked module should produce a span
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes['opin_tel.code.filename']).toBe('src/tracked')
  })

  it('respects object ignoreRules — ignores specific exports', async () => {
    const { tracer, getSpans, shutdown } = createSimpleProvider()

    writeTempModule(
      'src/mixed.js',
      `
      exports.allowed = async function allowed() { return 'yes' }
      exports.blocked = async function blocked() { return 'no' }
    `,
    )

    createAutoInstrumentHookCJS({
      tracer,
      instrumentPaths: [{ base: tmpDir, dirs: ['src'] }],
      ignoreRules: [{ file: 'src/mixed', exports: ['blocked'] }],
    })

    const mod = eval('require')(path.join(tmpDir, 'src', 'mixed.js'))

    await mod.allowed()
    await mod.blocked()

    await shutdown()
    const spans = getSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('allowed')
  })

  it('restoring Module._load prevents further wrapping', async () => {
    const { tracer, getSpans, shutdown } = createSimpleProvider()

    writeTempModule(
      'src/before.js',
      `exports.fn = async function fn() { return 'before' }`,
    )
    writeTempModule(
      'src/after.js',
      `exports.fn = async function fn() { return 'after' }`,
    )

    createAutoInstrumentHookCJS({
      tracer,
      instrumentPaths: [{ base: tmpDir, dirs: ['src'] }],
    })

    // Load a module while hook is active
    const before = eval('require')(path.join(tmpDir, 'src', 'before.js'))
    await before.fn()

    // Restore original _load
    ;(Module as any)._load = originalLoad

    // Clear require cache so the next require goes through _load
    delete eval('require').cache[
      eval('require').resolve(path.join(tmpDir, 'src', 'after.js'))
    ]
    const after = eval('require')(path.join(tmpDir, 'src', 'after.js'))
    await after.fn()

    await shutdown()
    const spans = getSpans()
    // Only the "before" module should have produced a span
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes['opin_tel.code.filename']).toBe('src/before')
  })
})
