# opinionated-telemetry

We've thought a lot about Telemetry in Node.js, so you don't have to

Opinionated OpenTelemetry patterns extracted from years of learnings from real-world o11y, to help Node.js projects eveywhere. Sensible defaults, tools, and hooks to cut out the noise and cost from default "instrument everything" implementations, and really drill down and understand what's most important.

The defaults included may or may not be right for you, so be sure to read the options carefully. Comes with powerful hooks for sampling spans, dropping spans, collapsing intermediate spans, globally "auto-instrumenting" important bits of your own code, as well as some nice helpers for some libraries I've used in the past.

Contributions & feedback are welcome, especially if you have ideas or other libraries with sensible default hooks that you'd like to share.

Best suited for & meant use with [Honeycomb.io](https://www.honeycomb.io/). Virtually unlimited attributes on a span for no additional cost is so powerful, I can't believe I don't hear its praises more often.


## Features

- **Stuck span detection**: detects in-flight spans exceeding a threshold and exports early "diagnostic" span snapshots, so you can understand what might be broken sooner (long queries, hung requests, etc.)
- **Sync span dropping**: automatically drops "synchronous" spans that are start and end in the same tick by default, configurable to allow for keeping specific spans e.g. keeping sync spans > `100ms`, or spans with a certain name, etc.
- **Span collapsing**: allows us to drop intermediate spans (e.g. knex, graphql) and merge their attributes into child spans. No use having both a `knex` span that has a single nested `pg` or `mysql` span underneath, unless there is an error in the `knex` span or something
- **Conditional span dropping**: tail-based conditional dropping with child buffering — register a `shouldDrop` callback at span start, evaluate at span end based on duration/error/attributes, with automatic child reparenting. Supports both simple drop (no attribute inheritance) and collapse mode (inherit attributes into children)
- **Baggage propagation**: propagates baggage entries as span attributes on all child spans by default, with outbound baggage suppressed to prevent leaking sensitive data to external APIs (opt-in allowlisting by host and key)
- **Memory & Memory delta tracking**: captures RSS (or detailed heap, configurable) memory & memory deltas on root spans.
- **Auto-instrumentation**: [opt-in hooks](#auto-instrumentation) wraps exported async functions from your own codebase with auto-spans based on the function or method name, configured via `ESM` or `Module._load` patching
- **Head & Tail Based Sampling**: Includes sensible approaches to dealing with Head & Tail based sampling out of the box
- **Burst Protection**: Along with the sampling, includes some conventions for preventing a simple coding mistake that generates an infinite loop spawning thousands of spans per second from doing too much damage.
- **Span aggregation**: collapses N parallel sibling spans with the same name (dataloader batches, S3 multi-get, parallel DB queries) into a single aggregate span with summary statistics, while preserving individual error spans. Configurable via per-scope options or a root-level predicate, with optional custom attribute stats (min, max, avg, median, uniq, etc.)
- **Flat metric exporter**: [opt-in exporter](#flat-metric-exporter) that wraps your metric exporter to fold dimensional attributes into metric names and expand histograms into summary stats + percentiles — so Honeycomb merges everything into a single wide event per collection cycle.
- **Integration helpers**: knex, graphql, bull, socket.io, express
- **Event loop utilization**: captures event loop utilization (0-1) on all spans. Useful for alerting on situation where expensive spans are blocking the event loop. Particularly useful when dealing with things that are synchronous, like `fs` calls or `better-sqlite3` queries

## Install

```
npm install opinionated-telemetry
```

## Quick start

```ts
import { opinionatedTelemetryInit } from 'opinionated-telemetry'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { KnexInstrumentation } from '@opentelemetry/instrumentation-knex'

const { sdk, getTracer, shutdown } = opinionatedTelemetryInit({
  serviceName: 'my-service',
  traceExporter: new OTLPTraceExporter({
    url: 'https://api.honeycomb.io:443/v1/traces', // or wherever you want these to go. We recommend Honeycomb
    headers: '...your headers...',
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new KnexInstrumentation({ maxQueryLength: 10000 }),
  ],
  // Per-instrumentation hooks, keyed by instrumentation scope name
  instrumentationHooks: {
    '@opentelemetry/instrumentation-knex': {
      collapse: true,
    },
  },
})
```

## Core API

### `opinionatedTelemetryInit(config)`

Initializes the OTel SDK with opinionated defaults.

```ts
opinionatedTelemetryInit({
  serviceName: string,
  resourceAttributes?: Record<string, string>,
  traceExporter?: SpanExporter,
  metricReaders?: MetricReader[],
  resourceDetectors?: ResourceDetector[],
  autoDetectResources?: boolean,
  idGenerator?: IdGenerator,
  spanLimits?: SpanLimits,
  dropSyncSpans?: true | ((span) => boolean),        // default: true
  baggageToAttributes?: boolean,                     // default: true
  memory?: boolean | MemoryConfig,              // default: true (rss only)
  memoryDelta?: boolean | MemoryConfig,              // default: true (rss only)
  eventLoopUtilization?: boolean | 'root',           // default: true (all spans)
  stuckSpanDetection?: boolean | StuckSpanConfig,    // default: true
  onSpanAfterShutdown?: (span) => void,              // default: logger.warn
  shutdownSignal?: string | null,                    // default: 'SIGTERM'
  aggregateSpan?: (span) => boolean | AggregateConfig, // default: undefined
  onDroppedSpan?: (span, reason, durationMs?) => void, // called on dropped/sampled spans
  instrumentations: Instrumentation[],
  instrumentationHooks?: Record<string, OpinionatedOptions>,
  globalHooks?: GlobalHooks,                         // hooks for all spans
  additionalSpanProcessors?: SpanProcessor[],
  batchProcessorConfig?: BufferConfig | false,    // false disables batching
  baggagePropagation?: BaggagePropagationConfig, // default: suppress all outbound
  logger?: OpinionatedLogger,                    // default: console
})
```

Returns `{ sdk, getTracer, shutdown }`.

#### `memory`

Captures memory usage root spans under `opin_tel.memory.*` attribute.

Set to `true` (default) for RSS-only via the fast `process.memoryUsage.rss()` path, or pass a `MemoryConfig` object to pick specific fields (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`) which uses the full `process.memoryUsage()` call. Set to `false` to disable.

#### `memoryDelta`

Captures memory usage deltas on root spans under `opin_tel.memory_delta.*` attribute.

Set to `true` (default) for RSS-only via the fast `process.memoryUsage.rss()` path, or pass a `MemoryConfig` object to pick specific fields (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`) which uses the full `process.memoryUsage()` call. Set to `false` to disable.

#### `eventLoopUtilization`

Captures event loop utilization (0-1 ratio) via `performance.eventLoopUtilization()`. The `opin_tel.event_loop.utilization` attribute tells you how saturated the event loop was during the span's lifetime. Set to `true` (default) for all spans, `'root'` for root spans only, or `false` to disable.

#### `stuckSpanDetection`

Detects spans that remain in-flight longer than a threshold and exports diagnostic snapshots. Enabled by default (60s threshold, 5s check interval). Pass a `StuckSpanConfig` object to customize:

```ts
stuckSpanDetection: {
  thresholdMs: 60_000,   // how long before a span is "stuck"
  intervalMs: 5_000,     // how often to check
  onStuckSpan: (span) => {
    // return false to skip exporting this snapshot
  },
}
```

Stuck span snapshots are exported with the original span's trace/span IDs, an `(incomplete)` name suffix, and attributes `opin_tel.stuck.duration_ms` and `opin_tel.stuck.is_snapshot`. They also receive memory delta, ELU, and instrumentation hook enrichment.

#### `batchProcessorConfig`

Overrides for the internal `BatchSpanProcessor`. Opinionated defaults differ from OTel's out-of-the-box values:

| Option                 | OTel Default | Opinionated Default |
| ---------------------- | ------------ | ------------------- |
| `scheduledDelayMillis` | 5000         | **2000**            |
| `exportTimeoutMillis`  | 30000        | **10000**           |
| `maxExportBatchSize`   | 512          | 512                 |
| `maxQueueSize`         | 2048         | 2048                |

Pass a `BufferConfig` object to override any of these:

```ts
opinionatedTelemetryInit({
  batchProcessorConfig: {
    scheduledDelayMillis: 1000, // flush every second
    maxQueueSize: 4096,
  },
})
```

Set to `false` to disable batching entirely and use a `SimpleSpanProcessor` instead. Spans will be exported immediately as they complete, which is useful for development, testing, or low-volume services:

```ts
opinionatedTelemetryInit({
  batchProcessorConfig: false,
})
```

#### `baggagePropagation`

By default, OpenTelemetry's `W3CBaggagePropagator` injects **all** baggage entries into a `baggage` HTTP header on every outgoing request — including requests to third-party APIs. This means any data you set as baggage (request headers, user IDs, tokens) can silently leak to external services.

opinionated-telemetry ships a `FilteredBaggagePropagator` that **suppresses all outbound baggage by default**. Inbound baggage extraction always works — this only affects what gets sent on outgoing requests.

To allow baggage propagation to specific internal services:

```ts
opinionatedTelemetryInit({
  // ...
  baggagePropagation: {
    // Only propagate baggage to these hosts
    allowedHosts: [
      '*.internal.example.com', // wildcard subdomain match
      'partner-api.trusted.com', // exact match
    ],
    // Only propagate these baggage keys (required — omit or [] to block all)
    allowedKeys: [
      'requestId',
      'app.*', // wildcard prefix match
      // '*',   // uncomment to allow all keys
    ],
  },
})
```

| Option         | Description                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `allowedHosts` | Host patterns where baggage is propagated. Supports exact match and `*.domain.com` wildcards. Default: `[]` (suppress all)   |
| `allowedKeys`  | Baggage key patterns to include. Supports exact match, `prefix.*` wildcards, and `*` for all keys. Default: `[]` (block all) |

**How host matching works:** The propagator reads `server.address` from the active client span (set by `instrumentation-http` before injection). If there's no active span or no `server.address` attribute, baggage is suppressed (safe fallback).

> **Note:** If the `OTEL_PROPAGATORS` environment variable is set, NodeSDK ignores the filtered propagator and uses the env-configured propagators instead. A warning is logged when this happens.

The `FilteredBaggagePropagator` class is also exported for standalone use if you need to configure propagators manually.

### Span Aggregation

When a parent span fires off many parallel child spans with the same name (dataloader batches, S3 multi-get, parallel DB queries), the result is N nearly-identical sibling spans that add volume without proportional signal. Span aggregation collapses them into a single aggregate span with summary statistics.

**How it works:** Spans are grouped by `${parentSpanId}:${spanName}`. By default (`emit: 'onInflightZero'`), the group tracks in-flight count; when it drops to zero, the batch is complete and an aggregate span is emitted. If the same parent later starts another batch with the same name, it's a new group.

**Error handling:** By default, error spans are exported individually (full attributes, events, stack trace preserved) and counted in `opin_tel.agg.error_count`. Set `keepErrors: false` to consume error spans into the aggregate instead.

**Single-span optimization:** If only one non-error span arrives in a group (and no errors), it's exported as-is — no aggregate wrapper.

#### Emission modes

| Mode                         | Behavior                                             | Best for                                      |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `'onInflightZero'` (default) | Emits when all started spans in the group have ended | Parallel patterns (`Promise.all`)             |
| `'onParentEnd'`              | Defers emission until the parent span ends           | Sequential loops (`for`/`while` with `await`) |

With the default `onInflightZero`, sequential spans each start and end before the next — inflight goes 1→0 every iteration, producing N separate aggregates of count=1. Use `emit: 'onParentEnd'` to keep the group open and aggregate all sequential children into one span.

#### Chunking

The `chunk` option emits intermediate aggregate spans at regular intervals, useful for long-running loops where you want periodic visibility without waiting for the parent to end.

- **Number** — emit every N spans: `chunk: 100`
- **Predicate** — emit when the function returns true: `chunk: (span, stats) => stats.totalDurationMs > 5000`

The predicate receives the current span and an `AggregateGroupStats` object (`count`, `errorCount`, `nonErrorCount`, `totalDurationMs`, `minDurationMs`, `maxDurationMs`).

Each chunk gets an `opin_tel.agg.chunk_index` attribute (0-based). After a chunk emits, the group stats reset for the next chunk. Any remaining spans are emitted when the group closes (parent end or inflight zero).

Chunking works with both emission modes.

#### Root-level predicate

```ts
opinionatedTelemetryInit({
  // Return true for default aggregation, or an AggregateConfig for custom stats
  aggregateSpan: (span) => {
    if (span.name.startsWith('S3.')) return true
    if (span.name === 'redis.cmd')
      return {
        attributes: {
          response_bytes: {
            attribute: 'redis.response_size_bytes',
            options: ['min', 'max', 'avg'],
          },
          all_statements: {
            attribute: 'db.statement',
            options: 'uniq',
          },
        },
      }
    // Sequential loop — aggregate all iterations under the parent
    if (span.name === 'process.record')
      return { emit: 'onParentEnd', chunk: 100 }
    return false
  },
})
```

#### Per-instrumentation

```ts
instrumentationHooks: {
  '@opentelemetry/instrumentation-dataloader': {
    aggregate: true,
  },
  // Or with custom attribute stats:
  '@opentelemetry/instrumentation-redis': {
    aggregate: {
      keepErrors: false,
      attributes: {
        sizes: {
          attribute: 'redis.response_size_bytes',
          options: ['min', 'max', 'range'],
        },
      },
    },
  },
}
```

#### Aggregate span attributes

Every aggregate span has `opin_tel.meta.is_aggregate = true` and the following built-in stats:

| Attribute                        | Description                                                   |
| -------------------------------- | ------------------------------------------------------------- |
| `opin_tel.agg.count`             | Total spans in the group (including errors)                   |
| `opin_tel.agg.error_count`       | Number of spans with ERROR status                             |
| `opin_tel.agg.min_duration_ms`   | Shortest non-error span duration                              |
| `opin_tel.agg.max_duration_ms`   | Longest non-error span duration                               |
| `opin_tel.agg.avg_duration_ms`   | Mean non-error span duration                                  |
| `opin_tel.agg.total_duration_ms` | Sum of non-error span durations                               |
| `opin_tel.agg.chunk_index`       | 0-based chunk index (present only when `chunk` is configured) |

#### Custom attribute stat options

When you configure `attributes`, each entry maps an output key to a source attribute and one or more stat options. Stats are emitted as `opin_tel.agg.{outputKey}.{stat}`.

| Option   | Input type | Description                                           |
| -------- | ---------- | ----------------------------------------------------- |
| `uniq`   | any        | Array of unique values (converted to strings)         |
| `count`  | any        | Number of spans that had this attribute               |
| `sum`    | numeric    | Sum of values                                         |
| `min`    | numeric    | Minimum value                                         |
| `max`    | numeric    | Maximum value                                         |
| `range`  | numeric    | max - min                                             |
| `avg`    | numeric    | Mean value                                            |
| `median` | numeric    | Median (average of two middle values for even counts) |

### `instrumentationHooks`

Per-instrumentation hooks keyed by instrumentation scope name. Allows you to customize span behavior for specific instrumentations without wrapping them.

```ts
opinionatedTelemetryInit({
  instrumentations: [
    new HttpInstrumentation(),
    new KnexInstrumentation(),
    new DataloaderInstrumentation(),
  ],
  instrumentationHooks: {
    '@opentelemetry/instrumentation-knex': {
      collapse: true,
    },
    '@opentelemetry/instrumentation-dataloader': {
      aggregate: true,
    },
    '@opentelemetry/instrumentation-http': {
      onEnd: (span, durationMs) =>
        span.updateName(
          `${span.attributes['http.method']} ${span.attributes['http.route']} (${Math.round(durationMs)}ms)`,
        ),
    },
  },
})
```

Options per hook:

- `collapse` — drop this span, merge attrs into children, reparent children to grandparent
- `aggregate` — `true` or an `AggregateConfig` to collapse parallel sibling spans into a single aggregate
- `onStart(span)` — called during span start; use `span.updateName()` to rename, `span.setAttribute()` to enrich. Can return `{ collapse: true }` to collapse this specific span, or `{ shouldDrop }` to register [conditional span dropping](#conditional-span-dropping). If both are returned, `collapse` takes precedence.
- `onEnd(span, durationMs)` — called during span end (before export); `durationMs` is the span duration in milliseconds. Same span mutation APIs available

A warning is logged (via `console.warn` by default) if any hook key doesn't match a registered instrumentation name. Pass a custom `logger` to redirect or suppress these warnings.

### `globalHooks`

Global hooks that fire for every span, regardless of instrumentation scope. Useful for cross-cutting concerns like conditional span dropping based on span attributes.

```ts
opinionatedTelemetryInit({
  // ...
  globalHooks: {
    onStart: (span) => {
      // Called on every span start
      // Can return { collapse: true } for per-span collapsing
      // Can return { shouldDrop } to register conditional dropping
    },
    onEnd: (span, durationMs) => {
      // Called on every span end, after enrichment
    },
  },
})
```

Both `globalHooks.onStart` and `instrumentationHooks[scope].onStart` can return `{ collapse: true }` for per-span collapsing, or `{ shouldDrop }` to register conditional span dropping — see below.

### Conditional Span Dropping

Tail-based conditional span dropping allows you to register a `shouldDrop` callback at span start, then decide whether to drop the span when it ends — based on duration, error status, or any other span data.

Child spans are buffered while waiting for the parent's decision. When a span is dropped, its children are reparented to the grandparent. When kept, all buffered children are flushed normally.

Register via `globalHooks.onStart` or `instrumentationHooks[scope].onStart`:

```ts
opinionatedTelemetryInit({
  // ...
  globalHooks: {
    onStart: (span) => {
      // Drop pg-pool.connect spans unless they're slow or errored
      if (span.name === 'pg-pool.connect') {
        return {
          shouldDrop: (span, durationMs) => {
            if (span.status.code === SpanStatusCode.ERROR) return false // keep errors
            if (durationMs > 50) return false // keep slow connections
            return true // drop fast, successful connections
          },
        }
      }
    },
  },
})
```

#### `shouldDrop` return values

The `shouldDrop` callback returns a value controlling how the span is dropped:

| Return value | Behavior                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| `false`      | Keep the span and all buffered children                                                |
| `true`       | Drop the span, reparent children to grandparent (no attribute inheritance)             |
| `'collapse'` | Drop the span like collapse: inherit attributes into children, reparent to grandparent |

`true` is the default drop mode — children are reparented but don't inherit the dropped span's attributes. Use `'collapse'` when the dropped span has useful context that should flow down to children (similar to the `collapse` instrumentation hook option).

#### Nested conditional drops

When multiple ancestors have `shouldDrop` registered, decisions cascade: if a parent is dropped, its reparented children wait for the next ancestor's decision before being flushed. This works correctly with any combination of `true` and `'collapse'` return values.

#### Interaction with collapse

If a span has both `collapse` and `shouldDrop` — whether from `instrumentationHooks[scope].collapse: true`, or from `onStart` returning both `{ collapse: true, shouldDrop }` — collapse takes priority and `shouldDrop` is ignored. The span is dropped immediately with attribute inheritance, and any conditional buffer is flushed with reparenting to the collapse target.

### Trace Counters

Root spans automatically receive counter attributes tracking drops and sampling decisions within their trace:

| Attribute                            | Description                             |
| ------------------------------------ | --------------------------------------- |
| `opin_tel.trace.started_span_count`  | Total child spans started in this trace |
| `opin_tel.trace.captured_span_count` | Child spans exported in this trace      |
| `opin_tel.dropped.sync_count`        | Spans dropped by sync span detection    |
| `opin_tel.dropped.conditional_count` | Spans dropped by conditional dropping   |
| `opin_tel.dropped.aggregated_count`  | Spans consumed by aggregation           |
| `opin_tel.sampled.head_count`        | Spans dropped by head sampling          |
| `opin_tel.sampled.tail_count`        | Spans dropped by tail sampling          |
| `opin_tel.sampled.burst_count`       | Spans dropped by burst protection       |

Counters are best-effort — they reflect drops that occurred before the root span ended. Only non-zero counters are written.

### `FilteringSpanProcessor`

Span processor that handles sync span dropping, baggage propagation, span collapsing, conditional dropping, instrumentation hooks, and custom lifecycle hooks. Used internally by `opinionatedTelemetryInit` but can be used standalone. Accepts `instrumentationHooks` and `globalHooks` in its config.

### Baggage utilities

```ts
import { withBaggage, getBaggageValue } from 'opinionated-telemetry'

// Set baggage and run in that context
withBaggage({ 'app.account_id': '123' }, () => {
  // Read baggage
  const accountId = getBaggageValue('app.account_id')
})
```

### Auto-instrumentation

Auto-instrumentation hooks are opt-in imports, separate from the main entry point:

**CJS** (`Module._load` patching):

```ts
import { createAutoInstrumentHookCJS } from 'opinionated-telemetry/auto-instrument'

createAutoInstrumentHookCJS({
  // tracer is optional — defaults to trace.getTracer('opin_tel.auto')
  instrumentPaths: [
    { base: '/app/src', dirs: ['controllers', 'helpers', 'lib'] },
  ],
  ignoreRules: [
    'helpers/health-check',
    { file: 'helpers/utils', exports: ['internalFn'] },
  ],
})
```

**ESM** (requires `--import @opentelemetry/instrumentation/hook.mjs`):

```ts
import { createAutoInstrumentHookESM } from 'opinionated-telemetry/auto-instrument-esm'

const unhook = createAutoInstrumentHookESM({
  instrumentPaths: [
    { base: '/app/src', dirs: ['controllers', 'helpers', 'lib'] },
  ],
})
```

#### Auto-instrument hooks

Both CJS and ESM hooks accept an optional `hooks` object with `onStart` and `onEnd` callbacks. These are called on every auto-instrumented function invocation with access to the function's arguments and return value, allowing you to enrich spans with call-specific context.

```ts
createAutoInstrumentHookCJS({
  instrumentPaths: [{ base: '/app/src', dirs: ['controllers', 'services'] }],
  hooks: {
    onStart: (span, { args, fnName, filename }) => {
      // Enrich the span before the function executes
      if (fnName === 'getUser') {
        span.setAttribute('app.user_id', args[0])
      }
    },
    onEnd: (span, { args, returnValue, error, fnName, filename }) => {
      // Enrich the span after the function completes
      if (returnValue?.rows) {
        span.setAttribute('app.row_count', returnValue.rows.length)
      }
    },
  },
})
```

| Callback  | Arguments                                                  | Description                                                             |
| --------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `onStart` | `(span, { args, fnName, filename })`                       | Called after span creation, before the wrapped function executes        |
| `onEnd`   | `(span, { args, fnName, filename, returnValue?, error? })` | Called after the function completes (success or error), before span end |

These hooks are for span enrichment only — use `globalHooks` or `instrumentationHooks` on the `FilteringSpanProcessor` for span lifecycle control (collapse, conditional dropping, etc.).

## Honeycomb Quick Start

The `opinionated-telemetry/honeycomb` entrypoint wires up OTLP trace and metric exporters pointed at Honeycomb with sensible defaults, so you don't need to configure exporters manually.

```ts
import { honeycombInit } from 'opinionated-telemetry/honeycomb'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'

const { sdk, getTracer, shutdown } = honeycombInit({
  serviceName: 'my-service',
  apiKey: process.env.HONEYCOMB_API_KEY!,
  instrumentations: [new HttpInstrumentation()],
  // ... other options
})
```

This sets up:

- **Trace export** to `https://api.honeycomb.io/v1/traces` with dataset = `serviceName`
- **Metric export** via `FlatMetricExporter` to `https://api.honeycomb.io/v1/metrics` with dataset = `${serviceName}_metrics`, collected every 60s

All other `opinionatedTelemetryInit` options are supported. `traceExporter` and `metricExporter` can be overridden if you need custom exporter configuration.

| Option                   | Type                 | Default  | Description                                 |
| ------------------------ | -------------------- | -------- | ------------------------------------------- |
| `apiKey`                 | `string`             | required | Honeycomb API key                           |
| `enableMetricCollection` | `boolean`            | `true`   | Set to `false` to disable metric collection |
| `metricExportInterval`   | `number`             | `60_000` | Metric export interval in milliseconds      |
| `traceExporter`          | `SpanExporter`       | —        | Override the default OTLP trace exporter    |
| `metricExporter`         | `PushMetricExporter` | —        | Override the default OTLP metric exporter   |

The entrypoint also re-exports everything from the main `opinionated-telemetry` package, so you can use it as your sole import.

## Flat Metric Exporter

Honeycomb [merges metric data points into a single event](https://docs.honeycomb.io/manage-data-volume/adjust-granularity/metrics-events) when they share the same timestamp, resource, and data point attributes. But metrics with **different** dimensional attributes (like `v8js.heap.space.name=new_space` vs `v8js.gc.type=major`) end up as separate events.

The `FlatMetricExporter` wraps your `OTLPMetricExporter` (or any `PushMetricExporter`) and transforms metrics before export:

1. **Folds dimensional attributes into metric names** — so all data points have the same (empty) attribute set
2. **Expands histograms** into individual gauge metrics with summary stats and percentiles

This ensures Honeycomb merges everything into one wide event per collection cycle.

```ts
import { FlatMetricExporter } from 'opinionated-telemetry/metrics'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'

const metricReader = new PeriodicExportingMetricReader({
  exporter: new FlatMetricExporter({
    exporter: new OTLPMetricExporter({
      url: 'https://api.honeycomb.io:443/v1/metrics',
      headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
    }),
  }),
  exportIntervalMillis: 15_000,
})
```

### Dimensional flattening

Metrics with dimensional attributes (like `v8js.heap.space.name`) are flattened by appending the dimension value to the metric name by default. Use `renameDimension` for custom naming:

```ts
new FlatMetricExporter({
  exporter: metricExporter,
  renameDimension: (metricName, dimKey, dimValue) => {
    if (dimKey === 'v8js.heap.space.name') {
      const short = dimValue.replace('_space', '')
      return metricName.replace('.heap.', `.heap_${short}.`)
    }
    if (dimKey === 'v8js.gc.type') {
      return metricName.replace('v8js.gc.', `v8js.gc_${dimValue}.`)
    }
    // Return undefined to use default (append _value)
  },
})
```

### Histogram expansion

Histogram metrics are automatically expanded into summary stats and percentiles:

| Suffix                                          | Description                  |
| ----------------------------------------------- | ---------------------------- |
| `.count`                                        | Total number of observations |
| `.sum`                                          | Sum of all values            |
| `.min`                                          | Minimum value                |
| `.max`                                          | Maximum value                |
| `.avg`                                          | Mean value (sum/count)       |
| `.p50`, `.p75`, `.p90`, `.p95`, `.p99`, `.p999` | Percentiles (configurable)   |

Customize percentiles via `histogramPercentiles`:

```ts
new FlatMetricExporter({
  exporter: metricExporter,
  histogramPercentiles: [0.5, 0.9, 0.95, 0.99],
})
```

### Result

Instead of N separate metric events, you get a single wide event per collection cycle:

```
timestamp: 2026-03-06T19:31:01Z
socket.io.open_connections: 1
v8js.memory.heap_new.used: 220136
v8js.memory.heap_new.limit: 1048576
v8js.memory.heap_large_object.used: 23513056
v8js.gc_major.duration.count: 3
v8js.gc_major.duration.avg: 0.0105
v8js.gc_major.duration.p99: 0.015
...
```

## Sampling

opinionated-telemetry includes built-in sampling with three composable modes: head-based, tail-based, and EMA burst protection. See [SAMPLING.md](./SAMPLING.md) for detailed documentation on the philosophy, algorithms, composition, and design decisions.

```ts
opinionatedTelemetryInit({
  serviceName: 'my-service',
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [new HttpInstrumentation()],
  sampling: {
    // Head-based: lightweight, immediate drop/keep at trace start
    head: {
      sample: (attrs, spanName) => {
        if (spanName.startsWith('health-check')) return 100 // keep 1-in-100
        return 1 // keep all
      },
      mustKeepSpan: (span, durationMs) =>
        span.status.code === SpanStatusCode.ERROR,
    },

    // Tail-based: buffer all spans, decide with full trace context
    tail: {
      sample: (rootAttrs, trace) => {
        if (trace.hasError) return 1 // keep all errors
        if (trace.durationMs > 5000) return 1 // keep slow traces
        return 10 // sample 1-in-10 otherwise
      },
      mustKeepSpan: (span, durationMs) =>
        span.status.code === SpanStatusCode.ERROR,
      maxTraces: 1000, // max buffered traces (default: 1000)
      maxAgeMs: 120_000, // max buffer age (default: 120s)
      maxSpansPerTrace: 500, // flush large traces early (default: 500)
    },

    // Burst protection: EMA-based per-key throttling
    burstProtection: {
      keyFn: (span) => span.name, // grouping key (default: span.name)
      halfLifeMs: 10_000, // EMA responsiveness (default: 10s)
      rateThreshold: 100, // spans/sec before throttling (default: 100)
      maxSampleRate: 100, // max sample rate cap (default: 100)
    },
  },
})
```

**Head-based** sampling calls `sample` once per root span and returns a 1-in-N rate. Spans are dropped immediately if sampled out. `mustKeepSpan` can rescue individual important spans (e.g. errors) by reparenting them to the root with `SampleRate=1`.

**Tail-based** sampling buffers all spans until the root ends, then calls `sample` with a `TraceSummary` containing error counts, duration, and span count. `mustKeepSpan` flags a trace for guaranteed keeping without short-circuiting the buffer. Safety valves (`maxTraces`, `maxAgeMs`, `maxSpansPerTrace`) prevent unbounded memory growth.

**Burst protection** uses an exponential moving average to detect per-key span rate spikes and automatically applies a sample rate when throughput exceeds the threshold. No manual rate configuration needed.

When combined, rates compose multiplicatively. Tail overrides head for the base decision. `mustKeepSpan` always clamps the rate to 1. Kept spans receive a `SampleRate=N` attribute following the Honeycomb convention.

### `onDroppedSpan`

Called whenever a span is dropped due to sync span dropping, conditional dropping, sampling, or burst protection. Useful for writing sampled-out spans to a compressed ndjson file or other secondary storage for later retrieval.

```ts
opinionatedTelemetryInit({
  // ...
  onDroppedSpan: (span, reason, durationMs) => {
    // reason: 'head' | 'tail' | 'burst' | 'sync' | 'conditional'
    // durationMs: provided for 'tail', 'burst', and 'conditional' drops
    droppedSpanLog.write(
      JSON.stringify({
        name: span.name,
        traceId: span.spanContext().traceId,
        reason,
        attributes: span.attributes,
        durationMs,
      }) + '\n',
    )
  },
})
```

## Integration Helpers

Each integration is a separate entry point to avoid pulling unnecessary dependencies.

### Express

Middleware that enriches the active OTel span with request metadata (method, path, query string, headers) and optionally propagates select values as baggage so they appear on all downstream child spans.

```ts
import { otelCreateExpressMiddleware } from 'opinionated-telemetry/integrations/express'

app.use(
  otelCreateExpressMiddleware({
    captureHeaders: ['user-agent', 'x-request-id'],
    baggageHeaders: ['x-request-id'],
    captureQueryParams: ['page', 'search'],
    baggageQueryParams: ['page'],
    requestHook: (req, { setAttribute, setAsBaggage }) => {
      if (req.user?.id) setAsBaggage('app.user.id', req.user.id)
    },
  }),
)
```

| Option               | Description                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `captureHeaders`     | Request headers to capture as `req.header.<name>` span attributes                                                             |
| `baggageHeaders`     | Subset of `captureHeaders` to also propagate as baggage                                                                       |
| `captureQueryParams` | Query params to capture as `req.query.<name>` span attributes                                                                 |
| `baggageQueryParams` | Subset of `captureQueryParams` to also propagate as baggage                                                                   |
| `requestHook`        | Custom hook with `setAttribute` and `setAsBaggage` helpers for extracting additional request context (e.g. user ID from auth) |
| `enabled`            | Enable/disable the middleware. Default: `true`                                                                                |

> **Security:** `baggageHeaders` and `baggageQueryParams` values are propagated as OTel baggage. With the default `baggagePropagation` config, outbound baggage is suppressed. If you configure `allowedHosts`, be careful not to include sensitive headers (e.g. `authorization`, `cookie`) in `baggageHeaders` — they would be sent to those hosts in the `baggage` HTTP header.

### Knex

Listens to knex `query` events and enriches the active span with connection ID, transaction ID, pool stats, and sanitized query bindings. Bindings are sanitized by replacing strings with `string<length>` and class instances with `<<Object#ClassName>>` to avoid leaking sensitive data.

Returns a cleanup function to remove the listener.

```ts
import { otelInitKnex } from 'opinionated-telemetry/integrations/knex'

const cleanup = otelInitKnex(knexInstance, {
  captureBindings: true,
  capturePoolStats: true,
  hashFn: (input) => customHash(input),
})

// Later: cleanup() to remove the listener
```

| Option             | Description                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `captureBindings`  | Capture sanitized bindings as `db.query.sanitized_bindings` and a CRC32 hash as `db.query.hash`. Default: `true` |
| `capturePoolStats` | Capture connection pool stats (`db.pool.used_count`, `db.pool.free_count`, etc.). Default: `true`                |
| `hashFn`           | Custom hash function for query+bindings. Default: CRC32 via `node:zlib`                                          |

Span attributes set: `db.connection.id`, `db.tx.id`, `db.timeout`, `db.query.sanitized_bindings`, `db.query.hash`, `db.pool.*`.

### GraphQL

Wraps custom resolve functions in a GraphQL schema with OTel context propagation. For each resolver call, extracts `graphql.*` attributes from the active span and propagates them as baggage, so downstream spans (e.g. database queries triggered by a resolver) inherit the GraphQL operation context.

Skips fields using the default field resolver (i.e. simple property access).

```ts
import { defaultFieldResolver } from 'graphql'
import { otelInitGraphql } from 'opinionated-telemetry/integrations/graphql'

otelInitGraphql(schema, {
  fieldResolver: defaultFieldResolver,
  shouldWrapResolver: ({ typeName, fieldName }) => {
    return typeName !== 'InternalType'
  },
})
```

| Option               | Description                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fieldResolver`      | **Required.** Pass `defaultFieldResolver` from `graphql` — used to identify which fields have custom resolvers         |
| `shouldWrapResolver` | Optional filter. Return `false` to skip wrapping a resolver. Receives `{ field, fieldName, type, typeName, resolver }` |

### Bull

Patches `Bull.prototype` to trace job processing with span links connecting producers to consumers across separate traces. This avoids creating artificially long parent-child traces for async job queues.

- **`.add()`** captures the current span context and stores it in the job data
- **`.process()`** creates a new root span with a span link back to the enqueuing span
- **`.on()`** wraps async event handlers with spans for lifecycle events

Call before any queues are created. Pass the Bull constructor (not an instance).

```ts
import Bull from 'bull'
import { otelInitBull } from 'opinionated-telemetry/integrations/bull'

otelInitBull(Bull, {
  tracerName: 'my-bull-tracer',
  tracedEvents: ['completed', 'failed'],
})
```

| Option         | Description                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `tracerName`   | Tracer name for bull spans. Default: `'bull-otel'`                                             |
| `tracedEvents` | Events to wrap with spans on `.on()`. Default: `['completed', 'stalled', 'failed', 'waiting']` |

### Socket.IO

Two functions for Socket.IO observability:

- **`otelInitSocketIo(io)`** sets up an observable gauge tracking open connection count (`socket.io.open_connections`)
- **`otelPatchSocketIo(socket, config)`** patches a socket's `.on()` to inject baggage context into all event handlers, so spans created during socket events inherit user/session context

```ts
import {
  otelInitSocketIo,
  otelPatchSocketIo,
} from 'opinionated-telemetry/integrations/socket-io'

// Set up connection count gauge
otelInitSocketIo(io)

// Patch each socket for baggage propagation
io.on('connection', (socket) => {
  otelPatchSocketIo(socket, {
    getBaggage: (s) => ({ 'app.user.id': s.data?.userId }),
  })
})
```

| Option       | Description                                                                            |
| ------------ | -------------------------------------------------------------------------------------- |
| `meterName`  | Meter name for the connection gauge. Default: `'socket-io-otel'`                       |
| `getBaggage` | **Required.** Function returning baggage entries to inject into event handler contexts |

## Testing Utilities

`opinionated-telemetry/testing` provides `TestSpanExporter` and `TestMetricExporter` — drop-in OTel exporter implementations with built-in assertion helpers, search utilities, and ASCII span tree rendering.

```ts
import {
  TestSpanExporter,
  TestMetricExporter,
} from 'opinionated-telemetry/testing'

const exporter = new TestSpanExporter()

// ... run your code ...

exporter.assertNoErrors()
exporter.assertNoOrphanSpans()
exporter.assertSpanExists('GET /api/users')
exporter.assertSpanCount('db.query', 3)
exporter.assertSpanAttributes('GET /api/users', { 'http.method': 'GET' })

console.log(exporter.toTree())
// GET /api/users
// ├── middleware - auth
// ├── db.query SELECT users
// └── serialize response
```

See [docs/TESTING.md](docs/TESTING.md) for the full API reference.

## License

MIT
