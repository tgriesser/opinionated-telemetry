import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import {
  PeriodicExportingMetricReader,
  PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import { opinionatedTelemetryInit } from './opinionated-telemetry-init.js'
import {
  FlatMetricExporter,
  flatMetricExporterViews,
} from './flat-metric-exporter.js'
import {
  NodeRuntimeMetrics,
  type NodeRuntimeMetricsConfig,
} from './node-runtime-metrics.js'
import type { OpinionatedTelemetryConfig } from './types.js'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'

export interface HoneycombInitOpinionatedTelemetryConfig extends Omit<
  OpinionatedTelemetryConfig,
  'traceExporter'
> {
  apiKey: string
  enableMetricCollection?: boolean
  metricExportInterval?: number
  metricExporter?: PushMetricExporter
  traceExporter?: SpanExporter
  /** Configure runtime metrics collection. Set to false to disable. Default: enabled when metrics are enabled. */
  runtimeMetrics?: NodeRuntimeMetricsConfig | false
}

export * from './index.js'

export function honeycombInit(config: HoneycombInitOpinionatedTelemetryConfig) {
  const {
    apiKey,
    metricExportInterval = 60_000,
    enableMetricCollection,
    runtimeMetrics: runtimeMetricsConfig,
    ...rest
  } = config

  const metricReader =
    enableMetricCollection === false
      ? undefined
      : new PeriodicExportingMetricReader({
          exporter: new FlatMetricExporter({
            exporter:
              config.metricExporter ??
              new OTLPMetricExporter({
                url: 'https://api.honeycomb.io/v1/metrics',
                headers: {
                  'x-honeycomb-team': apiKey,
                  'x-honeycomb-dataset': `${config.serviceName}_metrics`,
                },
              }),
          }),
          exportIntervalMillis: metricExportInterval,
        })

  let runtimeMetrics: NodeRuntimeMetrics | undefined
  if (enableMetricCollection !== false && runtimeMetricsConfig !== false) {
    runtimeMetrics = new NodeRuntimeMetrics(runtimeMetricsConfig ?? {})
    runtimeMetrics.start()
  }

  const result = opinionatedTelemetryInit({
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
    metricReaders: metricReader ? [metricReader] : [],
    views: metricReader ? flatMetricExporterViews : [],
  })

  return { ...result, runtimeMetrics }
}
