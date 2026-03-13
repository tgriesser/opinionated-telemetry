import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ExportResultCode } from '@opentelemetry/core'
import { SpanStatusCode } from '@opentelemetry/api'
import type {
  PushMetricExporter,
  ResourceMetrics,
  DataPoint,
} from '@opentelemetry/sdk-metrics'

type SpanWithParent = ReadableSpan & {
  parentSpanContext: Exclude<ReadableSpan['parentSpanContext'], undefined>
}

// ─── Span Exporter ────────────────────────────────────────────────

export class TestSpanExporter implements SpanExporter {
  private _spans: ReadableSpan[] = []
  private _stopped = false

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: ExportResultCode }) => void,
  ): void {
    if (this._stopped) {
      resultCallback({ code: ExportResultCode.FAILED })
      return
    }
    this._spans.push(...spans)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  shutdown(): Promise<void> {
    this._stopped = true
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  /** Clear all collected spans. */
  reset(): void {
    this._spans = []
  }

  /** All spans collected so far. */
  get spans(): ReadableSpan[] {
    return this._spans
  }

  // ── Finders ──────────────────────────────────────────────────

  /** Find the first span matching a name (string or regex). */
  findSpan(name: string | RegExp): ReadableSpan | undefined {
    return this._spans.find((s) =>
      typeof name === 'string' ? s.name === name : name.test(s.name),
    )
  }

  /** Find all spans matching a name (string or regex). */
  findSpans(name: string | RegExp): ReadableSpan[] {
    return this._spans.filter((s) =>
      typeof name === 'string' ? s.name === name : name.test(s.name),
    )
  }

  /** Get all unique span names. */
  get spanNames(): string[] {
    return [...new Set(this._spans.map((s) => s.name))]
  }

  /** Get all root spans (no parent). */
  get rootSpans(): ReadableSpan[] {
    return this._spans.filter((s) => !s.parentSpanContext)
  }

  /** Get all spans with error status. */
  get errorSpans(): ReadableSpan[] {
    return this._spans.filter((s) => s.status.code === SpanStatusCode.ERROR)
  }

  // ── Assertions ───────────────────────────────────────────────

  /**
   * Assert that a span with the given name exists.
   * Returns the first matching span for further assertions.
   */
  assertSpanExists(name: string | RegExp): ReadableSpan {
    const span = this.findSpan(name)
    if (!span) {
      throw new Error(
        `Expected span matching ${name} to exist. ` +
          `Found: [${this.spanNames.join(', ')}]`,
      )
    }
    return span
  }

  /** Assert that no span with the given name exists. */
  assertSpanNotExists(name: string | RegExp): void {
    const span = this.findSpan(name)
    if (span) {
      throw new Error(
        `Expected span matching ${name} not to exist, but it does`,
      )
    }
  }

  /** Assert the exact count of spans matching a name. */
  assertSpanCount(name: string | RegExp, expected: number): void {
    const found = this.findSpans(name).length
    if (found !== expected) {
      throw new Error(
        `Expected ${expected} span(s) matching ${name}, found ${found}`,
      )
    }
  }

  /** Assert that the total number of spans matches. */
  assertTotalSpanCount(expected: number): void {
    if (this._spans.length !== expected) {
      throw new Error(
        `Expected ${expected} total span(s), found ${this._spans.length}`,
      )
    }
  }

  /** Assert that a span has the given attributes (subset match). */
  assertSpanAttributes(
    name: string | RegExp,
    attrs: Record<string, unknown>,
  ): ReadableSpan {
    const span = this.assertSpanExists(name)
    for (const [key, value] of Object.entries(attrs)) {
      const actual = span.attributes[key]
      if (actual !== value) {
        throw new Error(
          `Span "${span.name}" attribute "${key}": expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
        )
      }
    }
    return span
  }

  /** Assert no spans have error status. */
  assertNoErrors(): void {
    const errors = this.errorSpans
    if (errors.length > 0) {
      const names = errors.map((s) => s.name).join(', ')
      throw new Error(
        `Expected no error spans, found ${errors.length}: [${names}]`,
      )
    }
  }

  /**
   * Assert every non-root span has a parent present in the collected spans.
   * Returns orphan span names on failure for easy debugging.
   */
  assertNoOrphanSpans(): void {
    const spanIds = new Set(this._spans.map((s) => s.spanContext().spanId))
    const orphans = this._spans.filter((s): s is SpanWithParent =>
      Boolean(s.parentSpanContext && !spanIds.has(s.parentSpanContext.spanId)),
    )
    if (orphans.length > 0) {
      const details = orphans
        .map(
          (s) =>
            `"${s.name}" (parent=${s.parentSpanContext.spanId.slice(0, 8)}…)`,
        )
        .join(', ')
      throw new Error(`Found ${orphans.length} orphan span(s): [${details}]`)
    }
  }

  // ── Snapshots ────────────────────────────────────────────────

  /**
   * Returns an ASCII tree of the span hierarchy, grouped by trace.
   *
   * Example output:
   * ```
   * GET /api/users
   * ├── middleware - auth
   * ├── pg.query SELECT
   * └── serialize response
   * ```
   *
   * Options:
   * - `attributes`: list of attribute keys to include inline
   * - `includeDuration`: include span duration (default: false)
   * - `sortByStart`: sort children by start time (default: true)
   */
  toTree(opts?: {
    attributes?: string[]
    includeDuration?: boolean
    sortByStart?: boolean
  }): string {
    const {
      attributes = [],
      includeDuration = false,
      sortByStart = true,
    } = opts ?? {}

    // Group spans by trace
    const byTrace = new Map<string, ReadableSpan[]>()
    for (const span of this._spans) {
      const traceId = span.spanContext().traceId
      let list = byTrace.get(traceId)
      if (!list) {
        list = []
        byTrace.set(traceId, list)
      }
      list.push(span)
    }

    const lines: string[] = []
    for (const [, spans] of byTrace) {
      if (lines.length > 0) lines.push('')

      // Build parent→children index
      const byParent = new Map<string, ReadableSpan[]>()
      const roots: ReadableSpan[] = []
      for (const s of spans) {
        if (!s.parentSpanContext) {
          roots.push(s)
        } else {
          const pid = s.parentSpanContext.spanId
          let children = byParent.get(pid)
          if (!children) {
            children = []
            byParent.set(pid, children)
          }
          children.push(s)
        }
      }

      const sortFn = sortByStart
        ? (a: ReadableSpan, b: ReadableSpan) =>
            hrToMs(a.startTime) - hrToMs(b.startTime)
        : undefined

      if (sortFn) roots.sort(sortFn)

      for (const root of roots) {
        renderNode(
          root,
          '',
          true,
          true,
          lines,
          byParent,
          attributes,
          includeDuration,
          sortFn,
        )
      }

      // Orphans — group by missing parent, render under "(missing span)" placeholder
      const knownIds = new Set(spans.map((s) => s.spanContext().spanId))
      const orphansByParent = new Map<string, ReadableSpan[]>()
      for (const s of spans) {
        if (s.parentSpanContext && !knownIds.has(s.parentSpanContext.spanId)) {
          const pid = s.parentSpanContext.spanId
          let list = orphansByParent.get(pid)
          if (!list) {
            list = []
            orphansByParent.set(pid, list)
          }
          list.push(s)
        }
      }
      for (const [, children] of orphansByParent) {
        if (sortFn) children.sort(sortFn)
        lines.push('(missing span)')
        for (let i = 0; i < children.length; i++) {
          renderNode(
            children[i],
            '',
            i === children.length - 1,
            false,
            lines,
            byParent,
            attributes,
            includeDuration,
            sortFn,
          )
        }
      }
    }

    return lines.join('\n')
  }

  /**
   * Returns a summary object useful for test snapshots.
   */
  summarize(): {
    totalSpans: number
    spanNames: Record<string, number>
    errorCount: number
    rootCount: number
    orphanCount: number
    traceCount: number
  } {
    const spanIds = new Set(this._spans.map((s) => s.spanContext().spanId))
    const spanNames: Record<string, number> = {}
    for (const s of this._spans) {
      spanNames[s.name] = (spanNames[s.name] ?? 0) + 1
    }
    return {
      totalSpans: this._spans.length,
      spanNames,
      errorCount: this.errorSpans.length,
      rootCount: this.rootSpans.length,
      orphanCount: this._spans.filter(
        (s) => s.parentSpanContext && !spanIds.has(s.parentSpanContext.spanId),
      ).length,
      traceCount: new Set(this._spans.map((s) => s.spanContext().traceId)).size,
    }
  }
}

// ─── Metric Exporter ──────────────────────────────────────────────

export class TestMetricExporter implements PushMetricExporter {
  private _metrics: ResourceMetrics[] = []
  private _stopped = false

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: { code: ExportResultCode }) => void,
  ): void {
    if (this._stopped) {
      resultCallback({ code: ExportResultCode.FAILED })
      return
    }
    this._metrics.push(metrics)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  shutdown(): Promise<void> {
    this._stopped = true
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  /** Clear all collected metrics. */
  reset(): void {
    this._metrics = []
  }

  /** All ResourceMetrics collected so far. */
  get resourceMetrics(): ResourceMetrics[] {
    return this._metrics
  }

  /**
   * Flatten all collected metrics into a `{ name: dataPoints[] }` map.
   * Each call to `export()` may contain multiple scopes and metrics;
   * this merges them all.
   */
  get flatMetrics(): Map<string, DataPoint<unknown>[]> {
    const result = new Map<string, DataPoint<unknown>[]>()
    for (const rm of this._metrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          const existing = result.get(m.descriptor.name)
          const points = m.dataPoints as DataPoint<unknown>[]
          if (existing) {
            existing.push(...points)
          } else {
            result.set(m.descriptor.name, [...points])
          }
        }
      }
    }
    return result
  }

  /** Get all unique metric names across all exports. */
  get metricNames(): string[] {
    return [...this.flatMetrics.keys()]
  }

  /**
   * Get a flat `name → latestValue` map (last data point wins).
   * Useful for simple gauge/counter assertions.
   */
  get metricValues(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [name, points] of this.flatMetrics) {
      if (points.length > 0) {
        result[name] = points[points.length - 1].value
      }
    }
    return result
  }

  // ── Assertions ───────────────────────────────────────────────

  /** Assert that a metric with the given name exists. */
  assertMetricExists(name: string): DataPoint<unknown>[] {
    const points = this.flatMetrics.get(name)
    if (!points || points.length === 0) {
      throw new Error(
        `Expected metric "${name}" to exist. Found: [${this.metricNames.join(', ')}]`,
      )
    }
    return points
  }

  /** Assert that a metric does not exist. */
  assertMetricNotExists(name: string): void {
    const points = this.flatMetrics.get(name)
    if (points && points.length > 0) {
      throw new Error(`Expected metric "${name}" not to exist, but it does`)
    }
  }

  /** Assert the latest value of a metric. */
  assertMetricValue(name: string, expected: unknown): void {
    const points = this.assertMetricExists(name)
    const actual = points[points.length - 1].value
    if (actual !== expected) {
      throw new Error(
        `Metric "${name}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      )
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────

function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1_000_000
}

function formatDuration(span: ReadableSpan): string {
  const ms = hrToMs(span.duration)
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`
}

function renderNode(
  span: ReadableSpan,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
  byParent: Map<string, ReadableSpan[]>,
  attributes: string[],
  includeDuration: boolean,
  sortFn?: (a: ReadableSpan, b: ReadableSpan) => number,
): void {
  const connector = isRoot ? '' : isLast ? '└── ' : '├── '
  const status = span.status.code === SpanStatusCode.ERROR ? ' ✗' : ''
  const dur = includeDuration ? ` (${formatDuration(span)})` : ''
  let attrStr = ''
  if (attributes.length > 0) {
    const parts: string[] = []
    for (const key of attributes) {
      if (key in span.attributes) {
        parts.push(`${key}=${JSON.stringify(span.attributes[key])}`)
      }
    }
    if (parts.length > 0) attrStr = ` {${parts.join(', ')}}`
  }
  lines.push(`${prefix}${connector}${span.name}${dur}${status}${attrStr}`)

  const children = byParent.get(span.spanContext().spanId) ?? []
  if (sortFn) children.sort(sortFn)
  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ')
  for (let i = 0; i < children.length; i++) {
    renderNode(
      children[i],
      childPrefix,
      i === children.length - 1,
      false,
      lines,
      byParent,
      attributes,
      includeDuration,
      sortFn,
    )
  }
}
