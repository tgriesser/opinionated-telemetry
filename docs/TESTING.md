# Testing Utilities

`opinionated-telemetry/testing` provides `TestSpanExporter` and `TestMetricExporter` — drop-in replacements for OTel's in-memory exporters with built-in assertion helpers, search utilities, and ASCII span tree rendering.

```ts
import {
  TestSpanExporter,
  TestMetricExporter,
} from 'opinionated-telemetry/testing'
```

## TestSpanExporter

Implements the OTel `SpanExporter` interface. Collects spans in memory and exposes helpers for querying and asserting on them.

### Setup

Use with `SimpleSpanProcessor` (or set `batchProcessorConfig: false` in `opinionatedTelemetryInit`) so spans are available immediately after ending:

```ts
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { TestSpanExporter } from 'opinionated-telemetry/testing'

const exporter = new TestSpanExporter()
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
const tracer = provider.getTracer('test')
```

Or with `opinionatedTelemetryInit`:

```ts
import { opinionatedTelemetryInit } from 'opinionated-telemetry'
import { TestSpanExporter } from 'opinionated-telemetry/testing'

const exporter = new TestSpanExporter()
opinionatedTelemetryInit({
  serviceName: 'test',
  traceExporter: exporter,
  batchProcessorConfig: false, // spans export immediately
  instrumentations: [],
})
```

### Properties

| Property     | Type             | Description                       |
| ------------ | ---------------- | --------------------------------- |
| `spans`      | `ReadableSpan[]` | All spans collected so far        |
| `spanNames`  | `string[]`       | Unique span names                 |
| `rootSpans`  | `ReadableSpan[]` | Spans without a parent            |
| `errorSpans` | `ReadableSpan[]` | Spans with `SpanStatusCode.ERROR` |

### Finders

#### `findSpan(name: string | RegExp): ReadableSpan | undefined`

Find the first span matching a name or pattern:

```ts
const span = exporter.findSpan('GET /api/users')
const dbSpan = exporter.findSpan(/^db\.query/)
```

#### `findSpans(name: string | RegExp): ReadableSpan[]`

Find all spans matching a name or pattern:

```ts
const queries = exporter.findSpans(/^db\./)
expect(queries).toHaveLength(3)
```

### Assertions

All assertion methods throw descriptive `Error` messages on failure, making them compatible with any test framework (vitest, jest, mocha, node:test).

#### `assertSpanExists(name: string | RegExp): ReadableSpan`

Assert a span exists and return it for further inspection:

```ts
const span = exporter.assertSpanExists('GET /api/users')
expect(span.attributes['http.status_code']).toBe(200)
```

#### `assertSpanNotExists(name: string | RegExp): void`

Assert no span matches:

```ts
exporter.assertSpanNotExists('debug-internal')
```

#### `assertSpanCount(name: string | RegExp, expected: number): void`

Assert exact count of matching spans:

```ts
exporter.assertSpanCount('db.query', 3)
exporter.assertSpanCount(/^middleware/, 2)
```

#### `assertTotalSpanCount(expected: number): void`

Assert total number of collected spans:

```ts
exporter.assertTotalSpanCount(5)
```

#### `assertSpanAttributes(name: string | RegExp, attrs: Record<string, unknown>): ReadableSpan`

Assert a span exists with the given attributes (subset match):

```ts
exporter.assertSpanAttributes('GET /api/users', {
  'http.method': 'GET',
  'http.status_code': 200,
})
```

#### `assertNoErrors(): void`

Assert no spans have error status:

```ts
exporter.assertNoErrors()
```

#### `assertNoOrphanSpans(): void`

Assert every non-root span has its parent present in the collected spans. Catches issues like missing parent spans from filtering, sampling, or incomplete traces:

```ts
exporter.assertNoOrphanSpans()
```

### Span Tree

#### `toTree(opts?): string`

Render an ASCII tree of the span hierarchy, grouped by trace. Durations are omitted by default for deterministic snapshot tests:

```ts
console.log(exporter.toTree())
```

```
GET /api/users
├── middleware - auth
├── db.query SELECT users
└── serialize response
```

Nested children are indented:

```
GET /api/users
├── middleware - auth
├── UserService.findAll
│   ├── db.query SELECT users
│   └── db.query SELECT roles
└── serialize response
```

Error spans are marked with `✗`:

