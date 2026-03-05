import { describe, it, expect, afterEach, vi } from 'vitest'
import { context, propagation, trace } from '@opentelemetry/api'
import express from 'express'
import supertest from 'supertest'
import { otelCreateExpressMiddleware } from '../../src/integrations/express.js'
import { cleanupOtel, createSimpleProvider } from '../helpers.js'

describe('otelCreateExpressMiddleware (real Express)', () => {
  afterEach(() => cleanupOtel())

  it('sets req.method and req.path on the span', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const app = express()

    // Simulate instrumentation-http by creating an active span
    app.use((req, res, next) => {
      tracer.startActiveSpan('http', (span) => {
        next()
        req.on('end', () => {
          span.end()
        })
      })
    })
    app.use(otelCreateExpressMiddleware())
    app.get('/api/test', (req, res) => {
      res.json({ ok: true })
    })

    await supertest(app).get('/api/test').expect(200)
    await provider.forceFlush()

    const spans = exporter.getFinishedSpans()
    const httpSpan = spans.find((s) => s.name === 'http')
    expect(httpSpan).toBeDefined()
    expect(httpSpan!.attributes['req.method']).toBe('GET')
    expect(httpSpan!.attributes['req.path']).toBe('/api/test')
  })

  it('captures whitelisted headers', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const app = express()

    app.use((req, res, next) => {
      tracer.startActiveSpan('http', (span) => {
        next()
        span.end()
      })
    })
    app.use(
      otelCreateExpressMiddleware({
        captureHeaders: ['user-agent', 'x-request-id'],
      }),
    )
    app.get('/test', (req, res) => {
      res.json({ ok: true })
    })

    await supertest(app).get('/test').set('x-request-id', 'req-123').expect(200)
    await provider.forceFlush()

    const httpSpan = exporter.getFinishedSpans().find((s) => s.name === 'http')
    expect(httpSpan!.attributes['req.header.x-request-id']).toBe('req-123')
    // authorization not in whitelist
    expect(httpSpan!.attributes['req.header.authorization']).toBeUndefined()
  })

  it('captures query params', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const app = express()

    app.use((req, res, next) => {
      tracer.startActiveSpan('http', (span) => {
        next()
        span.end()
      })
    })
    app.use(
      otelCreateExpressMiddleware({
        captureQueryParams: ['page', 'search'],
      }),
    )
    app.get('/test', (req, res) => {
      res.json({ ok: true })
    })

    await supertest(app)
      .get('/test?page=2&search=hello&secret=nope')
      .expect(200)
    await provider.forceFlush()

    const httpSpan = exporter.getFinishedSpans().find((s) => s.name === 'http')
    expect(httpSpan!.attributes['req.query.page']).toBe('2')
    expect(httpSpan!.attributes['req.query.search']).toBe('hello')
    expect(httpSpan!.attributes['req.query.secret']).toBeUndefined()
  })

  it('calls requestHook with helpers', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const app = express()

    app.use((req, res, next) => {
      tracer.startActiveSpan('http', (span) => {
        next()
        span.end()
      })
    })
    app.use(
      otelCreateExpressMiddleware({
        requestHook: (req, { setAttribute, setAsBaggage }) => {
          setAttribute('custom.attr', 'value')
          setAsBaggage('custom.baggage', 'bagged')
        },
      }),
    )
    app.get('/test', (req, res) => {
      res.json({ ok: true })
    })

    await supertest(app).get('/test').expect(200)
    await provider.forceFlush()

    const httpSpan = exporter.getFinishedSpans().find((s) => s.name === 'http')
    expect(httpSpan!.attributes['custom.attr']).toBe('value')
    expect(httpSpan!.attributes['custom.baggage']).toBe('bagged')
  })

  it('skips everything when disabled', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const app = express()

    app.use((req, res, next) => {
      tracer.startActiveSpan('http', (span) => {
        next()
        span.end()
      })
    })
    app.use(otelCreateExpressMiddleware({ enabled: false }))
    app.get('/test', (req, res) => {
      res.json({ ok: true })
    })

    await supertest(app).get('/test').expect(200)
    await provider.forceFlush()

    const httpSpan = exporter.getFinishedSpans().find((s) => s.name === 'http')
    expect(httpSpan!.attributes['req.method']).toBeUndefined()
  })

  it('wraps next in baggage context when baggage headers exist', async () => {
    const { tracer, exporter, provider } = createSimpleProvider()
    const app = express()
    let baggageSeen = false

    app.use((req, res, next) => {
      tracer.startActiveSpan('http', (span) => {
        next()
        span.end()
      })
    })
    app.use(
      otelCreateExpressMiddleware({
        captureHeaders: ['x-id'],
        baggageHeaders: ['x-id'],
      }),
    )
    app.get('/test', (req, res) => {
      const bag = propagation.getActiveBaggage()
      if (bag?.getEntry('req.header.x-id')?.value === '42') {
        baggageSeen = true
      }
      res.json({ ok: true })
    })

    await supertest(app).get('/test').set('x-id', '42').expect(200)

    expect(baggageSeen).toBe(true)
  })
})
