import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { SpanImpl, isSpanImplLike } from '../../src/utils.js'
import { createSimpleProvider } from '../helpers.js'

const require = createRequire(import.meta.url)

describe('SpanImpl import', () => {
  it('resolves to a usable constructor', () => {
    expect(typeof SpanImpl).toBe('function')
    expect(SpanImpl.name).toBe('SpanImpl')
  })

  it('is the class the installed SDK actually builds spans from', () => {
    const { tracer } = createSimpleProvider()
    const span = tracer.startSpan('probe')
    span.end()
    expect(span).toBeInstanceOf(SpanImpl)
    expect(isSpanImplLike(span)).toBe(true)
  })

  it('comes from a package this one depends on directly', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    expect(pkg.dependencies).toHaveProperty('@opentelemetry/sdk-trace')

    const declared = require('@opentelemetry/sdk-trace/package.json').version
    const viaBase =
      require('@opentelemetry/sdk-trace-base/package.json').version
    expect(declared).toBe(viaBase)
  })
})