```
POST /api/orders ✗
├── validate request
└── db.query INSERT orders ✗
```

Orphan spans (parent not in the collected set) are rendered under a `(missing span)` placeholder, grouped by missing parent:

```
GET /api/users
└── db.query
(missing span)
├── orphaned-child-a
└── orphaned-child-b
```

**Options:**

| Option            | Type       | Default | Description                      |
| ----------------- | ---------- | ------- | -------------------------------- |
| `attributes`      | `string[]` | `[]`    | Attribute keys to include inline |
| `includeDuration` | `boolean`  | `false` | Include span duration            |
| `sortByStart`     | `boolean`  | `true`  | Sort sibling spans by start time |

```ts
console.log(exporter.toTree({ includeDuration: true }))
```

```
GET /api/users (12.34ms)
├── middleware - auth (0.12ms)
└── db.query SELECT users (1.45ms)
```

```ts
console.log(exporter.toTree({ attributes: ['http.method', 'db.statement'] }))
```

```
GET /api/users {http.method="GET"}
└── db.query {db.statement="SELECT * FROM users"}
```

### Summary

#### `summarize(): object`

Returns a summary object useful for snapshot testing:

```ts
const summary = exporter.summarize()
// {
//   totalSpans: 5,
//   spanNames: { 'GET /api/users': 1, 'db.query': 3, 'serialize': 1 },
//   errorCount: 0,
//   rootCount: 1,
//   orphanCount: 0,
//   traceCount: 1,
// }
```

### Lifecycle

#### `reset(): void`

Clear all collected spans (call between tests):

```ts
afterEach(() => {
  exporter.reset()
})
```

---

## TestMetricExporter

Implements the OTel `PushMetricExporter` interface. Collects `ResourceMetrics` in memory with helpers for querying and asserting on metric values.

### Setup

```ts
import { TestMetricExporter } from 'opinionated-telemetry/testing'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

const metricExporter = new TestMetricExporter()
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 100,
})
```

### Properties

| Property          | Type                                | Description                                        |
| ----------------- | ----------------------------------- | -------------------------------------------------- |
| `resourceMetrics` | `ResourceMetrics[]`                 | Raw collected metrics from each export call        |
| `flatMetrics`     | `Map<string, DataPoint<unknown>[]>` | Flattened `name → dataPoints[]` across all exports |
| `metricNames`     | `string[]`                          | Unique metric names                                |
| `metricValues`    | `Record<string, unknown>`           | `name → latestValue` map (last data point wins)    |

### Assertions

#### `assertMetricExists(name: string): DataPoint<unknown>[]`

Assert a metric exists and return its data points:

```ts
const points = metricExporter.assertMetricExists('http.server.duration')
expect(points.length).toBeGreaterThan(0)
```

#### `assertMetricNotExists(name: string): void`

Assert a metric does not exist:

```ts
metricExporter.assertMetricNotExists('internal.debug.counter')
```

#### `assertMetricValue(name: string, expected: unknown): void`

Assert the latest value of a metric:

```ts
metricExporter.assertMetricValue('http.server.active_requests', 0)
```

### Lifecycle

#### `reset(): void`

Clear all collected metrics:

```ts
afterEach(() => {
  metricExporter.reset()
})
```

---

## Full Example

```ts
import { describe, it, afterEach } from 'vitest'
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { TestSpanExporter } from 'opinionated-telemetry/testing'

describe('UserService', () => {
  const exporter = new TestSpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const tracer = provider.getTracer('test')

  // Enable context propagation for parent-child linking
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  )

  afterEach(() => exporter.reset())

  it('creates expected spans for user lookup', async () => {
    tracer.startActiveSpan('GET /api/users', (root) => {
      tracer.startActiveSpan('UserService.findAll', (svc) => {
        tracer.startSpan('db.query SELECT users').end()
        tracer.startSpan('db.query SELECT roles').end()
        svc.end()
      })
      root.end()
    })

    await provider.forceFlush()

    // Structural assertions
    exporter.assertNoErrors()
    exporter.assertNoOrphanSpans()
    exporter.assertTotalSpanCount(4)
    exporter.assertSpanCount('db.query SELECT users', 1)

    // Inspect the tree
    console.log(exporter.toTree())
    // GET /api/users
    // └── UserService.findAll
    //     ├── db.query SELECT users
    //     └── db.query SELECT roles
  })
})
```
