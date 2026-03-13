import { context, propagation } from '@opentelemetry/api'

const { createBaggage, setBaggage, getActiveBaggage } = propagation

/**
 * Sets baggage entries on the current context and runs fn inside it.
 * Returns whatever fn returns.
 *
 * Usage: withBaggage({ 'app.account_id': '123' }, () => { ... })
 */
export function withBaggage<T>(
  entries: Record<string, unknown>,
  fn: () => T,
): T {
  const currentBaggage = getActiveBaggage() || createBaggage()
  let updated = currentBaggage
  for (const [key, value] of Object.entries(entries)) {
    if (value != null) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      updated = updated.setEntry(key, { value: String(value) })
    }
  }
  return context.with(setBaggage(context.active(), updated), fn)
}

/**
 * Gets a single baggage value from the active context.
 */
export function getBaggageValue(key: string): string | undefined {
  const baggage = getActiveBaggage()
  return baggage?.getEntry(key)?.value
}
