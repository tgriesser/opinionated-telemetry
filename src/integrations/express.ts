import { context, trace } from '@opentelemetry/api'
import { withBaggage } from '../baggage.js'

export interface ExpressOtelConfig {
  /** Headers to capture as span attributes (lowercase). */
  captureHeaders?: string[]
  /** Headers to also propagate as baggage. Must be a subset of captureHeaders. */
  baggageHeaders?: string[]
  /** Query params to capture as span attributes. */
  captureQueryParams?: string[]
  /** Query params to also propagate as baggage. Must be a subset of captureQueryParams. */
  baggageQueryParams?: string[]
  /**
   * Custom request hook for extracting additional attributes.
   * Called with the request and helpers for setting attributes/baggage.
   */
  requestHook?: (
    req: any,
    helpers: {
      setAttribute: (key: string, val: string | number | boolean) => void
      setAsBaggage: (key: string, val: string | number | boolean) => void
      span: any
    },
  ) => void
  /** Enable/disable the middleware. Default: true */
  enabled?: boolean
}

/**
 * Creates an Express middleware that enriches the active OTel span with
 * request metadata and propagates select values as baggage.
 */
export function otelCreateExpressMiddleware(config?: ExpressOtelConfig) {
  const {
    captureHeaders = [],
    baggageHeaders = [],
    captureQueryParams = [],
    baggageQueryParams = [],
    requestHook,
    enabled = true,
  } = config ?? {}

  const baggageHeaderSet = new Set(baggageHeaders)
  const baggageQuerySet = new Set(baggageQueryParams)

  return function expressOtelMiddleware(
    req: any,
    res: any,
    next: (...args: any[]) => void,
  ) {
    if (!enabled) return next()

    const span = trace.getActiveSpan()
    if (!span) return next()

    const baggageEntries: Record<string, unknown> = {}

    const setAttribute = (key: string, val: string | number | boolean) => {
      span.setAttribute(key, val)
    }

    const setAsBaggage = (key: string, val: string | number | boolean) => {
      baggageEntries[key] = val
      span.setAttribute(key, val)
    }

    // Capture request basics
    span.setAttribute('req.method', req.method)
    span.setAttribute('req.path', req.path)
    if (req.originalUrl !== req.path) {
      span.setAttribute('req.qs', req.originalUrl.slice(req.path.length))
    }

    // Capture headers
    for (const header of captureHeaders) {
      const val = req.headers?.[header]
      if (val) {
        if (baggageHeaderSet.has(header)) {
          setAsBaggage(`req.header.${header}`, String(val))
        } else {
          setAttribute(`req.header.${header}`, String(val))
        }
      }
    }

    // Capture query params
    if (req.query) {
      for (const key of captureQueryParams) {
        const val = req.query[key]
        if (val !== undefined) {
          if (baggageQuerySet.has(key)) {
            setAsBaggage(`req.query.${key}`, String(val))
          } else {
            setAttribute(`req.query.${key}`, String(val))
          }
        }
      }
    }

    // Custom request hook
    if (requestHook) {
      requestHook(req, { setAttribute, setAsBaggage, span })
    }

    // Set baggage and continue in that context
    if (Object.keys(baggageEntries).length > 0) {
      const ctx = withBaggage(baggageEntries)
      return context.with(ctx, () => next())
    }

    next()
  }
}
