import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  SimpleSpanProcessor,
  BasicTracerProvider,
} from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode } from '@opentelemetry/api'
import { TestSpanExporter, TestMetricExporter } from '../../src/testing.js'
import { setupOtel, cleanupOtel } from '../helpers.js'

describe('TestSpanExporter', () => {
  let exporter: TestSpanExporter
  let provider: BasicTracerProvider

  beforeEach(() => {
    setupOtel()
    exporter = new TestSpanExporter()
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
  })

  afterEach(() => {
    cleanupOtel()
  })

  function tracer() {
    return provider.getTracer('test')
  }

  async function flush() {
    await provider.forceFlush()
  }

  describe('basic collection', () => {
    it('collects exported spans', () => {
      tracer().startSpan('test-span').end()
      flush()
      expect(exporter.spans).toHaveLength(1)
      expect(exporter.spans[0].name).toBe('test-span')
    })

    it('reset clears spans', () => {
      tracer().startSpan('a').end()
      flush()
      exporter.reset()
      expect(exporter.spans).toHaveLength(0)
    })
  })

  describe('finders', () => {
    it('findSpan by string name', () => {
      tracer().startSpan('alpha').end()
      tracer().startSpan('beta').end()
      flush()
      expect(exporter.findSpan('beta')?.name).toBe('beta')
      expect(exporter.findSpan('gamma')).toBeUndefined()
    })

    it('findSpan by regex', () => {
      tracer().startSpan('GET /api/users').end()
      tracer().startSpan('POST /api/users').end()
      flush()
      expect(exporter.findSpan(/^GET/)?.name).toBe('GET /api/users')
    })

    it('findSpans returns all matches', () => {
      tracer().startSpan('db.query').end()
      tracer().startSpan('db.query').end()
      tracer().startSpan('other').end()
      flush()
      expect(exporter.findSpans('db.query')).toHaveLength(2)
      expect(exporter.findSpans(/db\./).length).toBe(2)
    })

    it('spanNames returns unique names', () => {
      tracer().startSpan('a').end()
      tracer().startSpan('b').end()
      tracer().startSpan('a').end()
      flush()
      expect(exporter.spanNames).toEqual(expect.arrayContaining(['a', 'b']))
      expect(exporter.spanNames).toHaveLength(2)
    })

    it('rootSpans returns spans without parent', () => {
      tracer().startActiveSpan('root', (root) => {
        tracer().startSpan('child').end()
        root.end()
      })
      flush()
      expect(exporter.rootSpans).toHaveLength(1)
      expect(exporter.rootSpans[0].name).toBe('root')
    })

    it('errorSpans returns spans with error status', () => {
      const span = tracer().startSpan('fail')
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'oops' })
      span.end()
      tracer().startSpan('ok').end()
      flush()
      expect(exporter.errorSpans).toHaveLength(1)
      expect(exporter.errorSpans[0].name).toBe('fail')
    })
  })

  describe('assertions', () => {
    it('assertSpanExists succeeds when span present', () => {
      tracer().startSpan('found').end()
      flush()
      const span = exporter.assertSpanExists('found')
      expect(span.name).toBe('found')
    })

    it('assertSpanExists throws when missing', () => {
      flush()
      expect(() => exporter.assertSpanExists('missing')).toThrow(
        /Expected span matching missing to exist/,
      )
    })

    it('assertSpanNotExists succeeds when absent', () => {
      tracer().startSpan('other').end()
      flush()
      expect(() => exporter.assertSpanNotExists('missing')).not.toThrow()
    })

    it('assertSpanNotExists throws when present', () => {
      tracer().startSpan('bad').end()
      flush()
      expect(() => exporter.assertSpanNotExists('bad')).toThrow(
        /Expected span matching bad not to exist/,
      )
    })

    it('assertSpanCount checks exact count', () => {
      tracer().startSpan('x').end()
      tracer().startSpan('x').end()
      tracer().startSpan('y').end()
      flush()
      expect(() => exporter.assertSpanCount('x', 2)).not.toThrow()
      expect(() => exporter.assertSpanCount('x', 1)).toThrow(
        /Expected 1 span\(s\) matching x, found 2/,
      )
    })

    it('assertTotalSpanCount checks total', () => {
      tracer().startSpan('a').end()
      tracer().startSpan('b').end()
      flush()
      expect(() => exporter.assertTotalSpanCount(2)).not.toThrow()
      expect(() => exporter.assertTotalSpanCount(3)).toThrow(
        /Expected 3 total span\(s\), found 2/,
      )
    })

    it('assertSpanAttributes checks subset match', () => {
      const span = tracer().startSpan('req')
      span.setAttribute('http.method', 'GET')
      span.setAttribute('http.url', '/api')
      span.end()
      flush()
      expect(() =>
        exporter.assertSpanAttributes('req', { 'http.method': 'GET' }),
      ).not.toThrow()
      expect(() =>
        exporter.assertSpanAttributes('req', { 'http.method': 'POST' }),
      ).toThrow(/expected "POST"/)
    })

    it('assertNoErrors passes with no error spans', () => {
      tracer().startSpan('ok').end()
      flush()
      expect(() => exporter.assertNoErrors()).not.toThrow()
    })

    it('assertNoErrors throws with error spans', () => {
      const span = tracer().startSpan('bad')
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      flush()
      expect(() => exporter.assertNoErrors()).toThrow(
        /Expected no error spans, found 1/,
      )
    })

    it('assertNoOrphanSpans passes when all parents present', () => {
      tracer().startActiveSpan('root', (root) => {
        tracer().startSpan('child').end()
        root.end()
      })
      flush()
      expect(() => exporter.assertNoOrphanSpans()).not.toThrow()
    })

    it('assertNoOrphanSpans throws with orphan details', () => {
      // Create parent+child, then build exporter with only the child
      const orphanExporter = new TestSpanExporter()
      const orphanProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(orphanExporter)],
      })
      const t = orphanProvider.getTracer('test')
      t.startActiveSpan('root', (root) => {
        t.startSpan('child-a').end()
        t.startSpan('child-b').end()
        root.end()
      })
      // Remove the root span, leaving children as orphans
      const children = orphanExporter.spans.filter((s) => s.parentSpanContext)
      const onlyChildren = new TestSpanExporter()
      onlyChildren.export(children, () => {})
      expect(() => onlyChildren.assertNoOrphanSpans()).toThrow(
        /Found 2 orphan span\(s\)/,
      )
      expect(() => onlyChildren.assertNoOrphanSpans()).toThrow(/child-a/)
      expect(() => onlyChildren.assertNoOrphanSpans()).toThrow(/child-b/)
    })
  })

  describe('toTree', () => {
    it('renders a simple hierarchy', () => {
      tracer().startActiveSpan('root', (root) => {
        tracer().startSpan('child-a').end()
        tracer().startSpan('child-b').end()
        root.end()
      })
      flush()
      expect(exporter.toTree()).toMatchInlineSnapshot(`
        "root
        ├── child-a
        └── child-b"
      `)
    })

    it('renders nested children', () => {
      tracer().startActiveSpan('root', (root) => {
        tracer().startActiveSpan('parent', (parent) => {
          tracer().startSpan('leaf').end()
          parent.end()
        })
        root.end()
      })
      flush()
      expect(exporter.toTree()).toMatchInlineSnapshot(`
        "root
        └── parent
            └── leaf"
      `)
    })

    it('includes duration when requested', () => {
      tracer().startSpan('test-span').end()
      flush()
      const tree = exporter.toTree({ includeDuration: true })
      expect(tree).toMatch(/^test-span \(\d/)
    })

    it('includes attributes when requested', () => {
      const span = tracer().startSpan('req')
      span.setAttribute('http.method', 'GET')
      span.end()
      flush()
      expect(exporter.toTree({ attributes: ['http.method'] }))
        .toMatchInlineSnapshot(`
        "req {http.method="GET"}"
      `)
    })

    it('marks error spans', () => {
      const span = tracer().startSpan('fail')
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      flush()
      expect(exporter.toTree()).toMatchInlineSnapshot(`"fail ✗"`)
    })

    it('renders orphan spans under (missing span) placeholder', () => {
      // Create a full trace, then build an exporter with only the children
      const fullExporter = new TestSpanExporter()
      const p = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(fullExporter)],
      })
      const t = p.getTracer('test')
      t.startActiveSpan('root', (root) => {
        t.startSpan('child-a').end()
        t.startActiveSpan('child-b', (childB) => {
          t.startSpan('grandchild').end()
          childB.end()
        })
        root.end()
      })
      // Keep only non-root spans
      const nonRoot = fullExporter.spans.filter((s) => s.parentSpanContext)
      const orphanExporter = new TestSpanExporter()
      orphanExporter.export(nonRoot, () => {})
      expect(orphanExporter.toTree()).toMatchInlineSnapshot(`
        "(missing span)
        ├── child-a
        └── child-b
            └── grandchild"
      `)
    })

    it('renders multiple missing parents separately', () => {
      // Create two separate traces, export only children
      const fullExporter = new TestSpanExporter()
      const p = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(fullExporter)],
      })
      const t = p.getTracer('test')
      t.startActiveSpan('root-1', (root1) => {
        t.startSpan('child-of-1').end()
        root1.end()
      })
      t.startActiveSpan('root-2', (root2) => {
        t.startSpan('child-of-2').end()
        root2.end()
      })
      const nonRoot = fullExporter.spans.filter((s) => s.parentSpanContext)
      const orphanExporter = new TestSpanExporter()
      orphanExporter.export(nonRoot, () => {})
      expect(orphanExporter.toTree()).toMatchInlineSnapshot(`
        "(missing span)
        └── child-of-1

        (missing span)
        └── child-of-2"
      `)
    })
  })

  describe('summarize', () => {
    it('returns correct summary', () => {
      tracer().startActiveSpan('root', (root) => {
        tracer().startSpan('child').end()
        const err = tracer().startSpan('error-child')
        err.setStatus({ code: SpanStatusCode.ERROR })
        err.end()
        root.end()
      })
      flush()
      const summary = exporter.summarize()
      expect(summary.totalSpans).toBe(3)
      expect(summary.spanNames).toEqual({
        root: 1,
        child: 1,
        'error-child': 1,
      })
      expect(summary.errorCount).toBe(1)
      expect(summary.rootCount).toBe(1)
      expect(summary.orphanCount).toBe(0)
      expect(summary.traceCount).toBe(1)
    })
  })
})

