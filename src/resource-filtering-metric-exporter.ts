import type {
  PushMetricExporter,
  ResourceMetrics,
  AggregationOption,
} from '@opentelemetry/sdk-metrics'
import {
  AggregationTemporality,
  AggregationType,
} from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { Attributes } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'

export type ResourceAttributePattern = string | RegExp

export interface ResourceFilteringMetricExporterConfig {
  /** The underlying metric exporter to forward to. */
  exporter: PushMetricExporter
  /** Resource attribute keys to strip from exported metrics. String = exact key; RegExp tested against the key. */
  drop?: ResourceAttributePattern[]
  /** If set, only keys matching at least one pattern are kept (applied before `drop`). */
  keep?: ResourceAttributePattern[]
}

/**
 * Verbose process-level resource attributes that bloat every metric row without
 * being useful metric dimensions. Stripped from Honeycomb metrics by default —
 * `service.*`, `host.*`, `process.pid`, and `process.runtime.{name,version}` are
 * kept so you can still tell instances apart.
 */
export const DEFAULT_METRIC_RESOURCE_DROP: string[] = [
  'process.command',
  'process.command_args',
  'process.command_line',
  'process.executable.name',
  'process.executable.path',
  'process.owner',
  'process.runtime.description',
]

function toKeyMatcher(
  pattern: ResourceAttributePattern,
): (k: string) => boolean {
  if (typeof pattern === 'string') return (k) => k === pattern
  return (k) => pattern.test(k)
}

/**
 * Wraps a `PushMetricExporter` and rewrites the `Resource` on each export to
 * drop (or keep only) selected resource attribute keys. Honeycomb flattens
 * resource attributes onto every metric row, so this trims noise without
 * touching trace exports (which keep the full resource).
 */
export class ResourceFilteringMetricExporter implements PushMetricExporter {
  private _exporter: PushMetricExporter
  private _shouldKeep: (key: string) => boolean

  constructor(config: ResourceFilteringMetricExporterConfig) {
    this._exporter = config.exporter
    const dropMatchers = config.drop?.map(toKeyMatcher)
    const keepMatchers = config.keep?.map(toKeyMatcher)
    this._shouldKeep = (key) => {
      if (keepMatchers && !keepMatchers.some((m) => m(key))) return false
      if (dropMatchers && dropMatchers.some((m) => m(key))) return false
      return true
    }
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const source = metrics.resource.attributes
    const filtered: Attributes = {}
    for (const key of Object.keys(source)) {
      if (this._shouldKeep(key)) filtered[key] = source[key]
    }

    const rewritten: ResourceMetrics = {
      resource: resourceFromAttributes(filtered),
      scopeMetrics: metrics.scopeMetrics,
    }
    this._exporter.export(rewritten, resultCallback)
  }

  forceFlush(): Promise<void> {
    return this._exporter.forceFlush()
  }

  shutdown(): Promise<void> {
    return this._exporter.shutdown()
  }

  // Delegate to the wrapped exporter so its temporality preference (e.g. the
  // delta default honeycombInit sets) reaches the reader, which only queries the
  // outermost exporter. Fall back to the OTel default if it expresses none.
  selectAggregationTemporality(
    instrumentType: Parameters<
      NonNullable<PushMetricExporter['selectAggregationTemporality']>
    >[0],
  ): AggregationTemporality {
    return (
      this._exporter.selectAggregationTemporality?.(instrumentType) ??
      AggregationTemporality.CUMULATIVE
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
