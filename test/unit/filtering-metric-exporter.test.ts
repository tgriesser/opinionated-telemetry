import { describe, it, expect, vi } from 'vitest'
import type {
  PushMetricExporter,
  ResourceMetrics,
  MetricData,
} from '@opentelemetry/sdk-metrics'
import {
  AggregationTemporality,
  AggregationType,
  DataPointType,
} from '@opentelemetry/sdk-metrics'
import {
  FilteringMetricExporter,
  dropMetrics,
} from '../../src/filtering-metric-exporter.js'

function createMockExporter(): PushMetricExporter & {
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

function makeMetric(name: string): MetricData {
  return {
    descriptor: {
      name,
      description: '',
      unit: '',
      type: 'OBSERVABLE_GAUGE' as any,
      valueType: 0,
      advice: {},
    },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.GAUGE,
    dataPoints: [
      {
        startTime: [0, 0],
        endTime: [1, 0],
        attributes: {},
        value: 42,
      },
    ],
  } as MetricData
}

function makeResourceMetrics(...metricNames: string[]): ResourceMetrics {
  return {
    resource: { attributes: {} } as any,
    scopeMetrics: [
      {
        scope: { name: 'test' },
        metrics: metricNames.map(makeMetric),
      },
    ],
  }
}

function exportSync(
  exporter: FilteringMetricExporter,
  metrics: ResourceMetrics,
): { code: number } {
  let result: { code: number } = { code: -1 }
  exporter.export(metrics, (r) => {
    result = r
  })
  return result
}

describe('FilteringMetricExporter', () => {
  describe('drop patterns', () => {
    it('drops metrics matching string glob pattern', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: ['http.server.*'],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'http.server.request.duration',
          'http.server.active_requests',
          'node.heap.used_mb',
        ),
      )

      expect(result.code).toBe(0)
      expect(mock.exported).toHaveLength(1)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual(['node.heap.used_mb'])
    })

    it('drops metrics matching regex', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: [/^node\.gc\./],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'node.gc.major.count',
          'node.gc.major.avg_ms',
          'node.heap.used_mb',
        ),
      )

      expect(result.code).toBe(0)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual(['node.heap.used_mb'])
    })

    it('drops metrics matching predicate function', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: [(name) => name.endsWith('.p99')],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'node.eventloop.delay.p50',
          'node.eventloop.delay.p99',
          'node.gc.major.p99_ms',
        ),
      )

      expect(result.code).toBe(0)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual([
        'node.eventloop.delay.p50',
        'node.gc.major.p99_ms', // p99_ms doesn't end with .p99
      ])
    })

    it('supports multiple drop patterns (any match drops)', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: [
          'http.server.*',
          /^node\.gc/,
          (name) => name === 'node.requests',
        ],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'http.server.request.duration',
          'node.gc.major.count',
          'node.requests',
          'node.heap.used_mb',
        ),
      )

      expect(result.code).toBe(0)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual(['node.heap.used_mb'])
    })
  })

  describe('allow patterns', () => {
    it('only keeps metrics matching allow patterns', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        allow: ['opin_tel.*', 'node.heap.*'],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'opin_tel.processor.spans.active',
          'node.heap.used_mb',
          'node.gc.major.count',
          'http.server.request.duration',
        ),
      )

      expect(result.code).toBe(0)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual([
        'opin_tel.processor.spans.active',
        'node.heap.used_mb',
      ])
    })

    it('supports regex and predicates in allow', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        allow: [/^opin_tel\./, (name) => name.startsWith('node.cpu')],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'opin_tel.processor.spans.active',
          'node.cpu.total_pct',
          'node.heap.used_mb',
        ),
      )

      expect(result.code).toBe(0)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual([
        'opin_tel.processor.spans.active',
        'node.cpu.total_pct',
      ])
    })
  })

  describe('combined drop + allow', () => {
    it('allow filters first, then drop', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        allow: ['opin_tel.*'],
        drop: ['opin_tel.processor.spans.dropped.*'],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics(
          'opin_tel.processor.spans.active',
          'opin_tel.processor.spans.dropped.sync',
          'node.heap.used_mb', // not in allow list
        ),
      )

      expect(result.code).toBe(0)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual(['opin_tel.processor.spans.active'])
    })
  })

  describe('edge cases', () => {
    it('returns success without forwarding when all metrics filtered', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: ['*'],
      })

      const result = exportSync(
        exporter,
        makeResourceMetrics('anything', 'everything'),
      )

      expect(result.code).toBe(0)
      expect(mock.exported).toHaveLength(0)
    })

    it('passes through all metrics when no filters configured', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({ exporter: mock })

      exportSync(exporter, makeResourceMetrics('a', 'b', 'c'))

      expect(mock.exported).toHaveLength(1)
      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual(['a', 'b', 'c'])
    })

    it('filters across multiple scopeMetrics', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: ['drop.*'],
      })

      const metrics: ResourceMetrics = {
        resource: { attributes: {} } as any,
        scopeMetrics: [
          {
            scope: { name: 'scope1' },
            metrics: [makeMetric('keep.a'), makeMetric('drop.b')],
          },
          { scope: { name: 'scope2' }, metrics: [makeMetric('drop.c')] },
          { scope: { name: 'scope3' }, metrics: [makeMetric('keep.d')] },
        ],
      }

      exportSync(exporter, metrics)

      expect(mock.exported).toHaveLength(1)
      const scopes = mock.exported[0].scopeMetrics
      // scope2 should be removed entirely (no remaining metrics)
      expect(scopes).toHaveLength(2)
      expect(scopes[0].scope.name).toBe('scope1')
      expect(scopes[0].metrics.map((m) => m.descriptor.name)).toEqual([
        'keep.a',
      ])
      expect(scopes[1].scope.name).toBe('scope3')
    })

    it('delegates forceFlush and shutdown', async () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({ exporter: mock })

      await exporter.forceFlush()
      await exporter.shutdown()

      expect(mock.forceFlush).toHaveBeenCalledOnce()
      expect(mock.shutdown).toHaveBeenCalledOnce()
    })
  })

  describe('glob matching', () => {
    it('* matches any sequence', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        allow: ['http.*'],
      })

      exportSync(
        exporter,
        makeResourceMetrics(
          'http.server.request.duration',
          'http.client.duration',
          'node.heap.used_mb',
        ),
      )

      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual([
        'http.server.request.duration',
        'http.client.duration',
      ])
    })

    it('exact string matches without wildcard', () => {
      const mock = createMockExporter()
      const exporter = new FilteringMetricExporter({
        exporter: mock,
        drop: ['node.heap.used_mb'],
      })

      exportSync(
        exporter,
        makeResourceMetrics('node.heap.used_mb', 'node.heap.total_mb'),
      )

      const names = mock.exported[0].scopeMetrics[0].metrics.map(
        (m) => m.descriptor.name,
      )
      expect(names).toEqual(['node.heap.total_mb'])
    })
  })
})

describe('dropMetrics', () => {
  it('generates ViewOptions with DROP aggregation for each pattern', () => {
    const views = dropMetrics('http.server.*', 'http.client.*')

    expect(views).toHaveLength(2)
    expect(views[0]).toEqual({
      instrumentName: 'http.server.*',
      aggregation: { type: AggregationType.DROP },
    })
    expect(views[1]).toEqual({
      instrumentName: 'http.client.*',
      aggregation: { type: AggregationType.DROP },
    })
  })

  it('returns empty array for no patterns', () => {
    expect(dropMetrics()).toEqual([])
  })
})
