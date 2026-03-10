import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  context,
  propagation,
  trace,
  ROOT_CONTEXT,
  defaultTextMapGetter,
  defaultTextMapSetter,
} from '@opentelemetry/api'
import { ATTR_SERVER_ADDRESS } from '@opentelemetry/semantic-conventions'
import { W3CBaggagePropagator } from '@opentelemetry/core'
import { FilteredBaggagePropagator } from '../../src/filtered-baggage-propagator.js'
import { createSimpleProvider, cleanupOtel } from '../helpers.js'

function makeContextWithBaggageAndSpan(
  tracer: ReturnType<typeof createSimpleProvider>['tracer'],
  serverAddress: string | undefined,
  baggageEntries: Record<string, string>,
) {
  let ctx = ROOT_CONTEXT

  // Set baggage
  let baggage = propagation.createBaggage()
  for (const [key, value] of Object.entries(baggageEntries)) {
    baggage = baggage.setEntry(key, { value })
  }
  ctx = propagation.setBaggage(ctx, baggage)

  // Create span with server.address attribute
  if (serverAddress !== undefined) {
    const span = tracer.startSpan(
      'test-client',
      { attributes: { [ATTR_SERVER_ADDRESS]: serverAddress } },
      ctx,
    )
    ctx = trace.setSpan(ctx, span)
  }

  return ctx
}

