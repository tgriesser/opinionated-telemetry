# opinionated-telemetry

Opinionated OpenTelemetry instrumentation patterns extracted from years of learnings from real-world o11y, meant for reuse across Node.js projects. The defaults included may or may not be right for you, be sure to read the options carefully.

Best suited for use with [Honeycomb](https://www.honeycomb.io/)

## Features

- **Stuck span detection** -- detects in-flight spans exceeding a threshold and exports diagnostic snapshots
- **Sync span dropping** -- automatically drops spans that start and end in the same tick
- **Span reparenting** -- drops intermediate spans (e.g. knex, graphql) and merges their attributes into child spans
- **Baggage propagation** -- propagates baggage entries as span attributes on all child spans
- **Memory delta tracking** -- captures RSS (or detailed heap) memory deltas on root spans
- **Event loop utilization** -- captures event loop utilization (0-1) on all spans
- **Auto-instrumentation** -- wraps exported async functions with spans via `ESM` or `Module._load` patching
- **Integration helpers** -- knex, graphql, bull, socket.io, express

## Install

```
npm install @tgriesser/opinionated-telemetry
```

## Quick start

```ts
import {
  opinionatedTelemetryInit,
  OpinionatedInstrumentation,
} from 'opinionated-telemetry'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { KnexInstrumentation } from '@opentelemetry/instrumentation-knex'

const { sdk, getTracer, shutdown } = opinionatedTelemetryInit({
  serviceName: 'my-service',
  traceExporter: new OTLPTraceExporter({
    url: 'https://api.honeycomb.io:443/v1/traces',
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new OpinionatedInstrumentation(
      new KnexInstrumentation({ maxQueryLength: 10000 }),
      {
        reparent: true,
      },
    ),
  ],
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
  metricReader?: MetricReader,
  spanLimits?: SpanLimits,
  dropSyncSpans?: true | ((span) => boolean),       // default: true
  enableReparenting?: boolean,                       // default: true
  baggageToAttributes?: boolean,                     // default: true
  memoryDelta?: boolean | MemoryDeltaConfig,         // default: true (rss only)
  eventLoopUtilization?: boolean | 'root',             // default: true (all spans)
  stuckSpanDetection?: boolean | StuckSpanConfig,    // default: true
  onSpanAfterShutdown?: (span) => void,              // default: debug log
  shutdownSignal?: string,                           // default: 'SIGTERM'
  instrumentations: Array<Instrumentation | OpinionatedInstrumentation>,
  additionalSpanProcessors?: SpanProcessor[],
})
```

Returns `{ sdk, getTracer, shutdown }`.

#### `memoryDelta`

Captures memory usage deltas on root spans. Set to `true` (default) for RSS-only via the fast `process.memoryUsage.rss()` path, or pass a `MemoryDeltaConfig` object to pick specific fields (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`) which uses the full `process.memoryUsage()` call. Set to `false` to disable.

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

### `OpinionatedInstrumentation`

Wraps an OTel instrumentation with opinionated behavior.

```ts
new OpinionatedInstrumentation(instrumentationInstance, opinionatedOptions?)
```

Options:

- `reparent` -- drop this span, merge attrs into children, reparent children to grandparent
- `renameSpan(span)` -- rename in onStart
- `renameSpanOnEnd(span)` -- rename in onEnd
- `onStart(span)` -- custom onStart hook
- `onEnd(span)` -- custom onEnd hook

### `FilteringSpanProcessor`

Span processor that handles sync span dropping, baggage propagation, reparenting, and custom hooks. Used internally by `opinionatedTelemetryInit` but can be used standalone.

### Baggage utilities

```ts
import { withBaggage, getBaggageValue } from 'opinionated-telemetry'

// Set baggage on context
const ctx = withBaggage({ 'app.account_id': '123' })
context.with(ctx, () => {
  /* ... */
})

// Read baggage
const accountId = getBaggageValue('app.account_id')
```

### Auto-instrumentation

```ts
import { createAutoInstrumentHook } from 'opinionated-telemetry'

createAutoInstrumentHook({
  tracer: getTracer('auto-instrument'),
  instrumentPaths: [
    { base: '/app/src', dirs: ['controllers', 'helpers', 'lib'] },
  ],
  ignoreRules: [
    'helpers/health-check',
    { file: 'helpers/utils', exports: ['internalFn'] },
  ],
})
```

## Integration helpers

Each integration is a separate entry point to avoid pulling unnecessary dependencies.

### Knex

```ts
import { otelInitKnex } from 'opinionated-telemetry/integrations/knex'

const cleanup = otelInitKnex(knexInstance, {
  captureBindings: true,
  capturePoolStats: true,
  hashFn: (input) => customHash(input),
})
```

### GraphQL

```ts
import { otelInitGraphql } from 'opinionated-telemetry/integrations/graphql'

otelInitGraphql(schema)
```

### Bull

```ts
import { otelInitBull } from 'opinionated-telemetry/integrations/bull'

otelInitBull(Bull, {
  tracerName: 'my-bull-tracer',
  tracedEvents: ['completed', 'failed'],
})
```

### Socket.IO

```ts
import {
  otelInitSocketIo,
  otelPatchSocketIo,
} from 'opinionated-telemetry/integrations/socket-io'

otelInitSocketIo(io)

io.on('connection', (socket) => {
  otelPatchSocketIo(socket, {
    getBaggage: (s) => ({ 'app.user.id': s.data?.userId }),
  })
})
```

### Express

```ts
import { otelCreateExpressMiddleware } from 'opinionated-telemetry/integrations/express'

app.use(
  otelCreateExpressMiddleware({
    captureHeaders: ['user-agent', 'x-request-id'],
    baggageHeaders: ['x-request-id'],
    captureQueryParams: ['page', 'search'],
    requestHook: (req, { setAsBaggage }) => {
      if (req.user?.id) setAsBaggage('app.user.id', req.user.id)
    },
  }),
)
```

## License

MIT
