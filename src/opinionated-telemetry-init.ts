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
import { ResourceFilteringMetricExporter } from './resource-filtering-metric-exporter.js'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { OpinionatedTelemetryConfig } from './types.js'

const RUNTIME_NODE_INSTRUMENTATION =
  '@opentelemetry/instrumentation-runtime-node'

/**
 * Disable and remove `instrumentation-runtime-node` from the list. Its
 * `nodejs.*` / `v8js.*` metrics duplicate the built-in `node.*` runtime metrics.
 * Removal (not just `disable()`) is required: `registerInstrumentations`
 * re-enables any instrumentation whose config is disabled when the SDK starts,
 * so the only way to keep it off is to never hand it to the SDK.
 */
function pruneRuntimeNodeInstrumentation(
  instrumentations: Instrumentation[],
  logger: { warn(msg: string): void },
  warn: boolean,
): Instrumentation[] {
  const flat = instrumentations.flat()
  const remaining = flat.filter(
    (inst) => inst.instrumentationName !== RUNTIME_NODE_INSTRUMENTATION,
  )
  if (remaining.length === flat.length) return instrumentations

  for (const inst of flat) {
    if (inst.instrumentationName === RUNTIME_NODE_INSTRUMENTATION) {
      inst.disable()
    }
  }
  // Only warn when we disabled it as a side effect (auto). An explicit
  // `disableRuntimeNodeInstrumentation: true` is an intentional opt-in — no nag.
  if (warn) {
    logger.warn(
      `[opin_tel] Disabled ${RUNTIME_NODE_INSTRUMENTATION}: its nodejs.*/v8js.* metrics ` +
        'duplicate the built-in node.* runtime metrics. Set runtimeMetrics:false to use it ' +
        'instead, or disableRuntimeNodeInstrumentation:false to keep both.',
    )
  }
  return remaining
}

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
    metricSources,
    metricResourceAttributes,
    disableRuntimeNodeInstrumentation,
    resourceDetectors,
    autoDetectResources,
    idGenerator,
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

  const runtimeMetricsEnabled =
    metricSources?.runtime !== false && runtimeMetricsConfig !== false

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

  // Source toggle: disabling http drops its instrument streams with zero
  // collection overhead (runtime/processor are stopped at the source below).
  if (metricSources?.http === false) {
    views = [...(views ?? []), ...dropMetrics('http.server.*', 'http.client.*')]
  }

  if (metricFilter) {
    if (metricExporter) {
      // metricExporter path: always use FilteringMetricExporter for all patterns.
      // DROP views can be bypassed when other views match the same instruments
      // and create their own streams.
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

  const hasResourceFilter =
    (metricResourceAttributes?.drop?.length ?? 0) > 0 ||
    (metricResourceAttributes?.keep?.length ?? 0) > 0

  if (metricExporter) {
    const hasFilter =
      (metricFilter?.drop?.length ?? 0) > 0 ||
      (metricFilter?.allow?.length ?? 0) > 0

    let exporter: PushMetricExporter = hasFilter
      ? new FilteringMetricExporter({
          exporter: metricExporter,
          drop: metricFilter?.drop,
          allow: metricFilter?.allow,
        })
      : metricExporter

    if (hasResourceFilter) {
      exporter = new ResourceFilteringMetricExporter({
        exporter,
        drop: metricResourceAttributes?.drop,
        keep: metricResourceAttributes?.keep,
      })
    }

    finalMetricReaders = [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: metricExportInterval ?? 60_000,
      }),
    ]
  } else if (hasResourceFilter) {
    logger.warn(
      '[opin_tel] metricResourceAttributes requires the metricExporter path (not metricReaders). ' +
        'Wrap your reader with ResourceFilteringMetricExporter directly for full control.',
    )
  }

  // Event-loop-delay percentiles and the processor's watermark metrics reset
  // their state on each collection, so they assume a single metric reader. With
  // more than one, whichever reader collects first consumes the interval.
  if ((finalMetricReaders?.length ?? 0) > 1) {
    logger.warn(
      '[opin_tel] Multiple metric readers configured. Event-loop-delay percentiles ' +
        '(node.eventloop.delay.*) and processor watermark metrics (*.max/*.min) reset ' +
        'on collection and will be inaccurate across readers; other metrics are unaffected.',
    )
  }

  const finalInstrumentations =
    (disableRuntimeNodeInstrumentation ?? runtimeMetricsEnabled)
      ? pruneRuntimeNodeInstrumentation(
          instrumentations,
          logger,
          disableRuntimeNodeInstrumentation !== true,
        )
      : instrumentations

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...resourceAttributes,
    }),
    resourceDetectors,
    autoDetectResources,
    idGenerator,
    spanLimits,
    spanProcessors,
    textMapPropagator,
    metricReaders: finalMetricReaders,
    instrumentations: finalInstrumentations,
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
  if (runtimeMetricsEnabled) {
    runtimeMetrics = new NodeRuntimeMetrics(
      typeof runtimeMetricsConfig === 'object' ? runtimeMetricsConfig : {},
    )
    runtimeMetrics.start()
  }

  // Processor diagnostic metrics (active spans, tail buffer, throughput, drops)
  if (metricSources?.processor !== false && processorMetrics !== false) {
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
