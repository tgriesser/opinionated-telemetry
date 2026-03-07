import type {
  PushMetricExporter,
  ResourceMetrics,
  MetricData,
  ScopeMetrics,
  GaugeMetricData,
  DataPoint,
} from '@opentelemetry/sdk-metrics'
import {
  AggregationTemporality,
  DataPointType,
} from '@opentelemetry/sdk-metrics'
import type { Attributes, HrTime } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import {
  type AggregationOption,
  AggregationType,
} from '@opentelemetry/sdk-metrics'
import debugLib from 'debug'

const debug = debugLib('opin_tel:flat-metrics')

export interface FlatMetricExporterConfig {
  /** The underlying metric exporter to forward transformed metrics to (e.g. OTLPMetricExporter) */
  exporter: PushMetricExporter

  /**
   * Rewrite metric name when a dimensional attribute is present on a data point.
   * Called for each attribute on each data point. Return the new metric name
   * with the dimension value folded in, or `undefined` to use the default
   * behavior (append `_${sanitizedValue}` to the metric name).
   *
   * Dimensional attributes are stripped from data points after renaming so that
   * all data points share the same (empty) attribute set, causing Honeycomb to
   * merge them into a single wide event.
   */
  renameDimension?: (
    metricName: string,
    dimensionKey: string,
    dimensionValue: string,
  ) => string | undefined

  /**
   * Histogram percentiles to compute from explicit bucket boundaries.
   * Each percentile becomes a separate gauge metric (e.g. `metric.p50`).
   * Default: `[0.5, 0.75, 0.9, 0.95, 0.99, 0.999]`
   */
  histogramPercentiles?: number[]
}

const DEFAULT_PERCENTILES = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999]

interface HistogramValue {
  count: number
  sum?: number
  min?: number
  max?: number
  buckets?: {
    boundaries: number[]
    counts: number[]
  }
}

export class FlatMetricExporter implements PushMetricExporter {
  private _exporter: PushMetricExporter
  private _renameDimension: FlatMetricExporterConfig['renameDimension']
  private _percentiles: number[]

  constructor(config: FlatMetricExporterConfig) {
    this._exporter = config.exporter
    this._renameDimension = config.renameDimension
    this._percentiles = config.histogramPercentiles ?? DEFAULT_PERCENTILES
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const transformedMetrics: MetricData[] = []

    for (const scopeMetrics of metrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (
          metric.dataPointType === DataPointType.HISTOGRAM ||
          metric.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM
        ) {
          // Expand each histogram data point into multiple gauge metrics
          for (const dp of metric.dataPoints) {
            const baseName = this._resolveMetricName(
              metric.descriptor.name,
              dp.attributes,
            )
            const histValue = dp.value as HistogramValue
            const gauges = this._expandHistogram(
              baseName,
              histValue,
              dp.startTime,
              dp.endTime,
            )
            transformedMetrics.push(...gauges)
          }
        } else {
          // Gauge or Sum — fold dimensions into name, strip attributes
          for (const dp of metric.dataPoints) {
            const flatName = this._resolveMetricName(
              metric.descriptor.name,
              dp.attributes,
            )
            transformedMetrics.push(
              makeGauge(flatName, dp.value as number, dp.startTime, dp.endTime),
            )
          }
        }
      }
    }

    if (transformedMetrics.length === 0) {
      debug('no metrics to export')
      resultCallback({ code: 0 })
      return
    }

    debug('exporting %d flattened metrics', transformedMetrics.length)

    const transformed: ResourceMetrics = {
      resource: metrics.resource,
      scopeMetrics: [
        {
          scope: { name: 'opin_tel.metrics' },
          metrics: transformedMetrics,
        },
      ],
    }

