import debugLib from 'debug'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { metrics, trace } from '@opentelemetry/api'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeRuntimeMetrics } from './node-runtime-metrics.js'
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core'
import { FilteringSpanProcessor } from './filtering-span-processor.js'
import { FilteredBaggagePropagator } from './filtered-baggage-propagator.js'
import {
  FilteringMetricExporter,
  dropMetrics,
} from './filtering-metric-exporter.js'
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
    metricExporter,
    metricExportInterval,
    metricFilter,
    resourceDetectors,
    spanLimits = DEFAULT_SPAN_LIMITS,
    shutdownSignal = 'SIGTERM',
    instrumentations,
    additionalSpanProcessors = [],
    batchProcessorConfig,
    baggagePropagation,
    processorMetrics,
    runtimeMetrics: runtimeMetricsConfig,
    views: userViews,
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

  // ── Metric pipeline ──
  if (metricExporter && metricReaders) {
    throw new Error(
      '[opin_tel] Cannot use both metricExporter and metricReaders. ' +
        'Use metricExporter for the simple path, or metricReaders for full control.',
    )
  }

  let views = userViews
  let finalMetricReaders = metricReaders

  if (metricFilter) {
    if (metricExporter) {
      // metricExporter path: always use FilteringMetricExporter for all patterns.
      // DROP views can be bypassed when other views (e.g. flatMetricExporterViews)
      // match the same instruments and create their own streams.
    } else {
      // metricReaders path: DROP views are the only option for string patterns
      const stringDrops = (metricFilter.drop ?? []).filter(
        (p): p is string => typeof p === 'string',
      )
      if (stringDrops.length) {
        views = [...(views ?? []), ...dropMetrics(...stringDrops)]
      }

      const hasNonStringPatterns =
        (metricFilter.allow?.length ?? 0) > 0 ||
        metricFilter.drop?.some((p) => typeof p !== 'string')

      if (hasNonStringPatterns) {
        logger.warn(
          '[opin_tel] metricFilter with RegExp/predicate patterns or allow requires metricExporter. ' +
            'String drop patterns have been applied as Views. Use metricExporter for full filtering.',
        )
      }
    }
  }

  if (metricExporter) {
    const hasFilter =
      (metricFilter?.drop?.length ?? 0) > 0 ||
      (metricFilter?.allow?.length ?? 0) > 0

    const exporter = hasFilter
      ? new FilteringMetricExporter({
          exporter: metricExporter,
          drop: metricFilter?.drop,
          allow: metricFilter?.allow,
        })
      : metricExporter

    finalMetricReaders = [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: metricExportInterval ?? 60_000,
      }),
    ]
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...resourceAttributes,
    }),
    resourceDetectors,
    spanLimits,
    spanProcessors,
    textMapPropagator,
    metricReaders: finalMetricReaders,
    instrumentations,
    views,
  })

  sdk.start()

  debug(
    'sdk started (dropSyncSpans=%s, baggageToAttributes=%s)',
    !!(processorConfig.dropSyncSpans ?? true),
    processorConfig.baggageToAttributes ?? true,
  )

  // Start runtime metrics AFTER sdk.start() so metrics.getMeter() returns
  // a real meter — the OTel metrics API has no proxy pattern, so getMeter()
  // before the global MeterProvider is registered returns a NoopMeter.
  let runtimeMetrics: NodeRuntimeMetrics | undefined
  if (runtimeMetricsConfig !== false) {
    runtimeMetrics = new NodeRuntimeMetrics(
      typeof runtimeMetricsConfig === 'object' ? runtimeMetricsConfig : {},
    )
    runtimeMetrics.start()
  }

  // Processor diagnostic metrics (active spans, tail buffer, throughput, drops)
  if (processorMetrics !== false) {
    filteringProcessor.registerMetrics(metrics.getMeter('opin_tel.processor'))
  }

  const shutdown = () => {
    runtimeMetrics?.stop()
    return sdk
      .shutdown()
      .catch((err) => console.error('OTel SDK shutdown error', err))
  }

  if (shutdownSignal) {
    debug('registering shutdown on %s', shutdownSignal)
    process.on(shutdownSignal, () => void shutdown())
  }

  return {
    sdk,
    runtimeMetrics,
    getTracer: (name = serviceName) => trace.getTracer(name),
    shutdown,
  }
}
