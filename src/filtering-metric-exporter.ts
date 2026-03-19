import type {
  PushMetricExporter,
  ResourceMetrics,
  ViewOptions,
  AggregationOption,
} from '@opentelemetry/sdk-metrics'
import {
  AggregationTemporality,
  AggregationType,
} from '@opentelemetry/sdk-metrics'
import type { ExportResult } from '@opentelemetry/core'

export type MetricPattern = string | RegExp | ((name: string) => boolean)

export interface FilteringMetricExporterConfig {
  /** The underlying metric exporter to forward filtered metrics to */
  exporter: PushMetricExporter
  /**
   * Metrics matching ANY drop pattern are excluded.
   * Strings use glob matching (`*` = any sequence of characters).
   */
  drop?: MetricPattern[]
  /**
   * Only metrics matching at least one allow pattern are included.
   * Applied before drop. Strings use glob matching.
   */
  allow?: MetricPattern[]
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

function toMatcher(pattern: MetricPattern): (name: string) => boolean {
  if (typeof pattern === 'string') {
    const regex = globToRegex(pattern)
    return (name) => regex.test(name)
  }
  if (pattern instanceof RegExp) {
    return (name) => pattern.test(name)
  }
  return pattern
}

function buildPredicate(
  drop?: MetricPattern[],
  allow?: MetricPattern[],
): (name: string) => boolean {
  const dropMatchers = drop?.map(toMatcher)
  const allowMatchers = allow?.map(toMatcher)

  return (name: string) => {
    if (allowMatchers && !allowMatchers.some((m) => m(name))) return false
    if (dropMatchers && dropMatchers.some((m) => m(name))) return false
    return true
  }
}

export class FilteringMetricExporter implements PushMetricExporter {
  private _exporter: PushMetricExporter
  private _shouldExport: (name: string) => boolean

  constructor(config: FilteringMetricExporterConfig) {
    this._exporter = config.exporter
    this._shouldExport = buildPredicate(config.drop, config.allow)
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const filtered: ResourceMetrics = {
      resource: metrics.resource,
      scopeMetrics: metrics.scopeMetrics
        .map((sm) => ({
          scope: sm.scope,
          metrics: sm.metrics.filter((m) =>
            this._shouldExport(m.descriptor.name),
          ),
        }))
        .filter((sm) => sm.metrics.length > 0),
    }

    if (filtered.scopeMetrics.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    this._exporter.export(filtered, resultCallback)
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
}

/**
 * Generate DROP views for the given glob patterns.
 * Metrics matching these patterns are never collected (zero overhead).
 * Compose with the `views` config option.
 *
 * @example
 * ```ts
 * opinionatedTelemetryInit({
 *   views: [...dropMetrics('http.server.*', 'http.client.*'), ...flatMetricExporterViews],
 * })
 * ```
 */
export function dropMetrics(...patterns: string[]): ViewOptions[] {
  return patterns.map((instrumentName) => ({
    instrumentName,
    aggregation: { type: AggregationType.DROP },
  }))
}
