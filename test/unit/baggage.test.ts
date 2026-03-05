import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { context, propagation } from '@opentelemetry/api'
import { withBaggage, getBaggageValue } from '../../src/baggage.js'
import { cleanupOtel, setupOtel } from '../helpers.js'

describe('baggage', () => {
  beforeEach(() => setupOtel())
  afterEach(() => cleanupOtel())

  describe('withBaggage', () => {
    it('creates a context with baggage entries', () => {
      const ctx = withBaggage({ 'app.id': '123', 'app.name': 'test' })
      const baggage = propagation.getBaggage(ctx)
      expect(baggage).toBeDefined()
      expect(baggage!.getEntry('app.id')?.value).toBe('123')
      expect(baggage!.getEntry('app.name')?.value).toBe('test')
    })

    it('converts non-string values to strings', () => {
      const ctx = withBaggage({ count: 42, flag: true })
      const baggage = propagation.getBaggage(ctx)
      expect(baggage!.getEntry('count')?.value).toBe('42')
      expect(baggage!.getEntry('flag')?.value).toBe('true')
    })

    it('skips null and undefined values', () => {
      const ctx = withBaggage({ keep: 'yes', skip: null, also_skip: undefined })
      const baggage = propagation.getBaggage(ctx)
      expect(baggage!.getEntry('keep')?.value).toBe('yes')
      expect(baggage!.getEntry('skip')).toBeUndefined()
      expect(baggage!.getEntry('also_skip')).toBeUndefined()
    })

    it('merges with existing baggage in active context', () => {
      const first = withBaggage({ a: '1' })
      context.with(first, () => {
        const second = withBaggage({ b: '2' })
        const baggage = propagation.getBaggage(second)
        expect(baggage!.getEntry('a')?.value).toBe('1')
        expect(baggage!.getEntry('b')?.value).toBe('2')
      })
    })
  })

  describe('getBaggageValue', () => {
    it('returns undefined when no baggage is active', () => {
      expect(getBaggageValue('anything')).toBeUndefined()
    })

    it('reads baggage from the active context', () => {
      const ctx = withBaggage({ 'app.id': '456' })
      context.with(ctx, () => {
        expect(getBaggageValue('app.id')).toBe('456')
        expect(getBaggageValue('nonexistent')).toBeUndefined()
      })
    })
  })
})
