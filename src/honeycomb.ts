import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { opinionatedTelemetryInit } from './opinionated-telemetry-init.js'
import { DEFAULT_METRIC_RESOURCE_DROP } from './resource-filtering-metric-exporter.js'
import type { OpinionatedTelemetryConfig } from './types.js'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'

export interface HoneycombInitOpinionatedTelemetryConfig extends Omit<
  OpinionatedTelemetryConfig,
  'traceExporter' | 'metricExporter' | 'metricExportInterval'
> {
  apiKey: string
  enableMetricCollection?: boolean
  /** Metric export interval in ms. Default: 60_000 */
  metricExportInterval?: number
  /** Override the default OTLP metric exporter */
  metricExporter?: PushMetricExporter
  traceExporter?: SpanExporter
  /**
   * Dataset to send metrics to. Honeycomb routes them by this header (not by `service.name`),
   * and without it they all land in `unknown_metrics`. Default: `${serviceName}_metrics`.
   */
  metricsDataset?: string
}

export * from './index.js'

export function honeycombInit(config: HoneycombInitOpinionatedTelemetryConfig) {
  const {
    apiKey,
    metricExportInterval = 60_000,
    enableMetricCollection,
    ...rest
  } = config

  const metricsEnabled = enableMetricCollection !== false

  const finalMetricExporter = metricsEnabled
    ? (config.metricExporter ??
      new OTLPMetricExporter({
        url: 'https://api.honeycomb.io/v1/metrics',
        headers: {
          'x-honeycomb-team': apiKey,
          'x-honeycomb-dataset': `${config.serviceName}_metrics`,
        },
        temporalityPreference: AggregationTemporalityPreference.DELTA,
      }))
    : undefined

  return opinionatedTelemetryInit({
    ...rest,
    traceExporter:
      config.traceExporter ??
      new OTLPTraceExporter({
        url: 'https://api.honeycomb.io/v1/traces',
        headers: {
          'x-honeycomb-team': apiKey,
          'x-honeycomb-dataset': config.serviceName,
        },
      }),
    metricExporter: finalMetricExporter,
    metricExportInterval,
    metricResourceAttributes: rest.metricResourceAttributes ?? {
      drop: DEFAULT_METRIC_RESOURCE_DROP,
    },
    metricSources: {
      http: false,
      processor: false,
      ...rest.metricSources,
    },
    disableRuntimeNodeInstrumentation:
      rest.disableRuntimeNodeInstrumentation ?? true,
  })
}
