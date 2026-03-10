import {
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  propagation,
  trace,
} from '@opentelemetry/api'
import { W3CBaggagePropagator } from '@opentelemetry/core'
import { ATTR_SERVER_ADDRESS } from '@opentelemetry/semantic-conventions'
import type { BaggagePropagationConfig } from './types.js'

type HostMatcher = (host: string) => boolean
type KeyMatcher = (key: string) => boolean

function compileHostMatcher(pattern: string): HostMatcher {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // e.g. ".example.com"
    return (host) => host.endsWith(suffix) || host === pattern.slice(2)
  }
  return (host) => host === pattern
}

function compileKeyMatcher(pattern: string): KeyMatcher {
  if (pattern === '*') return () => true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1) // e.g. "app."
    return (key) => key.startsWith(prefix)
  }
  return (key) => key === pattern
}

export class FilteredBaggagePropagator implements TextMapPropagator {
  private inner = new W3CBaggagePropagator()
  private hostMatchers: HostMatcher[]
  private keyMatchers: KeyMatcher[]

  constructor(config: BaggagePropagationConfig = {}) {
    this.hostMatchers = (config.allowedHosts ?? []).map(compileHostMatcher)
    this.keyMatchers = (config.allowedKeys ?? []).map(compileKeyMatcher)
  }

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    // No allowed hosts = suppress all outbound baggage
    if (this.hostMatchers.length === 0) return

    // Get destination host from the active span's server.address attribute
    const span = trace.getSpan(context)
    if (!span) return

    // ReadableSpan has attributes, but the Span interface doesn't expose them.
    // However, instrumentation-http sets attributes before inject, and we can
    // read them via the underlying ReadableSpan if available.
    const readable = span as unknown as { attributes?: Record<string, unknown> }
    const serverAddress = readable.attributes?.[ATTR_SERVER_ADDRESS]
    if (typeof serverAddress !== 'string') return

    // Check host against allowed patterns
    const hostAllowed = this.hostMatchers.some((m) => m(serverAddress))
    if (!hostAllowed) return

    // No allowed keys = suppress all outbound baggage
    if (this.keyMatchers.length === 0) return

    // Filter baggage entries by allowed keys
    const baggage = propagation.getBaggage(context)
    if (!baggage) return

    const keyMatchers = this.keyMatchers
    let filtered = propagation.createBaggage()
    for (const [key, entry] of baggage.getAllEntries()) {
      if (keyMatchers.some((m) => m(key))) {
        filtered = filtered.setEntry(key, entry)
      }
    }

    const filteredCtx = propagation.setBaggage(context, filtered)
    this.inner.inject(filteredCtx, carrier, setter)
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    // Always extract inbound baggage
    return this.inner.extract(context, carrier, getter)
  }

  fields(): string[] {
    return this.inner.fields()
  }
}