describe('TestMetricExporter', () => {
  let exporter: TestMetricExporter

  beforeEach(() => {
    exporter = new TestMetricExporter()
  })

  function fakeResourceMetrics(
    metrics: Array<{ name: string; value: number }>,
  ) {
    return {
      resource: { attributes: {}, merge: () => ({}) } as any,
      scopeMetrics: [
        {
          scope: { name: 'test' },
          metrics: metrics.map((m) => ({
            descriptor: {
              name: m.name,
              description: '',
              unit: '',
              valueType: 0,
            },
            aggregationTemporality: 1,
            dataPointType: 0,
            dataPoints: [
              {
                startTime: [0, 0] as [number, number],
                endTime: [1, 0] as [number, number],
                attributes: {},
                value: m.value,
              },
            ],
          })),
        },
      ],
    } as any
  }

  it('collects exported metrics', () => {
    exporter.export(fakeResourceMetrics([{ name: 'cpu', value: 42 }]), () => {})
    expect(exporter.resourceMetrics).toHaveLength(1)
  })

  it('metricNames returns unique names', () => {
    exporter.export(
      fakeResourceMetrics([
        { name: 'cpu', value: 42 },
        { name: 'mem', value: 100 },
      ]),
      () => {},
    )
    expect(exporter.metricNames).toEqual(expect.arrayContaining(['cpu', 'mem']))
  })

  it('metricValues returns latest values', () => {
    exporter.export(fakeResourceMetrics([{ name: 'cpu', value: 42 }]), () => {})
    exporter.export(fakeResourceMetrics([{ name: 'cpu', value: 99 }]), () => {})
    expect(exporter.metricValues['cpu']).toBe(99)
  })

  it('reset clears metrics', () => {
    exporter.export(fakeResourceMetrics([{ name: 'cpu', value: 1 }]), () => {})
    exporter.reset()
    expect(exporter.resourceMetrics).toHaveLength(0)
    expect(exporter.metricNames).toHaveLength(0)
  })

  describe('assertions', () => {
    it('assertMetricExists succeeds when present', () => {
      exporter.export(
        fakeResourceMetrics([{ name: 'cpu', value: 42 }]),
        () => {},
      )
      expect(() => exporter.assertMetricExists('cpu')).not.toThrow()
    })

    it('assertMetricExists throws when missing', () => {
      expect(() => exporter.assertMetricExists('missing')).toThrow(
        /Expected metric "missing" to exist/,
      )
    })

    it('assertMetricNotExists succeeds when absent', () => {
      expect(() => exporter.assertMetricNotExists('missing')).not.toThrow()
    })

    it('assertMetricNotExists throws when present', () => {
      exporter.export(
        fakeResourceMetrics([{ name: 'cpu', value: 42 }]),
        () => {},
      )
      expect(() => exporter.assertMetricNotExists('cpu')).toThrow(
        /Expected metric "cpu" not to exist/,
      )
    })

    it('assertMetricValue checks latest value', () => {
      exporter.export(
        fakeResourceMetrics([{ name: 'cpu', value: 42 }]),
        () => {},
      )
      expect(() => exporter.assertMetricValue('cpu', 42)).not.toThrow()
      expect(() => exporter.assertMetricValue('cpu', 99)).toThrow(
        /expected 99, got 42/,
      )
    })
  })
})
