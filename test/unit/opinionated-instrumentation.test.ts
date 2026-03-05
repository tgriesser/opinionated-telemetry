import { describe, it, expect } from 'vitest'
import { OpinionatedInstrumentation } from '../../src/opinionated-instrumentation.js'

function createMockInstrumentation(name: string) {
  return {
    instrumentationName: name,
    instrumentationVersion: '1.0.0',
    setTracerProvider() {},
    setMeterProvider() {},
    getConfig() {
      return {}
    },
    setConfig() {},
    enable() {},
    disable() {},
  } as any
}

describe('OpinionatedInstrumentation', () => {
  it('wraps an instrumentation instance with options', () => {
    const inst = createMockInstrumentation('test-inst')
    const wrapped = new OpinionatedInstrumentation(inst, { reparent: true })

    expect(wrapped.instrumentation).toBe(inst)
    expect(wrapped.options.reparent).toBe(true)
  })

  it('defaults to empty options when none provided', () => {
    const inst = createMockInstrumentation('test-no-opts')
    const wrapped = new OpinionatedInstrumentation(inst)

    expect(wrapped.options).toEqual({})
  })

  it('registers options in the static registry', () => {
    const opts = { reparent: true, onStart: () => {} }
    const inst = createMockInstrumentation('test-registry')
    new OpinionatedInstrumentation(inst, opts)

    expect(OpinionatedInstrumentation.getOptions('test-registry')).toBe(opts)
    expect(OpinionatedInstrumentation.hasOptions('test-registry')).toBe(true)
  })

  it('returns undefined for unregistered scopes', () => {
    expect(OpinionatedInstrumentation.getOptions('nonexistent')).toBeUndefined()
    expect(OpinionatedInstrumentation.hasOptions('nonexistent')).toBe(false)
  })

  it('getAllOptions returns all registered entries', () => {
    const inst = createMockInstrumentation('test-all-opts')
    new OpinionatedInstrumentation(inst, { reparent: true })

    const all = OpinionatedInstrumentation.getAllOptions()
    expect(all.has('test-all-opts')).toBe(true)
  })
})
