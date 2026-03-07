import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FlatMetricExporter,
  percentileKey,
  computePercentile,
} from '../../src/flat-metric-exporter.js'
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import {
  DataPointType,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'
import type { HrTime } from '@opentelemetry/api'

function makeResource(): any {
  return {
    attributes: { 'service.name': 'test-service' },
    merge: () => makeResource(),
  }
}

function makeGaugeMetric(
  name: string,
  value: number,
  attributes: Record<string, string> = {},
  endTime: HrTime = [1000, 0],
) {
  return {
    descriptor: { name, description: '', unit: '', valueType: 0 },
    aggregationTemporality: AggregationTemporality.DELTA,
    dataPointType: DataPointType.GAUGE,
    dataPoints: [
      {
        startTime: [999, 0] as HrTime,
        endTime,
        attributes,
        value,
      },
    ],
  }
}

function makeSumMetric(
  name: string,
  value: number,
  attributes: Record<string, string> = {},
  endTime: HrTime = [1000, 0],
) {
  return {
    descriptor: { name, description: '', unit: '', valueType: 0 },
    aggregationTemporality: AggregationTemporality.DELTA,
    dataPointType: DataPointType.SUM,
    isMonotonic: true,
    dataPoints: [
      {
        startTime: [999, 0] as HrTime,
        endTime,
        attributes,
        value,
      },
    ],
  }
}

function makeHistogramMetric(
  name: string,
  value: {
    count: number
    sum?: number
    min?: number
    max?: number
    buckets: { boundaries: number[]; counts: number[] }
  },
  attributes: Record<string, string> = {},
  endTime: HrTime = [1000, 0],
) {
  return {
    descriptor: { name, description: '', unit: '', valueType: 0 },
    aggregationTemporality: AggregationTemporality.DELTA,
    dataPointType: DataPointType.HISTOGRAM,
    dataPoints: [
      {
        startTime: [999, 0] as HrTime,
        endTime,
        attributes,
        value,
      },
    ],
  }
}

function makeResourceMetrics(
  metrics: any[],
  resource = makeResource(),
): ResourceMetrics {
  return {
    resource,
    scopeMetrics: [
      {
        scope: { name: 'test' },
        metrics,
      },
    ],
  }
}

function createMockMetricExporter(): PushMetricExporter & {
  exported: ResourceMetrics[]
} {
  const exported: ResourceMetrics[] = []
  return {
    exported,
    export(metrics, cb) {
      exported.push(metrics)
      cb({ code: 0 })
    },
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

/** Extract all metric names and values from exported ResourceMetrics */
function flattenExported(rm: ResourceMetrics): Record<string, number> {
  const result: Record<string, number> = {}
  for (const sm of rm.scopeMetrics) {
    for (const m of sm.metrics) {
      for (const dp of m.dataPoints) {
        result[m.descriptor.name] = dp.value as number
      }
    }
  }
  return result
}

describe('FlatMetricExporter', () => {
  let mockExporter: ReturnType<typeof createMockMetricExporter>
  let exporter: FlatMetricExporter

  beforeEach(() => {
    mockExporter = createMockMetricExporter()
    exporter = new FlatMetricExporter({ exporter: mockExporter })
  })

  it('exports gauge metrics with flattened names', () => {
    const metrics = makeResourceMetrics([
      makeGaugeMetric('process.memory.rss', 1024),
      makeGaugeMetric('socket.io.open_connections', 5),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    expect(cb).toHaveBeenCalledWith({ code: 0 })
    expect(mockExporter.exported).toHaveLength(1)
    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['process.memory.rss']).toBe(1024)
    expect(flat['socket.io.open_connections']).toBe(5)
  })

  it('exports sum metrics as gauges', () => {
    const metrics = makeResourceMetrics([makeSumMetric('http.requests', 42)])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['http.requests']).toBe(42)
  })

  it('flattens dimensional attributes into metric name by default', () => {
    const metrics = makeResourceMetrics([
      makeGaugeMetric('v8js.memory.heap.used', 100, {
        'v8js.heap.space.name': 'new_space',
      }),
      makeGaugeMetric('v8js.memory.heap.used', 200, {
        'v8js.heap.space.name': 'old_space',
      }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['v8js.memory.heap.used_new_space']).toBe(100)
    expect(flat['v8js.memory.heap.used_old_space']).toBe(200)
  })

  it('strips dimensional attributes from data points', () => {
    const metrics = makeResourceMetrics([
      makeGaugeMetric('metric', 42, { dimension: 'value' }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const rm = mockExporter.exported[0]
    const dp = rm.scopeMetrics[0].metrics[0].dataPoints[0]
    expect(dp.attributes).toEqual({})
  })

  it('uses renameDimension callback for custom flattening', () => {
    exporter = new FlatMetricExporter({
      exporter: mockExporter,
      renameDimension: (name, key, value) => {
        if (key === 'v8js.heap.space.name') {
          const short = value.replace('_space', '')
          return name.replace('.heap.', `.heap_${short}.`)
        }
        if (key === 'v8js.gc.type') {
          return name.replace('v8js.gc.', `v8js.gc_${value}.`)
        }
        return undefined
      },
    })

    const metrics = makeResourceMetrics([
      makeGaugeMetric('v8js.memory.heap.used', 100, {
        'v8js.heap.space.name': 'new_space',
      }),
      makeGaugeMetric('v8js.memory.heap.limit', 1048576, {
        'v8js.heap.space.name': 'new_space',
      }),
      makeGaugeMetric('v8js.memory.heap.used', 200, {
        'v8js.heap.space.name': 'large_object_space',
      }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['v8js.memory.heap_new.used']).toBe(100)
    expect(flat['v8js.memory.heap_new.limit']).toBe(1048576)
    expect(flat['v8js.memory.heap_large_object.used']).toBe(200)
  })

  it('expands histogram into summary stats and percentile gauges', () => {
    const metrics = makeResourceMetrics([
      makeHistogramMetric('v8js.gc.duration', {
        count: 10,
        sum: 50,
        min: 1,
        max: 35,
        buckets: {
          boundaries: [10, 20, 30],
          counts: [3, 3, 2, 2],
        },
      }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['v8js.gc.duration.count']).toBe(10)
    expect(flat['v8js.gc.duration.sum']).toBe(50)
    expect(flat['v8js.gc.duration.min']).toBe(1)
    expect(flat['v8js.gc.duration.max']).toBe(35)
    expect(flat['v8js.gc.duration.avg']).toBe(5)
    expect(flat['v8js.gc.duration.p50']).toBeTypeOf('number')
    expect(flat['v8js.gc.duration.p99']).toBeTypeOf('number')
    expect(flat['v8js.gc.duration.p999']).toBeTypeOf('number')
  })

  it('combines histogram dimension flattening with expansion', () => {
    exporter = new FlatMetricExporter({
      exporter: mockExporter,
      renameDimension: (name, key, value) => {
        if (key === 'v8js.gc.type') {
          return name.replace('v8js.gc.', `v8js.gc_${value}.`)
        }
        return undefined
      },
    })

    const metrics = makeResourceMetrics([
      makeHistogramMetric(
        'v8js.gc.duration',
        {
          count: 3,
          sum: 0.03,
          min: 0.007,
          max: 0.015,
          buckets: { boundaries: [0.01], counts: [1, 2] },
        },
        { 'v8js.gc.type': 'major' },
      ),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['v8js.gc_major.duration.count']).toBe(3)
    expect(flat['v8js.gc_major.duration.sum']).toBe(0.03)
    expect(flat['v8js.gc_major.duration.min']).toBe(0.007)
    expect(flat['v8js.gc_major.duration.max']).toBe(0.015)
    expect(flat['v8js.gc_major.duration.avg']).toBe(0.01)
    expect(flat['v8js.gc_major.duration.p50']).toBeTypeOf('number')
  })

  it('handles empty metrics gracefully', () => {
    const metrics = makeResourceMetrics([])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    expect(cb).toHaveBeenCalledWith({ code: 0 })
    expect(mockExporter.exported).toHaveLength(0)
  })

  it('all transformed data points are GAUGE type with empty attributes', () => {
    const metrics = makeResourceMetrics([
      makeGaugeMetric('a', 1, { dim: 'x' }),
      makeSumMetric('b', 2),
      makeHistogramMetric('c', {
        count: 5,
        sum: 25,
        min: 1,
        max: 10,
        buckets: { boundaries: [5], counts: [3, 2] },
      }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const rm = mockExporter.exported[0]
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        expect(m.dataPointType).toBe(DataPointType.GAUGE)
        for (const dp of m.dataPoints) {
          expect(dp.attributes).toEqual({})
        }
      }
    }
  })

  it('uses custom histogram percentiles', () => {
    exporter = new FlatMetricExporter({
      exporter: mockExporter,
      histogramPercentiles: [0.5, 0.99],
    })

    const metrics = makeResourceMetrics([
      makeHistogramMetric('latency', {
        count: 100,
        sum: 500,
        min: 1,
        max: 50,
        buckets: {
          boundaries: [5, 10, 25, 50],
          counts: [20, 30, 30, 15, 5],
        },
      }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['latency.p50']).toBeTypeOf('number')
    expect(flat['latency.p99']).toBeTypeOf('number')
    // Only p50 and p99 should be present (plus count/sum/min/max/avg)
    expect(flat['latency.p75']).toBeUndefined()
    expect(flat['latency.p90']).toBeUndefined()
  })

  it('forwards forceFlush to wrapped exporter', async () => {
    await exporter.forceFlush()
    expect(mockExporter.forceFlush).toHaveBeenCalled()
  })

  it('forwards shutdown to wrapped exporter', async () => {
    await exporter.shutdown()
    expect(mockExporter.shutdown).toHaveBeenCalled()
  })

  it('combines metrics from multiple scopes', () => {
    const metrics: ResourceMetrics = {
      resource: makeResource(),
      scopeMetrics: [
        {
          scope: { name: 'scope-a' },
          metrics: [makeGaugeMetric('a', 1)],
        },
        {
          scope: { name: 'scope-b' },
          metrics: [makeGaugeMetric('b', 2)],
        },
      ],
    }

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['a']).toBe(1)
    expect(flat['b']).toBe(2)
  })

  it('sanitizes dimension values with special characters', () => {
    const metrics = makeResourceMetrics([
      makeGaugeMetric('metric', 42, { type: 'some/weird:value' }),
    ])

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const flat = flattenExported(mockExporter.exported[0])
    expect(flat['metric_some_weird_value']).toBe(42)
  })

  it('preserves resource from original metrics', () => {
    const resource = makeResource()
    const metrics = makeResourceMetrics([makeGaugeMetric('test', 1)], resource)

    const cb = vi.fn()
    exporter.export(metrics, cb)

    expect(mockExporter.exported[0].resource).toBe(resource)
  })

  it('outputs all transformed metrics under a single scope', () => {
    const metrics: ResourceMetrics = {
      resource: makeResource(),
      scopeMetrics: [
        { scope: { name: 'a' }, metrics: [makeGaugeMetric('x', 1)] },
        { scope: { name: 'b' }, metrics: [makeGaugeMetric('y', 2)] },
      ],
    }

    const cb = vi.fn()
    exporter.export(metrics, cb)

    const rm = mockExporter.exported[0]
    expect(rm.scopeMetrics).toHaveLength(1)
    expect(rm.scopeMetrics[0].scope.name).toBe('opin_tel.metrics')
  })

  describe('percentile computation', () => {
    it('computes percentiles correctly for uniform distribution', () => {
      // 100 values: 25 in each of 4 buckets [0-10, 10-20, 20-30, 30-40]
      exporter = new FlatMetricExporter({
        exporter: mockExporter,
        histogramPercentiles: [0.25, 0.5, 0.75, 1.0],
      })

      const metrics = makeResourceMetrics([
        makeHistogramMetric('test', {
          count: 100,
          sum: 2000,
          min: 0,
          max: 40,
          buckets: {
            boundaries: [10, 20, 30, 40],
            counts: [25, 25, 25, 25, 0],
          },
        }),
      ])

      const cb = vi.fn()
      exporter.export(metrics, cb)

      const flat = flattenExported(mockExporter.exported[0])
      expect(flat['test.p25']).toBe(10)
      expect(flat['test.p50']).toBe(20)
      expect(flat['test.p75']).toBe(30)
    })

    it('handles single-bucket histogram', () => {
      exporter = new FlatMetricExporter({
        exporter: mockExporter,
        histogramPercentiles: [0.5],
      })

      const metrics = makeResourceMetrics([
        makeHistogramMetric('test', {
          count: 10,
          sum: 50,
          min: 3,
          max: 8,
          buckets: {
            boundaries: [10],
            counts: [10, 0],
          },
        }),
      ])

      const cb = vi.fn()
      exporter.export(metrics, cb)

      const flat = flattenExported(mockExporter.exported[0])
      const p50 = flat['test.p50']
      expect(p50).toBeTypeOf('number')
      expect(p50).toBeGreaterThanOrEqual(3)
      expect(p50).toBeLessThanOrEqual(10)
    })

    it('handles histogram with zero count', () => {
      exporter = new FlatMetricExporter({
        exporter: mockExporter,
        histogramPercentiles: [0.5],
      })

      const metrics = makeResourceMetrics([
        makeHistogramMetric('test', {
          count: 0,
          sum: 0,
          buckets: {
            boundaries: [10, 20],
            counts: [0, 0, 0],
          },
        }),
      ])

      const cb = vi.fn()
      exporter.export(metrics, cb)

      const flat = flattenExported(mockExporter.exported[0])
      expect(flat['test.count']).toBe(0)
      expect(flat['test.avg']).toBeUndefined()
      expect(flat['test.p50']).toBeUndefined()
    })
  })

  describe('percentileKey formatting', () => {
    it('formats standard percentiles correctly', () => {
      expect(percentileKey(0.001)).toBe('p001')
      expect(percentileKey(0.01)).toBe('p01')
      expect(percentileKey(0.05)).toBe('p05')
      expect(percentileKey(0.5)).toBe('p50')
      expect(percentileKey(0.75)).toBe('p75')
      expect(percentileKey(0.99)).toBe('p99')
      expect(percentileKey(0.999)).toBe('p999')
    })
  })

  describe('computePercentile', () => {
    it('handles uniform distribution', () => {
      const boundaries = [10, 20, 30]
      const counts = [25, 25, 25, 25]
      expect(computePercentile(boundaries, counts, 0.5, 0, 40)).toBe(20)
    })

    it('handles all values in first bucket', () => {
      const p = computePercentile([10, 20], [100, 0, 0], 0.5, 2, 8)
      expect(p).toBeGreaterThanOrEqual(2)
      expect(p).toBeLessThanOrEqual(10)
    })

    it('returns 0 for empty histogram', () => {
      expect(computePercentile([10], [0, 0], 0.5)).toBe(0)
    })
  })
})
