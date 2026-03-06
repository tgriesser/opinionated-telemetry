import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { propagation } from '@opentelemetry/api'
import { withBaggage, getBaggageValue } from '../../src/baggage.js'
import { cleanupOtel, setupOtel } from '../helpers.js'

describe('baggage', () => {
  beforeEach(() => setupOtel())
  afterEach(() => cleanupOtel())

  describe('withBaggage', () => {
    it('runs fn with baggage entries on the context', () => {
      withBaggage({ 'app.id': '123', 'app.name': 'test' }, () => {
        const baggage = propagation.getActiveBaggage()
        expect(baggage).toBeDefined()
        expect(baggage!.getEntry('app.id')?.value).toBe('123')
        expect(baggage!.getEntry('app.name')?.value).toBe('test')
      })
    })

    it('converts non-string values to strings', () => {
      withBaggage({ count: 42, flag: true }, () => {
        const baggage = propagation.getActiveBaggage()
        expect(baggage!.getEntry('count')?.value).toBe('42')
        expect(baggage!.getEntry('flag')?.value).toBe('true')
      })
    })

    it('skips null and undefined values', () => {
      withBaggage(
        { keep: 'yes', skip: null, also_skip: undefined },
        () => {
          const baggage = propagation.getActiveBaggage()
          expect(baggage!.getEntry('keep')?.value).toBe('yes')
          expect(baggage!.getEntry('skip')).toBeUndefined()
          expect(baggage!.getEntry('also_skip')).toBeUndefined()
        },
      )
    })

    it('merges with existing baggage in active context', () => {
      withBaggage({ a: '1' }, () => {
        withBaggage({ b: '2' }, () => {
          const baggage = propagation.getActiveBaggage()
          expect(baggage!.getEntry('a')?.value).toBe('1')
          expect(baggage!.getEntry('b')?.value).toBe('2')
        })
      })
    })

    it('returns the result of fn', () => {
      const result = withBaggage({ a: '1' }, () => 42)
      expect(result).toBe(42)
    })
  })

  describe('getBaggageValue', () => {
    it('returns undefined when no baggage is active', () => {
      expect(getBaggageValue('anything')).toBeUndefined()
    })

    it('reads baggage from the active context', () => {
      withBaggage({ 'app.id': '456' }, () => {
        expect(getBaggageValue('app.id')).toBe('456')
        expect(getBaggageValue('nonexistent')).toBeUndefined()
      })
    })
  })
})