    this._exporter.export(transformed, resultCallback)
  }

  forceFlush(): Promise<void> {
    return this._exporter.forceFlush()
  }

  shutdown(): Promise<void> {
    return this._exporter.shutdown()
  }

  selectAggregationTemporality(
    instrumentType: Parameters<
      NonNullable<PushMetricExporter['selectAggregationTemporality']>
    >[0],
  ): AggregationTemporality {
    return (
      this._exporter.selectAggregationTemporality?.(instrumentType) ??
      AggregationTemporality.DELTA
    )
  }

  selectAggregation(
    instrumentType: Parameters<
      NonNullable<PushMetricExporter['selectAggregation']>
    >[0],
  ): AggregationOption {
    return (
      this._exporter.selectAggregation?.(instrumentType) ?? {
        type: AggregationType.DEFAULT,
      }
    )
  }

  private _resolveMetricName(
    metricName: string,
    attributes: Attributes,
  ): string {
    const entries = Object.entries(attributes)
    if (entries.length === 0) return metricName

    let name = metricName
    for (const [key, value] of entries) {
      const strValue = String(value)
      if (this._renameDimension) {
        const result = this._renameDimension(name, key, strValue)
        if (result !== undefined) {
          name = result
          continue
        }
      }
      // Default: append sanitized dimension value
      name = `${name}_${sanitizeDimension(strValue)}`
    }
    return name
  }

  private _expandHistogram(
    baseName: string,
    value: HistogramValue,
    startTime: HrTime,
    endTime: HrTime,
  ): GaugeMetricData[] {
    const gauges: GaugeMetricData[] = []

    if (value.count !== undefined)
      gauges.push(
        makeGauge(`${baseName}.count`, value.count, startTime, endTime),
      )
    if (value.sum !== undefined)
      gauges.push(makeGauge(`${baseName}.sum`, value.sum, startTime, endTime))
    if (value.min !== undefined)
      gauges.push(makeGauge(`${baseName}.min`, value.min, startTime, endTime))
    if (value.max !== undefined)
      gauges.push(makeGauge(`${baseName}.max`, value.max, startTime, endTime))
    if (value.count > 0 && value.sum !== undefined) {
      gauges.push(
        makeGauge(
          `${baseName}.avg`,
          value.sum / value.count,
          startTime,
          endTime,
        ),
      )
    }

    // Percentiles from explicit histogram buckets
    if (value.buckets && value.count > 0) {
      for (const p of this._percentiles) {
        gauges.push(
          makeGauge(
            `${baseName}.${percentileKey(p)}`,
            computePercentile(
              value.buckets.boundaries,
              value.buckets.counts,
              p,
              value.min,
              value.max,
            ),
            startTime,
            endTime,
          ),
        )
      }
    }

    return gauges
  }
}

// --- Helpers ---

function makeGauge(
  name: string,
  value: number,
  startTime: HrTime,
  endTime: HrTime,
): GaugeMetricData {
  return {
    descriptor: { name, description: '', unit: '', valueType: 0 },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.GAUGE,
    dataPoints: [{ startTime, endTime, attributes: {}, value }],
  }
}

function sanitizeDimension(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Format a percentile (0-1) into a key suffix like 'p50', 'p99', 'p999'.
 */
export function percentileKey(p: number): string {
  const v100 = Math.round(p * 100)
  const v1000 = Math.round(p * 1000)
  // Clean percentages: 0.5→p50, 0.99→p99, 0.01→p01
  if (v100 * 10 === v1000) {
    return v100 < 10 ? `p0${v100}` : `p${v100}`
  }
  // Sub-percent: 0.999→p999, 0.001→p001
  if (v1000 < 10) return `p00${v1000}`
  if (v1000 < 100) return `p0${v1000}`
  return `p${v1000}`
}

/**
 * Compute an approximate percentile from explicit histogram bucket boundaries.
 * Uses linear interpolation within the target bucket.
 */
export function computePercentile(
  boundaries: number[],
  counts: number[],
  percentile: number,
  min?: number,
  max?: number,
): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return 0

  const target = percentile * total
  let cumulative = 0

  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i]
    if (cumulative >= target) {
      let lower: number
      let upper: number

      if (i === 0) {
        // First bucket: (-inf, boundaries[0]]
        lower = min ?? 0
        upper = boundaries[0] ?? max ?? 0
      } else if (i >= boundaries.length) {
        // Last bucket: (boundaries[n-1], +inf)
        lower = boundaries[boundaries.length - 1]
        upper = max ?? lower
      } else {
        lower = boundaries[i - 1]
        upper = boundaries[i]
      }

      if (counts[i] === 0) return lower
      const prevCumulative = cumulative - counts[i]
      const fraction = (target - prevCumulative) / counts[i]
      return lower + fraction * (upper - lower)
    }
  }

  return max ?? boundaries[boundaries.length - 1] ?? 0
}
