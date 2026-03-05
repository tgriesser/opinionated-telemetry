import { context, propagation } from '@opentelemetry/api'
import type { Context } from '@opentelemetry/api'

const { createBaggage, setBaggage, getActiveBaggage } = propagation

/**
 * Sets baggage entries on the current context and returns the new context.
 * Usage: context.with(withBaggage({ 'app.account_id': '123' }), () => { ... })
 */
export function withBaggage(entries: Record<string, unknown>): Context {
  const currentBaggage = getActiveBaggage() || createBaggage()
  let updated = currentBaggage
  for (const [key, value] of Object.entries(entries)) {
    if (value != null) {
      updated = updated.setEntry(key, { value: String(value) })
    }
  }
  return setBaggage(context.active(), updated)
}

/**
 * Gets a single baggage value from the active context.
 */
export function getBaggageValue(key: string): string | undefined {
  const baggage = getActiveBaggage()
  return baggage?.getEntry(key)?.value
}
