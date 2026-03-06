import { context, trace } from '@opentelemetry/api'
import debugLib from 'debug'
import { withBaggage } from '../baggage.js'

const debug = debugLib('opin_tel:graphql')

export interface ShouldWrapResolverInfo {
  field: any
  fieldName: string
  type: any
  typeName: string
  resolver: (...args: any[]) => any
}

export interface GraphqlOtelConfig {
  /** The default field resolver from graphql (i.e. graphql.defaultFieldResolver). Required. */
  fieldResolver: (...args: any[]) => any
  /** Optional filter for which resolvers to wrap. Return false to skip. Default: wraps all custom resolvers. */
  shouldWrapResolver?: (info: ShouldWrapResolverInfo) => boolean
}

/**
 * Walks all object types in a GraphQL schema and wraps custom resolve functions
 * with OTel context propagation. Skips fields using the default resolver.
 *
 * For each wrapped resolver, sets baggage with the current graphql attributes
 * from the active span, making them available to all child spans.
 */
export function otelInitGraphql(schema: any, config: GraphqlOtelConfig): void {
  const { fieldResolver, shouldWrapResolver } = config

  // Cache extracted graphql.* attrs per span — shared across all wrapped fields
  // so the attribute scan happens at most once per span regardless of field count
  const spanAttrs = new WeakMap<any, Record<string, any>>()

  const typeMap = schema.getTypeMap()
  for (const [typeName, type] of Object.entries(typeMap)) {
    if (typeName.startsWith('__')) continue
    if (!type || typeof (type as any).getFields !== 'function') continue

    const fields = (type as any).getFields()
    for (const [fieldName, field] of Object.entries<any>(fields)) {
      const originalResolve = field.resolve
      if (!originalResolve || originalResolve === fieldResolver) {
        continue
      }

      if (
        shouldWrapResolver &&
        !shouldWrapResolver({
          field,
          fieldName,
          type,
          typeName,
          resolver: originalResolve,
        })
      ) {
        debug(
          'skipping %s.%s (shouldWrapResolver returned false)',
          typeName,
          fieldName,
        )
        continue
      }

      debug('wrapping %s.%s', typeName, fieldName)
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
