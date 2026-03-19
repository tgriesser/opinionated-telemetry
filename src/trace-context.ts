import { trace } from '@opentelemetry/api'
import type { AttributeValue, Span } from '@opentelemetry/api'

interface TraceContextProvider {
  setTraceContext(traceId: string, attrs: Record<string, AttributeValue>): void
  getRootSpan(traceId: string): Span | undefined
}

const _providers = new Set<TraceContextProvider>()

export function _registerProvider(provider: TraceContextProvider): void {
  _providers.add(provider)
}

export function _unregisterProvider(provider: TraceContextProvider): void {
  _providers.delete(provider)
}

/**
 * Set trace-level context attributes that will be applied to all spans in the trace.
 * Uses the active span's traceId. No-op if there is no active span or no processor is active.
 *
 * Attributes are merged additively — calling multiple times accumulates attributes.
 * Trace context attributes never overwrite existing span attributes (span-level takes precedence).
 *
 * When using tail-based sampling, trace context is applied retroactively to buffered spans
 * when the tail buffer flushes.
 *
 * @example
 * setTraceContext({ 'user.id': '123', 'user.role': 'admin' })
 */
export function setTraceContext(attrs: Record<string, AttributeValue>): void {
  const span = trace.getActiveSpan()
  if (!span || _providers.size === 0) return
  const traceId = span.spanContext().traceId
  for (const provider of _providers) {
    provider.setTraceContext(traceId, attrs)
  }
}

/**
 * Get the root span of the active trace. Returns undefined if there is no
 * active span, the root span has already ended, or no processor is active.
 *
 * Useful for enriching just the root span with information discovered deeper
 * in the trace (e.g. user identity after authentication middleware).
 *
 * @example
 * // In an auth middleware, after identifying the user:
 * const root = getRootSpan()
 * if (root) {
 *   root.setAttribute('user.id', userId)
 *   root.setAttribute('user.role', role)
 * }
 */
export function getRootSpan(): Span | undefined {
  const span = trace.getActiveSpan()
  if (!span || _providers.size === 0) return undefined
  const traceId = span.spanContext().traceId
  for (const provider of _providers) {
    const root = provider.getRootSpan(traceId)
    if (root) return root
  }
  return undefined
}
