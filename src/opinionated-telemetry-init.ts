import debugLib from 'debug'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { trace } from '@opentelemetry/api'
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core'
import { FilteringSpanProcessor } from './filtering-span-processor.js'
import { FilteredBaggagePropagator } from './filtered-baggage-propagator.js'
import type { OpinionatedTelemetryConfig } from './types.js'

/** Opinionated BatchSpanProcessor defaults: flush more frequently, shorter timeout */
const DEFAULT_BATCH_CONFIG = {
  scheduledDelayMillis: 2000,
  exportTimeoutMillis: 10000,
}

/** Honeycomb-friendly defaults */
const DEFAULT_SPAN_LIMITS = {
  attributeCountLimit: 2000,
  attributeValueLengthLimit: 65536,
  eventCountLimit: Infinity,
  linkCountLimit: Infinity,
  attributePerEventCountLimit: 2000,
  attributePerLinkCountLimit: 2000,
}

const debug = debugLib('opin_tel:init')

export function opinionatedTelemetryInit(config: OpinionatedTelemetryConfig) {
  const {
    serviceName,
    resourceAttributes = {},
    traceExporter,
    metricReaders,
    resourceDetectors,
    spanLimits = DEFAULT_SPAN_LIMITS,
    shutdownSignal = 'SIGTERM',
    instrumentations,
    additionalSpanProcessors = [],
    batchProcessorConfig,
    baggagePropagation,
    views,
    ...processorConfig
  } = config

  const logger = processorConfig.logger ?? console

  debug('initializing service=%s', serviceName)

  // Warn about instrumentationHooks that don't match any instrumentation
  if (processorConfig.instrumentationHooks) {
    const instrumentationNames = new Set(
      instrumentations.map((inst) => inst.instrumentationName),
    )
    for (const hookName of Object.keys(processorConfig.instrumentationHooks)) {
      if (!instrumentationNames.has(hookName)) {
        logger.warn(
          `[opin_tel] instrumentationHooks key "${hookName}" does not match any registered instrumentation`,
        )
      }
    }
  }

  const exportProcessor =
    batchProcessorConfig === false
      ? new SimpleSpanProcessor(traceExporter)
      : new BatchSpanProcessor(traceExporter, {
          ...DEFAULT_BATCH_CONFIG,
          ...batchProcessorConfig,
        })

  const filteringProcessor = new FilteringSpanProcessor(
    exportProcessor,
    processorConfig,
  )
  const spanProcessors = [...additionalSpanProcessors, filteringProcessor]

  if (process.env.OTEL_PROPAGATORS) {
    logger.warn(
      '[opin_tel] OTEL_PROPAGATORS env var is set — the filtered baggage propagator will not be active. ' +
        'Remove OTEL_PROPAGATORS to use the default safe baggage filtering.',
    )
  }

  const textMapPropagator = new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new FilteredBaggagePropagator(baggagePropagation),
    ],
  })

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...resourceAttributes,
    }),
    resourceDetectors,
    spanLimits,
    spanProcessors,
    textMapPropagator,
    metricReaders,
    instrumentations,
    views,
  })

  sdk.start()

  debug(
    'sdk started (dropSyncSpans=%s, baggageToAttributes=%s)',
    !!(processorConfig.dropSyncSpans ?? true),
    processorConfig.baggageToAttributes ?? true,
  )

  const shutdown = () =>
    sdk.shutdown().catch((err) => console.error('OTel SDK shutdown error', err))

  if (shutdownSignal) {
    debug('registering shutdown on %s', shutdownSignal)
    process.on(shutdownSignal, () => void shutdown())
  }

  return {
    sdk,
    getTracer: (name = serviceName) => trace.getTracer(name),
    shutdown,
  }
}
