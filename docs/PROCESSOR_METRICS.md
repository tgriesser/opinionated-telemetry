# Processor Diagnostic Metrics

The `FilteringSpanProcessor` exposes its internal state as OTel observable gauges via `registerMetrics(meter)`. These metrics give you visibility into the telemetry pipeline itself — useful for detecting span leaks, understanding throughput, and diagnosing sampling behavior.

Enabled by default when using `opinionatedTelemetryInit`. Set `processorMetrics: false` to disable.

All metric names are prefixed with `opin_tel.processor.`.

## Gauges with interval watermarks

These metrics track a current value plus the high and low watermarks since the last metric observation. After each collection, watermarks reset to the current value.

| Metric                                      | Description                                             |
| ------------------------------------------- | ------------------------------------------------------- |
| `opin_tel.processor.spans.active`           | Number of in-flight spans (started but not yet ended)   |
| `opin_tel.processor.spans.active.max`       | Peak in-flight spans since last observation             |
| `opin_tel.processor.spans.active.min`       | Lowest in-flight spans since last observation           |
| `opin_tel.processor.traces.active`          | Number of active traces (root spans that haven't ended) |
| `opin_tel.processor.traces.active.max`      | Peak active traces since last observation               |
| `opin_tel.processor.traces.active.min`      | Lowest active traces since last observation             |
| `opin_tel.processor.tail_buffer.traces`     | Number of traces currently in the tail sampling buffer  |
| `opin_tel.processor.tail_buffer.traces.max` | Peak tail-buffered traces since last observation        |
| `opin_tel.processor.tail_buffer.traces.min` | Lowest tail-buffered traces since last observation      |
| `opin_tel.processor.tail_buffer.spans`      | Total spans across all tail-buffered traces             |
| `opin_tel.processor.tail_buffer.spans.max`  | Peak tail-buffered spans since last observation         |
| `opin_tel.processor.tail_buffer.spans.min`  | Lowest tail-buffered spans since last observation       |

**Why watermarks?** A snapshot gauge only tells you what the value is _at observation time_. If your active span count spikes to 10,000 between observations but settles back to 50, you'd never know. The `.max` watermark catches that spike.

## Snapshot gauges

Point-in-time values read at each observation.

| Metric                                        | Description                                                           |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `opin_tel.processor.stuck_spans`              | Spans currently flagged as stuck (in-flight past the stuck threshold) |
| `opin_tel.processor.aggregate_groups`         | Active span aggregation groups awaiting emission                      |
| `opin_tel.processor.conditional_drop_buffers` | Spans buffered waiting for a parent's `shouldDrop` decision           |

## Interval throughput counters

Count of events since the last observation. Reset to 0 after each collection.

| Metric                                         | Description                                               |
| ---------------------------------------------- | --------------------------------------------------------- |
| `opin_tel.processor.spans.started`             | Spans that entered `onStart`                              |
| `opin_tel.processor.spans.exported`            | Spans forwarded to the wrapped exporter                   |
| `opin_tel.processor.spans.dropped.sync`        | Spans dropped by sync span detection                      |
| `opin_tel.processor.spans.dropped.conditional` | Spans dropped by `shouldDrop` callbacks                   |
| `opin_tel.processor.spans.dropped.aggregated`  | Spans consumed by aggregation (not individually exported) |
| `opin_tel.processor.spans.dropped.head`        | Spans dropped by head sampling                            |
| `opin_tel.processor.spans.dropped.tail`        | Spans dropped by tail sampling                            |
| `opin_tel.processor.spans.dropped.burst`       | Spans dropped by burst protection                         |
| `opin_tel.processor.spans.dropped.stuck`       | Spans evicted via stuck span `'drop'` action              |

## What to watch for

**Span leaks**: `spans.active` growing steadily over time, or `spans.active.max` consistently much higher than `spans.active` — indicates spans being started but never ended.

**Tail buffer pressure**: `tail_buffer.traces` near your `maxTraces` limit (default 1000) means traces are being evicted before the root span ends. Consider increasing `maxTraces` or investigating why root spans are slow to complete.

**Drop ratios**: Compare `spans.started` vs `spans.exported` to understand your effective sample rate. Break down by drop reason to see where spans are being filtered.

**Stuck spans**: A non-zero `stuck_spans` count is expected if you have long-running operations. A _growing_ count suggests spans whose `.end()` is never called — consider using `onStuckSpan: () => 'evict'` after a few reports.

## Standalone usage

If using `FilteringSpanProcessor` directly (without `opinionatedTelemetryInit`):

```ts
import { metrics } from '@opentelemetry/api'

const processor = new FilteringSpanProcessor(innerProcessor, config)

// Call after MeterProvider is registered
processor.registerMetrics(metrics.getMeter('opin_tel.processor'))
```