describe('FilteredBaggagePropagator', () => {
  let tp: ReturnType<typeof createSimpleProvider>

  beforeEach(() => {
    tp = createSimpleProvider()
  })

  afterEach(() => {
    cleanupOtel()
  })

  describe('inject', () => {
    it('suppresses all baggage by default (no config)', () => {
      const propagator = new FilteredBaggagePropagator()
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(tp.tracer, 'api.example.com', {
        userId: '123',
        tenantId: 'acme',
      })

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('suppresses baggage when allowedHosts is empty', () => {
      const propagator = new FilteredBaggagePropagator({ allowedHosts: [] })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(tp.tracer, 'api.example.com', {
        userId: '123',
      })

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('suppresses baggage when allowedKeys is empty', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['api.example.com'],
        allowedKeys: [],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(tp.tracer, 'api.example.com', {
        userId: '123',
      })

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('suppresses baggage when allowedKeys is omitted (default)', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['api.example.com'],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(tp.tracer, 'api.example.com', {
        userId: '123',
      })

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('allows all keys with wildcard "*"', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['api.example.com'],
        allowedKeys: ['*'],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(tp.tracer, 'api.example.com', {
        userId: '123',
        tenantId: 'acme',
      })

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeDefined()
      expect(carrier.baggage).toContain('userId=123')
      expect(carrier.baggage).toContain('tenantId=acme')
    })

    it('injects baggage when host matches an exact allowedHosts entry', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['api.internal.example.com'],
        allowedKeys: ['*'],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(
        tp.tracer,
        'api.internal.example.com',
        { userId: '123', tenantId: 'acme' },
      )

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeDefined()
      expect(carrier.baggage).toContain('userId=123')
      expect(carrier.baggage).toContain('tenantId=acme')
    })

    it('suppresses baggage when host does not match', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['api.internal.example.com'],
        allowedKeys: ['*'],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(
        tp.tracer,
        'external-api.example.com',
        { userId: '123' },
      )

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('supports wildcard host patterns (*.example.com)', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['*.example.com'],
        allowedKeys: ['*'],
      })
      const carrier1: Record<string, string> = {}
      const carrier2: Record<string, string> = {}
      const carrier3: Record<string, string> = {}

      // Subdomain match
      propagator.inject(
        makeContextWithBaggageAndSpan(tp.tracer, 'api.example.com', {
          k: 'v',
        }),
        carrier1,
        defaultTextMapSetter,
      )
      expect(carrier1.baggage).toBeDefined()

      // Bare domain also matches
      propagator.inject(
        makeContextWithBaggageAndSpan(tp.tracer, 'example.com', { k: 'v' }),
        carrier2,
        defaultTextMapSetter,
      )
      expect(carrier2.baggage).toBeDefined()

      // Different domain does not match
      propagator.inject(
        makeContextWithBaggageAndSpan(tp.tracer, 'api.other.com', { k: 'v' }),
        carrier3,
        defaultTextMapSetter,
      )
      expect(carrier3.baggage).toBeUndefined()
    })

    it('suppresses baggage when there is no active span', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['*.example.com'],
        allowedKeys: ['*'],
      })
      const carrier: Record<string, string> = {}

      let ctx = ROOT_CONTEXT
      let baggage = propagation.createBaggage()
      baggage = baggage.setEntry('userId', { value: '123' })
      ctx = propagation.setBaggage(ctx, baggage)

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('suppresses baggage when span has no server.address attribute', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['*.example.com'],
        allowedKeys: ['*'],
      })
      const carrier: Record<string, string> = {}

      let ctx = ROOT_CONTEXT
      let baggage = propagation.createBaggage()
      baggage = baggage.setEntry('userId', { value: '123' })
      ctx = propagation.setBaggage(ctx, baggage)

      const span = tp.tracer.startSpan('test', {}, ctx)
      ctx = trace.setSpan(ctx, span)

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeUndefined()
    })

    it('filters baggage entries by allowedKeys', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['api.internal.example.com'],
        allowedKeys: ['requestId', 'env'],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(
        tp.tracer,
        'api.internal.example.com',
        { requestId: 'abc', env: 'prod', secretToken: 'should-not-leak' },
      )

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeDefined()
      expect(carrier.baggage).toContain('requestId=abc')
      expect(carrier.baggage).toContain('env=prod')
      expect(carrier.baggage).not.toContain('secretToken')
    })

    it('supports wildcard key patterns (app.*)', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['internal.example.com'],
        allowedKeys: ['app.*'],
      })
      const carrier: Record<string, string> = {}
      const ctx = makeContextWithBaggageAndSpan(
        tp.tracer,
        'internal.example.com',
        {
          'app.requestId': 'abc',
          'app.env': 'prod',
          userId: 'should-not-leak',
        },
      )

      propagator.inject(ctx, carrier, defaultTextMapSetter)

      expect(carrier.baggage).toBeDefined()
      expect(carrier.baggage).toContain('app.requestId=abc')
      expect(carrier.baggage).toContain('app.env=prod')
      expect(carrier.baggage).not.toContain('userId')
    })

    it('supports multiple allowedHosts patterns', () => {
      const propagator = new FilteredBaggagePropagator({
        allowedHosts: ['*.internal.example.com', 'special-host.other.com'],
        allowedKeys: ['*'],
      })

      const carrier1: Record<string, string> = {}
      propagator.inject(
        makeContextWithBaggageAndSpan(tp.tracer, 'api.internal.example.com', {
          k: 'v',
        }),
        carrier1,
        defaultTextMapSetter,
      )
      expect(carrier1.baggage).toBeDefined()

      const carrier2: Record<string, string> = {}
      propagator.inject(
        makeContextWithBaggageAndSpan(tp.tracer, 'special-host.other.com', {
          k: 'v',
        }),
        carrier2,
        defaultTextMapSetter,
      )
      expect(carrier2.baggage).toBeDefined()

      const carrier3: Record<string, string> = {}
      propagator.inject(
        makeContextWithBaggageAndSpan(tp.tracer, 'unknown.other.com', {
          k: 'v',
        }),
        carrier3,
        defaultTextMapSetter,
      )
      expect(carrier3.baggage).toBeUndefined()
    })
  })

  describe('extract', () => {
    it('always extracts inbound baggage regardless of config', () => {
      const propagator = new FilteredBaggagePropagator() // no allowed hosts
      const carrier = { baggage: 'userId=123,tenantId=acme' }

      const ctx = propagator.extract(
        ROOT_CONTEXT,
        carrier,
        defaultTextMapGetter,
      )

      const baggage = propagation.getBaggage(ctx)
      expect(baggage).toBeDefined()
      expect(baggage!.getEntry('userId')?.value).toBe('123')
      expect(baggage!.getEntry('tenantId')?.value).toBe('acme')
    })
  })

  describe('fields', () => {
    it('returns the baggage field name', () => {
      const propagator = new FilteredBaggagePropagator()
      expect(propagator.fields()).toEqual(['baggage'])
    })
  })
})
