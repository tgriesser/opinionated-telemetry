import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { opinionatedTelemetryInit } from './opinionated-telemetry-init.js'
import {
  FlatMetricExporter,
  flatMetricExporterViews,
} from './flat-metric-exporter.js'
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
  /** Override the default OTLP metric exporter (raw exporter — will be wrapped in FlatMetricExporter) */
  metricExporter?: PushMetricExporter
  traceExporter?: SpanExporter
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

  // Wrap the user's raw exporter (or default OTLP) in FlatMetricExporter
  const finalMetricExporter = metricsEnabled
    ? new FlatMetricExporter({
        exporter:
          config.metricExporter ??
          new OTLPMetricExporter({
            url: 'https://api.honeycomb.io/v1/metrics',
            headers: {
              'x-honeycomb-team': apiKey,
              'x-honeycomb-dataset': `${config.serviceName}_metrics`,
            },
          }),
      })
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
    // Use the init metricExporter path — creates the reader for us,
    // and if metricFilter has regex/predicates, wraps with FilteringMetricExporter
    metricExporter: finalMetricExporter,
    metricExportInterval,
    views: [
      ...(rest.views ?? []),
      ...(metricsEnabled ? flatMetricExporterViews : []),
    ],
  })
}
