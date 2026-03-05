import { context, trace } from '@opentelemetry/api'
import debugLib from 'debug'
import { withBaggage } from '../baggage.js'

const debug = debugLib('opin-tel:graphql')

export interface GraphqlOtelConfig {
  /** Custom field resolver to compare against (instead of graphql's defaultFieldResolver) */
  fieldResolver?: (...args: any[]) => any
}

/**
 * Walks all object types in a GraphQL schema and wraps custom resolve functions
 * with OTel context propagation. Skips fields using the default resolver.
 *
 * For each wrapped resolver, sets baggage with the current graphql attributes
 * from the active span, making them available to all child spans.
 */
export function otelInitGraphql(schema: any, config?: GraphqlOtelConfig): void {
  let defaultResolver: ((...args: any[]) => any) | undefined
  if (config?.fieldResolver) {
    defaultResolver = config.fieldResolver
  } else {
    try {
      // Dynamic import to avoid hard dep on graphql
      const graphql = require('graphql')
      defaultResolver = graphql.defaultFieldResolver
    } catch {
      debug('graphql module not found, skipping resolver wrapping')
      return
    }
  }

  const typeMap = schema.getTypeMap()
  for (const [typeName, type] of Object.entries(typeMap)) {
    if (typeName.startsWith('__')) continue
    if (!type || typeof (type as any).getFields !== 'function') continue

    const fields = (type as any).getFields()
    for (const [, field] of Object.entries<any>(fields)) {
      const originalResolve = field.resolve
      if (!originalResolve || originalResolve === defaultResolver) {
        continue
      }

      debug('wrapping %s.%s', typeName, field.name)
      const spanAttrs = new WeakMap<any, Record<string, any>>()
      field.resolve = function otelWrappedResolver(
        source: any,
        args: any,
        ctx: any,
        info: any,
      ) {
        const span = trace.getActiveSpan()
        if (!span) {
          return originalResolve.call(this, source, args, ctx, info)
        }

        let asBaggage = spanAttrs.get(span)
        if (!asBaggage) {
          const attrs = (span as any).attributes ?? {}
          asBaggage = {}
          for (const [key, val] of Object.entries(attrs)) {
            if (key.startsWith('graphql')) {
              asBaggage[key] = val
            }
          }
          spanAttrs.set(span, asBaggage)
        }

        return context.with(withBaggage(asBaggage), () =>
          originalResolve.call(this, source, args, ctx, info),
        )
      }
    }
  }
}
