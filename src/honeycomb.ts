import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { opinionatedTelemetryInit } from './opinionated-telemetry-init.js'
import { FlatMetricExporter } from './flat-metric-exporter.js'
import type { OpinionatedTelemetryConfig } from './types.js'

export interface HoneycombInitOpinionatedTelemetryConfig extends Omit<
  OpinionatedTelemetryConfig,
  'traceExporter'
> {
  apiKey: string
  enableMetricCollection?: boolean
  metricExportInterval?: number
}

export * from './index.js'

export function honeycombInit(config: HoneycombInitOpinionatedTelemetryConfig) {
  const {
    apiKey,
    metricExportInterval = 60_000,
    enableMetricCollection,
    ...rest
  } = config

  const metricReader =
    enableMetricCollection === false
      ? undefined
      : new PeriodicExportingMetricReader({
          exporter: new FlatMetricExporter({
            exporter: new OTLPMetricExporter({
              url: 'https://api.honeycomb.io/v1/metrics',
              headers: {
                'x-honeycomb-team': apiKey,
                'x-honeycomb-dataset': `${config.serviceName}_metrics`,
              },
            }),
          }),
          exportIntervalMillis: metricExportInterval,
        })

  return opinionatedTelemetryInit({
    ...rest,
    traceExporter: new OTLPTraceExporter({
      url: 'https://api.honeycomb.io/v1/traces',
      headers: {
        'x-honeycomb-team': apiKey,
        'x-honeycomb-dataset': config.serviceName,
      },
    }),
    metricReader,
  })
}
