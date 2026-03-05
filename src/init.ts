import debugLib from 'debug'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { trace } from '@opentelemetry/api'
import { FilteringSpanProcessor } from './filtering-span-processor.js'
import { OpinionatedInstrumentation } from './opinionated-instrumentation.js'
import type { OpinionatedTelemetryConfig } from './types.js'

/** Honeycomb-friendly defaults */
const DEFAULT_SPAN_LIMITS = {
  attributeCountLimit: 2000,
  attributeValueLengthLimit: 65536,
  eventCountLimit: Infinity,
  linkCountLimit: Infinity,
  attributePerEventCountLimit: 2000,
  attributePerLinkCountLimit: 2000,
}

const debug = debugLib('opin-tel:init')

export function opinionatedTelemetryInit(config: OpinionatedTelemetryConfig) {
  const {
    serviceName,
    resourceAttributes = {},
    traceExporter,
    metricReader,
    spanLimits = DEFAULT_SPAN_LIMITS,
    dropSyncSpans = true,
    enableReparenting = true,
    baggageToAttributes = true,
    onSpanAfterShutdown,
    shutdownSignal = 'SIGTERM',
    instrumentations,
    additionalSpanProcessors = [],
  } = config

  debug('initializing service=%s', serviceName)

  // Unwrap OpinionatedInstrumentation instances for NodeSDK
  // (their constructors already registered in the static registry)
  const unwrappedInstrumentations = instrumentations.map((inst) => {
    if (inst instanceof OpinionatedInstrumentation) {
      debug(
        'registered opinionated instrumentation: %s (reparent=%s)',
        inst.instrumentation.instrumentationName,
        !!inst.options.reparent,
      )
      return inst.instrumentation
    }
    return inst
  })

  // Build span processors
  const spanProcessors = [...additionalSpanProcessors]
  if (traceExporter) {
    const batchProcessor = new BatchSpanProcessor(traceExporter)
    const filteringProcessor = new FilteringSpanProcessor(batchProcessor, {
      dropSyncSpans,
      enableReparenting,
      baggageToAttributes,
      onSpanAfterShutdown,
    })
    spanProcessors.push(filteringProcessor)
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...resourceAttributes,
    }),
    spanLimits,
    spanProcessors,
    ...(metricReader ? { metricReader } : {}),
    instrumentations: unwrappedInstrumentations,
  })

  sdk.start()
  debug(
    'sdk started (dropSyncSpans=%s, reparenting=%s, baggageToAttributes=%s)',
    !!dropSyncSpans,
    enableReparenting,
    baggageToAttributes,
  )

  const shutdown = () =>
    sdk.shutdown().catch((err) => console.error('OTel SDK shutdown error', err))

  if (shutdownSignal) {
    debug('registering shutdown on %s', shutdownSignal)
    process.on(shutdownSignal, shutdown)
  }

  return {
    sdk,
    getTracer: (name = serviceName) => trace.getTracer(name),
    shutdown,
  }
}
