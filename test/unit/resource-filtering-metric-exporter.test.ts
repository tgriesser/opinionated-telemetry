import { describe, it, expect, vi } from 'vitest'
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import {
  AggregationTemporality,
  InstrumentType,
} from '@opentelemetry/sdk-metrics'
import {
  ResourceFilteringMetricExporter,
  DEFAULT_METRIC_RESOURCE_DROP,
} from '../../src/resource-filtering-metric-exporter.js'

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

function resourceMetricsWith(
  attributes: Record<string, unknown>,
): ResourceMetrics {
  return {
    resource: { attributes } as never,
    scopeMetrics: [],
  } as ResourceMetrics
}

function exportedAttrs(
  mock: ReturnType<typeof createMockExporter>,
): Record<string, unknown> {
  return mock.exported[0].resource.attributes
}

describe('ResourceFilteringMetricExporter', () => {
  it('drops keys matching string and RegExp patterns', () => {
    const mock = createMockExporter()
    const exporter = new ResourceFilteringMetricExporter({
      exporter: mock,
      drop: ['process.command_args', /^process\.executable/],
    })

    exporter.export(
      resourceMetricsWith({
        'service.name': 'svc',
        'process.command_args': 'a b',
        'process.executable.path': '/usr/bin/node',
        'process.pid': 4222,
      }),
      () => {},
    )

    const attrs = exportedAttrs(mock)
    expect(attrs).not.toHaveProperty('process.command_args')
    expect(attrs).not.toHaveProperty('process.executable.path')
    expect(attrs['service.name']).toBe('svc')
    expect(attrs['process.pid']).toBe(4222)
  })

  it('keep allow-lists, then drop removes from the kept set', () => {
    const mock = createMockExporter()
    const exporter = new ResourceFilteringMetricExporter({
      exporter: mock,
      keep: [/^service\./, 'host.name'],
      drop: ['service.instance.id'],
    })

    exporter.export(
      resourceMetricsWith({
        'service.name': 'svc',
        'service.instance.id': 'abc',
        'host.name': 'box',
        'process.pid': 1,
      }),
      () => {},
    )

    const attrs = exportedAttrs(mock)
    expect(attrs['service.name']).toBe('svc')
    expect(attrs['host.name']).toBe('box')
    expect(attrs).not.toHaveProperty('service.instance.id') // dropped after keep
    expect(attrs).not.toHaveProperty('process.pid') // not in keep list
  })

  it('default deny-list strips verbose process attrs but keeps the useful ones', () => {
    const mock = createMockExporter()
    const exporter = new ResourceFilteringMetricExporter({
      exporter: mock,
      drop: DEFAULT_METRIC_RESOURCE_DROP,
    })

    exporter.export(
      resourceMetricsWith({
        'service.name': 'svc',
        'process.command_args': 'a b',
        'process.owner': 'me',
        'process.runtime.description': 'Node.js',
        'process.pid': 1,
        'process.runtime.name': 'nodejs',
        'host.name': 'box',
      }),
      () => {},
    )

    const attrs = exportedAttrs(mock)
    expect(attrs).not.toHaveProperty('process.command_args')
    expect(attrs).not.toHaveProperty('process.owner')
    expect(attrs).not.toHaveProperty('process.runtime.description')
    expect(attrs['process.pid']).toBe(1)
    expect(attrs['process.runtime.name']).toBe('nodejs')
    expect(attrs['host.name']).toBe('box')
    expect(attrs['service.name']).toBe('svc')
  })

  it('delegates aggregation temporality, falling back to cumulative', () => {
    const delta: PushMetricExporter = {
      ...createMockExporter(),
      selectAggregationTemporality: () => AggregationTemporality.DELTA,
    }
    expect(
      new ResourceFilteringMetricExporter({
        exporter: delta,
      }).selectAggregationTemporality(InstrumentType.HISTOGRAM),
    ).toBe(AggregationTemporality.DELTA)

    expect(
      new ResourceFilteringMetricExporter({
        exporter: createMockExporter(),
      }).selectAggregationTemporality(InstrumentType.HISTOGRAM),
    ).toBe(AggregationTemporality.CUMULATIVE)
  })
})
